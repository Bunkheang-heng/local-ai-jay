// local-ai-jay console. Plain JS, no build step.
import { renderMarkdown as renderMd } from './markdown.js';
import { createModelMenu } from './model-menu.js';

const KEY_STORE = 'local-ai-jay.key';
const CHATS_STORE = 'local-ai-jay.chats';
const MAX_CHATS = 60;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

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

const store = {
  get(k, fallback = null) { try { const v = localStorage.getItem(k); return v == null ? fallback : v; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// Constant SVG markup only (never user content).
const ICONS = {
  copy: '<svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4.5V11h-6.5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 2.5l7.5 9.5-7.5 9.5-7.5-9.5z"/></svg>',
};
function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = ICONS[name];
  return t.content.firstChild;
}

// ---------------- key handling ----------------
let apiKey = null;
const initialHash = location.hash;
function readKey() {
  const m = location.hash.match(/key=([A-Za-z0-9_-]+)/);
  if (m) {
    store.set(KEY_STORE, m[1]);
    history.replaceState(null, '', location.pathname);
    return m[1];
  }
  return store.get(KEY_STORE);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) { showSignIn('That key was not accepted.'); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `${res.status} ${res.statusText}`);
  return data;
}

function showSignIn(message) {
  $('#signin').hidden = false;
  $('#app').hidden = true;
  const err = $('#signin-error');
  err.hidden = !message;
  err.textContent = message || '';
  setTimeout(() => $('#signin-key').focus(), 0);
}

$('#signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  apiKey = $('#signin-key').value.trim();
  try {
    await fetch('/api/info', { headers: { authorization: `Bearer ${apiKey}` } }).then((r) => { if (!r.ok) throw new Error(); });
    store.set(KEY_STORE, apiKey);
    $('#signin').hidden = true;
    $('#app').hidden = false;
    boot();
  } catch {
    showSignIn('That key was not accepted.');
  }
});

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

async function copy(text, quiet = false) {
  try { await navigator.clipboard.writeText(text); if (!quiet) toast('Copied'); return true; } catch { toast('Copy failed: select and copy by hand'); return false; }
}

function flashCopied(btn, label) {
  btn.textContent = '';
  btn.append(icon('check'));
  if (label) btn.append(' Copied');
  setTimeout(() => { btn.textContent = ''; btn.append(icon('copy')); if (label) btn.append(` ${label}`); }, 1400);
}

// ---------------- sidebar ----------------
const mobile = () => matchMedia('(max-width: 820px)').matches;
function setSidebar(open) {
  if (mobile()) {
    document.body.classList.toggle('sb-open', open);
    $('#scrim').hidden = !open;
  } else {
    document.body.classList.toggle('sb-closed', !open);
    store.set('local-ai-jay.sidebar', open ? 'open' : 'closed');
  }
}
if (store.get('local-ai-jay.sidebar') === 'closed') document.body.classList.add('sb-closed');
$('#sb-open').addEventListener('click', () => setSidebar(true));
$('#sb-collapse').addEventListener('click', () => setSidebar(false));
$('#scrim').addEventListener('click', () => setSidebar(false));
const closeOnMobile = () => { if (mobile()) setSidebar(false); };

// ---------------- tabs ----------------
const TAB_TITLES = { providers: 'Providers', usage: 'Usage', connect: 'Connect' };
let currentTab = 'playground';
function showTab(name) {
  currentTab = name;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  store.set('local-ai-jay.tab', name);
  updateTitle();
  renderRecents();
  if (name === 'providers') loadProviders();
  if (name === 'usage') loadUsage();
  if (name === 'connect') loadConnect();
  if (name === 'playground') { loadModels(); input.focus(); }
}
$$('.nav-item').forEach((b) => b.addEventListener('click', () => { showTab(b.dataset.tab); closeOnMobile(); }));

