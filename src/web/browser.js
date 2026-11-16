import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findExecutable } from '../process.js';
import { GatewayError } from '../util.js';

/** Finds Chrome, Chromium, Edge or Brave. `LOCAL_AI_JAY_BROWSER` wins if set. */
export function findBrowser(env = process.env, platform = process.platform) {
  if (env.LOCAL_AI_JAY_BROWSER) return fs.existsSync(env.LOCAL_AI_JAY_BROWSER) ? env.LOCAL_AI_JAY_BROWSER : null;
  const candidates = [];
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'));
    }
    for (const r of roots) candidates.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    for (const r of roots) candidates.push(path.join(r, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
  } else if (platform === 'darwin') {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      candidates.push(
        path.join(base, 'Google Chrome.app/Contents/MacOS/Google Chrome'),
        path.join(base, 'Chromium.app/Contents/MacOS/Chromium'),
        path.join(base, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
        path.join(base, 'Brave Browser.app/Contents/MacOS/Brave Browser'),
      );
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
      const found = findExecutable(name, env, platform);
      if (found) candidates.push(found);
    }
  }
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One Chrome DevTools Protocol connection (to a page or to the browser). */
export class CdpSession {
  static connect(wsUrl, timeoutMs = 10_000) {
    if (typeof WebSocket !== 'function') {
      throw new GatewayError(503, `Website providers need Node 22 or newer (you have ${process.version})`, 'provider_unavailable');
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new GatewayError(504, 'Browser did not answer', 'timeout')); }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(new CdpSession(ws)); };
      ws.onerror = () => { clearTimeout(timer); reject(new GatewayError(502, 'Could not connect to the browser', 'provider_error')); };
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString('utf8')); } catch { return; }
      const p = msg.id !== undefined && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new GatewayError(502, `Browser: ${msg.error.message}`, 'provider_error'));
      else p.resolve(msg.result);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new GatewayError(502, 'The browser tab closed', 'provider_error')); }
      this.pending.clear();
    };
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new GatewayError(502, 'The browser tab closed', 'provider_error'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayError(504, `Browser didn't answer ${method}`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new GatewayError(502, `Page script failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`, 'provider_error');
    }
    return r.result?.value;
  }

  insertText(text) { return this.send('Input.insertText', { text }); }

  async pressEnter() {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/**
 * A Chrome window with its own profile (so you stay signed in) that local-ai-jay drives through
 * the DevTools protocol on 127.0.0.1. Reuses a window that's already open with that profile.
 */
export class Browser {
  constructor({ profileDir, headless = false, env = process.env, fetchImpl = globalThis.fetch }) {
    this.profileDir = profileDir;
    this.headless = headless;
    this.env = env;
    this.fetch = fetchImpl;
    this.port = null;
    this.child = null;
    this.starting = null;
  }

  get executable() { return findBrowser(this.env); }

  #portFile() { return path.join(this.profileDir, 'DevToolsActivePort'); }

  async #alive(port) {
    try {
      const r = await this.fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch { return false; }
  }

  async #existingPort() {
    try {
      const port = Number(fs.readFileSync(this.#portFile(), 'utf8').split('\n')[0]);
      if (port && await this.#alive(port)) return port;
    } catch { /* none */ }
    return null;
  }

  /** Makes sure the browser is running; returns its DevTools port. */
  async ensure() {
    if (this.port && await this.#alive(this.port)) return this.port;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const existing = await this.#existingPort();
        if (existing) { this.port = existing; return existing; }
        const exe = this.executable;
        if (!exe) throw new GatewayError(503, 'No Chrome, Chromium, Edge or Brave found. Install one, or set LOCAL_AI_JAY_BROWSER.', 'provider_unavailable');
        fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
        try { fs.unlinkSync(this.#portFile()); } catch { /* none */ }
        const args = [
          '--remote-debugging-port=0',
          '--remote-debugging-address=127.0.0.1',
          `--user-data-dir=${this.profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
        ];
        if (this.headless) args.push('--headless=new', '--window-size=1280,900');
        args.push('about:blank');
        this.child = spawn(exe, args, { stdio: 'ignore', windowsHide: false });
        this.child.on('error', () => {});
        this.child.on('exit', () => { this.child = null; this.port = null; });
        for (let i = 0; i < 150; i++) {
          await sleep(200);
          const port = await this.#existingPort();
          if (port) { this.port = port; return port; }
          if (!this.child) break;
        }
        throw new GatewayError(503, 'The browser started but its control port never opened', 'provider_unavailable');
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** Opens a new tab at `url` and connects to it. */
  async openPage(url) {
    const port = await this.ensure();
    const res = await this.fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!res.ok) throw new GatewayError(502, `Couldn't open a browser tab (${res.status})`, 'provider_error');
    const target = await res.json();
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    const close = session.close.bind(session);
    session.close = () => {
      close();
      this.fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    };
    await session.send('Page.enable').catch(() => {});
    await session.send('Page.bringToFront').catch(() => {});
    return session;
  }

  /** Closes the browser if it's running with this profile. */
  async close() {
    const port = this.port || await this.#existingPort();
    if (!port) return false;
    try {
      const v = await (await this.fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const s = await CdpSession.connect(v.webSocketDebuggerUrl, 3000);
      await s.send('Browser.close', {}, 3000).catch(() => {});
      s.close();
    } catch { /* already gone */ }
    this.port = null;
    for (let i = 0; i < 25 && await this.#alive(port); i++) await sleep(200);
    return true;
  }

  /** Opens the profile in a normal window (no remote control) so you can sign in to sites. */
  openForSignIn(urls) {
    const exe = this.executable;
    if (!exe) throw new GatewayError(503, 'No Chrome, Chromium, Edge or Brave found. Install one, or set LOCAL_AI_JAY_BROWSER.');
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    const child = spawn(exe, [`--user-data-dir=${this.profileDir}`, '--no-first-run', '--no-default-browser-check', ...urls], { stdio: 'ignore' });
    return new Promise((resolve) => { child.on('exit', resolve); child.on('error', resolve); });
  }
}
