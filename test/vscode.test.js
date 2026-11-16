import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createGateway, listen } from '../src/server.js';
import { registryFrom } from '../src/providers/index.js';
import { Store } from '../src/store.js';
import { getPaths } from '../src/paths.js';
import { loadConfig, saveConfig } from '../src/config.js';

const require = createRequire(import.meta.url);
const { Gateway, homeDir } = require('../vscode/lib/gateway.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const fake = {
  id: 'fake',
  label: 'Fake',
  kind: 'cli',
  async status() { return { available: true, state: 'ready', detail: 'fake' }; },
  async models() { return ['default']; },
  async *chat() {
    yield { type: 'reasoning', text: 'hmm' };
    for (const ch of 'hello') yield { type: 'text', text: ch };
    yield { type: 'usage', inputTokens: 4, outputTokens: 5 };
  },
};

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function startGateway() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-vsc-'));
  const paths = getPaths(home);
  const { config } = loadConfig(paths);
  const gw = createGateway({ config, store: new Store(paths.state), registry: registryFrom([fake]), paths, version: 'test' });
  const { server, port } = await listen(gw.handler, { port: 0, tryNext: false });
  servers.push(server);
  config.port = port;
  saveConfig(paths, config);
  return { home, port, key: config.apiKey };
}

async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

for (const file of ['markdown.js', 'model-menu.js']) {
  test(`extension ships the same ${file} as the web console`, () => {
    const web = fs.readFileSync(path.join(root, 'public', file), 'utf8');
    const ext = fs.readFileSync(path.join(root, 'vscode', 'media', file), 'utf8');
    assert.equal(ext, web, `run \`npm run sync\` in vscode/ to copy public/${file}`);
  });
}

test('model menu names models by provider', async () => {
  const { describeModel, providerLabel } = await import('../public/model-menu.js');
  assert.deepEqual(describeModel('claude-code/sonnet', 'claude-code'), { name: 'sonnet', provider: 'Claude Code', detail: 'claude-code/sonnet' });
  assert.equal(describeModel('openrouter/meta/llama-3', 'openrouter').name, 'meta/llama-3');
  assert.equal(describeModel('auto').name, 'Auto');
  assert.equal(describeModel('mystery/x').provider, 'mystery');
  assert.equal(providerLabel('lmstudio'), 'LM Studio');
});

test('homeDir: setting, then env, then ~/.local-ai-jay', () => {
  assert.equal(homeDir('/x/y', {}), path.resolve('/x/y'));
  assert.equal(homeDir('', { LOCAL_AI_JAY_HOME: '/e' }), path.resolve('/e'));
  assert.equal(homeDir('', {}), path.join(os.homedir(), '.local-ai-jay'));
});

test('connect finds the gateway from its config file alone', async () => {
  const { home, port } = await startGateway();
  const g = new Gateway(() => ({ home }));
  const st = await g.connect();
  assert.equal(st.ok, true);
  assert.equal(st.version, 'test');
  assert.equal(g.base, `http://127.0.0.1:${port}`);
  assert.match(g.consoleUrl('providers'), /#key=jay-[\w-]+&tab=providers$/);
  const models = await g.models();
  assert.ok(models.some((m) => m.id === 'auto'));
});

test('connect reports a missing config, a wrong key and a stopped gateway', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-vsc-none-'));
  assert.equal((await new Gateway(() => ({ home: empty })).connect()).reason, 'no_config');

  const { home, port } = await startGateway();
  const bad = await new Gateway(() => ({ home, apiKey: 'jay-wrong-key-wrong-key-wrong' })).connect();
  assert.equal(bad.reason, 'bad_key');

  const free = await closedPort();
  const down = await new Gateway(() => ({ home, url: `http://127.0.0.1:${free}/v1` })).connect();
  assert.equal(down.reason, 'not_running');
  assert.ok(port);
});

test('chat streams reasoning, text and usage', async () => {
  const { home } = await startGateway();
  const g = new Gateway(() => ({ home }));
  await g.connect();
  let text = '';
  let reasoning = '';
  let usage = null;
  let model = '';
  for await (const p of g.chat({ model: 'fake', messages: [{ role: 'user', content: 'hi' }] })) {
    text += p.content || '';
    reasoning += p.reasoning || '';
    if (p.usage) usage = p.usage;
    if (p.model) model = p.model;
  }
  assert.equal(text, 'hello');
  assert.equal(reasoning, 'hmm');
  assert.equal(usage.completion_tokens, 5);
  assert.match(model, /^fake/);
});

test('chat surfaces the gateway error code for a folder that is not allowed', async () => {
  const { home } = await startGateway();
  const g = new Gateway(() => ({ home }));
  await g.connect();
  await assert.rejects(async () => {
    for await (const _ of g.chat({ model: 'fake', messages: [{ role: 'user', content: 'hi' }], workdir: os.tmpdir() })) { /* drain */ }
  }, (err) => err.code === 'workdir_not_allowed' && err.status === 403);
});
