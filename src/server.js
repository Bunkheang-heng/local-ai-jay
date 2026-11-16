import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GatewayError, Semaphore, safeEqual, isInside, realpathOrNull, localDay } from './util.js';
import { parseModel } from './providers/index.js';
import { validateMessages } from './prompt.js';
import { pickParams, sseData, upstreamError } from './providers/openai-compat.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 25 * 1024 * 1024;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  const h = hostHeader.toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function sendError(res, status, message, code = 'gateway_error') {
  const type = status === 401 ? 'authentication_error' : status < 500 ? 'invalid_request_error' : 'api_error';
  sendJson(res, status, { error: { message, type, code } });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new GatewayError(413, 'Request body too large', 'request_too_large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GatewayError(400, 'Request body is not valid JSON', 'invalid_json');
  }
}

/**
 * Builds the gateway's request handler.
 * `config` and `store` are live objects; changes to them apply from the next request.
 */
export function createGateway({ config, store, registry, paths, version = '0.0.0', log = () => {} }) {
  const semaphores = new Map();
  const statusCache = new Map();
  const recent = [];
  const startedAt = Date.now();

  const semaphoreFor = (p) => {
    if (!semaphores.has(p.id)) semaphores.set(p.id, new Semaphore(p.maxConcurrency || config.cliConcurrency || 2));
    return semaphores.get(p.id);
  };

  async function statusOf(p, { fresh = false } = {}) {
    const hit = statusCache.get(p.id);
    if (!fresh && hit && Date.now() - hit.at < 15_000) return hit.value;
    let value;
    try { value = await p.status(); } catch (err) { value = { available: false, state: 'error', detail: err.message }; }
    statusCache.set(p.id, { at: Date.now(), value });
    return value;
  }

  function settingsFor(workdir) {
    return {
      workspace: paths.workspace,
      stateDir: paths.state,
      allowedDirs: config.allowedDirs,
      access: config.cliAccess,
      timeoutMs: (config.cliTimeoutSeconds || 600) * 1000,
      workdir,
    };
  }

  function resolveWorkdir(requested) {
    if (!requested) return null;
    const real = realpathOrNull(path.resolve(String(requested)));
    const roots = [paths.workspace, ...config.allowedDirs];
    if (!real || !roots.some((r) => isInside(real, r))) {
      throw new GatewayError(403, `workdir must be inside an allowed folder (${roots.join(', ')}). Start with --allow <dir> to add one.`, 'workdir_not_allowed');
    }
    return real;
  }

  function addRecent(entry) {
    recent.unshift(entry);
    if (recent.length > 200) recent.length = 200;
    store.record({
      provider: entry.provider,
      ok: entry.ok,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      ms: entry.ms,
    });
    log(entry);
  }

  /** Providers to try for a model name, in order. */
  async function candidatesFor(modelName) {
    const target = parseModel(modelName);
    if (!target.auto) {
      const p = registry.get(target.providerId);
      if (!p) {
        throw new GatewayError(404, `Unknown model "${modelName}". Use "<provider>/<model>", e.g. "claude-code/sonnet", or "auto". See GET /v1/models.`, 'model_not_found');
      }
      if (store.isPaused(p.id)) throw new GatewayError(503, `${p.label} is paused. Resume it in the console.`, 'provider_paused');
      return [{ provider: p, model: target.model }];
    }
    // Website providers are only used by `auto` if you list them in autoOrder yourself.
    const order = [...config.autoOrder, ...registry.list().filter((p) => p.kind !== 'web').map((p) => p.id)];
    const seen = new Set();
    const list = [];
    for (const id of order) {
      if (seen.has(id)) continue;
      seen.add(id);
      const p = registry.get(id);
      if (!p || store.isPaused(id)) continue;
      const st = await statusOf(p);
      if (st.available) list.push({ provider: p, model: null });
    }
    if (!list.length) {
      throw new GatewayError(503, 'No provider is ready. Install and sign in to a CLI, start Ollama/LM Studio, or add an API key in the console.', 'no_provider');
    }
    return list;
  }

  // ---------------- /v1/chat/completions ----------------
  async function chatCompletions(req, res) {
    const body = await readJsonBody(req);
    validateMessages(body.messages);
    const stream = body.stream === true;
    const wantUsage = body.stream_options?.include_usage === true;
    const workdir = resolveWorkdir(body.workdir || req.headers['x-workdir']);
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });

    const candidates = await candidatesFor(body.model);
    const single = candidates.length === 1 ? candidates[0] : null;
    if (single && typeof single.provider.fetchChat === 'function' && !parseModel(body.model).auto) {
      return proxyChat(single.provider, single.model, body, res, ac);
    }

    const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    let headersSent = false;
    let lastWrite = Date.now();
    let publicModel = '';
    const write = (s) => { res.write(s); lastWrite = Date.now(); };
    const chunk = (delta, finish = null, extra = {}) => ({
      id, object: 'chat.completion.chunk', created, model: publicModel,
      choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
    });
    const startStream = () => {
      if (headersSent) return;
      headersSent = true;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      write(': local-ai-jay\n\n');
    };
    // CLIs can take a while before their first token; keep clients from timing out.
    const keepAlive = stream ? setInterval(() => {
      if (!headersSent && Date.now() - lastWrite > 8000) startStream();
      else if (headersSent && Date.now() - lastWrite > 15_000) write(': ping\n\n');
    }, 2000) : null;

    try {
      for (let i = 0; i < candidates.length; i++) {
        const { provider, model } = candidates[i];
        publicModel = `${provider.id}/${model || 'default'}`;
        const t0 = Date.now();
        let emitted = false;
        let text = '';
        let reasoning = '';
        let usage = null;
        let roleSent = false;
        let release = () => {};
        try {
          if (provider.kind === 'cli' || provider.kind === 'web') release = await semaphoreFor(provider).acquire(ac.signal);
          const events = provider.chat({
            messages: body.messages, model, signal: ac.signal, params: pickParams(body), settings: settingsFor(workdir),
          });
          for await (const ev of events) {
            if (ev.type === 'usage') { usage = ev; continue; }
            if (ev.type === 'final') { text = ev.text; continue; }
            if (ev.type !== 'text' && ev.type !== 'reasoning') continue;
            emitted = true;
            if (ev.type === 'text') text += ev.text; else reasoning += ev.text;
            if (stream) {
              startStream();
              if (!roleSent) { write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`); roleSent = true; }
              const delta = ev.type === 'text' ? { content: ev.text } : { reasoning_content: ev.text };
              write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
            }
          }
          const ms = Date.now() - t0;
          const u = {
            prompt_tokens: usage?.inputTokens || 0,
            completion_tokens: usage?.outputTokens || 0,
          };
          u.total_tokens = u.prompt_tokens + u.completion_tokens;
          addRecent({
            at: new Date().toISOString(), model: publicModel, provider: provider.id, ok: true, status: 200, ms,
            inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, stream, fallbackFrom: i ? candidates[0].provider.id : undefined,
          });
          if (stream) {
            startStream();
            if (!roleSent) write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`);
            write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
            if (wantUsage) write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: publicModel, choices: [], usage: u })}\n\n`);
            write('data: [DONE]\n\n');
            res.end();
          } else {
            const message = { role: 'assistant', content: text };
            if (reasoning) message.reasoning_content = reasoning;
            sendJson(res, 200, {
              id, object: 'chat.completion', created, model: publicModel,
              choices: [{ index: 0, message, finish_reason: 'stop' }],
              usage: u,
            });
          }
          return;
        } catch (err) {
          const status = err.status || 502;
          addRecent({
            at: new Date().toISOString(), model: publicModel, provider: provider.id, ok: false, status,
            ms: Date.now() - t0, error: err.message, stream,
          });
          if (ac.signal.aborted) { res.destroy(); return; }
          const canFallback = !emitted && i < candidates.length - 1;
          if (canFallback) continue;
          if (headersSent) {
            write(`data: ${JSON.stringify({ error: { message: err.message, type: 'api_error', code: err.code || 'provider_error' } })}\n\n`);
            write('data: [DONE]\n\n');
            res.end();
          } else {
            sendError(res, status, err.message, err.code);
          }
          return;
        } finally {
          release();
        }
      }
    } finally {
      if (keepAlive) clearInterval(keepAlive);
    }
  }

  /** Passes a request straight through to an OpenAI-compatible provider (tools, images, JSON mode all work). */
  async function proxyChat(provider, model, body, res, ac) {
    const t0 = Date.now();
    if (provider.needsKey && !provider.keySource()) {
      throw new GatewayError(503, `${provider.label} has no API key. Add one in the console (Providers)${provider.envKey ? ` or set ${provider.envKey}` : ''}.`, 'provider_no_key');
    }
    const chosen = model || (await provider.defaultModel());
    if (!chosen) throw new GatewayError(503, `${provider.label} has no models available`, 'provider_unavailable');
    const publicModel = `${provider.id}/${chosen}`;
    const wantUsage = body.stream_options?.include_usage === true;
    const upstreamBody = { ...body, model: chosen };
    delete upstreamBody.workdir;
    if (body.stream && provider.streamUsage) upstreamBody.stream_options = { ...(body.stream_options || {}), include_usage: true };

    const done = (ok, status, usage, error) => addRecent({
      at: new Date().toISOString(), model: publicModel, provider: provider.id, ok, status, ms: Date.now() - t0,
      inputTokens: usage?.prompt_tokens || 0, outputTokens: usage?.completion_tokens || 0, error, stream: !!body.stream,
    });

    let upstream;
    try {
      upstream = await provider.fetchChat(upstreamBody, ac.signal);
    } catch (err) {
      if (ac.signal.aborted) { done(false, 499, null, 'cancelled'); res.destroy(); return; }
      const e = new GatewayError(502, `${provider.label}: ${err.cause?.code === 'ECONNREFUSED' ? `not running at ${provider.baseUrl()}` : err.message}`, 'provider_unavailable');
      done(false, 502, null, e.message);
      throw e;
    }
    if (!upstream.ok) {
      const e = await upstreamError(upstream, provider.label);
      done(false, e.status, null, e.message);
      throw e;
    }

    if (!body.stream) {
      const j = await upstream.json();
      j.model = publicModel;
      done(true, 200, j.usage);
      sendJson(res, 200, j);
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let usage = null;
    try {
      for await (const data of sseData(upstream.body)) {
        if (data === '[DONE]') break;
        let o;
        try { o = JSON.parse(data); } catch { continue; }
        if (o.usage) usage = o.usage;
        if (!wantUsage && o.usage && !(o.choices?.length)) continue;
        if (!wantUsage && o.usage) delete o.usage;
        if (o.model) o.model = publicModel;
        res.write(`data: ${JSON.stringify(o)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      done(true, 200, usage);
    } catch (err) {
      done(false, 502, usage, err.message);
      if (ac.signal.aborted) { res.destroy(); return; }
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'api_error' } })}\n\n`);
      res.end();
    }
  }

  // ---------------- /v1/models ----------------
  async function listModels() {
    const data = [{ id: 'auto', object: 'model', created: 0, owned_by: 'local-ai-jay' }];
    const providers = registry.list();
    const lists = await Promise.all(providers.map(async (p) => {
      if (store.isPaused(p.id)) return [];
      const st = await statusOf(p);
      if (!st.available) return [];
      try { return await p.models(); } catch { return []; }
    }));
    providers.forEach((p, i) => {
      for (const m of lists[i]) data.push({ id: `${p.id}/${m}`, object: 'model', created: 0, owned_by: p.id });
    });
    return { object: 'list', data };
  }

  // ---------------- console API ----------------
  async function providerView(p, fresh) {
    const st = await statusOf(p, { fresh });
    return {
      id: p.id,
      label: p.label,
      kind: p.kind,
      available: st.available,
      state: store.isPaused(p.id) ? 'paused' : st.state,
      detail: st.detail,
      paused: store.isPaused(p.id),
      needsKey: !!p.needsKey,
      envKey: p.envKey || null,
      keyUrl: p.keyUrl || p.installHint || null,
      key: p.needsKey ? store.keyInfo(p.id) : null,
      keySource: p.keySource ? p.keySource() : null,
    };
  }

  async function testProvider(p) {
    const t0 = Date.now();
    let reply = '';
    let usage = null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120_000);
    let release = () => {};
    try {
      if (p.kind === 'cli' || p.kind === 'web') release = await semaphoreFor(p).acquire(ac.signal);
      const events = p.chat({
        messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }],
        model: null, signal: ac.signal, params: { max_tokens: 20 }, settings: settingsFor(null),
      });
      for await (const ev of events) {
        if (ev.type === 'text') reply += ev.text;
        if (ev.type === 'final') reply = ev.text;
        if (ev.type === 'usage') usage = ev;
      }
      const ms = Date.now() - t0;
      addRecent({ at: new Date().toISOString(), model: `${p.id}/default`, provider: p.id, ok: true, status: 200, ms, inputTokens: usage?.inputTokens || 0, outputTokens: usage?.outputTokens || 0, test: true });
      return { ok: true, ms, reply: reply.trim().slice(0, 200) };
    } catch (err) {
      const message = ac.signal.aborted ? 'No answer within 2 minutes' : err.message;
      addRecent({ at: new Date().toISOString(), model: `${p.id}/default`, provider: p.id, ok: false, status: err.status || 502, ms: Date.now() - t0, error: message, test: true });
      return { ok: false, ms: Date.now() - t0, error: message };
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  function usageView() {
    const u = store.usage();
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = localDay(d);
      const per = u.days[key] || {};
      let requests = 0, errors = 0, tokens = 0;
      for (const c of Object.values(per)) { requests += c.requests; errors += c.errors; tokens += c.inputTokens + c.outputTokens; }
      days.push({ day: key, requests, errors, tokens });
    }
    return { totals: u.totals, providers: u.providers, days, recent: recent.slice(0, 100) };
  }

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const method = req.method;

    if (method === 'GET' && parts[1] === 'info') {
      return sendJson(res, 200, {
        name: 'local-ai-jay', version, home: paths.home, workspace: paths.workspace,
        allowedDirs: config.allowedDirs, cliAccess: config.cliAccess, cors: !!config.cors,
        startedAt: new Date(startedAt).toISOString(), node: process.version, platform: process.platform,
      });
    }
    if (method === 'GET' && parts[1] === 'providers' && parts.length === 2) {
      const fresh = url.searchParams.get('fresh') === '1';
      return sendJson(res, 200, { providers: await Promise.all(registry.list().map((p) => providerView(p, fresh))) });
    }
    if (parts[1] === 'providers' && parts[2]) {
      const p = registry.get(parts[2]);
      if (!p) return sendError(res, 404, `No provider "${parts[2]}"`);
      const action = parts[3];
      if (method === 'POST' && action === 'pause') { store.setPaused(p.id, true); return sendJson(res, 200, await providerView(p)); }
      if (method === 'POST' && action === 'resume') { store.setPaused(p.id, false); return sendJson(res, 200, await providerView(p)); }
      if (method === 'POST' && action === 'test') return sendJson(res, 200, await testProvider(p));
      if (method === 'GET' && action === 'models') return sendJson(res, 200, { models: await p.models() });
      if (action === 'key') {
        if (!p.needsKey) return sendError(res, 400, `${p.label} doesn't use an API key`);
        if (method === 'PUT') {
          const { key } = await readJsonBody(req);
          const value = typeof key === 'string' ? key.trim() : '';
          if (value.length < 8 || /\s/.test(value)) return sendError(res, 400, 'That doesn\'t look like an API key');
          try {
            await p.validateKey(value);
          } catch (err) {
            return sendError(res, 400, `The provider rejected this key: ${err.message}`, 'invalid_key');
          }
          store.setKey(p.id, value);
          statusCache.delete(p.id);
          return sendJson(res, 200, await providerView(p, true));
        }
        if (method === 'DELETE') { store.removeKey(p.id); statusCache.delete(p.id); return sendJson(res, 200, await providerView(p, true)); }
        if (method === 'POST') {
          const { enabled } = await readJsonBody(req);
          if (!store.setKeyEnabled(p.id, enabled)) return sendError(res, 404, 'No key saved for this provider');
          statusCache.delete(p.id);
          return sendJson(res, 200, await providerView(p, true));
        }
      }
    }
    if (method === 'GET' && parts[1] === 'usage') return sendJson(res, 200, usageView());
    if (method === 'DELETE' && parts[1] === 'usage') { store.resetUsage(); recent.length = 0; return sendJson(res, 200, usageView()); }
    return sendError(res, 404, 'Not found');
  }

  function serveStatic(req, res, url) {
    const entry = STATIC[url.pathname];
    if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) return sendError(res, 404, 'Not found');
    const file = path.join(PUBLIC_DIR, entry[0]);
    let body;
    try { body = fs.readFileSync(file); } catch { return sendError(res, 404, 'Not found'); }
    res.writeHead(200, {
      'content-type': entry[1],
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function authorized(req) {
    const auth = req.headers.authorization || '';
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const key = bearer || req.headers['x-api-key'] || '';
    return safeEqual(String(key), config.apiKey);
  }

  async function handler(req, res) {
    try {
      // Only answer to localhost names: blocks DNS-rebinding attacks from web pages.
      if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host)) && !(config.allowedHosts || []).includes(hostnameOf(req.headers.host))) {
        return sendError(res, 403, 'Host not allowed', 'forbidden_host');
      }
      const url = new URL(req.url, 'http://localhost');
      const isApi = url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/');

      if (config.cors && url.pathname.startsWith('/v1/')) {
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, x-workdir');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      }

      if (url.pathname === '/health') return sendJson(res, 200, { ok: true, name: 'local-ai-jay', version });
      if (!isApi) return serveStatic(req, res, url);
      if (!authorized(req)) return sendError(res, 401, 'Missing or wrong API key. Run `npx local-ai-jay key` to see it.', 'invalid_api_key');

      if (url.pathname === '/v1/models' && req.method === 'GET') return sendJson(res, 200, await listModels());
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return await chatCompletions(req, res);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return sendError(res, 404, `No route for ${req.method} ${url.pathname}`);
    } catch (err) {
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
      const status = err.status || 500;
      sendError(res, status, status === 500 ? `Internal error: ${err.message}` : err.message, err.code);
    }
  }

  return { handler, statusOf, recent };
}

export function listen(handler, { port, host = '127.0.0.1', tryNext = true } = {}) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const server = http.createServer(handler);
    server.requestTimeout = 0; // long CLI runs
    server.headersTimeout = 60_000;
    const tryListen = (p) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && tryNext && attempt < 20) {
          attempt++;
          tryListen(p + 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, host, () => resolve({ server, port: server.address().port }));
    };
    tryListen(port);
  });
}
