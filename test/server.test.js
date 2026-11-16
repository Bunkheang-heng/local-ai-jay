import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createGateway, listen } from '../src/server.js';
import { registryFrom } from '../src/providers/index.js';
import { createOpenAICompatProvider } from '../src/providers/openai-compat.js';
import { Store } from '../src/store.js';
import { getPaths } from '../src/paths.js';
import { loadConfig } from '../src/config.js';

function fakeCli(id, { reply = 'pong', fail = false, available = true } = {}) {
  return {
    id,
    label: id,
    kind: 'cli',
    async status() { return available ? { available: true, state: 'ready', detail: 'fake' } : { available: false, state: 'not_installed', detail: '' }; },
    async models() { return ['default', 'big']; },
    async *chat({ model }) {
      if (fail) throw Object.assign(new Error(`${id} broke`), { status: 502 });
      yield { type: 'reasoning', text: 'thinking…' };
      for (const ch of `${reply}${model ? `:${model}` : ''}`) yield { type: 'text', text: ch };
      yield { type: 'usage', inputTokens: 7, outputTokens: 3 };
    },
  };
}

// A tiny fake OpenAI-compatible upstream for the pass-through path.
let upstream;
let upstreamUrl;
let lastUpstreamBody;
before(async () => {
  upstream = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'm-small' }, { id: 'm-big' }] }));
    }
    let body = '';
    for await (const c of req) body += c;
    lastUpstreamBody = JSON.parse(body);
    if (lastUpstreamBody.model === 'bad') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'no such model' } }));
    }
    if (lastUpstreamBody.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'x', model: 'm-big', choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'x', model: 'm-big', choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', model: lastUpstreamBody.model, choices: [{ index: 0, message: { role: 'assistant', content: 'hi', tool_calls: [{ id: 't1' }] } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    }
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
});
after(() => upstream.close());

