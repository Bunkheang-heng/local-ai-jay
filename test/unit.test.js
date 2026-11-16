import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt } from '../src/prompt.js';
import { parseModel } from '../src/providers/index.js';
import { claudeSpec, codexSpec, geminiSpec, checkModelName } from '../src/providers/cli.js';
import { sseData } from '../src/providers/openai-compat.js';
import { loadConfig, loadEnvFile, addAllowedDir } from '../src/config.js';
import { getPaths } from '../src/paths.js';
import { Store } from '../src/store.js';
import { Semaphore, safeEqual, maskSecret, isInside } from '../src/util.js';
import { runLines } from '../src/process.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jay-test-'));

test('buildPrompt passes a lone user message through untouched', () => {
  assert.equal(buildPrompt([{ role: 'user', content: 'hi there' }]), 'hi there');
});

test('buildPrompt folds system + history into one prompt', () => {
  const p = buildPrompt([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'What is 2+2?' },
    { role: 'assistant', content: '4' },
    { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }] },
  ]);
  assert.match(p, /<instructions>\nBe brief\.\n<\/instructions>/);
  assert.match(p, /User: What is 2\+2\?\n\nAssistant: 4/);
  assert.match(p, /And 3\+3\?$/);
});

test('buildPrompt rejects bad input', () => {
  assert.throws(() => buildPrompt([]), /non-empty/);
  assert.throws(() => buildPrompt([{ role: 'system', content: 'x' }]), /user message/);
  assert.throws(() => buildPrompt([{ content: 'x' }]), /role/);
});

test('parseModel splits provider and model', () => {
  assert.deepEqual(parseModel('auto'), { auto: true });
  assert.deepEqual(parseModel(undefined), { auto: true });
  assert.deepEqual(parseModel('ollama'), { providerId: 'ollama', model: null });
  assert.deepEqual(parseModel('claude-code/sonnet'), { providerId: 'claude-code', model: 'sonnet' });
  assert.deepEqual(parseModel('claude-code/default'), { providerId: 'claude-code', model: null });
  assert.deepEqual(parseModel('openrouter/meta-llama/llama-3'), { providerId: 'openrouter', model: 'meta-llama/llama-3' });
});

test('checkModelName blocks flag injection', () => {
  assert.equal(checkModelName('claude-sonnet-4-6[1m]'), 'claude-sonnet-4-6[1m]');
  assert.equal(checkModelName('default'), null);
  assert.throws(() => checkModelName('--dangerously-skip-permissions'));
  assert.throws(() => checkModelName('a b'));
  assert.throws(() => checkModelName('x;rm -rf'));
});

test('claude parser streams text, thinking and usage', () => {
  const st = {};
  const lines = [
    { type: 'system', subtype: 'init' },
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'po' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ng' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'pong', usage: { input_tokens: 3, cache_read_input_tokens: 10, output_tokens: 2 } },
  ];
  const events = lines.flatMap((l) => claudeSpec.parseLine(JSON.stringify(l), st));
  assert.deepEqual(events, [
    { type: 'reasoning', text: 'hmm' },
    { type: 'text', text: 'po' },
    { type: 'text', text: 'ng' },
    { type: 'usage', inputTokens: 13, outputTokens: 2, costUsd: undefined },
  ]);
});

test('claude parser separates turns and surfaces errors', () => {
  const st = {};
  const ev = (o) => claudeSpec.parseLine(JSON.stringify(o), st);
  ev({ type: 'stream_event', event: { type: 'message_start' } });
  assert.deepEqual(ev({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } } }), [{ type: 'text', text: 'A' }]);
  ev({ type: 'stream_event', event: { type: 'message_start' } });
  assert.deepEqual(ev({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'B' } } }), [{ type: 'text', text: '\n\nB' }]);
  assert.throws(() => ev({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in' }), /Not logged in/);
});

test('codex parser reads completed items', () => {
  const st = {};
  const events = [
    { type: 'thread.started' },
    { type: 'item.completed', item: { type: 'reasoning', text: 'think' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'pong' } },
    { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 5 } },
  ].flatMap((l) => codexSpec.parseLine(JSON.stringify(l), st));
  assert.deepEqual(events, [
    { type: 'reasoning', text: 'think\n' },
    { type: 'text', text: 'pong' },
    { type: 'usage', inputTokens: 100, outputTokens: 5 },
  ]);
  assert.throws(() => codexSpec.parseLine(JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } }), {}), /quota/);
});

