// Content script (top frame): page tree with refs, synthesized input, console capture.
// Injected at document_start by the manifest, or on demand by the background page.

(() => {
  if (window.__claudeInFirefox) return;
  window.__claudeInFirefox = true;

  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // -------------------------------------------------------------------------
  // Console capture
  // -------------------------------------------------------------------------

  const MAX_LOGS = 1000;
  const logs = [];
  const pageWin = window.wrappedJSObject;

  function pushLog(level, msg) {
    logs.push({ level, text: clip(msg, 5000), ts: Date.now() });
    if (logs.length > MAX_LOGS) logs.shift();
  }

  function fmt(v) {
    try {
      if (v === null || typeof v !== 'object') return String(v);
      if (v.nodeType === 1) return `<${String(v.tagName).toLowerCase()}>`;
      if ('message' in v && 'stack' in v) return `${v.name}: ${v.message}`;
      const json = pageWin.JSON.stringify(v);
      return json === undefined ? String(v) : json;
    } catch {
      try { return String(v); } catch { return '[unserializable]'; }
    }
  }

  try {
    const pageConsole = pageWin.console;
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const original = pageConsole[level];
      exportFunction(function (...args) {
        try { pushLog(level, args.map(fmt).join(' ')); } catch { /* never break the page */ }
        // Pass arguments one by one: the page may not read a content-script array (args.length).
        return original.call(pageConsole, ...args);
      }, pageConsole, { defineAs: level });
    }
  } catch { /* console hook unavailable */ }

  window.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && t.tagName) {
      pushLog('error', `Failed to load <${t.tagName.toLowerCase()}> ${t.currentSrc || t.src || t.href || ''}`);
    } else {
      pushLog('error', `Uncaught ${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
    }
  }, true);
  window.addEventListener('unhandledrejection', (e) => pushLog('error', `Unhandled promise rejection: ${fmt(e.reason)}`));

  function readConsole({ pattern, onlyErrors, clear, limit = 100 }) {
    const re = pattern ? new RegExp(pattern, 'i') : null;
    const matching = logs.filter((m) => (!onlyErrors || m.level === 'error') && (!re || re.test(m.text)));
    const shown = matching.slice(-limit);
    if (clear) logs.length = 0;
    if (!shown.length) return 'No console messages captured on this page.';
    const lines = shown.map((m) => `[${new Date(m.ts).toISOString().slice(11, 23)}] [${m.level}] ${m.text}`);
    return `${shown.length} of ${matching.length} message(s):\n${lines.join('\n')}`;
  }

  // -------------------------------------------------------------------------
  // Element refs
  // -------------------------------------------------------------------------

  const refToEl = new Map();
  const elToRef = new WeakMap();
  let refSeq = 0;

  function refOf(el) {
    let r = elToRef.get(el);
    if (!r) {
      r = `ref_${++refSeq}`;
      elToRef.set(el, r);
      refToEl.set(r, new WeakRef(el));
    }
    return r;
  }

  function elOf(ref) {
    const el = refToEl.get(ref)?.deref();
    if (!el || !el.isConnected) {
      throw new Error(`Element ${ref} no longer exists (the page changed). Call read_page or find again.`);
    }
    return el;
  }

  // -------------------------------------------------------------------------
  // Roles, names, visibility
  // -------------------------------------------------------------------------

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BASE']);
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider',
    'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
  ]);
  const NAME_FROM_CONTENT = new Set([
    'button', 'link', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
    'treeitem', 'switch', 'checkbox', 'radio', 'cell', 'columnheader', 'rowheader', 'tooltip',
  ]);
  const GENERIC = new Set(['generic', 'presentation', 'none', 'group', 'paragraph', 'listitem', 'list']);
  const TAG_ROLES = {
    BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img', H1: 'heading', H2: 'heading',
    H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', NAV: 'navigation', MAIN: 'main',
    HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form', TABLE: 'table',
    TR: 'row', TH: 'columnheader', TD: 'cell', UL: 'list', OL: 'list', LI: 'listitem', DIALOG: 'dialog',
    OPTION: 'option', SUMMARY: 'button', IFRAME: 'iframe', VIDEO: 'video', AUDIO: 'audio', P: 'paragraph',
    LABEL: 'label', FIELDSET: 'group', PROGRESS: 'progressbar',
  };
  const INPUT_ROLES = {
    checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button',
    image: 'button', range: 'slider', number: 'spinbutton', search: 'searchbox', hidden: null,
  };

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return type in INPUT_ROLES ? INPUT_ROLES[type] : 'textbox';
    }
    if (tag === 'SELECT' && (el.multiple || el.size > 1)) return 'listbox';
    if (tag === 'svg') return el.getAttribute('aria-label') || el.querySelector(':scope > title') ? 'img' : null;
    if (TAG_ROLES[tag]) return TAG_ROLES[tag];
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    return null;
  }

  function nameOf(el, role) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return squash(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = squash(labelledBy.split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent || '').join(' '));
      if (t) return t;
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.labels && el.labels.length) {
        const t = squash([...el.labels].map((l) => l.innerText).join(' '));
        if (t) return t;
      }
      if (['submit', 'button', 'reset'].includes(el.type) && el.value) return el.value;
      if (el.type === 'image' && el.alt) return el.alt;
      const ph = el.getAttribute('placeholder');
      if (ph) return ph;
    }
    if (tag === 'IMG' || tag === 'AREA') {
      const alt = el.getAttribute('alt');
      if (alt) return squash(alt);
    }
    if (tag === 'svg') {
      const t = el.querySelector(':scope > title');
      if (t) return squash(t.textContent);
    }
    if (NAME_FROM_CONTENT.has(role) || tag === 'LABEL') {
      const t = squash(el.innerText);
      if (t) return t;
    }
    return squash(el.getAttribute('title') || '');
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0 && !SKIP_TAGS.has(el.tagName)) return true;
    // Framework-rendered clickables (div/span with JS handlers) usually show a pointer cursor.
    if (!role || GENERIC.has(role) || role === 'img') {
      if (getComputedStyle(el).cursor === 'pointer') {
        const parent = el.parentElement;
        return !parent || getComputedStyle(parent).cursor !== 'pointer';
      }
    }
    return false;
  }

  // false => the element and its whole subtree are not rendered (display:none etc.)
  function rendered(el) {
    return el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0;
  }

  // true => the element itself is visible on the page (it may still be scrolled out of view)
  function shown(el) {
    if (el.tagName === 'OPTION') return true;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function childNodesOf(node) {
    const root = node.openOrClosedShadowRoot || node.shadowRoot;
    return root ? [...root.childNodes, ...node.childNodes] : [...node.childNodes];
  }

  function describe(el, role, name, interactive) {
    const tag = el.tagName;
    // Clickable divs/spans have no accessible name: show their text instead.
    if (!name && interactive && !isEditable(el) && tag !== 'SELECT') name = squash(el.innerText);
    let s = role || tag.toLowerCase();
    if (name) s += ` "${clip(name, 120)}"`;
    s += ` [${refOf(el)}]`;
    const attrs = [];
    if (role === 'heading' && /^H\d$/.test(tag)) attrs.push(`level=${tag[1]}`);
    if (tag === 'A' && el.hasAttribute('href')) attrs.push(`href="${clip(el.getAttribute('href'), 150)}"`);
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (!['text', 'checkbox', 'radio', 'submit', 'button'].includes(type)) attrs.push(`type=${type}`);
      if (type === 'checkbox' || type === 'radio') attrs.push(el.checked ? 'checked' : 'unchecked');
      else if (type !== 'password' && el.value && !['submit', 'button', 'reset'].includes(type)) {
        attrs.push(`value="${clip(el.value, 100)}"`);
      }
    }
    if (tag === 'TEXTAREA' && el.value) attrs.push(`value="${clip(squash(el.value), 100)}"`);
    if (tag === 'SELECT') {
      const sel = [...el.selectedOptions].map((o) => squash(o.text)).join(', ');
      attrs.push(`value="${clip(sel, 100)}"`);
    }
    if (tag === 'OPTION' && el.selected) attrs.push('selected');
    for (const a of ['aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed']) {
      const v = el.getAttribute(a);
      if (v !== null) attrs.push(`${a.slice(5)}=${v}`);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') attrs.push('disabled');
    if (el.isContentEditable && role === 'textbox' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      attrs.push(`value="${clip(squash(el.innerText), 100)}"`);
    }
    return attrs.length ? `${s} ${attrs.join(' ')}` : s;
  }

  // -------------------------------------------------------------------------
  // read_page / find / page text
  // -------------------------------------------------------------------------

  function readPage({ filter = 'all', ref, maxDepth = 30, maxChars = 40000 }) {
    const lines = [];
    let chars = 0;
    let truncated = false;
    const push = (depth, s) => {
      if (truncated) return;
      const line = '  '.repeat(depth) + s;
      chars += line.length + 1;
      if (chars > maxChars) { truncated = true; return; }
      lines.push(line);
    };

    function walk(node, depth, inNamed) {
      if (depth > maxDepth) return;
      for (const child of childNodesOf(node)) {
        if (truncated) return;
        if (child.nodeType === Node.TEXT_NODE) {
          if (filter !== 'all' || inNamed) continue;
          const t = squash(child.data);
          const parent = child.parentElement;
          if (t && parent && shown(parent)) push(depth, `text "${clip(t, 300)}"`);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const el = child;
        if (SKIP_TAGS.has(el.tagName) || el.getAttribute('aria-hidden') === 'true' || !rendered(el)) continue;
        const role = roleOf(el);
        const visible = shown(el);
        const interactive = visible && isInteractive(el, role);
        const include = visible && (filter === 'interactive' ? interactive : interactive || (role && !GENERIC.has(role)));
        const isLeaf = el.tagName === 'svg' || el.tagName === 'IFRAME' || el.tagName === 'SELECT';
        if (include) {
          const name = nameOf(el, role);
          push(depth, describe(el, role, name, interactive));
          const namedByContent = NAME_FROM_CONTENT.has(role) || (!name && interactive);
          if (!isLeaf) walk(el, depth + 1, inNamed || namedByContent);
        } else if (!(el instanceof SVGElement)) {
          walk(el, depth, inNamed);
        }
      }
    }

    let header = `Page: ${document.title}\nURL: ${location.href}\n`;
    if (ref) {
      const root = elOf(ref);
      push(0, describe(root, roleOf(root), nameOf(root, roleOf(root))));
      walk(root, 1, false);
    } else {
      header += `Viewport: ${innerWidth}x${innerHeight}, scrolled to (${Math.round(scrollX)}, ${Math.round(scrollY)}) ` +
        `of ${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}\n`;
      walk(document.body || document.documentElement, 0, false);
    }
    if (truncated) lines.push(`… [truncated at ${maxChars} chars: use filter="interactive" or ref_id to narrow down]`);
    if (!lines.length) lines.push('(no matching elements)');
    return `${header}\n${lines.join('\n')}`;
  }

  function find(query, limit = 20) {
    const terms = squash(query).toLowerCase().split(' ').filter(Boolean);
    if (!terms.length) throw new Error('Empty query');
    const hits = [];
    (function walk(node) {
      for (const el of childNodesOf(node)) {
        if (el.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(el.tagName) || !rendered(el)) continue;
        if (shown(el)) {
          const role = roleOf(el);
          const interactive = isInteractive(el, role);
          if (interactive || (role && !GENERIC.has(role))) {
            const name = nameOf(el, role);
            const hay = [role, name, el.tagName, el.id, el.getAttribute('name'), el.getAttribute('placeholder'),
              el.getAttribute('type'), typeof el.className === 'string' ? el.className : '',
              role && NAME_FROM_CONTENT.has(role) ? '' : clip(squash(el.innerText), 200)].join(' ').toLowerCase();
            const score = terms.filter((t) => hay.includes(t)).length;
            if (score) hits.push({ el, role, name, interactive, score: score + (interactive ? 0.5 : 0) });
          }
        }
        if (!(el instanceof SVGElement)) walk(el);
      }
    })(document.body || document.documentElement);
    hits.sort((a, b) => b.score - a.score);
    if (!hits.length) return `No element matches "${query}". Try other words, or read_page.`;
    return hits.slice(0, limit).map((h) => describe(h.el, h.role, h.name, h.interactive)).join('\n');
  }

  function pageText(maxChars = 100000) {
    const body = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    const t = body.length > maxChars ? body.slice(0, maxChars) + `\n… [truncated, ${body.length - maxChars} more chars]` : body;
    return `Title: ${document.title}\nURL: ${location.href}\n\n${t}`;
  }

  // -------------------------------------------------------------------------
  // Synthesized input
  // -------------------------------------------------------------------------

  const FOCUSABLE = 'a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]:not([contenteditable="false"])';
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', '']);

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function deepFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function label(el) {
    const role = roleOf(el);
    const name = nameOf(el, role);
    return `<${el.tagName.toLowerCase()}${role ? ` role=${role}` : ''}${name ? ` "${clip(name, 60)}"` : ''}>`;
  }

  function resolveTarget(ref, point) {
    if (ref) {
      const el = elOf(ref);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { el, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    if (!point) throw new Error('Provide either `coordinate` or `ref`.');
    const el = deepFromPoint(point.x, point.y);
    if (!el) throw new Error(`No element at (${Math.round(point.x)}, ${Math.round(point.y)}): outside the viewport?`);
    return { el, x: point.x, y: point.y };
  }

  function parseModifiers(spec) {
    const mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    for (const m of (spec || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)) {
      if (m === 'ctrl' || m === 'control') mods.ctrlKey = true;
      else if (m === 'shift') mods.shiftKey = true;
      else if (m === 'alt' || m === 'option') mods.altKey = true;
      else if (m === 'meta' || m === 'cmd' || m === 'command' || m === 'super' || m === 'win') mods.metaKey = true;
    }
    return mods;
  }

  function mouse(el, type, x, y, mods, extra = {}) {
    const isPointer = type.startsWith('pointer');
    const init = {
      bubbles: !type.endsWith('enter') && !type.endsWith('leave'),
      cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x + window.mozInnerScreenX, screenY: y + window.mozInnerScreenY,
      button: 0, buttons: 0, detail: 0, ...mods, ...extra,
    };
    if (isPointer) Object.assign(init, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
    return el.dispatchEvent(isPointer ? new PointerEvent(type, init) : new MouseEvent(type, init));
  }

  function hover(el, x, y, mods) {
    for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      mouse(el, t, x, y, mods);
    }
  }

  function focusFor(el) {
    const f = el.closest(FOCUSABLE);
    if (f && !f.disabled) f.focus({ preventScroll: true });
    else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  }

  function click({ el, x, y }, mods, button = 0, count = 1) {
    const buttons = button === 2 ? 2 : button === 1 ? 4 : 1;
    hover(el, x, y, mods);
    for (let i = 1; i <= count; i++) {
      mouse(el, 'pointerdown', x, y, mods, { button, buttons, detail: i });
      const notPrevented = mouse(el, 'mousedown', x, y, mods, { button, buttons, detail: i });
      if (i === 1 && notPrevented) focusFor(el);
      mouse(el, 'pointerup', x, y, mods, { button, detail: i });
      mouse(el, 'mouseup', x, y, mods, { button, detail: i });
      if (button === 0) mouse(el, 'click', x, y, mods, { button, detail: i });
      else if (button === 2) mouse(el, 'contextmenu', x, y, mods, { button, buttons, detail: i });
      else mouse(el, 'auxclick', x, y, mods, { button, detail: i });
    }
    if (button === 0 && count === 2) mouse(el, 'dblclick', x, y, mods, { detail: 2 });
  }

  function selectAllIn(el) {
    if (typeof el.select === 'function' && 'value' in el) { el.select(); return; }
    const block = el.closest('p, li, td, th, h1, h2, h3, h4, h5, h6, div, section, article') || el;
    const range = document.createRange();
    range.selectNodeContents(block);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function drag(from, to, mods) {
    const steps = 10;
    hover(from.el, from.x, from.y, mods);
    mouse(from.el, 'pointerdown', from.x, from.y, mods, { buttons: 1 });
    mouse(from.el, 'mousedown', from.x, from.y, mods, { buttons: 1 });
    const draggable = from.el.closest('[draggable="true"]');
    let dt = null;
    if (draggable) {
      dt = new DataTransfer();
      draggable.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: from.x, clientY: from.y }));
    }
    let over = from.el;
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      const el = deepFromPoint(x, y) || over;
      if (dt && el !== over) el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      over = el;
      mouse(el, 'pointermove', x, y, mods, { buttons: 1 });
      mouse(el, 'mousemove', x, y, mods, { buttons: 1 });
      if (dt) el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    }
    if (dt) {
      over.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: to.x, clientY: to.y }));
      draggable.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt, clientX: to.x, clientY: to.y }));
    }
    mouse(over, 'pointerup', to.x, to.y, mods);
    mouse(over, 'mouseup', to.x, to.y, mods);
  }

  // --- keyboard ---

  const KEYS = {
    enter: ['Enter', 'Enter', 13], return: ['Enter', 'Enter', 13], tab: ['Tab', 'Tab', 9],
    escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27], backspace: ['Backspace', 'Backspace', 8],
    delete: ['Delete', 'Delete', 46], space: [' ', 'Space', 32], up: ['ArrowUp', 'ArrowUp', 38],
    down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39],
    arrowup: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40],
    arrowleft: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39],
    home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33],
    pagedown: ['PageDown', 'PageDown', 34],
  };
  for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = [`F${i}`, `F${i}`, 111 + i];

  function keyInfo(name) {
    const k = KEYS[name.toLowerCase()];
    if (k) return { key: k[0], code: k[1], keyCode: k[2] };
    if (name.length === 1) {
      const up = name.toUpperCase();
      const letter = /[a-z]/i.test(name), digit = /\d/.test(name);
      return { key: name, code: letter ? `Key${up}` : digit ? `Digit${name}` : '', keyCode: letter || digit ? up.charCodeAt(0) : 0 };
    }
    return { key: name, code: name, keyCode: 0 };
  }

  function keyEvent(el, type, info, mods = {}) {
    const isPress = type === 'keypress';
    return el.dispatchEvent(new KeyboardEvent(type, {
      key: info.key, code: info.code, keyCode: isPress ? 0 : info.keyCode,
      charCode: isPress && info.key.length === 1 ? info.key.charCodeAt(0) : 0,
      bubbles: true, cancelable: true, composed: true, view: window, ...mods,
    }));
  }

  const isTextField = (el) => el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase()));
  const isEditable = (el) => el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !el.readOnly);

  function insertText(el, s) {
    if (document.execCommand('insertText', false, s)) return;
    if ('value' in el) {
      // Setting through the Xray wrapper hits the native setter, which React & co. detect as a real change.
      try {
        el.setRangeText(s, el.selectionStart, el.selectionEnd, 'end');
      } catch {
        el.value += s;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: s }));
    }
  }

  function deleteText(el, forward) {
    if (document.execCommand(forward ? 'forwardDelete' : 'delete')) return;
    if (!('value' in el)) return;
    try {
      let { selectionStart: a, selectionEnd: b } = el;
      if (a === b) { if (forward) b++; else a = Math.max(0, a - 1); }
      el.setRangeText('', a, b, 'end');
    } catch {
      el.value = forward ? el.value : el.value.slice(0, -1);
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: forward ? 'deleteContentForward' : 'deleteContentBackward' }));
  }

  function moveFocus(from, dir) {
    const all = [...document.querySelectorAll(FOCUSABLE)].filter((e) =>
      !e.disabled && Number(e.getAttribute('tabindex') ?? 0) >= 0 && shown(e));
    if (!all.length) return;
    const i = all.indexOf(from);
    const next = all[(i + dir + all.length) % all.length] || all[0];
    next.focus();
  }

  function enterDefault(el) {
    if (el.tagName === 'TEXTAREA') return insertText(el, '\n');
    if (el.isContentEditable) {
      if (!document.execCommand('insertParagraph')) insertText(el, '\n');
      return;
    }
    if (el.tagName === 'INPUT' && el.form) {
      const submitter = el.form.querySelector('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]');
      el.form.requestSubmit(submitter && !submitter.disabled ? submitter : undefined);
      return;
    }
    if (el.matches('a[href], button, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"]')) el.click();
  }

  function keyDefault(el, info, mods) {
    const k = info.key;
    const editable = isEditable(el);
    if (mods.ctrlKey || mods.metaKey) {
      const c = k.toLowerCase();
      if (c === 'a') selectAll(el);
      else if (c === 'c') document.execCommand('copy');
      else if (c === 'x' && editable) document.execCommand('cut');
      else if (c === 'z' && editable) document.execCommand(mods.shiftKey ? 'redo' : 'undo');
      else if (c === 'y' && editable) document.execCommand('redo');
      return;
    }
    if (mods.altKey) return;
    switch (k) {
      case 'Enter': return enterDefault(el);
      case 'Tab': return moveFocus(el, mods.shiftKey ? -1 : 1);
      case 'Backspace': if (editable) deleteText(el, false); return;
      case 'Delete': if (editable) deleteText(el, true); return;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (editable && 'selectionStart' in el) {
          try {
            const p = (k === 'ArrowLeft' ? el.selectionStart - 1 : el.selectionEnd + 1);
            const pos = Math.max(0, Math.min(el.value.length, p));
            el.setSelectionRange(pos, pos);
          } catch { /* input type without selection */ }
        } else if (!editable) window.scrollBy({ left: k === 'ArrowLeft' ? -40 : 40, behavior: 'instant' });
        return;
      case 'ArrowUp': case 'ArrowDown': case 'PageUp': case 'PageDown': case 'Home': case 'End': {
        if (editable) return;
        const page = innerHeight * 0.85;
        const dy = { ArrowUp: -40, ArrowDown: 40, PageUp: -page, PageDown: page }[k];
        if (dy !== undefined) window.scrollBy({ top: dy, behavior: 'instant' });
        else window.scrollTo({ top: k === 'Home' ? 0 : document.documentElement.scrollHeight, behavior: 'instant' });
        return;
      }
      case ' ':
        if (editable) insertText(el, ' ');
        else if (el.matches('button, summary, input[type="checkbox"], input[type="radio"], [role="button"], [role="checkbox"], [role="switch"]')) el.click();
        else window.scrollBy({ top: (mods.shiftKey ? -1 : 1) * innerHeight * 0.85, behavior: 'instant' });
        return;
      default:
        if (k.length === 1 && editable) insertText(el, mods.shiftKey ? k.toUpperCase() : k);
    }
  }

  function selectAll(el) {
    if (typeof el.select === 'function' && 'value' in el) el.select();
    else document.execCommand('selectAll');
  }

  function pressKeys(spec) {
    if (!spec || !spec.trim()) throw new Error('`text` must contain the key(s) to press, e.g. "Enter" or "ctrl+a".');
    for (const combo of spec.trim().split(/\s+/)) {
      const parts = combo.length > 1 ? combo.split('+') : [combo];
      const keyName = parts.pop() || '+';
      const mods = parseModifiers(parts.join('+'));
      const info = keyInfo(keyName);
      const el = deepActive() || document.body;
      if (keyEvent(el, 'keydown', info, mods)) {
        if (info.key.length === 1 || info.key === 'Enter') keyEvent(el, 'keypress', info, mods);
        keyDefault(el, info, mods);
      }
      keyEvent(deepActive() || document.body, 'keyup', info, mods);
    }
  }

  function typeText(text) {
    if (text == null || text === '') throw new Error('`text` is required for "type".');
    const el = deepActive();
    if (!el || el === document.body || el === document.documentElement || !isEditable(el)) {
      throw new Error('No editable element has focus. Click on the input first (or use form_input).');
    }
    if (text.length > 2000) { insertText(el, text); return; }
    for (const ch of text) {
      const info = ch === '\n' ? keyInfo('Enter') : keyInfo(ch);
      if (keyEvent(el, 'keydown', info)) {
        keyEvent(el, 'keypress', info);
        if (ch === '\n') enterDefault(el); else insertText(el, ch);
      }
      keyEvent(el, 'keyup', info);
    }
  }

  // --- scroll ---

  function scrollableAncestor(el, dx, dy) {
    for (let n = el; n && n !== document.body && n !== document.documentElement;
      n = n.parentElement || n.getRootNode().host) {
      const cs = getComputedStyle(n);
      if (dy && /(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight) return n;
      if (dx && /(auto|scroll|overlay)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth) return n;
    }
    return null;
  }

  function scroll({ ref, point, direction = 'down', amount = 3 }) {
    const px = Math.max(1, Number(amount) || 3) * 100;
    const dx = direction === 'left' ? -px : direction === 'right' ? px : 0;
    const dy = direction === 'up' ? -px : direction === 'down' ? px : 0;
    let el = null, x = innerWidth / 2, y = innerHeight / 2;
    if (ref) { el = elOf(ref); const r = el.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
    else if (point) { el = deepFromPoint(point.x, point.y); x = point.x; y = point.y; }
    el = el || document.scrollingElement || document.documentElement;
    const notPrevented = el.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, deltaX: dx, deltaY: dy, deltaMode: 0,
    }));
    if (!notPrevented) return 'Wheel event was handled by the page.';
    const target = scrollableAncestor(el, dx, dy);
    if (target) {
      target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      return `Scrolled ${label(target)} ${direction}; its position is now (${Math.round(target.scrollLeft)}, ${Math.round(target.scrollTop)}).`;
    }
    window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    return `Scrolled page ${direction}; position is now (${Math.round(scrollX)}, ${Math.round(scrollY)}) ` +
      `of ${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}.`;
  }

  function input(msg) {
    const mods = parseModifiers(msg.modifiers);
    const where = (t) => `${label(t.el)} at (${Math.round(t.x)}, ${Math.round(t.y)})`;
    switch (msg.action) {
      case 'left_click': { const t = resolveTarget(msg.ref, msg.point); click(t, mods); return `Clicked ${where(t)}`; }
      case 'right_click': { const t = resolveTarget(msg.ref, msg.point); click(t, mods, 2); return `Right-clicked ${where(t)}`; }
      case 'double_click': { const t = resolveTarget(msg.ref, msg.point); click(t, mods, 0, 2); return `Double-clicked ${where(t)}`; }
      case 'triple_click': {
        const t = resolveTarget(msg.ref, msg.point);
        click(t, mods, 0, 3);
        selectAllIn(t.el);
        return `Triple-clicked ${where(t)}`;
      }
      case 'hover': { const t = resolveTarget(msg.ref, msg.point); hover(t.el, t.x, t.y, mods); return `Hovered ${where(t)} (CSS :hover is not triggered by synthetic events)`; }
      case 'left_click_drag': {
        if (!msg.start || !msg.point) throw new Error('left_click_drag needs `start_coordinate` and `coordinate`.');
        const from = resolveTarget(null, msg.start);
        const to = resolveTarget(null, msg.point);
        drag(from, to, mods);
        return `Dragged from ${where(from)} to ${where(to)}`;
      }
      case 'type': typeText(msg.text); return `Typed ${msg.text.length} character(s) into ${label(deepActive())}`;
      case 'key': pressKeys(msg.text); return `Pressed ${msg.text}`;
      case 'scroll': return scroll(msg);
      case 'scroll_to': {
        if (!msg.ref) throw new Error('scroll_to needs `ref`.');
        const el = elOf(msg.ref);
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        return `Scrolled ${label(el)} into view`;
      }
      default: throw new Error(`Unknown action: ${msg.action}`);
    }
  }

  // -------------------------------------------------------------------------
  // form_input
  // -------------------------------------------------------------------------

  function formInput(ref, value) {
    const el = elOf(ref);
    const tag = el.tagName;
    const fire = () => {
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    };

    if (tag === 'SELECT') {
      const wanted = (Array.isArray(value) ? value : [value]).map((v) => String(v).trim());
      const matches = (o) => wanted.includes(o.value) || wanted.includes(squash(o.text));
      const hits = [...el.options].filter(matches);
      if (!hits.length) {
        throw new Error(`No option matches ${JSON.stringify(value)}. Options: ${[...el.options].map((o) => squash(o.text)).join(' | ')}`);
      }
      if (el.multiple) for (const o of el.options) o.selected = hits.includes(o);
      else hits[0].selected = true;
      fire();
      return `Selected ${hits.map((o) => `"${squash(o.text)}"`).join(', ')} in ${label(el)}`;
    }

    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      const want = value === true || ['true', 'on', '1', 'yes', 'checked'].includes(String(value).toLowerCase());
      if (el.checked !== want) el.click();
      return `${label(el)} is now ${el.checked ? 'checked' : 'unchecked'}`;
    }

    const str = String(value);
    if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll');
      if (!document.execCommand('insertText', false, str)) el.textContent = str;
      return `Set ${label(el)} to "${clip(str, 80)}"`;
    }

    if (!('value' in el)) throw new Error(`${label(el)} is not a form field.`);
    el.focus();
    if (isTextField(el) && str) {
      el.select();
      if (document.execCommand('insertText', false, str) && el.value === str) {
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return `Set ${label(el)} to "${clip(str, 80)}"`;
      }
    }
    el.value = str;
    fire();
    return `Set ${label(el)} to "${clip(str, 80)}"`;
  }

  // -------------------------------------------------------------------------
  // Message dispatch (never rejects: errors are returned as { error })
  // -------------------------------------------------------------------------

  function handle(msg) {
    switch (msg.type) {
      case 'ping': return { ok: true };
      case 'viewport': return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
      case 'read_page': return { text: readPage({ filter: msg.filter, ref: msg.ref, maxDepth: msg.maxDepth }) };
      case 'find': return { text: find(msg.query) };
      case 'page_text': return { text: pageText() };
      case 'form_input': return { text: formInput(msg.ref, msg.value) };
      case 'input': return { text: input(msg) };
      case 'console': return { text: readConsole(msg) };
      default: throw new Error(`Unknown request: ${msg.type}`);
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    try {
      return Promise.resolve(handle(msg));
    } catch (e) {
      return Promise.resolve({ error: String((e && e.message) || e) });
    }
  });
})();
