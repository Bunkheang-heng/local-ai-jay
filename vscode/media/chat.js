// Chat UI inside the VS Code webview. All network calls go through the extension host.
import { renderMarkdown } from './markdown.js';
import { createModelMenu } from './model-menu.js';

const vscode = acquireVsCodeApi();
const MAX_CHATS = 60;

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}

// Constant SVG markup only (never user content).
const ICONS = {
  spark: '<svg viewBox="0 0 24 24" class="fill"><path d="M12 2.5l7.5 9.5-7.5 9.5-7.5-9.5z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  history: '<svg viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4v4h4"/><path d="M12 8v4l3 2"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4.5V11h-6.5"/></svg>',
  insert: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24" class="fill"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
};
function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = ICONS[name];
  return t.content.firstChild;
}
function iconBtn(name, label, onclick, cls = 'icon-btn') {
  return el('button', { class: cls, type: 'button', title: label, 'aria-label': label, onclick }, icon(name));
}

// ---------------- state ----------------
const S = {
  chats: [],
  currentId: null,
  model: 'auto',
  models: [],
  status: null, // { ok, reason, message, version }
  starting: false,
  context: null, // { short, lines, hasSelection }
  attachOverride: null, // null = automatic (on when there's a selection)
  view: 'chat', // 'chat' | 'history'
  streaming: null, // { id, chatId, answer, reasoning, model, t0, usage, nodes }
  notice: null,
};
const current = () => S.chats.find((c) => c.id === S.currentId) || null;
const attachOn = () => !!S.context && (S.attachOverride ?? S.context.hasSelection);

function save() {
  S.chats.sort((a, b) => b.updated - a.updated);
  S.chats = S.chats.slice(0, MAX_CHATS);
  vscode.postMessage({ type: 'saveChats', chats: S.chats, currentId: S.currentId });
}
const titleFrom = (text) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > 60 ? `${t.slice(0, 57)}…` : t; };
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------------- layout ----------------
const root = document.getElementById('root');
const header = el('header', { class: 'header' });
const banner = el('div', { class: 'banner', hidden: true });
const thread = el('div', { class: 'thread' });
const threadInner = el('div', { class: 'thread-inner' });
thread.append(threadInner);
const welcome = el('div', { class: 'welcome' },
  el('div', { class: 'welcome-mark' }, icon('spark')),
  el('h1', { text: 'How can I help?' }),
  el('p', { class: 'muted', text: 'Select code in the editor to ask about it, or just start typing.' }));
const historyPanel = el('div', { class: 'history', hidden: true });

const input = el('textarea', { rows: 1, placeholder: 'Ask anything…', 'aria-label': 'Message' });
const ctxChip = el('button', { class: 'ctx-chip', type: 'button' });
const modelMenu = createModelMenu({
  align: 'left',
  onChange(id) {
    S.model = id;
    vscode.postMessage({ type: 'setModel', model: id });
    input.focus();
  },
});
const sendBtn = el('button', { class: 'send-btn', type: 'submit', title: 'Send (Enter)', 'aria-label': 'Send', disabled: true }, icon('up'));
const stopBtn = el('button', { class: 'send-btn stop', type: 'button', title: 'Stop (Esc)', 'aria-label': 'Stop', hidden: true }, icon('stop'));
const form = el('form', { class: 'composer' },
  el('div', { class: 'ctx-row' }, ctxChip),
  input,
  el('div', { class: 'composer-row' },
    modelMenu.root,
    el('span', { class: 'spacer' }),
    sendBtn, stopBtn));
const composerWrap = el('div', { class: 'composer-wrap' }, form);

const main = el('div', { class: 'main' }, banner, thread, welcome, composerWrap);
root.append(header, main, historyPanel);

function renderHeader() {
  header.textContent = '';
  if (S.view === 'history') {
    header.append(iconBtn('back', 'Back to chat', () => setView('chat')), el('div', { class: 'header-title', text: 'Chats' }));
    return;
  }
  header.append(
    el('div', { class: 'header-title', text: current()?.title || 'New chat' }),
    iconBtn('history', 'Chat history', () => setView('history')),
    iconBtn('plus', 'New chat', newChat),
    iconBtn('globe', 'Open the local-ai-jay console', () => vscode.postMessage({ type: 'openConsole' })),
  );
}

function setView(v) {
  S.view = v;
  historyPanel.hidden = v !== 'history';
  main.hidden = v === 'history';
  renderHeader();
  if (v === 'history') renderHistory();
  else input.focus();
}

