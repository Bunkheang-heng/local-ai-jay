import { buildPrompt } from '../prompt.js';
import { GatewayError } from '../util.js';
import { domToMarkdown } from './to-markdown.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Websites driven in a real browser window. Each site is a set of CSS selectors; the driver
 * types the prompt, presses send, and reads the answer back as Markdown while it's written.
 */
export const WEB_SITES = [
  {
    id: 'gemini-web',
    label: 'Gemini (website)',
    url: 'https://gemini.google.com/app',
    signInHosts: ['accounts.google.com'],
    input: 'rich-textarea div.ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"]',
    send: 'button[aria-label*="Send" i]',
    stop: 'button[aria-label*="Stop" i]',
    response: 'model-response',
    answer: '.markdown-main-panel, .markdown',
    error: 'simple-snack-bar, .mat-mdc-snack-bar-label',
    signedOut: 'a[href*="accounts.google.com/ServiceLogin"]',
  },
];

/** The script that reads the page's state; runs in the page. */
export function pollScript(site) {
  const q = JSON.stringify;
  return `(() => {
    const toMd = ${domToMarkdown.toString()};
    const rs = document.querySelectorAll(${q(site.response)});
    const last = rs[rs.length - 1];
    const ans = last && last.querySelector(${q(site.answer)});
    const err = document.querySelector(${q(site.error)});
    return {
      count: rs.length,
      generating: !!document.querySelector(${q(site.stop)}),
      text: ans ? toMd(ans) : '',
      error: err ? err.innerText.trim().slice(0, 300) : '',
    };
  })()`;
}

export function createWebProvider(site, { getBrowser, isEnabled, timeoutMs = () => 300_000 }) {
  return {
    id: site.id,
    label: site.label,
    kind: 'web',
    maxConcurrency: 1,
    installHint: site.url,

    async status() {
      if (!isEnabled()) {
        return { available: false, state: 'off', detail: 'Off. Start with --web to turn website providers on (see the warning).' };
      }
      const exe = getBrowser().executable;
      if (!exe) return { available: false, state: 'not_installed', detail: 'No Chrome, Chromium, Edge or Brave found' };
      return { available: true, state: 'ready', detail: `Drives ${new URL(site.url).host} in ${exe.split(/[\\/]/).pop()}` };
    },

    async models() { return ['default']; },

    async *chat({ messages, signal }) {
      if (!isEnabled()) throw new GatewayError(503, `${site.label} is off. Start local-ai-jay with --web to turn it on.`, 'provider_off');
      const prompt = buildPrompt(messages);
      const page = await getBrowser().openPage(site.url);
      const onAbort = () => page.close();
      signal?.addEventListener('abort', onAbort, { once: true });
      const q = JSON.stringify;
      const cancelled = () => new GatewayError(499, 'Request cancelled', 'cancelled');
      try {
        // 1. Wait for the chat box (or notice a sign-in wall).
        const loadBy = Date.now() + 45_000;
        for (;;) {
          if (signal?.aborted) throw cancelled();
          const st = await page.evaluate(`({ host: location.host, ready: !!document.querySelector(${q(site.input)}) })`).catch(() => null);
          if (st?.ready) break;
          if (st && site.signInHosts.includes(st.host)) {
            throw new GatewayError(401, `${site.label} wants you to sign in. Stop local-ai-jay and run \`npx local-ai-jay web-signin\` once.`, 'provider_auth_error');
          }
          if (Date.now() > loadBy) throw new GatewayError(504, `${site.label} didn't show its chat box within 45s`, 'timeout');
          await sleep(400);
        }

        // 2. Type the prompt and send it.
        const before = await page.evaluate(`document.querySelectorAll(${q(site.response)}).length`);
        // The box can appear before the page is ready to take typing, so check that the text landed.
        const typed = `(() => { const el = document.querySelector(${q(site.input)}); return el ? el.innerText.trim().length : 0; })()`;
        let landed = false;
        for (let attempt = 0; attempt < 8 && !landed; attempt++) {
          if (signal?.aborted) throw cancelled();
          if (attempt) await sleep(750);
          await page.evaluate(`(() => { const el = document.querySelector(${q(site.input)}); el.focus(); return true; })()`);
          if (await page.evaluate(typed)) {
            // Half-typed text from an earlier attempt: clear it and start again.
            await page.evaluate(`(() => { const el = document.querySelector(${q(site.input)}); el.focus(); document.execCommand('selectAll'); document.execCommand('delete'); return true; })()`);
          }
          await page.insertText(prompt);
          await sleep(300);
          landed = (await page.evaluate(typed)) > 0;
        }
        if (!landed) throw new GatewayError(502, `Couldn't type into ${site.label}'s chat box`, 'provider_error');
        const clicked = await page.evaluate(`(() => {
          const b = document.querySelector(${q(site.send)});
          if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
          b.click();
          return true;
        })()`);
        if (!clicked) await page.pressEnter();

        // 3. Read the answer as it's written. Only text up to the last paragraph break is streamed
        //    while the page is still writing, because the page re-renders the paragraph in progress.
        const script = pollScript(site);
        const started = Date.now();
        let emitted = '';
        let lastText = '';
        let stableSince = Date.now();
        for (;;) {
          if (signal?.aborted) throw cancelled();
          const s = await page.evaluate(script);
          const fresh = s.count > before;
          const text = fresh ? s.text : '';
          if (text !== lastText) { lastText = text; stableSince = Date.now(); }
          const done = fresh && !s.generating && text && Date.now() - stableSince >= 1200;
          const cut = text.lastIndexOf('\n\n');
          const safe = done ? text : (cut >= 0 ? text.slice(0, cut + 2) : '');
          if (safe.length > emitted.length && safe.startsWith(emitted)) {
            yield { type: 'text', text: safe.slice(emitted.length) };
            emitted = safe;
          }
          if (done) {
            // Non-streaming callers get the exact final text even if the page rewrote earlier parts.
            if (emitted !== text) yield { type: 'final', text };
            return;
          }
          const waited = Date.now() - started;
          if (!fresh && !s.generating && s.error && waited > 3000) throw new GatewayError(502, `${site.label}: ${s.error}`, 'provider_error');
          if (!fresh && !s.generating && waited > 30_000) {
            throw new GatewayError(502, `${site.label} didn't answer${s.error ? `: ${s.error}` : ' (it may need you to sign in, or you hit its limit)'}`, 'provider_error');
          }
          if (waited > timeoutMs()) throw new GatewayError(504, `${site.label} was still writing after ${Math.round(timeoutMs() / 1000)}s`, 'timeout');
          await sleep(400);
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        page.close();
      }
    },
  };
}