test('gemini parser handles deltas, results and plain text fallback', () => {
  const st = {};
  const events = [
    { type: 'init' },
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'message', role: 'assistant', content: 'po', delta: true },
    { type: 'message', role: 'assistant', content: 'ng', delta: true },
    { type: 'result', status: 'success', stats: { input_tokens: 4, output_tokens: 1 } },
  ].flatMap((l) => geminiSpec.parseLine(JSON.stringify(l), st));
  assert.deepEqual(events.map((e) => e.text ?? e.inputTokens), ['po', 'ng', 4]);

  const st2 = {};
  geminiSpec.parseLine('plain answer', st2);
  assert.deepEqual(geminiSpec.finish(st2), [{ type: 'text', text: 'plain answer' }]);
});

test('sseData splits events across chunk boundaries', async () => {
  async function* body() {
    yield new TextEncoder().encode('data: {"a":1}\n\nda');
    yield new TextEncoder().encode('ta: {"a":2}\r\n\r\n: comment\n\ndata: [DONE]\n\n');
  }
  const out = [];
  for await (const d of sseData(body())) out.push(d);
  assert.deepEqual(out, ['{"a":1}', '{"a":2}', '[DONE]']);
});

test('config: first run makes a private key, later runs keep it', () => {
  const paths = getPaths(tmp());
  const a = loadConfig(paths);
  assert.equal(a.firstRun, true);
  assert.match(a.config.apiKey, /^jay-[A-Za-z0-9_-]{32}$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(paths.config).mode & 0o777, 0o600);
  const b = loadConfig(paths);
  assert.equal(b.firstRun, false);
  assert.equal(b.config.apiKey, a.config.apiKey);
  assert.equal(b.config.cliAccess, 'read-only');
});

test('config: allowed dirs must exist and are stored as real paths', () => {
  const paths = getPaths(tmp());
  const { config } = loadConfig(paths);
  const dir = tmp();
  assert.equal(addAllowedDir(config, dir), fs.realpathSync(dir));
  assert.throws(() => addAllowedDir(config, path.join(dir, 'nope')), /not found/);
});

test('env file loads without overriding real env', () => {
  const dir = tmp();
  const file = path.join(dir, 'env');
  fs.writeFileSync(file, '# comment\nFOO_JAY=1\nexport BAR_JAY="two"\nEXISTING_JAY=nope\n');
  const env = { EXISTING_JAY: 'kept' };
  loadEnvFile(file, env);
  assert.deepEqual(env, { EXISTING_JAY: 'kept', FOO_JAY: '1', BAR_JAY: 'two' });
});

test('store keeps keys, pauses and usage across restarts', () => {
  const dir = tmp();
  const s = new Store(dir);
  assert.equal(s.addKey('groq', 'gsk_1234567890abcdef'), true);
  assert.equal(s.addKey('groq', 'gsk_1234567890abcdef'), false); // duplicate
  s.addKey('groq', 'gsk_second_key_0000');
  s.setPaused('codex', true);
  s.record({ provider: 'groq', ok: true, inputTokens: 10, outputTokens: 5, ms: 100 });
  s.record({ provider: 'groq', ok: false, ms: 50 });
  s.saveNow();
  const s2 = new Store(dir);
  assert.deepEqual(s2.getKeys('groq'), ['gsk_1234567890abcdef', 'gsk_second_key_0000']);
  assert.deepEqual(s2.keyInfo('groq').map((k) => k.masked), ['gsk_…cdef', 'gsk_…0000']);
  assert.equal(s2.isPaused('codex'), true);
  assert.deepEqual(s2.usage().totals, { requests: 2, errors: 1, inputTokens: 10, outputTokens: 5, totalMs: 150 });
  const firstId = s2.keyInfo('groq')[0].id;
  s2.setKeyEnabled('groq', false, firstId);
  assert.deepEqual(s2.getKeys('groq'), ['gsk_second_key_0000']);
  s2.removeKey('groq', firstId);
  assert.equal(s2.keyInfo('groq').length, 1);
  s2.removeKey('groq');
  assert.equal(s2.keyInfo('groq'), null);
});

