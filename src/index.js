// Programmatic API: embed the gateway in your own Node app.
export { createGateway, listen } from './server.js';
export { createRegistry, registryFrom, parseModel } from './providers/index.js';
export { createCliProvider, claudeSpec, codexSpec, geminiSpec } from './providers/cli.js';
export { createOpenAICompatProvider, CLOUD_SPECS, localSpecs } from './providers/openai-compat.js';
export { loadConfig, saveConfig } from './config.js';
export { getPaths, homeDir } from './paths.js';
export { Store } from './store.js';
export { buildPrompt } from './prompt.js';
