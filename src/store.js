import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJsonSecure, maskSecret, localDay } from './util.js';

const newKeyId = () => crypto.randomBytes(5).toString('hex');

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

  // ---- provider keys (several per provider; they take turns) ----
  #entries(id) {
    let list = this.data.keys[id];
    if (!list) return [];
    if (!Array.isArray(list)) {
      // Older single-key format: { value, enabled, addedAt }
      list = list.value ? [{ id: newKeyId(), value: list.value, enabled: list.enabled !== false, addedAt: list.addedAt }] : [];
      this.data.keys[id] = list;
    }
    return list;
  }

  /** Enabled key values, in the order they were added. */
  getKeys(id) {
    return this.#entries(id).filter((k) => k.enabled !== false).map((k) => k.value);
  }

  getKey(id) {
    return this.getKeys(id)[0] ?? null;
  }

  /** Raw entries for the server (values included; never send these to the console). */
  keyEntries(id) {
    return this.#entries(id).map((k) => ({ ...k }));
  }

  /** What the console may see: masked values only. */
  keyInfo(id) {
    const list = this.#entries(id);
    if (!list.length) return null;
    return list.map((k) => ({ id: k.id, masked: maskSecret(k.value), enabled: k.enabled !== false, addedAt: k.addedAt }));
  }

  /** Adds a key; returns false if that exact key is already saved. */
  addKey(id, value) {
    const list = this.#entries(id);
    if (list.some((k) => k.value === value)) return false;
    list.push({ id: newKeyId(), value, enabled: true, addedAt: new Date().toISOString() });
    this.data.keys[id] = list;
    this.saveNow();
    return true;
  }

  /** Switches one key (keyId) or all of a provider's keys on or off. */
  setKeyEnabled(id, enabled, keyId = null) {
    const list = this.#entries(id).filter((k) => !keyId || k.id === keyId);
    if (!list.length) return false;
    for (const k of list) k.enabled = !!enabled;
    this.saveNow();
    return true;
  }

  /** Removes one key (keyId) or all of a provider's keys. */
  removeKey(id, keyId = null) {
    const list = this.#entries(id);
    const keep = keyId ? list.filter((k) => k.id !== keyId) : [];
    const removed = list.length - keep.length;
    if (keep.length) this.data.keys[id] = keep; else delete this.data.keys[id];
    this.saveNow();
    return removed > 0;
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
