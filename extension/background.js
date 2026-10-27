// Background page: connects to the local MCP server(s) and executes tool calls.

const BASE_PORT = 8765;
const PORT_COUNT = 10;
const SCAN_INTERVAL_MS = 2000;
const MAX_SCREENSHOT_EDGE = 1568;
const MAX_SCREENSHOT_PIXELS = 1_150_000;
const MAX_NETWORK_ENTRIES = 1000;

const sockets = new Map();          // port -> WebSocket (connecting or open)
const claudeTabs = new Set();       // tabs opened through tabs_create
const screenshotScale = new Map();  // tabId -> CSS px per screenshot px
const network = new Map();          // tabId -> [{ ts, method, url, type, status, error }]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (s) => ({ content: [{ type: 'text', text: s }] });
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… [truncated, ${s.length - n} more chars]` : s);

// ---------------------------------------------------------------------------
// Connection to the MCP servers
// ---------------------------------------------------------------------------

function scan() {
  for (let port = BASE_PORT; port < BASE_PORT + PORT_COUNT; port++) {
    if (sockets.has(port)) continue;
    let ws;
    try { ws = new WebSocket(`ws://127.0.0.1:${port}`); } catch { continue; }
    sockets.set(port, ws);
    ws.onopen = updateBadge;
    ws.onclose = () => { sockets.delete(port); updateBadge(); };
    ws.onmessage = (ev) => onServerMessage(ws, ev);
  }
}

function connectedCount() {
  let n = 0;
  for (const ws of sockets.values()) if (ws.readyState === WebSocket.OPEN) n++;
  return n;
}

function updateBadge() {
  const n = connectedCount();
  browser.browserAction.setBadgeText({ text: n ? String(n) : '' });
  browser.browserAction.setBadgeBackgroundColor({ color: '#2e7d32' });
  browser.browserAction.setTitle({
    title: n ? `Claude in Firefox — connected to ${n} Claude session(s)` : 'Claude in Firefox — waiting for Claude Code',
  });
}

async function onServerMessage(ws, ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id == null || !msg.tool) return;
  let reply;
  try {
    const fn = tools[msg.tool];
    if (!fn) throw new Error(`Unknown tool: ${msg.tool}`);
    reply = { id: msg.id, result: await fn(msg.args || {}) };
  } catch (e) {
    reply = { id: msg.id, error: String((e && e.message) || e) };
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'status') {
    return Promise.resolve({
      connected: connectedCount(),
      ports: [...sockets].filter(([, ws]) => ws.readyState === WebSocket.OPEN).map(([p]) => p),
    });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeUrl(url) {
  url = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return 'https://' + url;
}

async function getTab(tabId) {
  if (typeof tabId !== 'number') throw new Error('tabId is required. Call tabs_context to list tabs.');
  try { return await browser.tabs.get(tabId); }
  catch { throw new Error(`Tab ${tabId} does not exist. Call tabs_context to list tabs.`); }
}

// Resolves once the tab has finished loading (or after `timeout`).
function waitForLoad(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    browser.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(finish, timeout);
    // Fallback in case the navigation was already complete or never fired an update.
    const poll = setInterval(() => {
      browser.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }, finish);
    }, 500);
  });
}

async function injectContent(tabId) {
  try {
    await browser.tabs.executeScript(tabId, { file: '/content.js', frameId: 0, runAt: 'document_idle' });
  } catch (e) {
    throw new Error(
      `Cannot access this page (${e.message}). Firefox does not let extensions script about: pages, ` +
      'addons.mozilla.org, the PDF viewer and other privileged pages.'
    );
  }
}

// Sends a request to the content script of the tab's top frame, injecting it if needed.
async function content(tabId, msg) {
  await getTab(tabId);
  let res;
  try {
    res = await browser.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch (e) {
    if (!/receiving end does not exist/i.test(e.message)) {
      // The page went away while handling the message (e.g. a click triggered a navigation).
      if (msg.mayNavigate) return { navigated: true };
      throw e;
    }
    await injectContent(tabId);
    res = await browser.tabs.sendMessage(tabId, msg, { frameId: 0 });
  }
  if (res && res.error) throw new Error(res.error);
  return res;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode the screenshot'));
    img.src = src;
  });
}