function updateTitle() {
  const t = currentTab === 'playground' ? (current()?.title || '') : TAB_TITLES[currentTab];
  $('#topbar-title').textContent = t;
  document.title = t ? `${t} · local-ai-jay` : 'local-ai-jay';
}

// ---------------- markdown ----------------
function codeCopy(lang, body) {
  const btn = el('button', { class: 'codeblock-copy', type: 'button' }, icon('copy'), ' Copy');
  btn.addEventListener('click', async () => { if (await copy(body, true)) flashCopied(btn, 'Copy'); });
  return [btn];
}
const renderMarkdown = (target, text) => renderMd(target, text, { codeActions: codeCopy });

// ---------------- chats (saved in this browser) ----------------
let chats = [];
let currentId = null;
let streaming = null; // { controller, chatId }
try { chats = JSON.parse(store.get(CHATS_STORE, '[]')); if (!Array.isArray(chats)) chats = []; } catch { chats = []; }
const current = () => chats.find((c) => c.id === currentId) || null;

function saveChats() {
  chats.sort((a, b) => b.updated - a.updated);
  chats = chats.slice(0, MAX_CHATS);
  while (!store.set(CHATS_STORE, JSON.stringify(chats)) && chats.length > 1) chats.pop();
}

function newChatObject() {
  return { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: '', messages: [], system: '', model: '', updated: Date.now() };
}