function renderHistory() {
  historyPanel.textContent = '';
  const list = S.chats.filter((c) => c.messages.length);
  if (!list.length) { historyPanel.append(el('p', { class: 'muted empty-note', text: 'No chats yet.' })); return; }
  const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  for (const c of list) {
    const row = el('div', { class: `hist${c.id === S.currentId ? ' active' : ''}` },
      el('button', { class: 'hist-open', type: 'button', onclick: () => { openChat(c.id); setView('chat'); } },
        el('span', { class: 'hist-title', text: c.title || 'Untitled' }),
        el('span', { class: 'hist-date', text: fmt.format(new Date(c.updated)) })),
      iconBtn('trash', 'Delete', () => {
        if (S.streaming?.chatId === c.id) stop();
        S.chats = S.chats.filter((x) => x.id !== c.id);
        if (S.currentId === c.id) S.currentId = null;
        save();
        renderHistory();
        renderThread();
      }, 'icon-btn hist-del'));
    historyPanel.append(row);
  }
}

function renderBanner() {
  const st = S.status;
  banner.textContent = '';
  if (S.notice) {
    banner.hidden = false;
    banner.className = 'banner info';
    banner.append(el('div', { class: 'banner-text', text: S.notice }), iconBtn('close', 'Dismiss', () => { S.notice = null; renderBanner(); }));
    return;
  }
  if (!st || st.ok) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.className = 'banner warn';
  const actions = el('div', { class: 'banner-actions' });
  if (S.starting) {
    banner.append(el('div', { class: 'banner-text' }, el('strong', { text: 'Starting local-ai-jay…' }), el('div', { class: 'muted', text: 'Watch the terminal below. This takes a few seconds the first time.' })));
    return;
  }
  if (st.reason === 'bad_key') {
    actions.append(el('button', { class: 'btn primary', type: 'button', text: 'Open settings', onclick: () => vscode.postMessage({ type: 'openSettings' }) }));
  } else {
    actions.append(el('button', { class: 'btn primary', type: 'button', text: 'Start local-ai-jay', onclick: () => { S.starting = true; renderBanner(); vscode.postMessage({ type: 'startGateway' }); } }));
  }
  actions.append(el('button', { class: 'btn', type: 'button', text: 'Retry', onclick: () => vscode.postMessage({ type: 'refresh' }) }));
  banner.append(el('div', { class: 'banner-text' },
    el('strong', { text: st.reason === 'bad_key' ? 'Key not accepted' : 'Not connected' }),
    el('div', { class: 'muted', text: st.message })), actions);
}

function renderModels() {
  modelMenu.setModels(S.models);
  // Keep a saved choice while disconnected; once models are known, fall back to auto if it's gone.
  if (S.models.length && !S.models.some((m) => m.id === S.model)) {
    S.model = S.models.some((m) => m.id === 'auto') ? 'auto' : S.models[0].id;
  }
  modelMenu.setValue(S.model);
}

function renderContext() {
  ctxChip.textContent = '';
  ctxChip.hidden = !S.context;
  if (!S.context) return;
  const on = attachOn();
  ctxChip.classList.toggle('on', on);
  ctxChip.title = on ? 'This will be sent with your message. Click to leave it out.' : 'Click to include this file with your message.';
  ctxChip.append(icon('file'), el('span', { text: S.context.hasSelection ? `${S.context.short}:${S.context.lines}` : S.context.short }));
  if (!on) ctxChip.append(el('span', { class: 'ctx-off', text: 'not included' }));
}
ctxChip.addEventListener('click', () => { S.attachOverride = !attachOn(); renderContext(); input.focus(); });

// ---------------- messages ----------------
let stick = true;
thread.addEventListener('scroll', () => { stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60; });
const scrollDown = (force) => { if (force) stick = true; if (stick) thread.scrollTop = thread.scrollHeight; };

function flash(btn, label) {
  btn.replaceChildren(icon('check'), ...(label ? [' Copied'] : []));
  setTimeout(() => btn.replaceChildren(icon('copy'), ...(label ? [` ${label}`] : [])), 1300);
}
function copyText(text, btn, label) { vscode.postMessage({ type: 'copy', text }); if (btn) flash(btn, label); }

