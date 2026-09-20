/**
 * Web key/value store backed by localStorage, with an in-memory fallback for environments
 * where storage is blocked (private mode, sandboxed iframes, static rendering on Node).
 */
import { isQuotaError, StorageError, type KeyValueStore } from './kvTypes';

const memory = new Map<string, string>();

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export const kv: KeyValueStore = {
  async getItem(key) {
    const s = storage();
    if (!s) return memory.get(key) ?? null;
    try {
      return s.getItem(key);
    } catch {
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
        throw new StorageError('quota', `Browser storage is full (${Math.round(value.length / 1024)} KB would not fit). Delete old sessions to make room.`, err);
      }
      throw new StorageError('io', `Could not write "${key}".`, err);
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
};
