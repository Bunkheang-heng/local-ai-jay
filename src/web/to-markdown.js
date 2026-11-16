/**
 * Runs inside the web page (via CDP Runtime.evaluate): turns a rendered chat answer back into Markdown.
 * Kept as a plain function with no closures so it can be serialized with Function.prototype.toString.
 */
export function domToMarkdown(root) {
  const SKIP = new Set(['BUTTON', 'MAT-ICON', 'GEM-ICON', 'GEM-ICON-BUTTON', 'SVG', 'STYLE', 'SCRIPT', 'SOURCES-CAROUSEL-INLINE', 'SOURCE-FOOTNOTE', 'SOURCES-LIST']);
  const inline = (node) => {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.nodeValue; continue; }
      if (n.nodeType !== 1 || SKIP.has(n.tagName)) continue;
      const t = n.tagName;
      if (t === 'BR') out += '\n';
      else if (t === 'STRONG' || t === 'B') { const s = inline(n); out += s.trim() ? `**${s}**` : s; }
      else if (t === 'EM' || t === 'I') { const s = inline(n); out += s.trim() ? `*${s}*` : s; }
      else if (t === 'CODE') out += '`' + n.textContent + '`';
      else if (t === 'A') { const s = inline(n); const href = n.getAttribute('href'); out += href && /^https?:/.test(href) && s.trim() ? `[${s}](${href})` : s; }
      else out += inline(n);
    }
    return out;
  };
  const block = (node, depth = 0) => {
    const parts = [];
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { if (n.nodeValue.trim()) parts.push(n.nodeValue.trim()); continue; }
      if (n.nodeType !== 1 || SKIP.has(n.tagName)) continue;
      const t = n.tagName;
      if (t === 'CODE-BLOCK' || t === 'PRE') {
        const code = n.querySelector('code') || n;
        const langEl = n.querySelector('.code-block-decoration span, .code-block-decoration');
        const lang = (langEl && langEl !== code ? langEl.textContent.trim() : '').toLowerCase().replace(/[^a-z0-9+#-]/g, '');
        parts.push('```' + lang + '\n' + code.textContent.replace(/\n$/, '') + '\n```');
      } else if (/^H[1-6]$/.test(t)) {
        parts.push('#'.repeat(Number(t[1])) + ' ' + inline(n).trim());
      } else if (t === 'P') {
        const s = inline(n).trim();
        if (s) parts.push(s);
      } else if (t === 'UL' || t === 'OL') {
        let i = 1;
        const items = [];
        for (const li of n.children) {
          if (li.tagName !== 'LI') continue;
          const marker = t === 'OL' ? `${i++}.` : '-';
          const nested = [...li.children].filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
          const clone = li.cloneNode(true);
          clone.querySelectorAll(':scope > ul, :scope > ol').forEach((c) => c.remove());
          const hasBlocks = clone.querySelector('p, code-block, pre');
          const text = (hasBlocks ? block(clone, depth + 1) : inline(clone)).trim().replace(/\n/g, '\n' + '  '.repeat(depth + 1));
          items.push('  '.repeat(depth) + marker + ' ' + text);
          for (const sub of nested) {
            const wrap = document.createElement('div');
            wrap.appendChild(sub.cloneNode(true));
            items.push(block(wrap, depth + 1));
          }
        }
        parts.push(items.join('\n'));
      } else if (t === 'BLOCKQUOTE') {
        parts.push(block(n, depth).split('\n').map((l) => '> ' + l).join('\n'));
      } else if (t === 'HR') {
        parts.push('---');
      } else if (t === 'TABLE') {
        const rows = [...n.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => inline(c).trim().replace(/\|/g, '\\|')));
        if (rows.length) {
          const lines = rows.map((r) => '| ' + r.join(' | ') + ' |');
          lines.splice(1, 0, '| ' + rows[0].map(() => '---').join(' | ') + ' |');
          parts.push(lines.join('\n'));
        }
      } else {
        const s = block(n, depth);
        if (s.trim()) parts.push(s);
      }
    }
    return parts.join('\n\n');
  };
  return block(root).replace(/\n{3,}/g, '\n\n').trim();
}
