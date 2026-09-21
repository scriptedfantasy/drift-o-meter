/** Web session backend: index and bodies both in localStorage (memory fallback when blocked). */
import { kv, webStorageBlocked } from './kv.web';
import type { SessionBackend } from './sessionStore';

const INDEX_KEY = 'dom.sessions.index.v1';
const BODY_PREFIX = 'dom.session.v1.';
const bodyKey = (id: string) => `${BODY_PREFIX}${id}`;

export const backend: SessionBackend = {
  readIndex: () => kv.getItem(INDEX_KEY),
  writeIndex: (json) => kv.setItem(INDEX_KEY, json),
  readBody: (id) => kv.getItem(bodyKey(id)),
  writeBody: (id, json) => kv.setItem(bodyKey(id), json),
  deleteBody: (id) => kv.removeItem(bodyKey(id)),
  /** The ids of the stored bodies, read from the key names — no body is fetched or parsed. */
  async listBodyIds() {
    return (await kv.keys(BODY_PREFIX)).map((k) => k.slice(BODY_PREFIX.length));
  },
  ephemeral: webStorageBlocked,
};