function renderRecents() {
  const box = $('#recents');
  box.textContent = '';
  const list = chats.filter((c) => c.messages.length);
  if (!list.length) { box.append(el('div', { class: 'recents-empty', text: 'Your chats will show up here.' })); return; }
  for (const c of list) {
    const del = el('button', { class: 'recent-del', type: 'button', 'aria-label': `Delete “${c.title}”`, title: 'Delete' }, icon('trash'));
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Delete “${c.title}”?`)) return;
      if (streaming?.chatId === c.id) streaming.controller.abort();
      chats = chats.filter((x) => x.id !== c.id);
      saveChats();
      if (currentId === c.id) startNewChat(); else renderRecents();
    });
    const open = el('button', { class: 'recent-open', type: 'button', text: c.title || 'Untitled', title: c.title });
    open.addEventListener('click', () => { openChat(c.id); closeOnMobile(); });
    box.append(el('div', { class: `recent${c.id === currentId && currentTab === 'playground' ? ' active' : ''}` }, open, del));
  }
}

function openChat(id) {
  if (streaming && streaming.chatId !== id) streaming.controller.abort();
  currentId = id;
  const c = current();
  store.set('local-ai-jay.current', id);
  $('#pg-system').value = c?.system || '';
  $('#pg-system').hidden = true;
  syncSystemChip();
  if (c?.model) setModel(c.model);
  if (currentTab !== 'playground') showTab('playground');
  renderThread();
  renderRecents();
  updateTitle();
  input.focus();
}

function startNewChat() {
  streaming?.controller.abort();
  currentId = null;
  store.del('local-ai-jay.current');
  $('#pg-system').value = '';
  $('#pg-system').hidden = true;
  syncSystemChip();
  if (currentTab !== 'playground') showTab('playground');
  renderThread();
  renderRecents();
  updateTitle();
  input.focus();
}
$('#pg-new').addEventListener('click', () => { startNewChat(); closeOnMobile(); });
$('#top-new').addEventListener('click', startNewChat);

// ---------------- chat view ----------------
const thread = $('#pg-log');
const inner = $('#thread-inner');
const input = $('#pg-input');
let stick = true;

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Up late? What are we working on?';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function scrollDown(force = false) {
  if (force) stick = true;
  if (stick) thread.scrollTop = thread.scrollHeight;
}
thread.addEventListener('scroll', () => {
  const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  stick = near;
  $('#to-bottom').hidden = near;
});
$('#to-bottom').addEventListener('click', () => { thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' }); });

function actionBtn(name, label, onClick) {
  const b = el('button', { class: 'act', type: 'button', 'aria-label': label, title: label }, icon(name));
  b.addEventListener('click', onClick);
  return b;
}
function copyBtn(getText) {
  const b = actionBtn('copy', 'Copy', async () => { if (await copy(getText(), true)) flashCopied(b); });
  return b;
}

function metaText(m) {
  const bits = [m.model];
  if (m.stopped) bits.push('stopped');
  else if (m.secs != null) bits.push(`${m.secs}s`);
  if (m.usage) bits.push(`${m.usage.prompt_tokens} in / ${m.usage.completion_tokens} out`);
  return bits.filter(Boolean).join(' · ');
}

function reasoningBlock(text, open = false) {
  const body = el('div', { class: 'reasoning-body', text });
  const d = el('details', { class: 'reasoning' }, el('summary', {}, icon('chevron'), 'Thinking'), body);
  d.open = open;
  return { node: d, body };
}

function userView(m, idx) {
  const bubble = el('div', { class: 'bubble', text: m.content });
  const wrap = el('div', { class: 'msg user' }, bubble);
  const edit = actionBtn('edit', 'Edit', () => startEdit(wrap, idx));
  wrap.append(el('div', { class: 'msg-actions' }, copyBtn(() => m.content), edit));
  return wrap;
}

function assistantView(m, isLast) {
  const bubble = el('div', { class: 'bubble' });
  renderMarkdown(bubble, m.content || (m.stopped ? '' : '(empty reply)'));
  const wrap = el('div', { class: 'msg assistant' });
  if (m.reasoning) wrap.append(reasoningBlock(m.reasoning).node);
  wrap.append(bubble);
  const actions = el('div', { class: 'msg-actions' }, copyBtn(() => m.content));
  if (isLast) actions.append(actionBtn('retry', 'Retry', () => retry()));
  actions.append(el('span', { class: 'meta', text: metaText(m) }));
  wrap.append(actions);
  return wrap;
}

function renderThread() {
  const c = current();
  const msgs = c?.messages || [];
  inner.textContent = '';
  const lastAssistant = msgs.length && msgs[msgs.length - 1].role === 'assistant' ? msgs.length - 1 : -1;
  msgs.forEach((m, idx) => inner.append(m.role === 'user' ? userView(m, idx) : assistantView(m, idx === lastAssistant)));
  const empty = !msgs.length;
  $('#tab-playground').classList.toggle('is-empty', empty);
  $('#pg-empty').hidden = !empty;
  $('#welcome-title').textContent = greeting();
  input.placeholder = empty ? 'How can I help you today?' : 'Reply…';
  syncSend();
  requestAnimationFrame(() => scrollDown(true));
}

function startEdit(wrap, idx) {
  if (streaming) return;
  const c = current();
  const ta = el('textarea', { 'aria-label': 'Edit message' });
  ta.value = c.messages[idx].content;
  const cancel = el('button', { class: 'btn small', type: 'button', text: 'Cancel' });
  const save = el('button', { class: 'btn small primary', type: 'button', text: 'Save & send' });
  const box = el('div', { class: 'edit-box' }, ta, el('div', { class: 'edit-actions' }, cancel, save));
  wrap.replaceChildren(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  cancel.addEventListener('click', renderThread);
  const submit = () => {
    const text = ta.value.trim();
    if (!text) return;
    c.messages = c.messages.slice(0, idx);
    c.messages.push({ role: 'user', content: text });
    if (idx === 0) c.title = titleFrom(text);
    c.updated = Date.now();
    saveChats();
    renderThread();
    generate();
  };
  save.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') renderThread();
  });
}

const titleFrom = (text) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > 60 ? `${t.slice(0, 57)}…` : t; };

// ---------------- composer ----------------
function syncSend() { $('#pg-send').disabled = !input.value.trim(); }
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 240)}px`; }
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#pg-form').requestSubmit(); }
});
input.addEventListener('input', () => { autosize(); syncSend(); });
$('#pg-stop').addEventListener('click', () => streaming?.controller.abort());

