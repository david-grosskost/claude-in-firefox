#!/usr/bin/env node
// MCP server (stdio) that relays tool calls to the "Claude in Firefox" WebExtension.
//
// Claude Code spawns this process. It listens on a localhost WebSocket; the extension's
// background page connects to it and executes the actual browser actions.
// Several Claude Code sessions can run at once: each server takes the first free port in
// [BASE_PORT, BASE_PORT + PORT_COUNT) and the extension connects to all of them.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { z } from 'zod';

const BASE_PORT = Number(process.env.CLAUDE_IN_FIREFOX_PORT || 8765);
const PORT_COUNT = 10;
const CONNECT_WAIT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;

const log = (...args) => console.error('[claude-in-firefox]', ...args);

// ---------------------------------------------------------------------------
// Extension bridge
// ---------------------------------------------------------------------------

let extSocket = null;
let seq = 0;
const pending = new Map(); // id -> { resolve, reject, timer, ws }
const connectWaiters = new Set();

function onExtensionConnected(ws) {
  if (extSocket && extSocket !== ws) extSocket.close(4000, 'replaced by a newer connection');
  extSocket = ws;
  log('Firefox extension connected');
  for (const wake of connectWaiters) wake();
  connectWaiters.clear();

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });

  ws.on('close', () => {
    if (extSocket === ws) extSocket = null;
    log('Firefox extension disconnected');
    for (const [id, p] of pending) {
      if (p.ws !== ws) continue;
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error('Lost the connection to the Firefox extension while the action was running.'));
    }
  });
}

async function listen() {
  for (let port = BASE_PORT; port < BASE_PORT + PORT_COUNT; port++) {
    try {
      const wss = await new Promise((resolve, reject) => {
        const server = new WebSocketServer({
          host: '127.0.0.1',
          port,
          // Only the extension may connect: web pages cannot forge a moz-extension:// origin.
          verifyClient: ({ origin }) => typeof origin === 'string' && origin.startsWith('moz-extension://'),
        });
        server.once('listening', () => resolve(server));
        server.once('error', reject);
      });
      wss.on('connection', onExtensionConnected);
      wss.on('error', (e) => log('WebSocket server error:', e.message));
      log(`listening on ws://127.0.0.1:${port}`);
      return port;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`No free port in ${BASE_PORT}-${BASE_PORT + PORT_COUNT - 1}`);
}

function waitForExtension(ms) {
  if (extSocket) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const wake = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      connectWaiters.delete(wake);
      reject(new Error(
        'The "Claude in Firefox" extension is not connected. Make sure Firefox is running and the ' +
        'extension is installed and enabled (about:debugging > This Firefox, or about:addons).'
      ));
    }, ms);
    connectWaiters.add(wake);
  });
}

