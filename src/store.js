import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonSecure, maskSecret, localDay } from './util.js';

const KEEP_DAYS = 90;

function emptyCounters() {
  return { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalMs: 0 };
}

/**
 * Persistent state: paused providers, provider API keys added in the console, and usage.
 * Kept in ~/.local-ai-jay/state/state.json, readable only by the user.
 */
export class Store {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    const data = readJson(this.file, {});
    this.data = {
      paused: Array.isArray(data.paused) ? data.paused : [],
      keys: data.keys && typeof data.keys === 'object' ? data.keys : {},
      usage: {
        providers: data.usage?.providers || {},
        days: data.usage?.days || {},
      },
    };
    this.timer = null;
  }

  // ---- pause / resume ----
  isPaused(id) { return this.data.paused.includes(id); }

  setPaused(id, paused) {
    const set = new Set(this.data.paused);
    if (paused) set.add(id); else set.delete(id);
    this.data.paused = [...set];
    this.save();
  }

  // ---- provider keys ----
  getKey(id) {
    const k = this.data.keys[id];
    return k && k.enabled !== false ? k.value : null;
  }

  keyInfo(id) {
    const k = this.data.keys[id];
    if (!k) return null;
    return { masked: maskSecret(k.value), enabled: k.enabled !== false, addedAt: k.addedAt };
  }

  setKey(id, value) {
    this.data.keys[id] = { value, enabled: true, addedAt: new Date().toISOString() };
    this.saveNow();
  }

  setKeyEnabled(id, enabled) {
    if (!this.data.keys[id]) return false;
    this.data.keys[id].enabled = !!enabled;
    this.saveNow();
    return true;
  }

  removeKey(id) {
    const had = !!this.data.keys[id];
    delete this.data.keys[id];
    this.saveNow();
    return had;
  }

  // ---- usage ----
  record({ provider, ok, inputTokens = 0, outputTokens = 0, ms = 0 }) {
    const add = (c) => {
      c.requests++;
      if (!ok) c.errors++;
      c.inputTokens += inputTokens || 0;
      c.outputTokens += outputTokens || 0;
      c.totalMs += ms || 0;
    };
    const p = (this.data.usage.providers[provider] ||= emptyCounters());
    add(p);
    const day = (this.data.usage.days[localDay()] ||= {});
    add((day[provider] ||= emptyCounters()));
    this.#trimDays();
    this.save();
  }

  usage() {
    const totals = emptyCounters();
    for (const c of Object.values(this.data.usage.providers)) {
      for (const k of Object.keys(totals)) totals[k] += c[k] || 0;
    }
    return {
      totals,
      providers: this.data.usage.providers,
      days: this.data.usage.days,
    };
  }

  resetUsage() {
    this.data.usage = { providers: {}, days: {} };
    this.saveNow();
  }

  #trimDays() {
    const days = Object.keys(this.data.usage.days).sort();
    while (days.length > KEEP_DAYS) delete this.data.usage.days[days.shift()];
  }

  // ---- persistence ----
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, 500);
    this.timer.unref?.();
  }

  saveNow() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeJsonSecure(this.file, this.data);
  }
}