async function screenshot(tabId) {
  let tab = await getTab(tabId);
  if (!tab.active) {
    await browser.tabs.update(tabId, { active: true });
    await sleep(250);
    tab = await browser.tabs.get(tabId);
  }
  // scale: 1 => one image pixel per CSS pixel, independent of HiDPI.
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png', scale: 1 });
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth, h = img.naturalHeight;
  const factor = Math.min(1, MAX_SCREENSHOT_EDGE / Math.max(w, h), Math.sqrt(MAX_SCREENSHOT_PIXELS / (w * h)));
  const ow = Math.round(w * factor), oh = Math.round(h * factor);

  const canvas = document.createElement('canvas');
  canvas.width = ow;
  canvas.height = oh;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, ow, oh);
  const jpeg = canvas.toDataURL('image/jpeg', 0.85);

  let cssWidth = w;
  try { cssWidth = (await content(tabId, { type: 'viewport' })).width || w; } catch { /* privileged page */ }
  screenshotScale.set(tabId, cssWidth / ow);

  return {
    content: [
      { type: 'image', data: jpeg.slice(jpeg.indexOf(',') + 1), mimeType: 'image/jpeg' },
      { type: 'text', text: `Screenshot of tab ${tabId} (${ow}x${oh}) — ${tab.title} — ${tab.url}` },
    ],
  };
}

// ---------------------------------------------------------------------------
// Network log
// ---------------------------------------------------------------------------

function recordRequest(d) {
  if (d.tabId < 0) return;
  let list = network.get(d.tabId);
  if (!list) network.set(d.tabId, (list = []));
  list.push({ ts: d.timeStamp, method: d.method, url: d.url, type: d.type, status: d.statusCode, error: d.error });
  if (list.length > MAX_NETWORK_ENTRIES) list.splice(0, list.length - MAX_NETWORK_ENTRIES);
}

browser.webRequest.onCompleted.addListener(recordRequest, { urls: ['<all_urls>'] });
browser.webRequest.onErrorOccurred.addListener(recordRequest, { urls: ['<all_urls>'] });

