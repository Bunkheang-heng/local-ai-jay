import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt } from '../prompt.js';
import { findExecutable, runLines, runOnce, childEnv } from '../process.js';
import { GatewayError } from '../util.js';

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,119}$/;

export function checkModelName(model) {
  if (!model || model === 'default') return null;
  if (!MODEL_NAME.test(model)) {
    throw new GatewayError(400, `Invalid model name: ${JSON.stringify(model)}`, 'invalid_request_error');
  }
  return model;
}

function tryJson(line) {
  if (line[0] !== '{') return null;
  try { return JSON.parse(line); } catch { return null; }
}

/** Adds a blank line between separate assistant turns (e.g. before and after tool use). */
function textEvent(st, text) {
  const out = st.pendingSep && st.emittedText ? `\n\n${text}` : text;
  st.pendingSep = false;
  st.emittedText = true;
  return { type: 'text', text: out };
}

// ---------- Claude Code: `claude -p --output-format stream-json` ----------
export const claudeSpec = {
  id: 'claude-code',
  label: 'Claude Code',
  bin: 'claude',
  binEnv: 'LOCAL_AI_JAY_CLAUDE_BIN',
  models: ['default', 'sonnet', 'opus', 'haiku'],
  installHint: 'https://docs.claude.com/en/docs/claude-code',
  buildArgs({ model, dirs, access }) {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--no-session-persistence',
      '--permission-mode', access === 'edit' ? 'acceptEdits' : 'default',
    ];
    if (model) args.push('--model', model);
    for (const d of dirs) args.push('--add-dir', d);
    return args;
  },
  parseLine(line, st) {
    const o = tryJson(line);
    if (!o) return [];
    const events = [];
    if (o.type === 'stream_event') {
      const e = o.event || {};
      if (e.type === 'message_start') st.pendingSep = true;
      if (e.type === 'content_block_delta') {
        if (e.delta?.type === 'text_delta' && e.delta.text) {
          st.sawDelta = true;
          events.push(textEvent(st, e.delta.text));
        } else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) {
          st.sawDelta = true;
          events.push({ type: 'reasoning', text: e.delta.thinking });
        }
      }
    } else if (o.type === 'assistant' && !st.sawDelta) {
      // Older Claude Code without partial messages: take whole messages.
      st.pendingSep = true;
      for (const block of o.message?.content || []) {
        if (block.type === 'text' && block.text) events.push(textEvent(st, block.text));
      }
    } else if (o.type === 'result') {
      if (o.is_error || (o.subtype && o.subtype !== 'success')) {
        throw new GatewayError(502, `Claude Code: ${o.result || o.subtype || 'failed'}`, 'provider_error');
      }
      if (!st.emittedText && o.result) events.push(textEvent(st, o.result));
      const u = o.usage || {};
      events.push({
        type: 'usage',
        inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        outputTokens: u.output_tokens || 0,
        costUsd: o.total_cost_usd,
      });
    }
    return events;
  },
};

// ---------- Codex: `codex exec --json` ----------
export const codexSpec = {
  id: 'codex',
  label: 'Codex',
  bin: 'codex',
  binEnv: 'LOCAL_AI_JAY_CODEX_BIN',
  models: ['default'],
  installHint: 'https://github.com/openai/codex',
  buildArgs({ model, cwd, dirs, access }) {
    const args = [
      'exec', '--json', '--skip-git-repo-check', '--ephemeral',
      '--sandbox', access === 'edit' ? 'workspace-write' : 'read-only',
      '-C', cwd,
    ];
    if (model) args.push('-m', model);
    for (const d of dirs) args.push('--add-dir', d);
    args.push('-');
    return args;
  },
  parseLine(line, st) {
    const o = tryJson(line);
    if (!o) return [];
    const events = [];
    if (o.type === 'item.completed' && o.item) {
      if (o.item.type === 'agent_message' && o.item.text) {
        st.pendingSep = true;
        events.push(textEvent(st, o.item.text));
      } else if (o.item.type === 'reasoning' && o.item.text) {
        events.push({ type: 'reasoning', text: `${o.item.text}\n` });
      }
    } else if (o.type === 'turn.completed' && o.usage) {
      events.push({
        type: 'usage',
        inputTokens: o.usage.input_tokens || 0,
        outputTokens: (o.usage.output_tokens || 0) + (o.usage.reasoning_output_tokens || 0),
      });
    } else if (o.type === 'turn.failed') {
      throw new GatewayError(502, `Codex: ${o.error?.message || st.lastError || 'turn failed'}`, 'provider_error');
    } else if (o.type === 'error' && o.message) {
      st.lastError = o.message;
    }
    return events;
  },
};