const codeActions = (lang, code) => {
  const insert = el('button', { class: 'code-act', type: 'button', title: 'Insert at cursor' }, icon('insert'), ' Insert');
  insert.addEventListener('click', () => vscode.postMessage({ type: 'insert', code }));
  const copy = el('button', { class: 'code-act', type: 'button', title: 'Copy' }, icon('copy'), ' Copy');
  copy.addEventListener('click', () => copyText(code, copy, 'Copy'));
  return [insert, copy];
};
const md = (target, text) => renderMarkdown(target, text, { codeActions });

function metaText(m) {
  const bits = [m.model];
  if (m.stopped) bits.push('stopped');
  else if (m.secs != null) bits.push(`${m.secs}s`);
  if (m.usage) bits.push(`${m.usage.prompt_tokens} in / ${m.usage.completion_tokens} out`);
  return bits.filter(Boolean).join(' · ');
}

function reasoningBlock(text, open) {
  const body = el('div', { class: 'reasoning-body', text });
  const d = el('details', { class: 'reasoning' }, el('summary', {}, icon('chevron'), 'Thinking'), body);
  d.open = !!open;
  return { node: d, body };
}

function userView(m) {
  const wrap = el('div', { class: 'msg user' });
  if (m.attachment) wrap.append(el('div', { class: 'attach' }, icon('file'), el('span', { text: m.attachment })));
  wrap.append(el('div', { class: 'bubble', text: m.content }));
  return wrap;
}

function assistantView(m, isLast) {
  const wrap = el('div', { class: 'msg assistant' });
  if (m.reasoning) wrap.append(reasoningBlock(m.reasoning).node);
  const bubble = el('div', { class: 'bubble' });
  md(bubble, m.content || (m.stopped ? '' : '(empty reply)'));
  wrap.append(bubble);
  const copy = iconBtn('copy', 'Copy', () => copyText(m.content, copy), 'act');
  const actions = el('div', { class: 'msg-actions' }, copy);
  if (isLast) actions.append(iconBtn('retry', 'Retry', retry, 'act'));
  actions.append(el('span', { class: 'meta', text: metaText(m) }));
  wrap.append(actions);
  return wrap;
}

function renderThread() {
  const c = current();
  const msgs = c?.messages || [];
  threadInner.textContent = '';
  const lastIdx = msgs.length && msgs[msgs.length - 1].role === 'assistant' ? msgs.length - 1 : -1;
  msgs.forEach((m, i) => threadInner.append(m.role === 'user' ? userView(m) : assistantView(m, i === lastIdx)));
  if (c?.error) {
    const again = el('button', { class: 'btn small', type: 'button', onclick: retry }, icon('retry'), ' Retry');
    threadInner.append(el('div', { class: 'msg assistant error' }, el('div', { class: 'bubble', text: c.error }), el('div', { class: 'msg-actions' }, again)));
  }
  if (S.streaming && S.streaming.chatId === c?.id) threadInner.append(S.streaming.nodes.wrap);
  const empty = !msgs.length && !S.streaming;
  main.classList.toggle('is-empty', empty);
  welcome.hidden = !empty;
  thread.hidden = empty;
  input.placeholder = empty ? 'Ask anything…' : 'Reply…';
  renderHeader();
  requestAnimationFrame(() => scrollDown(true));
}

// ---------------- chat actions ----------------
function newChat() {
  if (S.streaming) stop();
  S.currentId = null;
  save();
  setView('chat');
  renderThread();
  input.focus();
}

function openChat(id) {
  if (S.streaming && S.streaming.chatId !== id) stop();
  S.currentId = id;
  save();
  renderThread();
}

function stop() {
  if (S.streaming) vscode.postMessage({ type: 'stop', id: S.streaming.id });
}

function submit(text, attach) {
  text = text.trim();
  if (!text || S.streaming) return;
  let c = current();
  if (!c) {
    c = { id: newId('c'), title: '', messages: [], updated: Date.now() };
    S.chats.unshift(c);
    S.currentId = c.id;
  }
  delete c.error;
  if (c.messages.length && c.messages[c.messages.length - 1].role === 'user') c.messages.pop();
  if (!c.title) c.title = titleFrom(text);
  c.messages.push({ role: 'user', content: text });
  c.updated = Date.now();
  input.value = '';
  autosize();
  syncSend();
  generate(c, attach);
}

function retry() {
  const c = current();
  if (!c || S.streaming) return;
  delete c.error;
  if (c.messages[c.messages.length - 1]?.role === 'assistant') c.messages.pop();
  if (!c.messages.length) return;
  generate(c, false);
}

