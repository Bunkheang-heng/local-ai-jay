import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class GatewayError extends Error {
  constructor(status, message, code = 'gateway_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Write JSON atomically, readable only by the current user. */
export function writeJsonSecure(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    if (err instanceof SyntaxError) {
      // Keep the broken file for the user to inspect instead of silently losing it.
      try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* ignore */ }
      return fallback;
    }
    throw err;
  }
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

export function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 10) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function tail(s, max = 600) {
  const clean = stripAnsi(s).trim();
  return clean.length > max ? `…${clean.slice(-max)}` : clean;
}

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function realpathOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

/** Counting semaphore whose waiters can give up through an AbortSignal. */
export class Semaphore {
  constructor(limit) {
    this.free = Math.max(1, limit);
    this.waiters = [];
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(new GatewayError(499, 'Request cancelled', 'cancelled'));
    if (this.free > 0) {
      this.free--;
      return Promise.resolve(this.#releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new GatewayError(499, 'Request cancelled', 'cancelled'));
      };
      waiter.cleanup = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  get waiting() { return this.waiters.length; }

  #releaser() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) {
        next.cleanup?.();
        next.resolve(this.#releaser());
      } else {
        this.free++;
      }
    };
  }
}

export function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
