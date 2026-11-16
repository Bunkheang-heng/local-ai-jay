// Talks to a running local-ai-jay gateway. No VS Code APIs here, so it can be tested with plain Node.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

/** Same rules as the gateway: a setting wins, then $LOCAL_AI_JAY_HOME, then ~/.local-ai-jay. */
function homeDir(override, env = process.env) {
  if (override) return path.resolve(expandHome(override));
  if (env.LOCAL_AI_JAY_HOME) return path.resolve(env.LOCAL_AI_JAY_HOME);
  return path.join(os.homedir(), '.local-ai-jay');
}

function readLocalConfig(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { return null; }
}

class GatewayError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Splits an SSE byte stream into parsed `data:` JSON objects. */
async function* sseObjects(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch { /* skip partial or odd lines */ }
    }
  }
}

class Gateway {
  /** `settings()` returns { url, apiKey, home } from the user's settings (all optional). */
  constructor(settings) {
    this.settings = settings;
    this.base = null;
    this.key = null;
  }

  /**
   * Finds the gateway. Resolves to { ok: true, version } or { ok: false, reason, message }
   * where reason is 'no_config' (never started), 'not_running' or 'bad_key'.
   */
  async connect() {
    const s = this.settings() || {};
    const home = homeDir(s.home);
    const local = readLocalConfig(home);
    const key = (s.apiKey || '').trim() || local?.apiKey;
    if (!key) {
      return { ok: false, reason: 'no_config', message: `local-ai-jay hasn't been started on this computer yet (no key in ${home}).` };
    }
    const url = (s.url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
    const port = Number(local?.port) || 3000;
    const bases = url ? [url] : Array.from({ length: 10 }, (_, n) => `http://127.0.0.1:${port + n}`);
    let sawBadKey = false;
    for (const base of bases) {
      let res;
      try {
        res = await fetch(`${base}/api/info`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(1500) });
      } catch { continue; }
      if (res.status === 401) { sawBadKey = true; continue; }
      if (!res.ok) continue;
      const info = await res.json().catch(() => null);
      if (!info || !info.version) continue;
      this.base = base;
      this.key = key;
      return { ok: true, version: info.version, base };
    }
    this.base = null;
    if (sawBadKey) return { ok: false, reason: 'bad_key', message: 'local-ai-jay is running but did not accept the API key.' };
    return { ok: false, reason: 'not_running', message: url ? `Nothing answered at ${url}.` : `local-ai-jay isn't running (looked on ports ${port}–${port + 9}).` };
  }

  #headers() {
    return { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' };
  }

  async #errorFrom(res) {
    const j = await res.json().catch(() => ({}));
    return new GatewayError(j.error?.message || `${res.status} ${res.statusText}`, j.error?.code, res.status);
  }

  async models() {
    if (!this.base) throw new GatewayError('Not connected', 'not_connected');
    const res = await fetch(`${this.base}/v1/models`, { headers: this.#headers(), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw await this.#errorFrom(res);
    const { data } = await res.json();
    return data || [];
  }

  /**
   * Streams one chat reply. Yields { content?, reasoning?, model?, usage? } pieces.
   * Throws GatewayError (with .code from the gateway) on failure.
   */
  async* chat({ model, messages, workdir, signal }) {
    if (!this.base) throw new GatewayError('Not connected', 'not_connected');
    const body = { model: model || 'auto', messages, stream: true, stream_options: { include_usage: true } };
    if (workdir) body.workdir = workdir;
    const res = await fetch(`${this.base}/v1/chat/completions`, { method: 'POST', headers: this.#headers(), body: JSON.stringify(body), signal });
    if (!res.ok) throw await this.#errorFrom(res);
    for await (const o of sseObjects(res.body)) {
      if (o.error) throw new GatewayError(o.error.message, o.error.code);
      const d = o.choices?.[0]?.delta || {};
      const piece = {};
      if (o.model) piece.model = o.model;
      if (o.usage) piece.usage = o.usage;
      if (d.content) piece.content = d.content;
      if (d.reasoning_content || d.reasoning) piece.reasoning = d.reasoning_content || d.reasoning;
      if (Object.keys(piece).length) yield piece;
    }
  }

  consoleUrl(tab) {
    if (!this.base) return null;
    return `${this.base}/#key=${this.key}${tab ? `&tab=${tab}` : ''}`;
  }
}

module.exports = { Gateway, GatewayError, homeDir, readLocalConfig, sseObjects };