function generate(c, attach) {
  const id = newId('r');
  const bubble = el('div', { class: 'bubble' }, el('div', { class: 'thinking' }, icon('spark')));
  const meta = el('span', { class: 'meta', text: S.model });
  const wrap = el('div', { class: 'msg assistant' }, bubble, el('div', { class: 'msg-actions' }, meta));
  S.streaming = { id, chatId: c.id, answer: '', reasoning: '', model: S.model, t0: performance.now(), usage: null, nodes: { wrap, bubble, meta, reasoning: null }, frame: 0 };
  save();
  renderThread();
  setBusy(true);
  const messages = c.messages.map((m) => ({ role: m.role, content: m.apiContent || m.content }));
  vscode.postMessage({ type: 'send', id, model: S.model, messages, attach });
  if (attach) S.attachOverride = null;
}

function paint() {
  const s = S.streaming;
  if (!s) return;
  s.frame = 0;
  if (s.reasoning) {
    if (!s.nodes.reasoning) { s.nodes.reasoning = reasoningBlock('', true); s.nodes.wrap.insertBefore(s.nodes.reasoning.node, s.nodes.bubble); }
    s.nodes.reasoning.body.textContent = s.reasoning;
  }
  if (s.answer) { md(s.nodes.bubble, s.answer); s.nodes.bubble.classList.add('streaming'); }
  s.nodes.meta.textContent = s.model;
  scrollDown();
}

function finish({ stopped, error }) {
  const s = S.streaming;
  if (!s) return;
  cancelAnimationFrame(s.frame);
  const c = S.chats.find((x) => x.id === s.chatId);
  S.streaming = null;
  setBusy(false);
  if (c) {
    if (s.answer || s.reasoning) {
      c.messages.push({
        role: 'assistant', content: s.answer, reasoning: s.reasoning || undefined, model: s.model,
        secs: stopped || error ? undefined : +((performance.now() - s.t0) / 1000).toFixed(1), usage: s.usage || undefined, stopped: stopped || !!error || undefined,
      });
    }
    if (error) c.error = error;
    c.updated = Date.now();
    save();
  }
  renderThread();
  input.focus();
}

function setBusy(busy) {
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
}

// ---------------- composer ----------------
function syncSend() { sendBtn.disabled = !input.value.trim(); }
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 220)}px`; }
input.addEventListener('input', () => { autosize(); syncSend(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.streaming) stop(); });
form.addEventListener('submit', (e) => { e.preventDefault(); submit(input.value, attachOn()); });
stopBtn.addEventListener('click', stop);

// ---------------- messages from the extension ----------------
window.addEventListener('message', ({ data: m }) => {
  const s = S.streaming;
  switch (m.type) {
    case 'init':
      S.chats = Array.isArray(m.chats) ? m.chats : [];
      S.currentId = S.chats.some((c) => c.id === m.currentId) ? m.currentId : null;
      S.model = m.model || 'auto';
      S.context = m.context;
      renderModels();
      renderContext();
      renderThread();
      break;
    case 'status':
      S.status = m.status;
      if (m.status.ok) S.starting = false;
      S.models = m.models || [];
      renderModels();
      renderBanner();
      break;
    case 'starting': S.starting = true; renderBanner(); break;
    case 'context':
      S.context = m.context;
      S.attachOverride = null;
      renderContext();
      break;
    case 'notice': S.notice = m.text; renderBanner(); break;
    case 'newChat': newChat(); break;
    case 'prefill':
      setView('chat');
      if (m.attach && S.context) S.attachOverride = true;
      renderContext();
      if (m.send) { newChat(); submit(m.text, !!m.attach && !!S.context); } else { input.value = m.text || input.value; autosize(); syncSend(); input.focus(); }
      break;
    case 'userContent': {
      const c = S.chats.find((x) => x.id === s?.chatId);
      const last = c?.messages[c.messages.length - 1];
      if (last?.role === 'user') { last.apiContent = m.content; last.attachment = m.attachment; save(); renderThread(); }
      break;
    }
    case 'delta':
      if (!s || s.id !== m.id) break;
      if (m.content) s.answer += m.content;
      if (m.reasoning) s.reasoning += m.reasoning;
      if (m.model) s.model = m.model;
      if (m.usage) s.usage = m.usage;
      if (!s.frame) s.frame = requestAnimationFrame(paint);
      break;
    case 'done': if (s && s.id === m.id) finish({ stopped: m.stopped }); break;
    case 'error': if (s && s.id === m.id) finish({ error: m.message }); break;
    default: break;
  }
});

renderHeader();
renderThread();
vscode.postMessage({ type: 'ready' });
