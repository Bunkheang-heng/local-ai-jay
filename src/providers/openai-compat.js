import { GatewayError } from '../util.js';

// Request fields passed through to OpenAI-compatible providers when routing through the event path.
const PASSTHROUGH = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'seed', 'presence_penalty', 'frequency_penalty', 'reasoning_effort'];

export function pickParams(body = {}) {
  const out = {};
  for (const k of PASSTHROUGH) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

/** Yields the `data:` payload of each server-sent event in a fetch body. */
export async function* sseData(body) {
  const decoder = new TextDecoder();
  let buf = '';
  let data = [];
  const flushLine = function* (line) {
    if (line === '') {
      if (data.length) { yield data.join('\n'); data = []; }
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  };
  for await (const chunk of body) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      yield* flushLine(line);
    }
  }
  buf += decoder.decode();
  if (buf) yield* flushLine(buf.replace(/\r$/, ''));
  yield* flushLine('');
}

export async function upstreamError(res, label) {
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  let message = text;
  try {
    const j = JSON.parse(text);
    message = j.error?.message || j.message || j.error || text;
    if (Array.isArray(j) && j[0]?.error?.message) message = j[0].error.message;
  } catch { /* not json */ }
  if (typeof message !== 'string') message = JSON.stringify(message);
  message = (message || res.statusText || `HTTP ${res.status}`).slice(0, 500);
  const status = res.status >= 500 ? 502 : res.status;
  return new GatewayError(status, `${label}: ${message}`, res.status === 401 || res.status === 403 ? 'provider_auth_error' : 'provider_error');
}

/**
 * A provider that speaks the OpenAI chat-completions protocol: cloud APIs and local servers
 * like Ollama and LM Studio.
 */
export function createOpenAICompatProvider(spec, { getKeys = () => [], fetchImpl = globalThis.fetch } = {}) {
  const {
    id, label, kind = 'cloud', needsKey = true, envKey, keyUrl, preferredModels = [],
    streamUsage = true, extraHeaders = {},
  } = spec;
  const base = () => (typeof spec.baseUrl === 'function' ? spec.baseUrl() : spec.baseUrl).replace(/\/+$/, '');
  // Keys from the console, else from the environment (several allowed, comma-separated).
  const keys = () => {
    const saved = getKeys(id) || [];
    if (saved.length) return saved;
    const env = envKey ? process.env[envKey] : '';
    return env ? env.split(',').map((k) => k.trim()).filter(Boolean) : [];
  };
  const key = () => keys()[0] || null;

  // Keys take turns. A key that hits a rate limit (429) or is rejected (401/403) rests for a while
  // and the request moves on to the next key, so callers only see an error when every key fails.
  let turn = 0;
  const resting = new Map(); // key -> rest-until (ms)
  function keysInTurn() {
    const list = keys();
    if (!list.length) return [null];
    const start = turn++ % list.length;
    const rotated = [...list.slice(start), ...list.slice(0, start)];
    const now = Date.now();
    const ready = rotated.filter((k) => !(resting.get(k) > now));
    const tired = rotated.filter((k) => resting.get(k) > now).sort((a, b) => resting.get(a) - resting.get(b));
    return [...ready, ...tired];
  }
  function rest(k, res) {
    if (!k) return;
    const after = Number(res.headers?.get?.('retry-after'));
    const ms = res.status === 429 ? (after > 0 ? Math.min(after, 3600) * 1000 : 60_000) : 10 * 60_000;
    resting.set(k, Date.now() + ms);
  }

  let modelCache = { at: 0, list: null };

  function headers(k) {
    const h = { 'content-type': 'application/json', ...extraHeaders };
    if (k) h.authorization = `Bearer ${k}`;
    return h;
  }

  async function listModels(k, timeoutMs = 6000) {
    const res = await fetchImpl(`${base()}/models`, { headers: headers(k), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw await upstreamError(res, label);
    const j = await res.json();
    const items = j.data || j.models || [];
    return [...new Set(items.map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean))].sort();
  }

  async function models() {
    if (needsKey && !key()) return [];
    if (modelCache.list && Date.now() - modelCache.at < 60_000) return modelCache.list;
    try {
      const list = await listModels(key());
      modelCache = { at: Date.now(), list };
      return list;
    } catch {
      return modelCache.list || preferredModels.slice(0, 1);
    }
  }

  async function defaultModel() {
    const list = await models();
    return preferredModels.find((m) => list.includes(m)) || list[0] || preferredModels[0] || null;
  }

  async function fetchChat(body, signal) {
    const order = keysInTurn();
    let res;
    for (let i = 0; i < order.length; i++) {
      res = await fetchImpl(`${base()}/chat/completions`, {
        method: 'POST',
        headers: headers(order[i]),
        body: JSON.stringify(body),
        signal,
      });
      if (res.status === 429 || res.status === 401 || res.status === 403) {
        rest(order[i], res);
        if (i < order.length - 1) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          continue;
        }
      }
      return res;
    }
    return res;
  }

  return {
    id,
    label,
    kind,
    needsKey,
    envKey,
    keyUrl,
    baseUrl: base,
    streamUsage,

    keyCount: () => keys().length,
    isResting: (k) => resting.get(k) > Date.now(),

    keySource() {
      if ((getKeys(id) || []).length) return 'console';
      if (envKey && process.env[envKey]) return 'env';
      return null;
    },

    async status() {
      if (needsKey) {
        return key()
          ? { available: true, state: 'ready', detail: keyDetail(this.keySource(), keys().length) }
          : { available: false, state: 'no_key', detail: `Add a key${envKey ? ` (or set ${envKey})` : ''}` };
      }
      try {
        const list = await listModels(key(), 1500);
        modelCache = { at: Date.now(), list };
        return list.length
          ? { available: true, state: 'ready', detail: `${list.length} model${list.length === 1 ? '' : 's'} at ${base()}` }
          : { available: false, state: 'no_models', detail: `Running at ${base()}, but no models are loaded` };
      } catch {
        return { available: false, state: 'offline', detail: `Not running at ${base()}` };
      }
    },

    models,
    defaultModel,

    /** Checks a key with the provider before it's saved. */
    async validateKey(k) {
      await listModels(k, 10_000);
    },

    fetchChat,

    async *chat({ messages, model, signal, params = {} }) {
      const chosen = model && model !== 'default' ? model : await defaultModel();
      if (!chosen) throw new GatewayError(503, `${label} has no models available`, 'provider_unavailable');
      const body = { ...pickParams(params), model: chosen, messages, stream: true };
      if (streamUsage) body.stream_options = { include_usage: true };
      const res = await fetchChat(body, signal);
      if (!res.ok) throw await upstreamError(res, label);
      for await (const data of sseData(res.body)) {
        if (data === '[DONE]') break;
        let o;
        try { o = JSON.parse(data); } catch { continue; }
        if (o.error) throw new GatewayError(502, `${label}: ${o.error.message || JSON.stringify(o.error)}`, 'provider_error');
        const d = o.choices?.[0]?.delta;
        const reasoning = d?.reasoning_content || d?.reasoning;
        if (reasoning) yield { type: 'reasoning', text: reasoning };
        if (d?.content) yield { type: 'text', text: d.content };
        if (o.usage) {
          yield { type: 'usage', inputTokens: o.usage.prompt_tokens || 0, outputTokens: o.usage.completion_tokens || 0 };
        }
      }
    },
  };
}