function syncSystemChip() { $('#pg-system-toggle').classList.toggle('on', !!$('#pg-system').value.trim()); }
$('#pg-system-toggle').addEventListener('click', () => { const s = $('#pg-system'); s.hidden = !s.hidden; (s.hidden ? input : s).focus(); });
$('#pg-system').addEventListener('input', () => {
  syncSystemChip();
  const c = current();
  if (c) { c.system = $('#pg-system').value; saveChats(); }
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); startNewChat(); }
  if (e.key === 'Escape' && streaming) streaming.controller.abort();
});

$('#pg-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || streaming) return;
  let c = current();
  if (!c) {
    c = newChatObject();
    c.system = $('#pg-system').value;
    chats.unshift(c);
    currentId = c.id;
    store.set('local-ai-jay.current', c.id);
  }
  // A question whose reply failed earlier is replaced by the new one.
  if (c.messages.length && c.messages[c.messages.length - 1].role === 'user') c.messages.pop();
  if (!c.title) c.title = titleFrom(text);
  c.messages.push({ role: 'user', content: text });
  c.updated = Date.now();
  saveChats();
  input.value = '';
  autosize();
  renderThread();
  renderRecents();
  updateTitle();
  generate();
});

function retry() {
  const c = current();
  if (!c || streaming) return;
  if (c.messages[c.messages.length - 1]?.role === 'assistant') c.messages.pop();
  saveChats();
  renderThread();
  generate();
}

function setBusy(busy) {
  $('#pg-send').hidden = busy;
  $('#pg-stop').hidden = !busy;
}

async function generate() {
  const c = current();
  if (!c || !c.messages.length) return;
  const model = modelMenu.value || 'auto';
  c.model = model;
  const system = (c.system || '').trim();
  const messages = [...(system ? [{ role: 'system', content: system }] : []), ...c.messages.map(({ role, content }) => ({ role, content }))];

  const bubble = el('div', { class: 'bubble' }, el('div', { class: 'thinking' }, icon('spark')));
  const meta = el('span', { class: 'meta', text: model });
  const wrap = el('div', { class: 'msg assistant' }, bubble, el('div', { class: 'msg-actions' }, meta));
  inner.append(wrap);
  scrollDown(true);

  const controller = new AbortController();
  streaming = { controller, chatId: c.id };
  setBusy(true);
  const t0 = performance.now();
  let answer = '';
  let reasoning = '';
  let usedModel = model;
  let usage = null;
  let reasoningView = null;
  let frame = 0;
  const paint = () => {
    frame = 0;
    if (reasoningView) reasoningView.body.textContent = reasoning;
    if (answer) { renderMarkdown(bubble, answer); bubble.classList.add('streaming'); }
    meta.textContent = usedModel;
    scrollDown();
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };

  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error?.message || `${res.status} ${res.statusText}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let o;
        try { o = JSON.parse(data); } catch { continue; }
        if (o.error) throw new Error(o.error.message);
        if (o.model) usedModel = o.model;
        if (o.usage) usage = o.usage;
        const d = o.choices?.[0]?.delta;
        if (d?.reasoning_content || d?.reasoning) {
          reasoning += d.reasoning_content || d.reasoning;
          if (!reasoningView) { reasoningView = reasoningBlock('', true); wrap.insertBefore(reasoningView.node, bubble); }
        }
        if (d?.content) answer += d.content;
        schedule();
      }
    }
    c.messages.push({ role: 'assistant', content: answer, reasoning: reasoning || undefined, model: usedModel, secs: +((performance.now() - t0) / 1000).toFixed(1), usage: usage || undefined });
  } catch (err) {
    cancelAnimationFrame(frame);
    if (err.name === 'AbortError') {
      if (answer || reasoning) c.messages.push({ role: 'assistant', content: answer, reasoning: reasoning || undefined, model: usedModel, stopped: true });
    } else {
      if (answer) c.messages.push({ role: 'assistant', content: answer, reasoning: reasoning || undefined, model: usedModel, stopped: true });
      c.updated = Date.now();
      saveChats();
      streaming = null;
      setBusy(false);
      if (currentId !== c.id) return;
      renderThread();
      const again = el('button', { class: 'btn small', type: 'button' }, icon('retry'), 'Retry');
      again.addEventListener('click', () => {
        if (c.messages[c.messages.length - 1]?.role === 'assistant') c.messages.pop();
        renderThread();
        generate();
      });
      inner.append(el('div', { class: 'msg assistant error' },
        el('div', { class: 'bubble', text: err.message }),
        el('div', { class: 'msg-actions' }, again, el('span', { class: 'meta', text: usedModel }))));
      scrollDown(true);
      return;
    }
  }
  cancelAnimationFrame(frame);
  c.updated = Date.now();
  saveChats();
  streaming = null;
  setBusy(false);
  if (currentId === c.id) { renderThread(); renderRecents(); input.focus(); }
}

// ---------------- models ----------------
let modelsLoaded = [];
const modelMenu = createModelMenu({
  align: 'right',
  onChange(id) {
    store.set('local-ai-jay.model', id);
    const c = current();
    if (c) { c.model = id; saveChats(); }
    input.focus();
  },
});
$('#model-menu-slot').replaceWith(modelMenu.root);
modelMenu.setValue(store.get('local-ai-jay.model') || 'auto');

function setModel(id) { modelMenu.setValue(id); }

async function loadModels() {
  try {
    const { data } = await api('/v1/models');
    modelsLoaded = data.map((m) => ({ id: m.id, owner: m.owned_by }));
    modelMenu.setModels(modelsLoaded);
    if (!modelsLoaded.some((m) => m.id === modelMenu.value)) modelMenu.setValue('auto');
  } catch (err) {
    if (err.message !== 'unauthorized') toast(`Couldn't load models: ${err.message}`);
  }
}

