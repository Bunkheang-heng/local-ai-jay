import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJsonSecure, realpathOrNull, GatewayError } from './util.js';

export const DEFAULT_AUTO_ORDER = [
  'claude-code', 'codex', 'gemini-cli', 'antigravity',
  'ollama', 'lmstudio',
  'groq', 'cerebras', 'gemini-api', 'openrouter', 'mistral', 'deepseek', 'openai',
];

export function newApiKey() {
  return `jay-${crypto.randomBytes(24).toString('base64url')}`;
}

function defaults() {
  return {
    version: 1,
    apiKey: newApiKey(),
    port: 3000,
    allowedDirs: [],
    cliAccess: 'read-only',
    cors: false,
    cliConcurrency: 2,
    cliTimeoutSeconds: 600,
    autoOrder: DEFAULT_AUTO_ORDER,
  };
}

export function ensureDirs(paths) {
  for (const dir of [paths.home, paths.state, paths.logs, paths.workspace]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try { fs.chmodSync(paths.home, 0o700); } catch { /* Windows */ }
}

/** Loads config.json, creating it (with a fresh API key) on first run. */
export function loadConfig(paths) {
  ensureDirs(paths);
  const stored = readJson(paths.config, null);
  const firstRun = !stored || typeof stored.apiKey !== 'string' || stored.apiKey.length < 20;
  const config = { ...defaults(), ...(stored || {}) };
  if (firstRun) config.apiKey = newApiKey();
  if (!['read-only', 'edit'].includes(config.cliAccess)) config.cliAccess = 'read-only';
  if (!Array.isArray(config.allowedDirs)) config.allowedDirs = [];
  if (!Array.isArray(config.autoOrder)) config.autoOrder = DEFAULT_AUTO_ORDER;
  // Providers added in newer versions join the end of an older saved order.
  for (const id of DEFAULT_AUTO_ORDER) if (!config.autoOrder.includes(id)) config.autoOrder.push(id);
  if (firstRun || JSON.stringify(stored) !== JSON.stringify(config)) saveConfig(paths, config);
  return { config, firstRun };
}

export function saveConfig(paths, config) {
  writeJsonSecure(paths.config, config);
}

export function addAllowedDir(config, dir) {
  const real = realpathOrNull(path.resolve(dir));
  if (!real) throw new GatewayError(400, `Folder not found: ${dir}`);
  if (!fs.statSync(real).isDirectory()) throw new GatewayError(400, `Not a folder: ${dir}`);
  if (!config.allowedDirs.includes(real)) config.allowedDirs.push(real);
  return real;
}

export function removeAllowedDir(config, dir) {
  const real = realpathOrNull(path.resolve(dir)) || path.resolve(dir);
  const before = config.allowedDirs.length;
  config.allowedDirs = config.allowedDirs.filter((d) => d !== real && d !== path.resolve(dir));
  return before !== config.allowedDirs.length;
}

/** Reads NAME=value lines from ~/.local-ai-jay/env without overriding the real environment. */
export function loadEnvFile(file, env = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const loaded = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[m[1]] === undefined) {
      env[m[1]] = value;
      loaded.push(m[1]);
    }
  }
  return loaded;
}
