/**
 * What the replay screen draws, resolved once from a session id + the URL.
 *
 * The scene itself comes from `buildReplay` — this module only decides WHICH session to build
 * (a stored recording, or the same deterministic fixture the results screen uses, so a deep link
 * from a fixture result lands on the same run), and works out the two things the replay has to
 * be honest about:
 *
 *  • `trusted` — mirrored from `SessionScore.trusted`, the same contract the results screen
 *    settled on: when false the recording still plays, but nothing on screen may present points
 *    or a grade (see `src/ui/results/model.ts`).
 *  • `gaps` — stretches where the GPS gave no fix, so the positions in them are dead reckoning.
 *    The renderer dashes those stretches instead of drawing a confident glowing line through a
 *    hole in the data.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { buildReplay, type Replay } from '../../engine/replay';
import type { Session } from '../../engine/types';
import { loadSession } from '../../platform';
import { buildFixtureSession, resolveFixture, type FixtureSpec } from '../results/fixture';
import type { ReplayParams } from './params';

/** A stretch of the run with no GPS fix: the position here was dead-reckoned. */
export interface GapWindow {
  /** Replay-relative seconds. */
  startT: number;
  endT: number;
  durationS: number;
}

/** No fix for this long and the line between the fixes is a guess, not a measurement. */
export const GAP_THRESHOLD_S = 2.5;

export interface ReplayView {
  session: Session;
  replay: Replay;
  /** False when the engine refuses to publish this run's score (hand-held phone, etc.). */
  trusted: boolean;
  /** Why it refused, in the integrity monitor's own words. */
  untrustedBody: string;
  /** Session name, uppercased for the HUD (the sim suffix dropped, like the reference frame). */
  title: string;
  /** Everything wrong with the data, the engine's wording first. */
  warnings: string[];
  gaps: GapWindow[];
  /** Per trail sample: 1 where the position was dead-reckoned through a gap. */
  dead: Uint8Array;
  fixture: FixtureSpec | null;
}

export interface UseReplaySource {
  view: ReplayView | null;
  loading: boolean;
  error: string | null;
}

/**
 * Blank the recorded positions (and the fixes that produced them) for `seconds` in the middle of
 * the run — a tunnel, a car park, a phone that lost the sky. This damages the RECORDING, exactly
 * as the real defect would, so the replay's own bad-data path runs for real: `buildReplay`
 * reports the dropped samples in `warnings` and the renderer has a hole to be honest about.
 * Harness only (`?gaps=<s>`); it never touches a stored session on disk.
 */
function punchGap(session: Session, seconds: number): Session {
  const states = session.states;
  if (seconds <= 0 || states.length < 2) return session;
  const t0 = states[0].t;
  const t1 = states[states.length - 1].t;
  const start = t0 + (t1 - t0) * 0.45;
  const end = start + seconds;
  return {
    ...session,
    states: states.map((s) => (s.t >= start && s.t <= end ? { ...s, x: NaN, y: NaN } : s)),
    gps: session.gps.filter((g) => g.t < start || g.t > end),
  };
}

/** Stretches with no GPS fix for longer than `GAP_THRESHOLD_S`, in replay-relative seconds. */
export function findGaps(session: Session, replay: Replay): GapWindow[] {
  const out: GapWindow[] = [];
  const rel = (t: number) => t - replay.t0;
  const fixes = session.gps;
  const end = replay.durationS;
  if (fixes.length === 0) return replay.durationS > 0 ? [{ startT: 0, endT: end, durationS: end }] : [];
  let prev = rel(fixes[0].t);
  if (prev > GAP_THRESHOLD_S) out.push({ startT: 0, endT: Math.min(prev, end), durationS: Math.min(prev, end) });
  for (let i = 1; i < fixes.length; i++) {
    const t = rel(fixes[i].t);
    if (t - prev >= GAP_THRESHOLD_S) {
      const a = Math.max(0, Math.min(prev, end));
      const b = Math.max(0, Math.min(t, end));
      if (b - a >= GAP_THRESHOLD_S * 0.8) out.push({ startT: a, endT: b, durationS: b - a });
    }
    prev = t;
  }
  if (end - prev >= GAP_THRESHOLD_S) out.push({ startT: Math.max(0, prev), endT: end, durationS: end - prev });
  return out;
}

function deadMask(replay: Replay, gaps: GapWindow[]): Uint8Array {
  const mask = new Uint8Array(replay.trail.n);
  for (const g of gaps) {
    const a = Math.max(0, Math.floor(g.startT * replay.trail.hz));
    const b = Math.min(replay.trail.n - 1, Math.ceil(g.endT * replay.trail.hz));
    for (let i = a; i <= b; i++) mask[i] = 1;
  }
  return mask;
}

function titleOf(session: Session, replay: Replay): string {
  const name = replay.info.name || session.name || 'Session';
  return name.toUpperCase().replace(' (SIM)', '');
}

/** Build the view model for an already-loaded session. Pure and synchronous. */
export function buildReplayView(session: Session, params: ReplayParams, fixture: FixtureSpec | null): ReplayView {
  const damaged = params.gaps > 0 ? punchGap(session, params.gaps) : session;
  const replay = buildReplay(damaged, { ghostSync: params.ghost, ghost: !params.noGhost });
  const gaps = findGaps(damaged, replay);
  const warnings = [...replay.warnings];
  for (const g of gaps) warnings.push(`no GPS fix for ${g.durationS.toFixed(1)} s at ${g.startT.toFixed(0)} s — the line through it is dead reckoning`);
  return {
    session: damaged,
    replay,
    trusted: damaged.score.trusted !== false,
    untrustedBody: damaged.integrity?.message || 'The recording is valid; the judgement is not.',
    title: titleOf(damaged, replay),
    warnings,
    gaps,
    dead: deadMask(replay, gaps),
    fixture,
  };
}

/**
 * Resolve `/replay/<id>?...` to a scene. A fixture id (or `?fixture=`) rebuilds the same session
 * the results screen shows — the deep link from a fixture result has to land on the same run —
 * and anything else is looked up in storage.
 */
export function useReplaySource(id: string | undefined, params: ReplayParams, query: Record<string, string | string[] | undefined>): UseReplaySource {
  const spec = useMemo(() => resolveFixture(id, flatten(query)), [id, query]);
  const [view, setView] = useState<ReplayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // the params object is rebuilt every render; the build only cares about these few fields
  const key = `${spec ? JSON.stringify(spec) : id}|${params.ghost}|${params.noGhost}|${params.gaps}`;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    // Give React one frame to paint the loading state: a pipeline fixture takes about a second,
    // and a blank white-to-black flash is worse than a stated wait.
    const timer = setTimeout(() => {
      if (!alive) return;
      const run = async () => {
        const session = spec ? buildFixtureSession(spec) : await loadSession(id ?? '');
        if (!alive) return;
        if (!session) {
          setView(null);
          setError(null);
          setLoading(false);
          return;
        }
        setView(buildReplayView(session, paramsRef.current, spec));
        setLoading(false);
      };
      run().catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    }, 16);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { view, loading, error };
}

function flatten(query: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of Object.keys(query)) {
    const v = query[k];
    out[k] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}