// ---------- Gemini CLI: `gemini -p "" -o stream-json` ----------
export const geminiSpec = {
  id: 'gemini-cli',
  label: 'Gemini CLI',
  bin: 'gemini',
  binEnv: 'LOCAL_AI_JAY_GEMINI_BIN',
  models: ['default', 'pro', 'flash', 'flash-lite'],
  installHint: 'https://github.com/google-gemini/gemini-cli',
  env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
  buildArgs({ model, dirs, access }) {
    const args = ['-p', '', '-o', 'stream-json', '--approval-mode', access === 'edit' ? 'auto_edit' : 'default'];
    if (model) args.push('-m', model);
    if (dirs.length) args.push('--include-directories', dirs.join(','));
    return args;
  },
  parseLine(line, st) {
    const o = tryJson(line);
    if (!o) {
      (st.plain ||= []).push(line);
      return [];
    }
    const events = [];
    if (o.type === 'message' && o.role === 'assistant' && typeof o.content === 'string' && o.content) {
      if (!o.delta) st.pendingSep = true;
      events.push(textEvent(st, o.content));
    } else if (o.type === 'result') {
      if (o.status && o.status !== 'success') {
        throw new GatewayError(502, `Gemini CLI: ${o.error?.message || st.lastError || o.status}`, 'provider_error');
      }
      const s = o.stats || {};
      events.push({ type: 'usage', inputTokens: s.input_tokens || s.input || 0, outputTokens: s.output_tokens || s.output || 0 });
    } else if (o.type === 'error') {
      st.lastError = o.message || o.error?.message;
    }
    return events;
  },
  finish(st) {
    // Very old versions print plain text only.
    if (!st.emittedText && st.plain?.length) return [textEvent(st, st.plain.join('\n'))];
    return [];
  },
};

// ---------- Antigravity CLI: `agy --input-format stream-json --output-format stream-json` ----------
// agy auto-approves tools in print mode (and many users set "toolPermission": "always-proceed"),
// so access is enforced with session-only deny rules passed through --settings <file>.
export function antigravitySettings(access, toolMode = false) {
  let deny = access === 'edit' ? ['command(*)', 'mcp(*)'] : ['write_file(*)', 'command(*)', 'mcp(*)'];
  // When the client brings its own tools (e.g. VS Code Agent mode), the model must act only through
  // them: its built-in tools would run on this machine, not the client's, so they're all blocked.
  if (toolMode) deny = ['read_file(*)', 'write_file(*)', 'command(*)', 'mcp(*)', 'url(*)'];
  return { toolPermission: 'request-review', permissions: { allow: [], deny } };
}

function antigravitySettingsFile(stateDir, access, toolMode = false) {
  const name = toolMode ? 'client-tools' : access === 'edit' ? 'edit' : 'read-only';
  const file = path.join(stateDir, `antigravity-${name}.json`);
  const body = `${JSON.stringify(antigravitySettings(access, toolMode), null, 2)}\n`;
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* not yet written */ }
  if (current !== body) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, body, { mode: 0o600 });
  }
  return file;
}

// A custom agy agent with no built-in tools, used when the client brings its own tools.
export const ANTIGRAVITY_TOOLS_AGENT = 'local-ai-jay-tools';
const TOOLS_AGENT_MD = `---
name: ${ANTIGRAVITY_TOOLS_AGENT}
description: Used by local-ai-jay when a client (such as VS Code Agent mode) supplies its own tools. Has no built-in tools; it calls the client's tools by writing tool_call blocks.
tools: []
subagent: false
---
You are an assistant whose tools are provided by the user's app. You have no built-in tools in this
session. When the user's message lists tools, you act ONLY by writing the <tool_call> blocks it
describes; the app runs them on the user's computer and returns the results. Never claim you lack tools.
`;

export function ensureAntigravityToolsAgent(home = os.homedir()) {
  const file = path.join(home, '.gemini', 'config', 'agents', `${ANTIGRAVITY_TOOLS_AGENT}.md`);
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* not yet */ }
  if (current !== TOOLS_AGENT_MD) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, TOOLS_AGENT_MD);
  }
  return file;
}