test('store upgrades the old single-key format', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ keys: { groq: { value: 'gsk_old_single_key', enabled: true } } }));
  const s = new Store(dir);
  assert.deepEqual(s.getKeys('groq'), ['gsk_old_single_key']);
  assert.equal(s.keyInfo('groq').length, 1);
});

test('several keys take turns; a rate-limited key rests and the next one answers', async () => {
  const { createOpenAICompatProvider } = await import('../src/providers/openai-compat.js');
  const seen = [];
  const limited = new Set(['k-two']);
  const fetchImpl = async (url, opts) => {
    const k = opts.headers.authorization.slice(7);
    seen.push(k);
    if (limited.has(k)) return new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { 'retry-after': '30' } });
    return new Response('{"ok":true}', { status: 200 });
  };
  const p = createOpenAICompatProvider({ id: 'x', label: 'X', baseUrl: 'http://x/v1' }, { getKeys: () => ['k-one', 'k-two', 'k-three'], fetchImpl });
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await p.fetchChat({}, undefined)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200]);
  // turn 1: one; turn 2: two (429, rests) -> three; turn 3: three; turn 4: one (two still resting)
  assert.deepEqual(seen, ['k-one', 'k-two', 'k-three', 'k-three', 'k-one']);
  assert.equal(p.isResting('k-two'), true);
  assert.equal(p.keyCount(), 3);

  // Every key limited: the caller gets the 429.
  limited.add('k-one'); limited.add('k-three');
  assert.equal((await p.fetchChat({}, undefined)).status, 429);
});

test('env var can hold several comma-separated keys', async () => {
  const { createOpenAICompatProvider } = await import('../src/providers/openai-compat.js');
  process.env.JAY_TEST_MULTI_KEY = 'aaa111aaa, bbb222bbb';
  const p = createOpenAICompatProvider({ id: 'y', label: 'Y', baseUrl: 'http://y/v1', envKey: 'JAY_TEST_MULTI_KEY' }, {});
  assert.equal(p.keyCount(), 2);
  assert.equal(p.keySource(), 'env');
  assert.match((await p.status()).detail, /2 keys/);
  delete process.env.JAY_TEST_MULTI_KEY;
});

test('semaphore queues and honours abort', async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();
  const ac = new AbortController();
  const p2 = sem.acquire(ac.signal);
  ac.abort();
  await assert.rejects(p2, /cancelled/);
  const p3 = sem.acquire();
  r1();
  const r3 = await p3;
  r3();
  r3(); // double release is harmless
  assert.equal(sem.free, 1);
});

test('helpers', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', undefined), false);
  assert.equal(maskSecret('short'), '••••');
  assert.equal(isInside('/a/b/c', '/a/b'), true);
  assert.equal(isInside('/a/bc', '/a/b'), false);
  assert.equal(isInside('/a', '/a/b'), false);
});

test('runLines streams stdout, feeds stdin and reports failures', async () => {
  const echo = 'process.stdin.on("data", d => process.stdout.write(String(d).toUpperCase() + "\\nsecond\\n"))';
  const lines = [];
  for await (const l of runLines({ command: process.execPath, args: ['-e', echo], input: 'hello', name: 'echo' })) lines.push(l);
  assert.deepEqual(lines, ['HELLO', 'second']);

  const fail = runLines({ command: process.execPath, args: ['-e', 'console.error("boom"); process.exit(3)'], name: 'failer' });
  await assert.rejects(async () => { for await (const _ of fail) { /* drain */ } }, /failer failed: boom/);

  const slow = runLines({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], name: 'slow', timeoutMs: 200 });
  await assert.rejects(async () => { for await (const _ of slow) { /* drain */ } }, /longer than/);
});

