/**
 * Native session backend: the index lives in AsyncStorage, each session body is a JSON file in
 * `<documents>/sessions/<id>.json` (expo-file-system). (Web: `sessionBackend.web.ts`.)
 */
import { Directory, File, Paths } from 'expo-file-system';

import { kv } from './kv';
import { isQuotaError, sizeKb, StorageError } from './kvTypes';
import type { SessionBackend } from './sessionStore';

const INDEX_KEY = 'dom.sessions.index.v1';

function sessionsDir(): Directory {
  return new Directory(Paths.document, 'sessions');
}

function fileFor(id: string): File {
  return new File(sessionsDir(), `${id}.json`);
}

export const backend: SessionBackend = {
  readIndex: () => kv.getItem(INDEX_KEY),
  writeIndex: (json) => kv.setItem(INDEX_KEY, json),

  async readBody(id) {
    try {
      const f = fileFor(id);
      if (!f.exists) return null;
      return await f.text();
    } catch (err) {
      throw new StorageError('io', 'That run is on this phone but could not be read back.', err, `readBody "${id}"`);
    }
  },

  async writeBody(id, json) {
    try {
      const dir = sessionsDir();
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      const f = fileFor(id);
      if (!f.exists) f.create({ intermediates: true });
      f.write(json);
    } catch (err) {
      throw isQuotaError(err)
        ? new StorageError('quota', `Your phone is out of space — this run needs ${sizeKb(json)} KB.`, err, `writeBody "${id}"`)
        : new StorageError('io', 'Your phone would not let the app write this run to storage.', err, `writeBody "${id}"`);
    }
  },

  async deleteBody(id) {
    try {
      const f = fileFor(id);
      if (f.exists) f.delete();
    } catch (err) {
      throw new StorageError('io', 'That run could not be deleted — it is still on this phone.', err, `deleteBody "${id}"`);
    }
  },

  /**
   * The ids of the stored recordings, from the file names alone — no file is opened or parsed.
   * This is what a damaged run list is rebuilt from.
   */
  async listBodyIds() {
    const dir = sessionsDir();
    if (!dir.exists) return [];
    return dir
      .list()
      .map((e) => e.name)
      .filter((n): n is string => typeof n === 'string' && n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length));
  },
};
