/**
 * Web key/value store backed by localStorage, with an in-memory fallback for environments
 * where storage is blocked (private mode, sandboxed iframes, static rendering on Node).
 *
 * The fallback is necessary — a statically rendered page has no `localStorage` at all — but it
 * is also a trap: everything written to it disappears when the tab does, and a garage drawn
 * from it says "first run" to a driver who has a season of them. So the fallback is recorded
 * rather than hidden, and `blocked()` is true exactly when this is a REAL browser that will
 * not let the app keep anything. A screen can then say so instead of lying quietly.
 */
import { isQuotaError, sizeKb, StorageError, type KeyValueStore } from './kvTypes';

const memory = new Map<string, string>();

/** True once a real browser has refused us its storage (not merely "there is none here"). */
let refused = false;

function inBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') {
      // No storage object at all: static rendering on Node, not a browser refusing us.
      if (inBrowser()) refused = true;
      return null;
    }
    return localStorage;
  } catch {
    // Accessing `localStorage` threw — a sandboxed iframe or a browser with site data blocked.
    refused = true;
    return null;
  }
}

/**
 * True when nothing written here will survive the tab. Call it after at least one read or
 * write, because it is set by the first attempt that had to fall back.
 */
export function webStorageBlocked(): boolean {
  storage();
  return refused;
}

export interface WebKeyValueStore extends KeyValueStore {
  /** Every key with this prefix, from whichever store is actually in use. */
  keys(prefix: string): Promise<string[]>;
}

export const kv: WebKeyValueStore = {
  async getItem(key) {
    const s = storage();
    if (!s) return memory.get(key) ?? null;
    try {
      return s.getItem(key);
    } catch {
      refused = true;
      return memory.get(key) ?? null;
    }
  },
  async setItem(key, value) {
    const s = storage();
    if (!s) {
      memory.set(key, value);
      return;
    }
    try {
      s.setItem(key, value);
    } catch (err) {
      if (isQuotaError(err)) {
        throw new StorageError('quota', `This browser is out of space — the last ${sizeKb(value)} KB would not fit.`, err, `setItem "${key}"`);
      }
      throw new StorageError('io', 'This browser would not let the app write to its storage.', err, `setItem "${key}"`);
    }
  },
  async removeItem(key) {
    memory.delete(key);
    const s = storage();
    if (!s) return;
    try {
      s.removeItem(key);
    } catch {
      // ignore
    }
  },
  /**
   * Enumerating keys is how a damaged run list is repaired: the session bodies are named
   * `dom.session.v1.<id>`, so the ids can be recovered from the store itself without the index
   * that is supposed to hold them. No value is read, so scanning 50 runs costs no parsing.
   */
  async keys(prefix) {
    const s = storage();
    if (!s) return [...memory.keys()].filter((k) => k.startsWith(prefix));
    try {
      const out: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k !== null && k.startsWith(prefix)) out.push(k);
      }
      return out;
    } catch {
      refused = true;
      return [...memory.keys()].filter((k) => k.startsWith(prefix));
    }
  },
};