// ---------------- providers ----------------
const STATE_TEXT = {
  ready: 'Ready', not_installed: 'Not installed', no_key: 'No key', offline: 'Not running',
  no_models: 'No models', paused: 'Paused', error: 'Error', off: 'Off',
};
const KIND_TEXT = { cli: 'CLI', local: 'local', cloud: 'cloud', web: 'website' };

function providerCard(p) {
  const result = el('div', { class: 'pcard-result', hidden: true });
  const actions = el('div', { class: 'pcard-actions' });
  const card = el('div', { class: 'card pcard' },
    el('div', { class: 'pcard-head' },
      el('div', {}, el('span', { class: 'pcard-title', text: p.label }), el('span', { class: 'kind', text: KIND_TEXT[p.kind] || p.kind })),
      el('span', { class: `pill ${p.state}`, text: STATE_TEXT[p.state] || p.state })),
    el('div', { class: 'pcard-detail', text: p.detail || '' }),
  );

  const busy = async (btn, fn) => {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try { await fn(); } catch (err) { if (err.message !== 'unauthorized') { result.hidden = false; result.className = 'pcard-result bad'; result.textContent = err.message; } }
    finally { btn.disabled = false; btn.textContent = label; }
  };

  if (p.available && !p.paused) {
    const test = el('button', { class: 'btn small', type: 'button', text: 'Test' });
    test.addEventListener('click', () => busy(test, async () => {
      const r = await api(`/api/providers/${p.id}/test`, { method: 'POST' });
      result.hidden = false;
      result.className = `pcard-result ${r.ok ? 'ok' : 'bad'}`;
      result.textContent = r.ok ? `✓ Answered “${r.reply || '…'}” in ${(r.ms / 1000).toFixed(1)}s` : r.error;
    }));
    actions.append(test);
  }
  const toggle = el('button', { class: 'btn small', type: 'button', text: p.paused ? 'Resume' : 'Pause' });
  toggle.addEventListener('click', () => busy(toggle, async () => {
    await api(`/api/providers/${p.id}/${p.paused ? 'resume' : 'pause'}`, { method: 'POST' });
    toast(`${p.label} ${p.paused ? 'resumed' : 'paused'}`);
    loadProviders();
  }));
  actions.append(toggle);
  if (p.keyUrl && p.kind !== 'web' && (!p.available || p.needsKey)) {
    actions.append(el('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', class: 'small', text: p.needsKey ? 'Get a key ↗' : 'Install ↗' }));
  }
  card.append(actions);

  if (p.needsKey) {
    const keys = p.key || [];
    if (keys.length) {
      const list = el('div', { class: 'keylist' });
      for (const k of keys) {
        const onoff = el('button', { class: 'ghost small', type: 'button', text: k.enabled ? 'Off' : 'On', title: k.enabled ? 'Switch this key off' : 'Switch this key on' });
        onoff.addEventListener('click', () => busy(onoff, async () => {
          await api(`/api/providers/${p.id}/key/${k.id}`, { method: 'POST', body: JSON.stringify({ enabled: !k.enabled }) });
          loadProviders();
        }));
        const del = el('button', { class: 'ghost small', type: 'button', text: 'Remove' });
        del.addEventListener('click', () => busy(del, async () => {
          if (!confirm(`Remove key ${k.masked} from this server?`)) return;
          await api(`/api/providers/${p.id}/key/${k.id}`, { method: 'DELETE' });
          toast('Key removed');
          loadProviders();
        }));
        const note = !k.enabled ? 'off' : k.resting ? 'resting (hit its limit)' : '';
        list.append(el('div', { class: `keyrow-item${k.enabled ? '' : ' off'}` },
          el('code', { text: k.masked }),
          el('span', { class: 'muted small', text: note }),
          el('span', { class: 'spacer' }),
          onoff, del));
      }
      card.append(list);
      if (keys.length > 1) card.append(el('div', { class: 'muted small', text: `${keys.filter((k) => k.enabled).length} of ${keys.length} keys on. They take turns; a key that hits its limit rests and the next one is used.` }));
    } else if (p.keySource === 'env') {
      card.append(el('div', { class: 'muted small', text: `Using ${p.envKey} from the environment.` }));
    }
    const keyInput = el('textarea', {
      rows: 1,
      placeholder: keys.length ? 'Add more keys (one per line)…' : 'Paste API key(s), one per line…',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': `${p.label} API keys`,
      class: 'keyinput',
    });
    keyInput.addEventListener('input', () => { keyInput.rows = Math.min(6, Math.max(1, keyInput.value.split('\n').length)); });
    const save = el('button', { class: 'primary small', type: 'submit', text: 'Add' });
    const form = el('form', { class: 'keyrow' }, keyInput, save);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = keyInput.value.trim();
      if (!text) return;
      busy(save, async () => {
        const r = await api(`/api/providers/${p.id}/key`, { method: 'PUT', body: JSON.stringify({ keys: text.split(/[\s,]+/) }) });
        keyInput.value = '';
        keyInput.rows = 1;
        const ok = r.results.filter((x) => x.ok && !x.duplicate).length;
        const dup = r.results.filter((x) => x.duplicate).length;
        const bad = r.results.filter((x) => !x.ok);
        toast(`${p.label}: ${ok} key${ok === 1 ? '' : 's'} checked and added${dup ? `, ${dup} already saved` : ''}${bad.length ? `, ${bad.length} rejected` : ''}`);
        loadProviders();
        if (bad.length) setTimeout(() => toast(`Rejected: ${bad.map((b) => `${b.masked} (${b.error})`).join('; ')}`), 2800);
      });
    });
    form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit(); });
    card.append(form);
  }
  card.append(result);
  return card;
}

