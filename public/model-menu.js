// Model picker shared by the web console and the VS Code extension: a button that opens a
// searchable, grouped popover menu. The extension ships a copy at vscode/media/model-menu.js;
// a test keeps the two identical. Styling lives in each app's stylesheet (.mm-*).

const PROVIDER_LABELS = {
  'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI', antigravity: 'Antigravity',
  ollama: 'Ollama', lmstudio: 'LM Studio', groq: 'Groq', cerebras: 'Cerebras', 'gemini-api': 'Google AI Studio',
  openrouter: 'OpenRouter', mistral: 'Mistral', deepseek: 'DeepSeek', openai: 'OpenAI', 'gemini-web': 'Gemini website',
};
const SEARCH_FROM = 9; // show the search box once there are this many models

// Constant SVG markup only.
const SVG = {
  chevron: '<svg viewBox="0 0 24 24" class="mm-caret"><path d="M7 10l5 5 5-5"/></svg>',
  check: '<svg viewBox="0 0 24 24" class="mm-check"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  search: '<svg viewBox="0 0 24 24" class="mm-search-icon"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
  auto: '<svg viewBox="0 0 24 24" class="mm-auto-icon"><path d="M12 2.5l7.5 9.5-7.5 9.5-7.5-9.5z"/></svg>',
};
function svg(name) {
  const t = document.createElement('template');
  t.innerHTML = SVG[name];
  return t.content.firstChild;
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export const providerLabel = (id) => PROVIDER_LABELS[id] || id;

/** Splits "claude-code/sonnet" into its provider and model parts. */
export function describeModel(id, owner) {
  if (id === 'auto') return { name: 'Auto', provider: '', detail: 'First ready tool, falls back if one fails' };
  const prov = owner || (id.includes('/') ? id.slice(0, id.indexOf('/')) : id);
  const name = id.startsWith(`${prov}/`) ? id.slice(prov.length + 1) : id;
  return { name, provider: providerLabel(prov), detail: id };
}

let uid = 0;

/**
 * createModelMenu({ onChange, align: 'left' | 'right' })
 * Returns { root, setModels([{ id, owner }]), setValue(id), value, close() }.
 */
export function createModelMenu({ onChange = () => {}, align = 'right' } = {}) {
  const id = `mm${++uid}`;
  let models = [];
  let value = 'auto';
  let options = []; // [{ id, node }] currently shown, in order
  let active = -1;

  const root = el('div', `mm mm-${align}`);
  const label = el('span', 'mm-label');
  const sub = el('span', 'mm-sub');
  const trigger = el('button', 'mm-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', 'Model');
  trigger.title = 'Choose a model';
  trigger.append(label, sub, svg('chevron'));

  const pop = el('div', 'mm-pop');
  pop.hidden = true;
  const searchWrap = el('div', 'mm-search');
  const search = el('input');
  search.type = 'text';
  search.placeholder = 'Search models…';
  search.setAttribute('aria-label', 'Search models');
  search.setAttribute('aria-controls', `${id}-list`);
  search.autocomplete = 'off';
  search.spellcheck = false;
  searchWrap.append(svg('search'), search);
  const list = el('div', 'mm-list');
  list.id = `${id}-list`;
  list.setAttribute('role', 'listbox');
  list.tabIndex = -1;
  pop.append(searchWrap, list);
  root.append(trigger, pop);

  function renderTrigger() {
    const m = models.find((x) => x.id === value);
    const d = describeModel(value, m?.owner);
    label.textContent = d.name;
    sub.textContent = d.provider;
    sub.hidden = !d.provider;
    trigger.title = value === 'auto' ? 'Model: auto' : `Model: ${value}`;
  }

  function setActive(i, scroll = true) {
    if (active >= 0 && options[active]) options[active].node.classList.remove('is-active');
    active = options.length ? Math.max(0, Math.min(i, options.length - 1)) : -1;
    const o = options[active];
    if (!o) { list.removeAttribute('aria-activedescendant'); search.removeAttribute('aria-activedescendant'); return; }
    o.node.classList.add('is-active');
    list.setAttribute('aria-activedescendant', o.node.id);
    search.setAttribute('aria-activedescendant', o.node.id);
    if (scroll) o.node.scrollIntoView({ block: 'nearest' });
  }

  function renderList() {
    const q = search.value.trim().toLowerCase();
    list.textContent = '';
    options = [];
    const groups = new Map();
    for (const m of models) {
      if (q && !`${m.id} ${providerLabel(m.owner)}`.toLowerCase().includes(q)) continue;
      const key = m.id === 'auto' ? '' : m.owner;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    for (const [owner, items] of groups) {
      const group = el('div', 'mm-group');
      group.setAttribute('role', 'group');
      if (owner) {
        const head = el('div', 'mm-group-label', providerLabel(owner));
        head.id = `${id}-g-${options.length}`;
        group.setAttribute('aria-labelledby', head.id);
        group.append(head);
      }
      for (const m of items) {
        const d = describeModel(m.id, m.owner);
        const opt = el('div', `mm-option${m.id === value ? ' is-selected' : ''}`);
        opt.id = `${id}-o-${options.length}`;
        opt.setAttribute('role', 'option');
        opt.setAttribute('aria-selected', String(m.id === value));
        const text = el('div', 'mm-text');
        text.append(el('div', 'mm-name', d.name));
        if (m.id === 'auto') text.append(el('div', 'mm-detail', d.detail));
        if (m.id === 'auto') opt.append(svg('auto'));
        opt.append(text, svg('check'));
        const index = options.length;
        opt.addEventListener('mousemove', () => { if (active !== index) setActive(index, false); });
        opt.addEventListener('click', () => choose(m.id));
        group.append(opt);
        options.push({ id: m.id, node: opt });
      }
      list.append(group);
    }
    if (!options.length) list.append(el('div', 'mm-empty', models.length ? 'No models match.' : 'No models yet. Is local-ai-jay running?'));
    const sel = options.findIndex((o) => o.id === value);
    setActive(sel >= 0 && !q ? sel : 0);
  }

  function place() {
    const r = trigger.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = above >= 260 || above > below;
    root.classList.toggle('mm-up', up);
    root.classList.toggle('mm-down', !up);
    pop.style.maxHeight = `${Math.max(160, Math.min(420, up ? above : below))}px`;
  }

  function open() {
    if (!pop.hidden) return;
    searchWrap.hidden = models.length < SEARCH_FROM;
    search.value = '';
    pop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    root.classList.add('is-open');
    place();
    renderList();
    (searchWrap.hidden ? list : search).focus({ preventScroll: true });
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
  }

  function close(refocus) {
    if (pop.hidden) return;
    pop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    root.classList.remove('is-open');
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    if (refocus === true) trigger.focus();
  }

  function onOutside(e) { if (!root.contains(e.target)) close(); }

  function choose(next) {
    const changed = next !== value;
    value = next;
    renderTrigger();
    close(true);
    if (changed) onChange(value);
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Home' && e.target !== search) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && e.target !== search) { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (options[active]) choose(options[active].id); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close();
  }

  trigger.addEventListener('click', () => (pop.hidden ? open() : close(true)));
  trigger.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(); }
  });
  list.addEventListener('keydown', onKey);
  search.addEventListener('keydown', onKey);
  search.addEventListener('input', renderList);

  renderTrigger();
  return {
    root,
    get value() { return value; },
    setModels(next) {
      models = next.map((m) => ({ id: m.id, owner: m.owner || '' }));
      renderTrigger();
      if (!pop.hidden) { searchWrap.hidden = models.length < SEARCH_FROM; renderList(); }
    },
    setValue(next) { value = next || 'auto'; renderTrigger(); if (!pop.hidden) renderList(); },
    close,
  };
}