test('antigravity parser streams text across steps and reads the result', async () => {
  const { antigravitySpec } = await import('../src/providers/cli.js');
  const st = {};
  const lines = [
    { event: 'init', init: { model: 'x', permission_mode: 'request-review' } },
    { event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } },
    { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Let me look.' } },
    { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\n' } },
    { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'read_file' } },
    { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'It is 51.' } },
    { event: 'result', result: { status: 'SUCCESS', response: 'It is 51.\n', usage: { input_tokens: 20, output_tokens: 4 } } },
  ];
  const events = lines.flatMap((l) => antigravitySpec.parseLine(JSON.stringify(l), st));
  assert.deepEqual(events, [
    { type: 'text', text: 'Let me look.' },
    { type: 'text', text: '\n\nIt is 51.' },
    { type: 'usage', inputTokens: 20, outputTokens: 4 },
  ]);
  assert.equal(st.done, true);

  const bad = {};
  antigravitySpec.parseLine('error: Error: empty prompt', bad);
  assert.throws(() => antigravitySpec.parseLine(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'quota exceeded' } }), bad), /quota exceeded/);
});

test('antigravity: prompt goes over stdin as NDJSON and access is enforced with deny rules', async () => {
  const { antigravitySpec, antigravitySettings } = await import('../src/providers/cli.js');
  const input = antigravitySpec.formatInput('hi "there"\n--model x');
  assert.deepEqual(JSON.parse(input), { event: 'user', message: { role: 'user', content: 'hi "there"\n--model x' } });
  assert.deepEqual(antigravitySettings('read-only').permissions.deny, ['write_file(*)', 'command(*)', 'mcp(*)']);
  assert.deepEqual(antigravitySettings('edit').permissions.deny, ['command(*)', 'mcp(*)']);
  assert.deepEqual(antigravitySettings('read-only').permissions.allow, []);

  const stateDir = tmp();
  const args = antigravitySpec.buildArgs({ model: 'gemini-3.8-flash-low', dirs: ['/a'], access: 'read-only', stateDir });
  const file = args[args.indexOf('--settings') + 1];
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), antigravitySettings('read-only'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.deepEqual(args.slice(-4), ['--model', 'gemini-3.8-flash-low', '--add-dir', '/a']);
});

test('antigravity provider: runs the CLI, stops as soon as the result arrives', async () => {
  const { antigravitySpec, createCliProvider } = await import('../src/providers/cli.js');
  const dir = tmp();
  const fake = path.join(dir, 'fake-agy.mjs');
  // A fake agy: echoes the prompt back, then lingers for 20s like the real one does.
  fs.writeFileSync(fake, `#!/usr/bin/env node
if (process.argv[2] === 'models') { console.log('Fetching available models...'); console.log('m-one\\tM One'); console.log('m-two\\tM Two'); process.exit(0); }
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  const msg = JSON.parse(buf.trim());
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  say({ event: 'init', init: {} });
  say({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'echo: ' + msg.message.content } });
  say({ event: 'result', result: { status: 'SUCCESS', response: 'x', usage: { input_tokens: 1, output_tokens: 2 } } });
  setTimeout(() => {}, 20000);
});
`, { mode: 0o755 });
  if (process.platform === 'win32') return; // shebang scripts need a POSIX shell
  const p = createCliProvider(antigravitySpec, { env: { ...process.env, LOCAL_AI_JAY_ANTIGRAVITY_BIN: fake } });
  assert.deepEqual(await p.models(), ['default', 'm-one', 'm-two']);
  const t0 = Date.now();
  const events = [];
  for await (const ev of p.chat({
    messages: [{ role: 'user', content: 'ping' }],
    model: null,
    settings: { workspace: dir, stateDir: dir, allowedDirs: [], access: 'read-only', timeoutMs: 15000 },
  })) events.push(ev);
  assert.ok(Date.now() - t0 < 10000, 'should not wait for the CLI to linger');
  assert.deepEqual(events, [{ type: 'text', text: 'echo: ping' }, { type: 'usage', inputTokens: 1, outputTokens: 2 }]);
});
