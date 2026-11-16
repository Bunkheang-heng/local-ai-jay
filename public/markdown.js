// Small, safe Markdown renderer shared by the web console and the VS Code extension.
// It builds DOM nodes directly (never HTML strings), so model output can't inject markup.
// The VS Code extension ships a copy at vscode/media/markdown.js; a test keeps the two identical.

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}

const SAFE_URL = /^(https?:|mailto:)/i;

function inline(text) {
  const out = [];
  const re = /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*(?!\s)([\s\S]+?)\*|(?<![\w])_(?!\s)([\s\S]+?)_(?![\w])|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,:;"'!?\]])|\n/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    last = re.lastIndex;
    if (m[0] === '\n') out.push(el('br'));
    else if (m[1]) out.push(el('code', { text: m[2].trim() || m[2] }));
    else if (m[3] != null || m[4] != null) out.push(el('strong', {}, inline(m[3] ?? m[4])));
    else if (m[5] != null) out.push(el('del', {}, inline(m[5])));
    else if (m[6] != null || m[7] != null) out.push(el('em', {}, inline(m[6] ?? m[7])));
    else if (m[8] != null) {
      out.push(SAFE_URL.test(m[9])
        ? el('a', { href: m[9], target: '_blank', rel: 'noopener noreferrer' }, inline(m[8]))
        : document.createTextNode(m[0]));
    } else if (m[10]) out.push(el('a', { href: m[10], target: '_blank', rel: 'noopener noreferrer', text: m[10] }));
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

const RE = {
  fence: /^\s*(```+|~~~+)\s*([\w+#.-]*)/,
  heading: /^(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
  quote: /^\s*>\s?/,
  item: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
};
const indentOf = (s) => s.match(/^\s*/)[0].replace(/\t/g, '    ').length;
const splitRow = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function blocks(text, opts) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const startsBlock = (l, next) => RE.fence.test(l) || RE.heading.test(l) || RE.hr.test(l) || RE.quote.test(l) || RE.item.test(l)
    || (l.includes('|') && next != null && RE.tableSep.test(next));

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m = line.match(RE.fence);
    if (m) {
      const fence = m[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++;
      const code = body.join('\n');
      const actions = el('div', { class: 'codeblock-actions' }, opts.codeActions ? opts.codeActions(m[2], code) : []);
      out.push(el('div', { class: 'codeblock' },
        el('div', { class: 'codeblock-head' }, el('span', { text: m[2] || 'code' }), actions),
        el('pre', {}, el('code', { text: code }))));
      continue;
    }
    if ((m = line.match(RE.heading))) {
      out.push(el(`h${Math.min(m[1].length, 4)}`, {}, inline(m[2])));
      i++;
      continue;
    }
    if (RE.hr.test(line)) { out.push(el('hr')); i++; continue; }
    if (RE.quote.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && RE.quote.test(lines[i])) body.push(lines[i++].replace(RE.quote, ''));
      out.push(el('blockquote', {}, blocks(body.join('\n'), opts)));
      continue;
    }
    if (line.includes('|') && RE.tableSep.test(lines[i + 1] || '')) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      out.push(el('table', {},
        el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, inline(h))))),
        el('tbody', {}, rows.map((r) => el('tr', {}, head.map((_, j) => el('td', {}, inline(r[j] || ''))))))));
      continue;
    }
    if ((m = line.match(RE.item))) {
      const base = indentOf(line);
      const ordered = /\d/.test(m[2]);
      const list = el(ordered ? 'ol' : 'ul');
      if (ordered && parseInt(m[2], 10) !== 1) list.setAttribute('start', parseInt(m[2], 10));
      while (i < lines.length) {
        const im = lines[i].match(RE.item);
        if (!im || indentOf(lines[i]) !== base || /\d/.test(im[2]) !== ordered) break;
        const body = [im[3]];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            const nxt = lines[i + 1];
            if (nxt != null && nxt.trim() && indentOf(nxt) > base) { body.push(''); i++; continue; }
            break;
          }
          if (indentOf(l) > base) { body.push(l.slice(Math.min(indentOf(l), base + (im[2].length + 1)))); i++; continue; }
          if (RE.item.test(l) || startsBlock(l, lines[i + 1])) break;
          body.push(l); // lazy continuation
          i++;
        }
        const inner = blocks(body.join('\n'), opts);
        const li = el('li');
        if (inner.length && inner[0].tagName === 'P') { li.append(...inner[0].childNodes); inner.shift(); }
        li.append(...inner);
        list.append(li);
      }
      out.push(list);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++]);
    out.push(el('p', {}, inline(para.join('\n'))));
  }
  return out;
}

/**
 * Renders `text` as Markdown into `target`, replacing what was there.
 * `codeActions(lang, code)` may return buttons for each code block's header.
 */
export function renderMarkdown(target, text, opts = {}) {
  target.textContent = '';
  target.append(...blocks(text, opts));
}
