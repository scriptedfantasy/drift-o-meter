/**
 * Session persistence core (pure). Bodies (several MB of samples) and the small index
 * (id, name, date, score, grade) are stored separately so listing is cheap.
 */
import type { Grade, Session } from '../engine/types';
import { StorageError } from './kvTypes';

export interface SessionIndexEntry {
  id: string;
  name: string;
  /** Wall-clock start, ms since epoch. */
  startedAt: number;
  durationS: number;
  total: number;
  grade: Grade;
  drifts: number;
  /** Track name from `Session.meta.track`, when present. */
  track: string | null;
}

/** Raw storage the store is built on. `readIndex`/`readBody` return null when missing. */
export interface SessionBackend {
  readIndex(): Promise<string | null>;
  writeIndex(json: string): Promise<void>;
  readBody(id: string): Promise<string | null>;
  writeBody(id: string, json: string): Promise<void>;
  deleteBody(id: string): Promise<void>;
}

export interface SessionStore {
  /** Newest first. */
  listSessions(): Promise<SessionIndexEntry[]>;
  loadSession(id: string): Promise<Session | null>;
  saveSession(session: Session): Promise<SessionIndexEntry>;
  deleteSession(id: string): Promise<void>;
  clearSessions(): Promise<void>;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GRADES: readonly Grade[] = ['S', 'A', 'B', 'C', 'D'];

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

function assertId(id: string): void {
  if (!isValidSessionId(id)) throw new StorageError('invalid-id', `Invalid session id "${String(id)}".`);
}

/** `20260920-134201-k3f9`: sortable, file-name safe, unique enough. */
export function newSessionId(startedAt: number = Date.now()): string {
  const d = new Date(startedAt);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
  return `${stamp}-${rand}`;
}

export function summarizeSession(s: Session): SessionIndexEntry {
  const track = s.meta && typeof s.meta.track === 'string' ? s.meta.track : null;
  return {
    id: s.id,
    name: s.name,
    startedAt: s.startedAt,
    durationS: s.durationS,
    total: s.score?.total ?? 0,
    grade: GRADES.includes(s.score?.grade) ? s.score.grade : 'D',
    drifts: Array.isArray(s.drifts) ? s.drifts.length : 0,
    track,
  };
}

interface IndexFile {
  version: 1;
  entries: SessionIndexEntry[];
}

function parseIndex(raw: string | null): SessionIndexEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<IndexFile> | SessionIndexEntry[];
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [];
    return entries.filter((e) => e && isValidSessionId(e.id) && typeof e.startedAt === 'number');
  } catch {
    return [];
  }
}

function byNewest(a: SessionIndexEntry, b: SessionIndexEntry): number {
  return b.startedAt - a.startedAt;
}

export function createSessionStore(backend: SessionBackend): SessionStore {
  let indexCache: SessionIndexEntry[] | null = null;

  async function readIndex(): Promise<SessionIndexEntry[]> {
    if (!indexCache) indexCache = parseIndex(await backend.readIndex());
    return indexCache;
  }

  async function writeIndex(entries: SessionIndexEntry[]): Promise<void> {
    indexCache = entries;
    const file: IndexFile = { version: 1, entries };
    await backend.writeIndex(JSON.stringify(file));
  }

  return {
    async listSessions() {
      return [...(await readIndex())].sort(byNewest);
    },

    async loadSession(id) {
      assertId(id);
      const raw = await backend.readBody(id);
      if (raw === null) return null;
      let session: Session;
      try {
        session = JSON.parse(raw) as Session;
      } catch (err) {
        throw new StorageError('corrupt', `Session "${id}" is not valid JSON.`, err);
      }
      if (!session || session.version !== 1 || session.id !== id) {
        throw new StorageError('corrupt', `Session "${id}" has an unexpected shape.`);
      }
      return session;
    },

    async saveSession(session) {
      assertId(session.id);
      await backend.writeBody(session.id, JSON.stringify(session));
      const entry = summarizeSession(session);
      const rest = (await readIndex()).filter((e) => e.id !== session.id);
      await writeIndex([entry, ...rest].sort(byNewest));
      return entry;
    },

    async deleteSession(id) {
      assertId(id);
      await backend.deleteBody(id);
      await writeIndex((await readIndex()).filter((e) => e.id !== id));
    },

    async clearSessions() {
      for (const e of await readIndex()) await backend.deleteBody(e.id);
      await writeIndex([]);
    },
  };
}

/** In-memory backend for tests and previews. */
export function createMemoryBackend(): SessionBackend & { bodies: Map<string, string>; index: string | null } {
  const state = {
    bodies: new Map<string, string>(),
    index: null as string | null,
    async readIndex() {
      return state.index;
    },
    async writeIndex(json: string) {
      state.index = json;
    },
    async readBody(id: string) {
      return state.bodies.get(id) ?? null;
    },
    async writeBody(id: string, json: string) {
      state.bodies.set(id, json);
    },
    async deleteBody(id: string) {
      state.bodies.delete(id);
    },
  };
  return state;
}