async function callExtension(tool, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await waitForExtension(CONNECT_WAIT_MS);
  const ws = extSocket;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for Firefox to run "${tool}".`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, ws });
    ws.send(JSON.stringify({ id, tool, args }));
  });
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: 'claude-in-firefox', version: '0.1.0' },
  {
    instructions:
      'Tools to control the user\'s real Firefox browser (their profile, cookies and logins). ' +
      'Start with tabs_context to get tab IDs, or tabs_create to open a new tab. ' +
      'Prefer read_page/find (element refs) over screenshot coordinates when clicking or typing. ' +
      'Input events are synthesized from a content script: they work on most sites but are not ' +
      '"trusted" events, so a few sites may ignore them. Avoid triggering alert()/confirm() dialogs, ' +
      'they block the page. Ask the user before submitting forms, purchasing, or sending messages.',
  },
);

const tabId = z.number().int().describe('Tab ID (from tabs_context or tabs_create)');
const ref = z.string().describe('Element reference such as "ref_12", from read_page or find');

function tool(name, description, shape, timeoutFor) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      const timeout = timeoutFor ? timeoutFor(args) : DEFAULT_TIMEOUT_MS;
      return await callExtension(name, args, timeout);
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });
}

tool('tabs_context',
  'List the open Firefox tabs (ID, title, URL, active state). Tabs opened through tabs_create are marked [claude]. Call this first to get a valid tab ID.',
  {});

tool('tabs_create',
  'Open a new tab (made active in the current window) and wait for it to load. Returns the new tab ID.',
  { url: z.string().optional().describe('URL to open (defaults to about:blank). "example.com" becomes https://example.com') });

tool('tabs_close', 'Close a tab.', { tabId });

tool('navigate',
  'Navigate a tab to a URL and wait for the page to load. Use "back" or "forward" to move through history.',
  { tabId, url: z.string().describe('Target URL, or "back" / "forward"') });

tool('read_page',
  'Get an accessibility-style tree of the page with element refs (e.g. [ref_12]) usable by computer/form_input. ' +
  'filter="interactive" lists only clickable/editable elements (compact); "all" also includes headings, landmarks and text. ' +
  'Hidden elements are skipped. Refs stay valid until the page navigates.',
  {
    tabId,
    filter: z.enum(['all', 'interactive']).optional().describe('Default "all"'),
    ref_id: z.string().optional().describe('Only return the subtree under this ref'),
    max_depth: z.number().int().optional().describe('Maximum tree depth (default 30)'),
  });

tool('find',
  'Find elements whose role, label, text, placeholder, id or name match the given keywords. Returns up to 20 matches with refs, best first.',
  { tabId, query: z.string().describe('Keywords, e.g. "search box" or "add to cart button"') });

tool('get_page_text',
  'Return the title, URL and visible text of the page (document.body.innerText). Good for reading articles or checking content.',
  { tabId });

tool('computer',
  'Interact with the page. Actions:\n' +
  '- screenshot: capture the visible part of the tab (the tab is activated first)\n' +
  '- left_click / right_click / double_click / triple_click / hover: at `coordinate` (pixels of the latest screenshot) or on `ref`\n' +
  '- left_click_drag: drag from `start_coordinate` to `coordinate`\n' +
  '- type: type `text` into the focused element (click it first)\n' +
  '- key: press keys in `text`, space separated, e.g. "Enter", "Tab", "ctrl+a", "Down Down Enter"\n' +
  '- scroll: scroll at `coordinate`/`ref` (or the page) in `scroll_direction` by `scroll_amount` ticks (~100px each)\n' +
  '- scroll_to: scroll `ref` into view\n' +
  '- wait: wait `duration` seconds (max 30)',
  {
    tabId,
    action: z.enum(['screenshot', 'left_click', 'right_click', 'double_click', 'triple_click', 'hover',
      'left_click_drag', 'type', 'key', 'scroll', 'scroll_to', 'wait']),
    coordinate: z.array(z.number()).length(2).optional().describe('[x, y] in screenshot pixels'),
    start_coordinate: z.array(z.number()).length(2).optional().describe('[x, y] drag start for left_click_drag'),
    ref: ref.optional(),
    text: z.string().optional().describe('Text for "type", key combo(s) for "key"'),
    modifiers: z.string().optional().describe('Modifier keys held during a click, e.g. "ctrl", "shift", "ctrl+shift"'),
    scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    scroll_amount: z.number().optional().describe('Scroll ticks (default 3)'),
    duration: z.number().optional().describe('Seconds for "wait"'),
  },
  (args) => (args.action === 'wait' ? (Math.min(args.duration ?? 1, 30) + 15) * 1000 : DEFAULT_TIMEOUT_MS));

tool('form_input',
  'Set the value of a form field by ref: text inputs/textareas (replaces content), <select> (option value or visible text; array for multi-select), checkboxes/radios (true/false).',
  { tabId, ref, value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]) });

tool('javascript_exec',
  'Run JavaScript in the page (content-script context: full DOM access; page globals are reachable through window.wrappedJSObject). ' +
  'The value of the last expression is returned, as JSON when possible. Promises are awaited, so use an async IIFE for await: ' +
  '(async () => { ... return x; })(). Return plain data, not DOM nodes.',
  { tabId, code: z.string() });

tool('read_console_messages',
  'Read console messages (console.log/info/warn/error/debug), uncaught errors and failed resource loads captured on the current page since it loaded.',
  {
    tabId,
    pattern: z.string().optional().describe('Case-insensitive regex filter on the message text'),
    onlyErrors: z.boolean().optional(),
    clear: z.boolean().optional().describe('Clear the buffer after reading'),
    limit: z.number().int().optional().describe('Max messages (default 100, most recent)'),
  });

tool('read_network_requests',
  'List the HTTP requests made by a tab (method, status, type, URL), most recent last. Bodies are not captured.',
  {
    tabId,
    urlPattern: z.string().optional().describe('Substring filter on the URL'),
    clear: z.boolean().optional().describe('Clear the buffer after reading'),
    limit: z.number().int().optional().describe('Max requests (default 100, most recent)'),
  });

tool('resize_window',
  'Resize the browser window containing the tab (outer size in pixels). Returns the resulting viewport size.',
  { tabId, width: z.number().int(), height: z.number().int() });

// ---------------------------------------------------------------------------

await listen();
await server.connect(new StdioServerTransport());