function keyDetail(source, n) {
  const what = n === 1 ? 'Key' : `${n} keys (taking turns)`;
  return source === 'env' ? `${what} from environment` : `${what} added in console`;
}

export const CLOUD_SPECS = [
  {
    id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys', preferredModels: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
  },
  {
    id: 'cerebras', label: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', envKey: 'CEREBRAS_API_KEY',
    keyUrl: 'https://cloud.cerebras.ai', preferredModels: ['llama-3.3-70b', 'gpt-oss-120b'], streamUsage: false,
  },
  {
    id: 'gemini-api', label: 'Google AI Studio', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'GEMINI_API_KEY', keyUrl: 'https://aistudio.google.com/apikey', preferredModels: ['gemini-2.5-flash', 'gemini-flash-latest'],
  },
  {
    id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys', preferredModels: ['openrouter/auto'],
    extraHeaders: { 'HTTP-Referer': 'https://www.npmjs.com/package/local-ai-jay', 'X-Title': 'local-ai-jay' },
  },
  {
    id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', envKey: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys', preferredModels: ['mistral-small-latest'], streamUsage: false,
  },
  {
    id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', envKey: 'DEEPSEEK_API_KEY',
    keyUrl: 'https://platform.deepseek.com/api_keys', preferredModels: ['deepseek-chat'],
  },
  {
    id: 'sealion', label: 'SEA-LION', baseUrl: 'https://api.sea-lion.ai/v1', envKey: 'SEALION_API_KEY',
    keyUrl: 'https://playground.sea-lion.ai', streamUsage: false,
    preferredModels: ['aisingapore/Qwen-SEA-LION-v4.5-27B-IT', 'aisingapore/Llama-SEA-LION-v3.5-70B-R'],
  },
  {
    id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys', preferredModels: ['gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o-mini'],
  },
];

export function localSpecs(env = process.env) {
  const ollamaHost = (env.OLLAMA_HOST || '127.0.0.1:11434').replace(/\/+$/, '');
  const ollamaBase = /^https?:\/\//.test(ollamaHost) ? ollamaHost : `http://${ollamaHost.replace(/^0\.0\.0\.0/, '127.0.0.1')}`;
  return [
    {
      id: 'ollama', label: 'Ollama', kind: 'local', needsKey: false,
      baseUrl: `${ollamaBase}/v1`, keyUrl: 'https://ollama.com/download',
    },
    {
      id: 'lmstudio', label: 'LM Studio', kind: 'local', needsKey: false, streamUsage: false,
      baseUrl: (env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1'), keyUrl: 'https://lmstudio.ai',
    },
  ];
}
