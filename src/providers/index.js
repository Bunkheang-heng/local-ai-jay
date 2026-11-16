import { createCliProvider, claudeSpec, codexSpec, geminiSpec } from './cli.js';
import { createOpenAICompatProvider, CLOUD_SPECS, localSpecs } from './openai-compat.js';

/** Every provider local-ai-jay knows about, in display order. */
export function createRegistry({ store, env = process.env, fetchImpl } = {}) {
  const getKey = (id) => store?.getKey(id) ?? null;
  const providers = [
    createCliProvider(claudeSpec, { env }),
    createCliProvider(codexSpec, { env }),
    createCliProvider(geminiSpec, { env }),
    ...localSpecs(env).map((s) => createOpenAICompatProvider(s, { getKey, fetchImpl })),
    ...CLOUD_SPECS.map((s) => createOpenAICompatProvider(s, { getKey, fetchImpl })),
  ];
  return registryFrom(providers);
}

export function registryFrom(providers) {
  const byId = new Map(providers.map((p) => [p.id, p]));
  return {
    list: () => providers,
    get: (id) => byId.get(id),
  };
}

/**
 * "claude-code/sonnet" -> { providerId: "claude-code", model: "sonnet" }
 * "openrouter/meta-llama/llama-3" -> { providerId: "openrouter", model: "meta-llama/llama-3" }
 * "ollama" -> { providerId: "ollama", model: null }   "auto" -> { auto: true }
 */
export function parseModel(name) {
  if (!name || name === 'auto') return { auto: true };
  const s = String(name).trim();
  const i = s.indexOf('/');
  if (i < 0) return { providerId: s, model: null };
  const model = s.slice(i + 1);
  return { providerId: s.slice(0, i), model: model && model !== 'default' ? model : null };
}
