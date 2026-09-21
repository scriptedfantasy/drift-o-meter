/**
 * Demo sessions: `/?demo=night` fills the session list with real, deterministic runs so the
 * garage can be developed, reviewed and photographed without driving anywhere.
 *
 * Nothing here is mocked. Each run is built by the results screen's own fixture builder
 * (`buildFixtureSession` → the simulator, and for the hand-held one the REAL engine pipeline),
 * then scored by the REAL scorer (`buildResultsModel`) and the result written back into
 * `Session.score`, so the grade in the list is the same grade the results screen shows.
 *
 * Two economies keep this honest and cheap:
 *   • the bodies are stored TRIMMED — no motion, GPS, state or truth arrays (10 MB each, far
 *     past a browser's localStorage quota). Everything the garage reads (score, drifts,
 *     integrity, calibration, meta) survives.
 *   • every id is `fixture-<name>`, which is exactly what `/results/fixture-<name>` rebuilds
 *     from the simulator, so tapping a row shows the full run, samples and all. Seed overrides
 *     ride in `Session.meta.fixtureQuery`, which the garage reads when a row is opened.
 *
 * `saveSession` re-summarises through `summarizeSession`, so every seeded run lands in the
 * index with `trusted`, `heldPeakDeg`, `spins`, the mount verdict and the slide trace filled in.
 */
import type { Session } from '../../engine/types';
import { clearSessions, listSessions, saveSession } from '../../platform';
import { buildFixtureSession, FIXTURES, type FixtureSpec } from '../results/fixture';
import { buildResultsModel } from '../results/model';
import { forgetDetails } from './lastRun';

export interface DemoRun {
  /** A key of `FIXTURES` — the id becomes `fixture-<key>`, which the results screen rebuilds. */
  fixture: keyof typeof FIXTURES & string;
  /** Seed override. Also sets the run's clock: the fixture dates it 21:44 + seed minutes. */
  seed: number;
}

/**
 * A believable night out, newest first. The seeds are chosen so no two runs share a minute
 * (the fixture builder dates a run `21:44 + seed` on 19 Sep 2026) and so the set covers what
 * the list has to be able to say: an S lap, a spin, a scruffy run, a different track, and one
 * recording the engine refuses to score at all.
 */
export const DEMO_SETS: Record<string, DemoRun[]> = {
  /** Six runs across two tracks, one of them not scored. */
  night: [
    { fixture: 'good', seed: 7 },
    { fixture: 'touge', seed: 5 },
    { fixture: 'spin', seed: 4 },
    { fixture: 'hero', seed: 3 },
    { fixture: 'sloppy', seed: 1 },
    { fixture: 'handheld', seed: 0 },
  ],
  /** A driver who has been out exactly once. */
  first: [{ fixture: 'good', seed: 7 }],
  /**
   * The last run was hand-held and thrown out — the one case where the garage has something to
   * say about the mount. Newest first, so the rejected run is the card AND the notice.
   */
  flagged: [
    { fixture: 'handheld', seed: 9 },
    { fixture: 'good', seed: 7 },
    { fixture: 'spin', seed: 4 },
    { fixture: 'sloppy', seed: 1 },
  ],
  /** One track, four scored runs: the personal-best board with something to say. */
  harbor: [
    { fixture: 'good', seed: 7 },
    { fixture: 'spin', seed: 4 },
    { fixture: 'hero', seed: 3 },
    { fixture: 'sloppy', seed: 1 },
  ],
};

export const DEMO_NAMES = Object.keys(DEMO_SETS);

/**
 * Everything a stored session needs except the several megabytes of raw samples.
 *
 * ONE state sample survives. It is the run's clock origin, and `summarizeSession` normalises
 * the slide trace against it — so a trimmed demo run and a full recording summarise to exactly
 * the same shape. Dropping it would have made the shipped screenshots the only ones drawn from
 * a different origin than a real run's, which is the kind of divergence that hides bugs.
 */
