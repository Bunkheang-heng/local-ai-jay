import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { GatewayError, tail } from './util.js';

const IS_WIN = process.platform === 'win32';

/** Finds an executable on PATH (plus a few places installers commonly use). */
export function findExecutable(name, env = process.env, platform = process.platform) {
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = (env.PATH || env.Path || '').split(sep).filter(Boolean);
  const home = os.homedir();
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'));
  if (platform !== 'win32') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  const exts = platform === 'win32'
    ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        const st = fs.statSync(candidate);
        if (!st.isFile()) continue;
        if (platform === 'win32') {
          if (ext) return candidate; // Windows needs an extension to run it
        } else if (st.mode & 0o111) {
          return candidate;
        }
      } catch { /* not here */ }
    }
  }
  return null;
}

// Arguments that pass through cmd.exe (npm's .cmd shims on Windows) must not carry metacharacters.
function quoteForCmd(arg) {
  const s = String(arg);
  if (/["%^&|<>!\r\n]/.test(s)) {
    throw new GatewayError(400, `Argument not allowed on Windows: ${JSON.stringify(s)}`);
  }
  return `"${s}"`;
}

function spawnTool(command, args, options) {
  const viaCmd = IS_WIN && /\.(cmd|bat)$/i.test(command);
  if (viaCmd) {
    return spawn(quoteForCmd(command), args.map(quoteForCmd), { ...options, shell: true, windowsHide: true });
  }
  return spawn(command, args, { ...options, shell: false, windowsHide: true });
}

/** Environment for child CLIs: inherits the user's, minus markers that make Claude Code refuse to nest. */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;
  return env;
}

/**
 * Runs a CLI with `input` on stdin and yields its stdout line by line.
 * The child is killed when the consumer stops early, the signal aborts, or the timeout passes.
 */
export async function* runLines({ command, args, input = '', cwd, env, signal, timeoutMs = 600_000, name = command, describeError }) {
  if (signal?.aborted) throw new GatewayError(499, 'Request cancelled', 'cancelled');
  const child = spawnTool(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let timedOut = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-16_000); });
  const exited = new Promise((resolve) => {
    child.on('error', (err) => resolve({ err }));
    child.on('close', (code, sig) => resolve({ code, sig }));
  });

  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    const t = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }
    }, 3000);
    t.unref?.();
  };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  timer.unref?.();
  signal?.addEventListener('abort', kill, { once: true });

  child.stdin.on('error', () => { /* child may exit before reading stdin */ });
  child.stdin.end(input);

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.trim()) yield line;
    }
    const result = await exited;
    if (result.err) {
      throw new GatewayError(503, `Couldn't start ${name}: ${result.err.message}`, 'provider_unavailable');
    }
    if (signal?.aborted) throw new GatewayError(499, 'Request cancelled', 'cancelled');
    if (timedOut) throw new GatewayError(504, `${name} took longer than ${Math.round(timeoutMs / 1000)}s and was stopped`, 'timeout');
    if (result.code !== 0) {
      const detail = describeError?.(stderr) || summarizeStderr(stderr) || `exit code ${result.code ?? result.sig}`;
      throw new GatewayError(502, `${name} failed: ${detail}`, 'provider_error');
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
    rl.close();
    kill();
  }
}

/** Picks the useful part of a CLI's stderr: the first error-looking line, without stack traces. */
export function summarizeStderr(stderr) {
  const lines = tail(stderr, 8000).split('\n').map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^[{}[\],]+$/.test(l) && l !== '…');
  const errLine = lines.find((l) => /error|failed|not (logged|signed) in|unauthori[sz]ed|denied|invalid/i.test(l));
  const picked = errLine || lines.slice(-3).join(' ');
  return picked.length > 400 ? `${picked.slice(0, 400)}…` : picked;
}

/** Runs a command to completion and returns its trimmed output (used for `--version`). */
export async function runOnce(command, args, { timeoutMs = 10_000, env = childEnv() } = {}) {
  let out = '';
  for await (const line of runLines({ command, args, env, timeoutMs, name: path.basename(command) })) {
    out += `${line}\n`;
    if (out.length > 4000) break;
  }
  return out.trim();
}