browser.tabs.onRemoved.addListener((tabId) => {
  claudeTabs.delete(tabId);
  screenshotScale.delete(tabId);
  network.delete(tabId);
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const tools = {
  async tabs_context() {
    const tabs = await browser.tabs.query({});
    const lines = tabs.map((t) =>
      `- tabId ${t.id}${t.active ? ' (active)' : ''}${claudeTabs.has(t.id) ? ' [claude]' : ''} ` +
      `window ${t.windowId}: ${t.title || '(untitled)'} — ${t.url}`);
    return text(`${tabs.length} open tab(s):\n${lines.join('\n')}`);
  },

  async tabs_create({ url }) {
    const tab = await browser.tabs.create({ url: url ? normalizeUrl(url) : 'about:blank', active: true });
    claudeTabs.add(tab.id);
    if (url) await waitForLoad(tab.id);
    const t = await browser.tabs.get(tab.id);
    return text(`Created tab ${t.id}: ${t.title || '(untitled)'} — ${t.url}`);
  },

  async tabs_close({ tabId }) {
    await getTab(tabId);
    await browser.tabs.remove(tabId);
    return text(`Closed tab ${tabId}`);
  },

  async navigate({ tabId, url }) {
    await getTab(tabId);
    if (url === 'back') await browser.tabs.goBack(tabId);
    else if (url === 'forward') await browser.tabs.goForward(tabId);
    else await browser.tabs.update(tabId, { url: normalizeUrl(url) });
    await sleep(100);
    await waitForLoad(tabId);
    screenshotScale.delete(tabId);
    const t = await browser.tabs.get(tabId);
    return text(`Tab ${tabId} is now at ${t.url}\nTitle: ${t.title}`);
  },

  async read_page({ tabId, filter, ref_id, max_depth }) {
    const res = await content(tabId, { type: 'read_page', filter, ref: ref_id, maxDepth: max_depth });
    return text(res.text);
  },

  async find({ tabId, query }) {
    return text((await content(tabId, { type: 'find', query })).text);
  },

  async get_page_text({ tabId }) {
    return text((await content(tabId, { type: 'page_text' })).text);
  },

  async form_input({ tabId, ref, value }) {
    return text((await content(tabId, { type: 'form_input', ref, value })).text);
  },

  async computer(args) {
    const { tabId, action } = args;
    if (action === 'screenshot') return screenshot(tabId);
    if (action === 'wait') {
      const s = Math.max(0, Math.min(Number(args.duration ?? 1), 30));
      await sleep(s * 1000);
      return text(`Waited ${s}s`);
    }
    const scale = screenshotScale.get(tabId) || 1;
    const toCss = (c) => (c ? { x: c[0] * scale, y: c[1] * scale } : null);
    const res = await content(tabId, {
      type: 'input',
      mayNavigate: true,
      action,
      point: toCss(args.coordinate),
      start: toCss(args.start_coordinate),
      ref: args.ref,
      text: args.text,
      modifiers: args.modifiers,
      direction: args.scroll_direction,
      amount: args.scroll_amount,
    });
    if (res && res.navigated) {
      await waitForLoad(tabId, 15000);
      screenshotScale.delete(tabId);
      const t = await browser.tabs.get(tabId);
      return text(`${action} done; the page navigated to ${t.url}`);
    }
    return text(res.text);
  },

  async javascript_exec({ tabId, code }) {
    await getTab(tabId);
    let results;
    try {
      results = await browser.tabs.executeScript(tabId, { code, frameId: 0 });
    } catch (e) {
      throw new Error(`JavaScript error: ${e.message}`);
    }
    const v = results ? results[0] : undefined;
    let out;
    if (v === undefined) out = 'undefined';
    else if (typeof v === 'string') out = v;
    else {
      try { out = JSON.stringify(v, null, 2); } catch { out = String(v); }
    }
    return text(clip(out, 50000));
  },

  async read_console_messages({ tabId, pattern, onlyErrors, clear, limit }) {
    return text((await content(tabId, { type: 'console', pattern, onlyErrors, clear, limit })).text);
  },

  async read_network_requests({ tabId, urlPattern, clear, limit = 100 }) {
    await getTab(tabId);
    let list = network.get(tabId) || [];
    if (urlPattern) list = list.filter((r) => r.url.includes(urlPattern));
    const shown = list.slice(-limit);
    if (clear) network.delete(tabId);
    if (!shown.length) return text('No network requests recorded for this tab.');
    const lines = shown.map((r) => {
      const time = new Date(r.ts).toISOString().slice(11, 23);
      const status = r.error ? `ERR ${r.error}` : r.status;
      return `[${time}] ${r.method} ${status} ${r.type} ${r.url}`;
    });
    return text(`${shown.length} of ${list.length} request(s):\n${lines.join('\n')}`);
  },

  async resize_window({ tabId, width, height }) {
    const tab = await getTab(tabId);
    await browser.windows.update(tab.windowId, { state: 'normal' });
    await browser.windows.update(tab.windowId, { width, height });
    await sleep(300);
    screenshotScale.delete(tabId);
    let viewport = '';
    try {
      const vp = await content(tabId, { type: 'viewport' });
      viewport = ` Viewport is now ${vp.width}x${vp.height} CSS px.`;
    } catch { /* privileged page */ }
    return text(`Window resized to ${width}x${height}.${viewport}`);
  },
};

updateBadge();
scan();
setInterval(scan, SCAN_INTERVAL_MS);
