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

/** Wraps a CLI spec into a provider. */
export function createCliProvider(spec, { env = process.env } = {}) {
  let versionCache = null;
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

    async models() { return spec.models; },

    async *chat({ messages, model, signal, settings }) {
      const bin = locate();
      if (!bin) throw new GatewayError(503, `${spec.label} isn't installed ("${spec.bin}" not on PATH)`, 'provider_unavailable');
      const prompt = buildPrompt(messages);
      const cwd = settings.workdir || settings.workspace;
      const args = spec.buildArgs({
        model: checkModelName(model),
        cwd,
        dirs: settings.allowedDirs || [],
        access: settings.access,
      });
      const st = {};
      const lines = runLines({
        command: bin,
        args,
        input: prompt,
        cwd,
        env: childEnv(spec.env),
        signal,
        timeoutMs: settings.timeoutMs,
        name: spec.label,
        describeError: () => st.lastError,
      });
      for await (const line of lines) {
        for (const ev of spec.parseLine(line, st)) yield ev;
      }
      if (spec.finish) for (const ev of spec.finish(st)) yield ev;
    },
  };
}