function trim(session: Session): Session {
  return { ...session, motion: [], gps: [], states: session.states.length > 0 ? [session.states[0]] : [], truth: undefined };
}

/**
 * Build one demo run and store it.
 *
 * WHICH SCORE GETS STORED matters, and the rule is: whatever a real run would have stored.
 *
 *  • A `pipeline` fixture has been through the real `DriftPipeline`, so `Session.score` is the
 *    pipeline's own number — the authoritative one, produced with the per-sample plausibility
 *    mask that a later re-score cannot reconstruct. It is written through untouched. If the
 *    results screen's re-score disagrees with it, the garage must SHOW that disagreement: this
 *    used to overwrite it with the re-score, which meant every screenshot in the repo depicted
 *    an agreement a real run does not get.
 *  • A `sim` fixture never ran the pipeline. `sessionFromSimulation` leaves a placeholder score
 *    behind, which is a fiction, so the real scorer's number replaces it — that is the only
 *    honest number available for those.
 */
export async function seedDemoRun(run: DemoRun): Promise<void> {
  const base = FIXTURES[run.fixture];
  if (!base) return;
  const spec: FixtureSpec = { ...base, seed: run.seed };
  const session = buildFixtureSession(spec);
  if (spec.source !== 'pipeline') {
    const model = buildResultsModel(session);
    session.score = {
      ...session.score,
      total: model.total,
      grade: model.grade,
      trusted: model.trusted,
      longestChainPoints: model.stats.longestChainPoints,
    };
    session.integrity = model.judged;
  }
  session.meta = { ...session.meta, source: 'simulation', demo: true };
  await saveSession(trim(session));
  forgetDetails(session.id);
}

export interface SeedProgress {
  done: number;
  total: number;
}

/**
 * Put a demo set into storage, replacing whatever is there. Reports progress after each run
 * (a set takes 1–2 s: the hand-held one goes through the whole engine pipeline).
 */
export async function seedDemoSessions(set: string, onProgress?: (p: SeedProgress) => void): Promise<number> {
  const runs = DEMO_SETS[set];
  if (!runs) return 0;
  await clearSessions();
  forgetDetails();
  onProgress?.({ done: 0, total: runs.length });
  // oldest first, so the index is written in the order a driver would have made them
  const ordered = [...runs].reverse();
  let done = 0;
  for (const run of ordered) {
    await seedDemoRun(run);
    done++;
    onProgress?.({ done, total: runs.length });
    // let the screen paint between runs
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return runs.length;
}

/** Empty the garage (`/?demo=none`). */
export async function clearDemoSessions(): Promise<void> {
  await clearSessions();
  forgetDetails();
}

/**
 * Resolve the `?demo=` parameter. `none`/`clear`/`empty` wipes, a set name seeds it, anything
 * else is ignored. Returns null when the URL does not ask for anything.
 */
export function resolveDemoRequest(value: string | undefined | null): { kind: 'clear' } | { kind: 'seed'; set: string } | null {
  if (value === undefined || value === null) return null;
  const v = value.trim().toLowerCase();
  if (v === '') return null;
  if (v === 'none' || v === 'clear' || v === 'empty' || v === '0' || v === 'false') return { kind: 'clear' };
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return { kind: 'seed', set: 'night' };
  return DEMO_SETS[v] ? { kind: 'seed', set: v } : null;
}

/** True when storage already holds exactly this set, so a re-render does not rebuild it. */
export async function demoSetPresent(set: string): Promise<boolean> {
  const runs = DEMO_SETS[set];
  if (!runs) return false;
  // A damaged index throws rather than reading as empty; re-seeding repairs it, so say no.
  let stored;
  try {
    stored = await listSessions();
  } catch {
    return false;
  }
  if (stored.length !== runs.length) return false;
  const ids = new Set(stored.map((e) => e.id));
  return runs.every((r) => ids.has(`fixture-${r.fixture}`));
}