async function startGateway(providers) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-srv-'));
  const paths = getPaths(home);
  const { config } = loadConfig(paths);
  const store = new Store(paths.state);
  const gw = createGateway({ config, store, registry: registryFrom(providers), paths, version: 'test' });
  const { server, port } = await listen(gw.handler, { port: 0, tryNext: false });
  const base = `http://127.0.0.1:${port}`;
  const call = (p, opts = {}) => fetch(base + p, {
    ...opts,
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  return { server, base, call, config, store };
}

test('auth, host check, health and static console', async () => {
  const g = await startGateway([fakeCli('fake')]);
  try {
    assert.equal((await fetch(`${g.base}/health`)).status, 200);
    assert.equal((await fetch(`${g.base}/v1/models`)).status, 401);
    assert.equal((await fetch(`${g.base}/v1/models`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await g.call('/v1/models')).status, 200);
    assert.equal((await g.call('/v1/models', { headers: { authorization: '', 'x-api-key': g.config.apiKey } })).status, 200);

    const page = await fetch(`${g.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await fetch(`${g.base}/../package.json`)).status, 404);

    // DNS rebinding: a request whose Host isn't localhost is refused.
    const status = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: new URL(g.base).port, path: '/health', headers: { host: 'evil.example:80' } }, (res) => resolve(res.statusCode));
      req.end();
    });
    assert.equal(status, 403);
  } finally { g.server.close(); }
});

test('/v1/models lists available, unpaused providers plus auto', async () => {
  const g = await startGateway([fakeCli('a'), fakeCli('b', { available: false }), fakeCli('c')]);
  try {
    g.store.setPaused('c', true);
    const { data } = await (await g.call('/v1/models')).json();
    assert.deepEqual(data.map((m) => m.id), ['auto', 'a/default', 'a/big']);
  } finally { g.server.close(); }
});

test('non-streaming chat returns an OpenAI-shaped completion', async () => {
  const g = await startGateway([fakeCli('fake')]);
  try {
    const res = await g.call('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'fake/big', messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.object, 'chat.completion');
    assert.equal(j.model, 'fake/big');
    assert.equal(j.choices[0].message.content, 'pong:big');
    assert.equal(j.choices[0].message.reasoning_content, 'thinking…');
    assert.deepEqual(j.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    const usage = await (await g.call('/api/usage')).json();
    assert.equal(usage.totals.requests, 1);
    assert.equal(usage.recent[0].model, 'fake/big');
  } finally { g.server.close(); }
});

test('streaming chat sends SSE chunks, usage and [DONE]', async () => {
  const g = await startGateway([fakeCli('fake')]);
  try {
    const res = await g.call('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'fake', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    const chunks = text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    assert.equal(chunks.at(-1), '[DONE]');
    const objs = chunks.slice(0, -1).map((c) => JSON.parse(c));
    assert.equal(objs[0].choices[0].delta.role, 'assistant');
    assert.equal(objs.map((o) => o.choices[0]?.delta?.content || '').join(''), 'pong');
    assert.equal(objs.at(-2).choices[0].finish_reason, 'stop');
    assert.equal(objs.at(-1).usage.total_tokens, 10);
  } finally { g.server.close(); }
});

test('auto falls back to the next provider when one fails', async () => {
  const g = await startGateway([fakeCli('broken', { fail: true }), fakeCli('good', { reply: 'ok' })]);
  g.config.autoOrder = ['broken', 'good'];
  try {
    const j = await (await g.call('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }) })).json();
    assert.equal(j.model, 'good/default');
    assert.equal(j.choices[0].message.content, 'ok');
  } finally { g.server.close(); }
});

test('errors: unknown model, paused provider, bad JSON, bad workdir', async () => {
  const g = await startGateway([fakeCli('fake')]);
  try {
    const post = (body) => g.call('/v1/chat/completions', { method: 'POST', body });
    const msg = [{ role: 'user', content: 'hi' }];
    let r = await post(JSON.stringify({ model: 'nope/x', messages: msg }));
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error.code, 'model_not_found');
    g.store.setPaused('fake', true);
    assert.equal((await post(JSON.stringify({ model: 'fake', messages: msg }))).status, 503);
    g.store.setPaused('fake', false);
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post(JSON.stringify({ model: 'fake', messages: [] }))).status, 400);
    r = await post(JSON.stringify({ model: 'fake', messages: msg, workdir: '/' }));
    assert.equal(r.status, 403);
  } finally { g.server.close(); }
});

test('console API: pause, resume, test', async () => {
  const g = await startGateway([fakeCli('fake')]);
  try {
    let p = await (await g.call('/api/providers/fake/pause', { method: 'POST' })).json();
    assert.equal(p.state, 'paused');
    p = await (await g.call('/api/providers/fake/resume', { method: 'POST' })).json();
    assert.equal(p.state, 'ready');
    const t = await (await g.call('/api/providers/fake/test', { method: 'POST' })).json();
    assert.equal(t.ok, true);
    assert.equal(t.reply, 'pong');
  } finally { g.server.close(); }
});

test('OpenAI-compatible providers are proxied (tools etc. pass through)', async () => {
  const prov = createOpenAICompatProvider({ id: 'up', label: 'Up', kind: 'local', needsKey: false, baseUrl: upstreamUrl, preferredModels: ['m-big'] });
  const g = await startGateway([prov]);
  try {
    let j = await (await g.call('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'up', tools: [{ type: 'function', function: { name: 'f' } }], messages: [{ role: 'user', content: 'hi' }] }),
    })).json();
    assert.equal(lastUpstreamBody.model, 'm-big');
    assert.equal(lastUpstreamBody.tools[0].function.name, 'f');
    assert.equal(j.model, 'up/m-big');
    assert.equal(j.choices[0].message.tool_calls[0].id, 't1');

    // Streaming: usage chunk is dropped unless the client asked for it.
    const text = await (await g.call('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ model: 'up/m-big', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })).text();
    assert.equal(lastUpstreamBody.stream_options.include_usage, true);
    assert.doesNotMatch(text, /"usage"/);
    assert.match(text, /"model":"up\/m-big"/);
    assert.match(text, /data: \[DONE\]/);

    const bad = await g.call('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'up/bad', messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(bad.status, 400);
    j = await bad.json();
    assert.match(j.error.message, /no such model/);

    const usage = await (await g.call('/api/usage')).json();
    assert.equal(usage.providers.up.requests, 3);
    assert.equal(usage.providers.up.errors, 1);
    assert.equal(usage.providers.up.inputTokens, 4);
  } finally { g.server.close(); }
});

test('cloud keys: checked before saving, several at once, only shown masked', async () => {
  let storeRef;
  const prov = createOpenAICompatProvider(
    { id: 'cloudy', label: 'Cloudy', baseUrl: upstreamUrl, envKey: 'CLOUDY_TEST_KEY' },
    { getKeys: (id) => storeRef.getKeys(id) },
  );
  const g = await startGateway([prov]);
  storeRef = g.store;
  try {
    let p = (await (await g.call('/api/providers')).json()).providers[0];
    assert.equal(p.state, 'no_key');
    const put = await g.call('/api/providers/cloudy/key', { method: 'PUT', body: JSON.stringify({ keys: ['sk-test-1234567890', 'sk-test-abcdefghij', 'sk-test-1234567890', 'bad'] }) });
    p = await put.json();
    assert.equal(put.status, 200);
    assert.equal(p.state, 'ready');
    assert.deepEqual(p.key.map((k) => k.masked), ['sk-t…7890', 'sk-t…ghij']);
    assert.deepEqual(p.results.map((r) => r.ok), [true, true, false]);
    assert.doesNotMatch(JSON.stringify(p), /sk-test-1234567890|sk-test-abcdefghij/);
    assert.match(p.detail, /2 keys/);

    p = await (await g.call(`/api/providers/cloudy/key/${p.key[0].id}`, { method: 'POST', body: JSON.stringify({ enabled: false }) })).json();
    assert.deepEqual(p.key.map((k) => k.enabled), [false, true]);
    p = await (await g.call(`/api/providers/cloudy/key/${p.key[0].id}`, { method: 'DELETE' })).json();
    assert.equal(p.key.length, 1);
    p = await (await g.call('/api/providers/cloudy/key', { method: 'DELETE' })).json();
    assert.equal(p.state, 'no_key');
    assert.equal((await g.call('/api/providers/cloudy/key', { method: 'PUT', body: JSON.stringify({ key: 'x' }) })).status, 400);
  } finally { g.server.close(); }
});

test('remote hosts: only listed addresses/names are accepted; missing addresses are retried', async () => {
  const { listenExtra } = await import('../src/server.js');
  const g = await startGateway([fakeCli('fake')]);
  const port = new URL(g.base).port;
  const status = (host) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  try {
    assert.equal(await status('100.126.100.24:3000'), 403);
    g.config.hosts = ['100.126.100.24'];
    g.config.allowedHosts = ['yourbox.tail1234.ts.net'];
    assert.equal(await status('100.126.100.24:3000'), 200);
    assert.equal(await status('YOURBOX.tail1234.ts.net'), 200);
    assert.equal(await status('evil.example'), 403);

    // 192.0.2.1 is a documentation address that no machine has: listen fails and is retried.
    const errors = [];
    const servers = listenExtra(() => {}, { port: 0, hosts: ['192.0.2.1'], log: (h, e) => errors.push([h, e?.code]) });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(errors, [['192.0.2.1', 'EADDRNOTAVAIL']]);
    servers.forEach((s) => s.close());
  } finally { g.server.close(); }
});
