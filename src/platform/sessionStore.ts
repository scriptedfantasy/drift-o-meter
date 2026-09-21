/**
 * Session persistence core (pure). Bodies (several MB of samples) and the small index
 * (id, name, date, score, grade) are stored separately so listing is cheap.
 */
import type { Grade, Session } from '../engine/types';
import { StorageError } from './kvTypes';

/** How steady the phone was, as the integrity monitor saw it. */
export type MountVerdict = 'rigid' | 'suspect' | 'loose';

/**
 * One slide, positioned in the run: start and end as a fraction of the recording (0..1), the
 * angle the driver HELD through it in degrees, and whether it ended in a spin.
 *
 * `heldDeg` is `DriftStats.heldPeakDeg` for EVERY slide, spun ones included, and never
 * `DriftEvent.peakAngle` — the same contract `SessionIndexEntry.heldPeakDeg` states below, for
 * the same reason. A spun slide used to carry its instantaneous peak here, which is 118° on the
 * shipped fixtures, and the card drew it on an axis captioned "held angle" with a 60° ceiling.
 * Whether a spin is worth drawing at all is the screen's decision (`src/ui/garage/trace.ts`
 * draws it as a footprint with no height); it is not a licence to store a different quantity
 * under the same name. 0 when the drift's statistics were never stored.
 *
 * A tuple, not an object, because this is the only array-shaped thing in the index and it has
 * to stay small: four numbers serialise to about 18 bytes, so a ten-slide run costs ~180 bytes
 * against the ~800 an entry already takes. It is what the last-run card's trace is drawn from,
 * and it exists in the index for the same reason `trusted` does — so that drawing the home
 * screen never parses a session body (see the note on `trusted` below).
 */
export type SlideMark = [startFrac: number, endFrac: number, heldDeg: number, spun: 0 | 1];

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
  /**
   * Whether the engine was willing to publish this run's score. A list row MUST check it
   * before printing a grade, the same way the results screen does.
   *
   * Everything from here down exists so a list can be drawn from the index alone. Without it
   * the garage had to load and parse every session body to print a grade letter: 5.75 MB of
   * JSON per run where it needed 87 KB, about 31 ms of parsing each, so twenty stored runs
   * meant 115 MB parsed on the UI thread every time the screen opened.
   *
   * Those figures, and the claim that drawing the garage reads no bodies at all, are re-runnable
   * rather than remembered: `npx tsx tools/analysis/storage-census.ts` counts the reads a full
   * garage render makes over a stored season and prints what the index costs to parse.
   */
  trusted: boolean;
  /**
   * The biggest angle the driver HELD, in degrees — `DriftStats.heldPeakDeg`, the same number
   * the angle component is scored on and the same one the results screen prints under the
   * instantaneous peak ("held 51° for 1.5 s").
   *
   * NOT `DriftEvent.peakAngle`. That is the instantaneous peak, which on the runs this repo
   * ships runs 9–16° above the held figure (hero 64 vs 51, touge 48 vs 39, rough 68 vs 53), and
   * the garage prints this number under a caption that says "held". 0 when the run held nothing
   * the scorer counted.
   */
  heldPeakDeg: number;
  /** Points in the run's longest banked chain. */
  longestChainPoints: number;
  /**
   * Slides that ended in a spin. `drifts - spins` is the engine's `angleDrifts` — the slides
   * the angle was actually measured over — and a screen that prints one without the other is
   * claiming eleven slides for a run the driver spun three times.
   */
  spins: number;
  /** The run's slides, for the last-run card's trace. Empty when nothing slid. */
  slides: SlideMark[];
  /** What the integrity monitor made of the mount. */
  mount: MountVerdict;
  /**
   * 0..1 from `Session.calibration`. **Negative means unknown** — an entry written before this
   * field existed claims nothing, and a screen must not read that as "never calibrated".
   */
  calibrationQuality: number;
  /**
   * Whether the mount calibrator ever worked out which way the car points. Not a low number but
   * a MISSING FACT, which is why it travels beside the quality rather than inside it: see
   * `calibrationBand` in `src/engine/integrity`, the one place that turns the pair into a verdict.
   */
  calibrationForwardResolved: boolean;
  /** `IntegrityMonitor`'s own sentence about why the run was not believed. Empty when it was. */
  integrityMessage: string;
}

