/** Web session backend: index and bodies both in localStorage (memory fallback when blocked). */
import { kv } from './kv.web';
import type { SessionBackend } from './sessionStore';

const INDEX_KEY = 'dom.sessions.index.v1';
const bodyKey = (id: string) => `dom.session.v1.${id}`;

export const backend: SessionBackend = {
  readIndex: () => kv.getItem(INDEX_KEY),
  writeIndex: (json) => kv.setItem(INDEX_KEY, json),
  readBody: (id) => kv.getItem(bodyKey(id)),
  writeBody: (id, json) => kv.setItem(bodyKey(id), json),
  deleteBody: (id) => kv.removeItem(bodyKey(id)),
};
