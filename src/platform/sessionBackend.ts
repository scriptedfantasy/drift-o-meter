/**
 * Native session backend: the index lives in AsyncStorage, each session body is a JSON file in
 * `<documents>/sessions/<id>.json` (expo-file-system). (Web: `sessionBackend.web.ts`.)
 */
import { Directory, File, Paths } from 'expo-file-system';

import { kv } from './kv';
import { isQuotaError, StorageError } from './kvTypes';
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
      throw new StorageError('io', `Could not read session "${id}".`, err);
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
      throw new StorageError(isQuotaError(err) ? 'quota' : 'io', `Could not save session "${id}".`, err);
    }
  },

  async deleteBody(id) {
    try {
      const f = fileFor(id);
      if (f.exists) f.delete();
    } catch (err) {
      throw new StorageError('io', `Could not delete session "${id}".`, err);
    }
  },
};
