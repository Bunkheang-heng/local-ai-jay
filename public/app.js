// local-ai-jay console. Plain JS, no build step.
const KEY_STORE = 'local-ai-jay.key';
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

// ---------------- key handling ----------------
let apiKey = null;
const initialHash = location.hash;
function readKey() {
  const m = location.hash.match(/key=([A-Za-z0-9_-]+)/);
  if (m) {
    try { localStorage.setItem(KEY_STORE, m[1]); } catch { /* private mode */ }
    history.replaceState(null, '', location.pathname);
    return m[1];
  }
  try { return localStorage.getItem(KEY_STORE); } catch { return null; }
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
  $$('.tab-panel').forEach((p) => { p.hidden = true; });
  $('.tabs').hidden = true;
  const err = $('#signin-error');
  err.hidden = !message;
  err.textContent = message || '';
}

$('#signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  apiKey = $('#signin-key').value.trim();
  try {
    await fetch('/api/info', { headers: { authorization: `Bearer ${apiKey}` } }).then((r) => { if (!r.ok) throw new Error(); });
    try { localStorage.setItem(KEY_STORE, apiKey); } catch { /* ignore */ }
    $('#signin').hidden = true;
    $('.tabs').hidden = false;
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

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed: select and copy by hand'); }
}

// ---------------- tabs ----------------
let currentTab = 'playground';
function showTab(name) {
  currentTab = name;
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  try { localStorage.setItem('local-ai-jay.tab', name); } catch { /* ignore */ }
  if (name === 'providers') loadProviders();
  if (name === 'usage') loadUsage();
  if (name === 'connect') loadConnect();
  if (name === 'playground') loadModels();
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------------- tiny safe markdown: code fences + inline code ----------------
function renderText(target, text) {
  target.textContent = '';
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const body = nl >= 0 ? part.slice(nl + 1) : part;
      target.append(el('pre', {}, el('code', { text: body.replace(/\n$/, '') })));
    } else {
      const bits = part.split(/`([^`\n]+)`/);
      bits.forEach((b, j) => target.append(j % 2 ? el('code', { text: b }) : document.createTextNode(b)));
    }
  });
}

// ---------------- playground ----------------
const chat = { messages: [], controller: null };
const emptyState = $('#pg-empty');

async function loadModels() {
  const sel = $('#pg-model');
  const prev = sel.value || (() => { try { return localStorage.getItem('local-ai-jay.model'); } catch { return null; } })();
  try {
    const { data } = await api('/v1/models');
    sel.textContent = '';
    const groups = new Map();
    for (const m of data) {
      const g = m.owned_by === 'local-ai-jay' ? 'Routing' : m.owned_by;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(m.id);
    }
    for (const [g, ids] of groups) {
      const og = el('optgroup', { label: g });
      ids.forEach((id) => og.append(el('option', { value: id, text: id })));
      sel.append(og);
    }
    if (prev && data.some((m) => m.id === prev)) sel.value = prev;
  } catch (err) {
    if (err.message !== 'unauthorized') toast(`Couldn't load models: ${err.message}`);
  }
}
$('#pg-model').addEventListener('change', (e) => { try { localStorage.setItem('local-ai-jay.model', e.target.value); } catch { /* ignore */ } });
$('#pg-system-toggle').addEventListener('click', () => { const s = $('#pg-system'); s.hidden = !s.hidden; if (!s.hidden) s.focus(); });
$('#pg-new').addEventListener('click', () => {
  chat.controller?.abort();
  chat.messages = [];
  $('#pg-log').textContent = '';
  $('#pg-log').append(emptyState);
  emptyState.hidden = false;
  $('#pg-input').focus();
});

function addMsg(role, text = '') {
  emptyState.hidden = true;
  const bubble = el('div', { class: 'bubble' });
  renderText(bubble, text);
  const wrap = el('div', { class: `msg ${role}` }, bubble);
  $('#pg-log').append(wrap);
  $('#pg-log').scrollTop = $('#pg-log').scrollHeight;
  return { wrap, bubble };
}

const input = $('#pg-input');
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#pg-form').requestSubmit(); }
});
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; });
$('#pg-stop').addEventListener('click', () => chat.controller?.abort());

$('#pg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || chat.controller) return;
  input.value = '';
  input.style.height = '';
  addMsg('user', text);
  chat.messages.push({ role: 'user', content: text });

  const model = $('#pg-model').value || 'auto';
  const system = $('#pg-system').value.trim();
  const messages = system ? [{ role: 'system', content: system }, ...chat.messages] : chat.messages;
  const { wrap, bubble } = addMsg('assistant');
  bubble.classList.add('cursor');
  const meta = el('div', { class: 'meta', text: model });
  let reasoningBox = null;
  wrap.append(meta);

  chat.controller = new AbortController();
  $('#pg-send').hidden = true;
  $('#pg-stop').hidden = false;
  const t0 = performance.now();
  let answer = '';
  let reasoning = '';
  let usedModel = model;
  let usage = null;
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } }),
      signal: chat.controller.signal,
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
          if (!reasoningBox) {
            reasoningBox = el('div');
            wrap.insertBefore(el('details', { class: 'reasoning' }, el('summary', { text: 'Thinking' }), reasoningBox), bubble);
          }
          reasoningBox.textContent = reasoning;
        }
        if (d?.content) {
          answer += d.content;
          renderText(bubble, answer);
        }
        meta.textContent = usedModel;
        $('#pg-log').scrollTop = $('#pg-log').scrollHeight;
      }
    }
    chat.messages.push({ role: 'assistant', content: answer });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    meta.textContent = `${usedModel} · ${secs}s${usage ? ` · ${usage.prompt_tokens} in / ${usage.completion_tokens} out` : ''}`;
    if (!answer) renderText(bubble, '(empty reply)');
  } catch (err) {
    if (err.name === 'AbortError') {
      if (answer) chat.messages.push({ role: 'assistant', content: answer });
      meta.textContent = `${usedModel} · stopped`;
      if (!answer) wrap.remove();
    } else {
      wrap.classList.add('error');
      renderText(bubble, answer ? `${answer}\n\n⚠ ${err.message}` : err.message);
      chat.messages.pop(); // let the user retry the same question
    }
  } finally {
    bubble.classList.remove('cursor');
    chat.controller = null;
    $('#pg-send').hidden = false;
    $('#pg-stop').hidden = true;
    input.focus();
  }
});