async function loadProviders(fresh = false) {
  try {
    const { providers } = await api(`/api/providers${fresh ? '?fresh=1' : ''}`);
    const groups = { cloud: $('#prov-cloud'), web: $('#prov-web') };
    const local = $('#prov-local');
    for (const g of [local, ...Object.values(groups)]) g.textContent = '';
    for (const p of providers) (groups[p.kind] || local).append(providerCard(p));
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message);
  }
}
$('#prov-refresh').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  await loadProviders(true);
  b.disabled = false;
  toast('Checked again');
});

// ---------------- usage ----------------
const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtShort = (n) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);

async function loadUsage() {
  let u;
  try { u = await api('/api/usage'); } catch { return; }
  const t = u.totals;
  const tiles = $('#usage-tiles');
  tiles.textContent = '';
  const avg = t.requests ? `${(t.totalMs / t.requests / 1000).toFixed(1)}s` : '–';
  [['Requests', fmt(t.requests)], ['Errors', fmt(t.errors)], ['Tokens in', fmtShort(t.inputTokens)], ['Tokens out', fmtShort(t.outputTokens)], ['Avg. time', avg]]
    .forEach(([label, value]) => tiles.append(el('div', { class: 'tile' }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }))));

  const chart = $('#usage-chart');
  chart.textContent = '';
  const max = Math.max(1, ...u.days.map((d) => d.requests));
  for (const d of u.days) {
    const fill = el('div', { class: `fill${d.requests ? '' : ' zero'}`, title: `${d.day}: ${d.requests} requests, ${d.errors} errors` });
    fill.style.height = `${Math.max(2, (d.requests / max) * 100)}%`;
    const date = new Date(`${d.day}T00:00:00`);
    chart.append(el('div', { class: 'bar' },
      el('span', { class: 'n', text: d.requests || '' }),
      fill,
      el('span', { class: 'd', text: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) })));
  }

  const table = $('#usage-table');
  table.textContent = '';
  table.append(el('tr', {}, ...['Provider', 'Requests', 'Errors', 'Tokens in', 'Tokens out', 'Avg. time'].map((h, i) => el('th', { class: i ? 'num' : '', text: h }))));
  const rows = Object.entries(u.providers).sort((a, b) => b[1].requests - a[1].requests);
  if (!rows.length) table.append(el('tr', {}, el('td', { colspan: 6, class: 'muted', text: 'No requests yet.' })));
  for (const [id, c] of rows) {
    table.append(el('tr', {},
      el('td', { text: id }), el('td', { class: 'num', text: fmt(c.requests) }), el('td', { class: 'num', text: fmt(c.errors) }),
      el('td', { class: 'num', text: fmt(c.inputTokens) }), el('td', { class: 'num', text: fmt(c.outputTokens) }),
      el('td', { class: 'num', text: c.requests ? `${(c.totalMs / c.requests / 1000).toFixed(1)}s` : '–' })));
  }

  const recent = $('#recent-table');
  recent.textContent = '';
  recent.append(el('tr', {}, ...['Time', 'Model', 'Status', 'Time taken', 'Tokens', 'Error'].map((h) => el('th', { text: h }))));
  if (!u.recent.length) recent.append(el('tr', {}, el('td', { colspan: 6, class: 'muted', text: 'Nothing since the gateway started.' })));
  for (const r of u.recent) {
    recent.append(el('tr', {},
      el('td', { text: new Date(r.at).toLocaleTimeString() }),
      el('td', { text: r.model + (r.test ? ' (test)' : '') + (r.fallbackFrom ? ` (after ${r.fallbackFrom})` : '') }),
      el('td', { class: r.ok ? 'ok' : 'err', text: r.status }),
      el('td', { class: 'num', text: `${(r.ms / 1000).toFixed(1)}s` }),
      el('td', { class: 'num', text: r.ok ? `${fmt(r.inputTokens)} / ${fmt(r.outputTokens)}` : '' }),
      el('td', { class: 'err', text: r.error || '' })));
  }
}
$('#usage-reset').addEventListener('click', async () => {
  if (!confirm('Reset all usage counters?')) return;
  await api('/api/usage', { method: 'DELETE' });
  loadUsage();
});