export const antigravitySpec = {
  id: 'antigravity',
  label: 'Antigravity',
  bin: 'agy',
  binEnv: 'LOCAL_AI_JAY_ANTIGRAVITY_BIN',
  models: ['default'],
  installHint: 'https://antigravity.google',
  buildArgs({ model, dirs, access, stateDir, toolMode }) {
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--disable-slash-commands',
      '--settings', antigravitySettingsFile(stateDir, access, toolMode),
    ];
    if (model) args.push('--model', model);
    if (toolMode) {
      ensureAntigravityToolsAgent();
      args.push('--agent', ANTIGRAVITY_TOOLS_AGENT);
    } else {
      for (const d of dirs) args.push('--add-dir', d);
    }
    return args;
  },
  // The prompt goes over stdin as one NDJSON message, never on the command line.
  formatInput(prompt) {
    return `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`;
  },
  async listModels(bin) {
    const out = await runOnce(bin, ['models'], { timeoutMs: 30_000 });
    const ids = out.split('\n')
      .map((l) => l.split('\t')[0].trim())
      .filter((id) => MODEL_NAME.test(id) && !/\s/.test(id) && !id.endsWith('...'));
    return ['default', ...ids];
  },
  parseLine(line, st) {
    const o = tryJson(line);
    if (!o) {
      if (/^error:/i.test(line)) st.lastError = line.replace(/^error:\s*/i, '');
      return [];
    }
    const events = [];
    if (o.event === 'step_update') {
      const s = o.step_update || {};
      if (s.step_type === 'agent_response' && typeof s.text_delta === 'string' && s.text_delta) {
        if (st.textStep !== undefined && st.textStep !== s.step_index) st.pendingSep = true;
        st.textStep = s.step_index;
        // agy ends each response step with a lone newline; skip it so replies don't trail "\n".
        if (!(s.state === 'DONE' && s.text_delta === '\n')) events.push(textEvent(st, s.text_delta));
      }
    } else if (o.event === 'result') {
      const r = o.result || {};
      st.done = true;
      if (r.status && r.status !== 'SUCCESS') {
        throw new GatewayError(502, `Antigravity: ${r.error || st.lastError || r.status}`, 'provider_error');
      }
      if (!st.emittedText && r.response) events.push(textEvent(st, r.response.replace(/\n$/, '')));
      const u = r.usage || {};
      events.push({ type: 'usage', inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 });
    }
    return events;
  },
};

/** Wraps a CLI spec into a provider. */
export function createCliProvider(spec, { env = process.env } = {}) {
  let versionCache = null;
  let modelCache = null;
  const locate = () => env[spec.binEnv] || findExecutable(spec.bin, env);

  return {
    id: spec.id,
    label: spec.label,
    kind: 'cli',
    installHint: spec.installHint,

    async status() {
      const bin = locate();
      if (!bin) {
        return { available: false, state: 'not_installed', detail: `"${spec.bin}" isn't on your PATH` };
      }
      if (!versionCache || versionCache.bin !== bin) {
        let version = '';
        try { version = (await runOnce(bin, ['--version'])).split('\n')[0]; } catch { /* still usable */ }
        versionCache = { bin, version };
      }
      return { available: true, state: 'ready', detail: versionCache.version || bin, path: bin };
    },

    async models() {
      if (!spec.listModels) return spec.models;
      const bin = locate();
      if (!bin) return spec.models;
      if (modelCache && modelCache.bin === bin && Date.now() - modelCache.at < 10 * 60_000) return modelCache.list;
      try {
        const list = await spec.listModels(bin);
        modelCache = { bin, at: Date.now(), list: list.length ? list : spec.models };
        return modelCache.list;
      } catch {
        return modelCache?.list || spec.models;
      }
    },

    async *chat({ messages, model, signal, settings }) {
      const bin = locate();
      if (!bin) throw new GatewayError(503, `${spec.label} isn't installed ("${spec.bin}" not on PATH)`, 'provider_unavailable');
      const prompt = buildPrompt(messages);
      // With client-side tools the files live on the client, so run in the empty workspace.
      const cwd = settings.toolMode ? settings.workspace : settings.workdir || settings.workspace;
      const args = spec.buildArgs({
        model: checkModelName(model),
        cwd,
        dirs: settings.allowedDirs || [],
        access: settings.access,
        stateDir: settings.stateDir || path.join(path.dirname(settings.workspace), 'state'),
        toolMode: !!settings.toolMode,
      });
      const st = {};
      const lines = runLines({
        command: bin,
        args,
        input: spec.formatInput ? spec.formatInput(prompt) : prompt,
        cwd,
        env: childEnv(spec.env),
        signal,
        timeoutMs: settings.timeoutMs,
        name: spec.label,
        describeError: () => st.lastError,
      });
      for await (const line of lines) {
        for (const ev of spec.parseLine(line, st)) yield ev;
        // Some CLIs linger after their final event; stop reading (and end the process) right away.
        if (st.done) break;
      }
      if (spec.finish) for (const ev of spec.finish(st)) yield ev;
    },
  };
}