// ---------------- providers ----------------
const STATE_TEXT = {
  ready: 'Ready', not_installed: 'Not installed', no_key: 'No key', offline: 'Not running',
  no_models: 'No models', paused: 'Paused', error: 'Error',
};
const KIND_TEXT = { cli: 'CLI', local: 'local', cloud: 'cloud' };

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
    const test = el('button', { class: 'ghost small', type: 'button', text: 'Test' });
    test.addEventListener('click', () => busy(test, async () => {
      const r = await api(`/api/providers/${p.id}/test`, { method: 'POST' });
      result.hidden = false;
      result.className = `pcard-result ${r.ok ? 'ok' : 'bad'}`;
      result.textContent = r.ok ? `✓ Answered “${r.reply || '…'}” in ${(r.ms / 1000).toFixed(1)}s` : r.error;
    }));
    actions.append(test);
  }
  const toggle = el('button', { class: 'ghost small', type: 'button', text: p.paused ? 'Resume' : 'Pause' });
  toggle.addEventListener('click', () => busy(toggle, async () => {
    await api(`/api/providers/${p.id}/${p.paused ? 'resume' : 'pause'}`, { method: 'POST' });
    toast(`${p.label} ${p.paused ? 'resumed' : 'paused'}`);
    loadProviders();
  }));
  actions.append(toggle);
  if (p.keyUrl && (!p.available || p.needsKey)) {
    actions.append(el('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', class: 'small', text: p.needsKey ? 'Get a key ↗' : 'Install ↗' }));
  }
  card.append(actions);

  if (p.needsKey) {
    if (p.key) {
      const row = el('div', { class: 'pcard-actions' },
        el('code', { text: p.key.masked }),
        el('span', { class: 'muted small', text: p.key.enabled ? '' : '(switched off)' }));
      const onoff = el('button', { class: 'ghost small', type: 'button', text: p.key.enabled ? 'Switch off' : 'Switch on' });
      onoff.addEventListener('click', () => busy(onoff, async () => {
        await api(`/api/providers/${p.id}/key`, { method: 'POST', body: JSON.stringify({ enabled: !p.key.enabled }) });
        loadProviders();
      }));
      const del = el('button', { class: 'ghost small', type: 'button', text: 'Remove' });
      del.addEventListener('click', () => busy(del, async () => {
        if (!confirm(`Remove the ${p.label} key from this computer?`)) return;
        await api(`/api/providers/${p.id}/key`, { method: 'DELETE' });
        toast('Key removed');
        loadProviders();
      }));
      row.append(onoff, del);
      card.append(row);
    } else if (p.keySource === 'env') {
      card.append(el('div', { class: 'muted small', text: `Using ${p.envKey} from your environment.` }));
    }
    const keyInput = el('input', { type: 'password', placeholder: p.key ? 'Replace key…' : 'Paste API key…', autocomplete: 'off', 'aria-label': `${p.label} API key` });
    const save = el('button', { class: 'primary small', type: 'submit', text: 'Save' });
    const form = el('form', { class: 'keyrow' }, keyInput, save);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!keyInput.value.trim()) return;
      busy(save, async () => {
        await api(`/api/providers/${p.id}/key`, { method: 'PUT', body: JSON.stringify({ key: keyInput.value.trim() }) });
        keyInput.value = '';
        toast(`${p.label} key checked and saved`);
        loadProviders();
      });
    });
    card.append(form);
  }
  card.append(result);
  return card;
}

async function loadProviders(fresh = false) {
  try {
    const { providers } = await api(`/api/providers${fresh ? '?fresh=1' : ''}`);
    const local = $('#prov-local');
    const cloud = $('#prov-cloud');
    local.textContent = '';
    cloud.textContent = '';
    for (const p of providers) (p.kind === 'cloud' ? cloud : local).append(providerCard(p));
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message);
  }
}
$('#prov-refresh').addEventListener('click', async (e) => {
  e.target.disabled = true;
  await loadProviders(true);
  e.target.disabled = false;
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
  try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
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
    $('#ver').textContent = `v${info.version}`;
  } catch { return; }
  let tab = 'playground';
  try { tab = localStorage.getItem('local-ai-jay.tab') || tab; } catch { /* ignore */ }
  const fromLink = initialHash.match(/tab=([a-z]+)/);
  if (fromLink) tab = fromLink[1];
  showTab(['playground', 'providers', 'usage', 'connect'].includes(tab) ? tab : 'playground');
  setInterval(() => { if (currentTab === 'usage' && !document.hidden) loadUsage(); }, 5000);
}

apiKey = readKey();
if (apiKey) boot(); else showSignIn();
