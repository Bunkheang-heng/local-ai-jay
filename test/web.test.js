import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebProvider, WEB_SITES, pollScript } from '../src/web/provider.js';
import { findBrowser } from '../src/web/browser.js';

const site = WEB_SITES[0];

/**
 * A fake browser tab. It answers the driver's page scripts by recognising them, and plays
 * back a scripted sequence of page states after "send" is clicked.
 */
function fakePage({ states = [], host = 'gemini.google.com', readyAfter = 0, typeFailures = 0 } = {}) {
  const page = {
    typed: '',
    inserts: 0,
    clicked: false,
    closed: false,
    polls: 0,
    loads: 0,
    async evaluate(expr) {
      if (expr.includes('location.host')) {
        page.loads++;
        return { host, ready: page.loads > readyAfter };
      }
      if (expr.includes('const toMd')) {
        const s = states[Math.min(page.polls, states.length - 1)];
        page.polls++;
        return s;
      }
      if (expr.includes('.length`') || expr.endsWith('.length')) return 0; // response count before sending
      if (expr.includes('innerText.trim().length')) return page.typed.length;
      if (expr.includes('b.click()')) { page.clicked = true; return true; }
      return true; // focus / clear
    },
    async insertText(t) {
      page.inserts++;
      if (page.inserts > typeFailures) page.typed = t;
    },
    async pressEnter() {},
    close() { page.closed = true; },
  };
  return page;
}

function provider(page, { enabled = true } = {}) {
  return createWebProvider(site, {
    getBrowser: () => ({ executable: '/fake/chrome', openPage: async () => page }),
    isEnabled: () => enabled,
    timeoutMs: () => 20_000,
  });
}

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const msgs = [{ role: 'user', content: 'Line one\nLine two' }];

test('web provider types the prompt, streams finished paragraphs, and closes the tab', { timeout: 20_000 }, async () => {
  const page = fakePage({
    states: [
      { count: 0, generating: true, text: '', error: '' },
      { count: 1, generating: true, text: 'First para', error: '' },
      { count: 1, generating: true, text: 'First paragraph.\n\nSecond', error: '' },
      { count: 1, generating: false, text: 'First paragraph.\n\nSecond paragraph.', error: '' },
    ],
  });
  const events = await collect(provider(page).chat({ messages: msgs }));
  assert.equal(page.typed, 'Line one\nLine two');
  assert.equal(page.clicked, true);
  assert.equal(page.closed, true);
  assert.deepEqual(events.map((e) => e.text).join(''), 'First paragraph.\n\nSecond paragraph.');
  assert.deepEqual(events[0], { type: 'text', text: 'First paragraph.\n\n' }); // the unfinished paragraph waited
});

test('web provider retries typing until the text lands', { timeout: 20_000 }, async () => {
  const page = fakePage({ typeFailures: 2, states: [{ count: 1, generating: false, text: '51', error: '' }] });
  const events = await collect(provider(page).chat({ messages: msgs }));
  assert.equal(page.inserts, 3);
  assert.equal(events.map((e) => e.text).join(''), '51');
});

test('web provider sends the exact final text when the page rewrote earlier parts', { timeout: 20_000 }, async () => {
  const page = fakePage({
    states: [
      { count: 1, generating: true, text: 'Draft one.\n\nmore', error: '' },
      { count: 1, generating: false, text: 'Rewritten.\n\nDone.', error: '' },
    ],
  });
  const events = await collect(provider(page).chat({ messages: msgs }));
  assert.deepEqual(events.at(-1), { type: 'final', text: 'Rewritten.\n\nDone.' });
});

test('web provider: sign-in wall, site error, off, cancel', { timeout: 30_000 }, async () => {
  await assert.rejects(collect(provider(fakePage({ host: 'accounts.google.com', readyAfter: 99 })).chat({ messages: msgs })), /web-signin/);

  const errPage = fakePage({ states: [{ count: 0, generating: false, text: '', error: "You've reached your limit" }] });
  await assert.rejects(collect(provider(errPage).chat({ messages: msgs })), /reached your limit/);
  assert.equal(errPage.closed, true);

  await assert.rejects(collect(provider(fakePage(), { enabled: false }).chat({ messages: msgs })), /--web/);
  assert.equal((await provider(fakePage(), { enabled: false }).status()).state, 'off');

  const ac = new AbortController();
  const slow = fakePage({ states: [{ count: 0, generating: true, text: '', error: '' }] });
  const run = collect(provider(slow).chat({ messages: msgs, signal: ac.signal }));
  setTimeout(() => ac.abort(), 1500);
  await assert.rejects(run, /cancelled/);
  assert.equal(slow.closed, true);
});

test('poll script is valid JavaScript with the converter inlined', () => {
  // eslint-disable-next-line no-new-func
  assert.doesNotThrow(() => new Function(`return ${pollScript(site)}`));
});

test('findBrowser honours LOCAL_AI_JAY_BROWSER', () => {
  assert.equal(findBrowser({ LOCAL_AI_JAY_BROWSER: process.execPath }), process.execPath);
  assert.equal(findBrowser({ LOCAL_AI_JAY_BROWSER: '/nope/chrome' }), null);
});