// ---------------- connect ----------------
let snipName = 'curl';
function snippet(name) {
  const base = `${location.origin}/v1`;
  const key = apiKey;
  switch (name) {
    case 'python':
      return `from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="${key}")
reply = client.chat.completions.create(
    model="auto",  # or "claude-code/sonnet", "ollama/llama3.2", ...
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)`;
    case 'node':
      return `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${base}", apiKey: "${key}" });
const stream = await client.chat.completions.create({
  model: "auto", // or "codex", "groq/llama-3.3-70b-versatile", ...
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");`;
    case 'env':
      return `export OPENAI_BASE_URL="${base}"
export OPENAI_API_KEY="${key}"`;
    default:
      return `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello!"}]}'`;
  }
}
function renderSnip() {
  $$('.snip-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.snip === snipName));
  $('#snip code').textContent = snippet(snipName);
}
$$('.snip-tabs button').forEach((b) => b.addEventListener('click', () => { snipName = b.dataset.snip; renderSnip(); }));
$('#snip-copy').addEventListener('click', () => copy(snippet(snipName)));

let keyShown = false;
function renderKey() { $('#c-key').textContent = keyShown ? apiKey : `${apiKey.slice(0, 6)}${'•'.repeat(18)}`; $('#c-reveal').textContent = keyShown ? 'Hide' : 'Show'; }
$('#c-reveal').addEventListener('click', () => { keyShown = !keyShown; renderKey(); });
$('[data-copy-key]').addEventListener('click', () => copy(apiKey));
$('[data-copy="c-base"]').addEventListener('click', () => copy($('#c-base').textContent));
$('#signout').addEventListener('click', () => {
  store.del(KEY_STORE);
  apiKey = null;
  showSignIn();
});

async function loadConnect() {
  $('#c-base').textContent = `${location.origin}/v1`;
  renderKey();
  renderSnip();
  try {
    const info = await api('/api/info');
    const dl = $('#c-settings');
    dl.textContent = '';
    const add = (k, v) => dl.append(el('dt', { text: k }), el('dd', { text: v }));
    add('Access', info.cliAccess === 'edit' ? 'Can edit files in allowed folders' : 'Read-only');
    add('Default folder', info.workspace);
    add('Allowed folders', info.allowedDirs.length ? info.allowedDirs.join(', ') : 'none besides the default');
    add('CORS', info.cors ? 'on: browser apps on other sites can call /v1 with the key' : 'off');
    add('Data folder', info.home);
  } catch { /* shown elsewhere */ }
}

// ---------------- boot ----------------
async function boot() {
  try {
    const info = await api('/api/info');
    $('#ver').textContent = `local-ai-jay v${info.version} · running`;
    $('#status-dot').classList.add('ok');
  } catch { return; }
  const saved = store.get('local-ai-jay.current');
  if (saved && chats.some((c) => c.id === saved)) {
    currentId = saved;
    const c = current();
    $('#pg-system').value = c.system || '';
    syncSystemChip();
    if (c.model) setModel(c.model);
  }
  let tab = store.get('local-ai-jay.tab') || 'playground';
  const fromLink = initialHash.match(/tab=([a-z]+)/);
  if (fromLink) tab = fromLink[1];
  renderThread();
  showTab(['playground', 'providers', 'usage', 'connect'].includes(tab) ? tab : 'playground');
  setInterval(() => { if (currentTab === 'usage' && !document.hidden) loadUsage(); }, 5000);
}

apiKey = readKey();
if (apiKey) boot(); else showSignIn();