/** Raw storage the store is built on. `readIndex`/`readBody` return null when missing. */
export interface SessionBackend {
  readIndex(): Promise<string | null>;
  writeIndex(json: string): Promise<void>;
  readBody(id: string): Promise<string | null>;
  writeBody(id: string, json: string): Promise<void>;
  deleteBody(id: string): Promise<void>;
  /**
   * Every session id whose BODY is on the device, found without reading the index. Optional:
   * a backend that cannot enumerate returns nothing and the store then cannot offer a rebuild.
   */
  listBodyIds?(): Promise<string[]>;
  /** True when this device is not really keeping anything (a blocked localStorage, say). */
  ephemeral?(): boolean;
}

/** What is wrong with storage, for a screen that has to explain itself. */
export interface StorageDiagnosis {
  /** `unreadable` = there IS an index and it will not parse. Not the same as an empty garage. */
  index: 'ok' | 'unreadable';
  /** Recordings whose bodies are on the device, or null when the backend cannot enumerate them. */
  recordings: number | null;
  /** True when nothing written here will survive the tab being closed. */
  ephemeral: boolean;
}

export interface SessionStore {
  /** Newest first. Rejects with `StorageError('corrupt')` when the index will not parse. */
  listSessions(): Promise<SessionIndexEntry[]>;
  loadSession(id: string): Promise<Session | null>;
  saveSession(session: Session): Promise<SessionIndexEntry>;
  deleteSession(id: string): Promise<void>;
  clearSessions(): Promise<void>;
  /** What state storage is in. Free when the index has already been read. */
  diagnose(): Promise<StorageDiagnosis>;
  /**
   * Re-derive the whole index from the session bodies on the device and write it. The only
   * repair for an unreadable index, and the only thing in this module that parses bodies in
   * bulk — so it happens when a driver asks for it, never on a screen's behalf.
   */
  rebuildIndex(): Promise<SessionIndexEntry[]>;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GRADES: readonly Grade[] = ['S', 'A', 'B', 'C', 'D'];
const MOUNTS: readonly MountVerdict[] = ['rigid', 'suspect', 'loose'];

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * The messages below are FRAGMENTS, because the only screen that shows them completes the
 * sentence: the results screen writes "That session could not be read: <message>"
 * (`src/app/results/[id].tsx`). The id goes in `detail`, where a log can have it and a driver
 * cannot.
 */
function assertId(id: string): void {
  if (!isValidSessionId(id)) throw new StorageError('invalid-id', 'that is not a valid run link.', undefined, `id ${String(id)}`);
}

/** `20260920-134201-k3f9`: sortable, file-name safe, unique enough. */
export function newSessionId(startedAt: number = Date.now()): string {
  const d = new Date(startedAt);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
  return `${stamp}-${rand}`;
}

/**
 * `Session.score.perDrift` is declared as `Record<number, DriftScore>` and is written by the
 * pipeline as `Record<number, ScoredDrift>` — a DriftScore plus the per-drift statistics. Read
 * structurally, so this module needs nothing from the engine's internals, and defensively,
 * because a session stored before those statistics existed simply has none.
 */
interface StoredDriftStats {
  heldPeakDeg?: unknown;
  spun?: unknown;
}

function statsOf(s: Session, id: number): StoredDriftStats | null {
  const per = s.score?.perDrift as Record<number, { stats?: StoredDriftStats }> | undefined;
  const scored = per ? per[id] : undefined;
  return scored && typeof scored.stats === 'object' && scored.stats !== null ? scored.stats : null;
}

function spunDrift(s: Session, d: { id: number; spin?: boolean }): boolean {
  return d.spin === true || statsOf(s, d.id)?.spun === true;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * The biggest angle the driver actually HELD, in degrees, taken from the drifts the scorer
 * counted. A spun drift is excluded for the same reason it lends nothing to the angle
 * component: the angle a car reaches while spinning is not an angle the driver held.
 *
 * The figure comes from `DriftStats.heldPeakDeg` — the engine's own answer to this exact
 * question — and a drift whose statistics were never stored contributes nothing rather than
 * falling back to its instantaneous peak. `--` is honest; the wrong number is not.
 */
function heldPeakAngleDeg(s: Session): number {
  if (!Array.isArray(s.drifts)) return 0;
  let peak = 0;
  for (const d of s.drifts) {
    if (spunDrift(s, d)) continue;
    const held = num(statsOf(s, d.id)?.heldPeakDeg, -1);
    if (held > peak) peak = held;
  }
  return Math.round(peak * 10) / 10;
}

function spinCount(s: Session): number {
  if (!Array.isArray(s.drifts)) return 0;
  let n = 0;
  for (const d of s.drifts) if (spunDrift(s, d)) n++;
  return n;
}

/**
 * The run's slides on its own clock, normalised to 0..1 so the card can draw them without
 * knowing what the engine's time base was. The origin is the first recorded state when there
 * is one and the first slide otherwise, which is why `demo.ts` keeps one state sample when it
 * trims a body: a demo run and a real one must summarise to the same shape.
 */
function slideMarks(s: Session): SlideMark[] {
  const drifts = Array.isArray(s.drifts) ? s.drifts : [];
  if (drifts.length === 0) return [];
  const firstState = Array.isArray(s.states) && s.states.length > 0 ? num(s.states[0]?.t, NaN) : NaN;
  const firstDrift = drifts.reduce((m, d) => Math.min(m, num(d.startT, 0)), Infinity);
  const t0 = Number.isFinite(firstState) ? firstState : Number.isFinite(firstDrift) ? firstDrift : 0;
  const lastEnd = drifts.reduce((m, d) => Math.max(m, num(d.endT, 0)), 0);
  const span = num(s.durationS, 0) > 0 ? s.durationS : Math.max(1e-3, lastEnd - t0);
  const frac = (t: number) => Math.min(1, Math.max(0, Math.round(((t - t0) / span) * 1000) / 1000));
  const out: SlideMark[] = [];
  for (const d of drifts) {
    const a = frac(num(d.startT, 0));
    const b = Math.max(a, frac(num(d.endT, 0)));
    // The engine's own held peak, whether or not it spun. A spin is flagged, not re-measured:
    // substituting `d.peakAngle` here put 118° into a field whose contract forbids exactly that.
    const deg = num(statsOf(s, d.id)?.heldPeakDeg, 0);
    out.push([a, b, Math.round(deg * 10) / 10, spunDrift(s, d) ? 1 : 0]);
  }
  return out;
}

export function summarizeSession(s: Session): SessionIndexEntry {
  const track = s.meta && typeof s.meta.track === 'string' ? s.meta.track : null;
  const integrity = s.integrity;
  return {
    id: s.id,
    name: s.name,
    startedAt: s.startedAt,
    durationS: s.durationS,
    total: s.score?.total ?? 0,
    grade: GRADES.includes(s.score?.grade) ? s.score.grade : 'D',
    drifts: Array.isArray(s.drifts) ? s.drifts.length : 0,
    track,
    // Default to untrusted rather than trusted: a row that cannot tell must not award a grade.
    trusted: s.score?.trusted === true && integrity?.scoreTrusted !== false,
    heldPeakDeg: heldPeakAngleDeg(s),
    longestChainPoints: num(s.score?.longestChainPoints, 0),
    spins: spinCount(s),
    slides: slideMarks(s),
    mount: MOUNTS.includes(integrity?.mount as MountVerdict) ? integrity.mount : 'rigid',
    calibrationQuality: num(s.calibration?.quality, -1),
    calibrationForwardResolved: s.calibration?.forwardResolved === true,
    integrityMessage: integrity?.scoreTrusted === false ? String(integrity.message ?? '') : '',
  };
}

interface IndexFile {
  version: 1;
  entries: SessionIndexEntry[];
}

function normaliseSlides(v: unknown): SlideMark[] {
  if (!Array.isArray(v)) return [];
  const out: SlideMark[] = [];
  for (const m of v) {
    if (!Array.isArray(m) || m.length < 4) continue;
    out.push([num(m[0]), num(m[1]), num(m[2]), m[3] === 1 ? 1 : 0]);
  }
  return out;
}

/**
 * Fill in the fields an entry written by an older build does not have. Every default claims
 * NOTHING: no held angle, no spins, no trace, an unknown calibration (negative, not 0, which
 * would read as "never calibrated") and no complaint from the monitor.
 */
function normalise(e: SessionIndexEntry): SessionIndexEntry {
  return {
    ...e,
    heldPeakDeg: num(e.heldPeakDeg, 0),
    longestChainPoints: num(e.longestChainPoints, 0),
    spins: num(e.spins, 0),
    slides: normaliseSlides(e.slides),
    mount: MOUNTS.includes(e.mount) ? e.mount : 'rigid',
    calibrationQuality: num(e.calibrationQuality, -1),
    calibrationForwardResolved: e.calibrationForwardResolved === true,
    integrityMessage: typeof e.integrityMessage === 'string' ? e.integrityMessage : '',
  };
}

const UNREADABLE = 'your run list could not be read.';

/**
 * An index that will not parse is NOT an empty garage, and the difference is the difference
 * between "your first run" and "every run you have ever done is still here". This used to
 * swallow the error and return `[]`, which put FIRST RUN · NOTHING TO BEAT YET on screen over a
 * disk full of recordings — and then the next save wrote a fresh one-entry index over the top
 * and orphaned all of them. So: no index at all is empty; an index that will not parse throws.
 */
function parseIndex(raw: string | null): SessionIndexEntry[] {
  if (raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StorageError('corrupt', UNREADABLE, err, 'the session index is not valid JSON');
  }
  const file = parsed as Partial<IndexFile> | SessionIndexEntry[] | null;
  const entries = Array.isArray(file) ? file : file && Array.isArray(file.entries) ? file.entries : null;
  if (entries === null) {
    throw new StorageError('corrupt', UNREADABLE, undefined, 'the session index has an unexpected shape');
  }
  return entries.filter((e) => e && isValidSessionId(e.id) && typeof e.startedAt === 'number').map(normalise);
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

  async function bodyIds(): Promise<string[] | null> {
    if (!backend.listBodyIds) return null;
    try {
      return (await backend.listBodyIds()).filter(isValidSessionId);
    } catch {
      return null;
    }
  }

  async function readBody(id: string): Promise<Session | null> {
    const raw = await backend.readBody(id);
    if (raw === null) return null;
    let session: Session;
    try {
      session = JSON.parse(raw) as Session;
    } catch (err) {
      throw new StorageError('corrupt', 'the file is damaged.', err, `session "${id}" is not valid JSON`);
    }
    if (!session || session.version !== 1 || session.id !== id) {
      throw new StorageError('corrupt', 'it was saved by a different version of the app.', undefined, `session "${id}" has an unexpected shape`);
    }
    return session;
  }

  return {
    async listSessions() {
      return [...(await readIndex())].sort(byNewest);
    },

    async loadSession(id) {
      assertId(id);
      return readBody(id);
    },

    async saveSession(session) {
      assertId(session.id);
      // The body first: a recording on the device can always be found again, and if the index
      // turns out to be unreadable this run is at least not the one that was lost.
      await backend.writeBody(session.id, JSON.stringify(session));
      const entry = summarizeSession(session);
      let rest: SessionIndexEntry[];
      try {
        rest = (await readIndex()).filter((e) => e.id !== session.id);
      } catch (err) {
        if (err instanceof StorageError && err.code === 'corrupt') {
          // Writing a one-entry index here would orphan every other recording on the device,
          // permanently and silently. Refuse, and say where the repair lives.
          throw new StorageError(
            'corrupt',
            'your run list is damaged, so this run could not be added to it — the recording is safe on this device, and the garage can rebuild the list.',
            err,
            `index unreadable while saving "${session.id}"`,
          );
        }
        throw err;
      }
      await writeIndex([entry, ...rest].sort(byNewest));
      return entry;
    },

    async deleteSession(id) {
      assertId(id);
      await backend.deleteBody(id);
      await writeIndex((await readIndex()).filter((e) => e.id !== id));
    },

    async clearSessions() {
      // Every body this device can name, whether or not the index still names it — otherwise
      // "empty the garage" leaves orphans behind exactly when the index is the thing at fault.
      const ids = new Set<string>((await bodyIds()) ?? []);
      try {
        for (const e of await readIndex()) ids.add(e.id);
      } catch (err) {
        if (!(err instanceof StorageError && err.code === 'corrupt')) throw err;
      }
      for (const id of ids) await backend.deleteBody(id);
      await writeIndex([]);
    },

    async diagnose() {
      const ids = await bodyIds();
      let index: StorageDiagnosis['index'] = 'ok';
      try {
        await readIndex();
      } catch (err) {
        if (err instanceof StorageError && err.code === 'corrupt') index = 'unreadable';
        else throw err;
      }
      return { index, recordings: ids ? ids.length : null, ephemeral: backend.ephemeral?.() === true };
    },

    async rebuildIndex() {
      const ids = await bodyIds();
      if (!ids) throw new StorageError('io', 'this device cannot list what it has stored, so the run list cannot be rebuilt.', undefined, 'backend has no listBodyIds');
      const entries: SessionIndexEntry[] = [];
      for (const id of ids) {
        try {
          const session = await readBody(id);
          if (session) entries.push(summarizeSession(session));
        } catch {
          // A body that will not parse is not a reason to abandon the ones that will.
        }
      }
      entries.sort(byNewest);
      indexCache = null;
      await writeIndex(entries);
      return entries;
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
    async listBodyIds() {
      return [...state.bodies.keys()];
    },
  };
  return state;
}
