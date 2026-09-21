/**
 * The replay view model: what the screen draws, built from a Session and the URL.
 *
 * Pure and synchronous, and deliberately free of any platform import, so it can be tested on
 * Linux (`replay-ui.test.ts`) — `source.ts` keeps the hook that reaches storage.
 *
 * It settles the two things the replay has to be honest about:
 *
 *  • `trusted` — `SessionIntegrity.scoreTrusted`, the integrity monitor's own verdict on whether
 *    the run may be presented as a drive at all. It used to be read from `SessionScore.trusted`,
 *    a mirror of it kept inside the scorer so a scored object could never be separated from the
 *    verdict; the scorer is gone and the monitor is the one that survives. When false the
 *    recording still plays and every angle on it is drawn in the neutral grey, because a phone
 *    waved in a parked car produces large angles and a plausible-looking run.
 *  • `gaps` — stretches where the GPS gave no fix, so the positions in them are dead reckoning.
 *    These are `Replay.gapWindows`, NOT a second derivation: the engine's contract says they are
 *    "derived once, here… renderers draw these dashed rather than each deriving their own windows
 *    with their own threshold", and this module used to do exactly that — a 2.0 s middle-gap rule
 *    against the engine's 2.5 s, with no accuracy floor where the engine rejects fixes worse than
 *    50 m. Both copies then went into the warning list, which is why the plate announced "4
 *    PROBLEMS WITH THIS RECORDING" over a list of two problems stated twice.
 */
import { buildReplay, type Replay } from '../../engine/replay';
import type { Session } from '../../engine/types';
import type { FixtureSpec } from '../results/fixture';
import type { ReplayParams } from './params';

/** A stretch of the run with no GPS fix: the position here was dead-reckoned. */
export interface GapWindow {
  /** Replay-relative seconds. */
  startT: number;
  endT: number;
  durationS: number;
}

export interface ReplayView {
  session: Session;
  replay: Replay;
  /** False when the integrity monitor will not vouch for the recording (hand-held phone, etc.). */
  trusted: boolean;
  /** Why it refused, in the integrity monitor's own words. */
  untrustedBody: string;
  /** Session name, uppercased for the HUD (the sim suffix dropped, like the reference frame). */
  title: string;
  /** Everything wrong with the data, in the engine's words. One line per problem. */
  warnings: string[];
  /** `Replay.gapWindows`, with each window's length worked out for the labels. */
  gaps: GapWindow[];
  fixture: FixtureSpec | null;
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

/** The engine's dropout windows, with their lengths — the renderer labels them "NO FIX 7.1S". */
export function gapWindows(replay: Replay): GapWindow[] {
  return replay.gapWindows.map((g) => ({ startT: g.startT, endT: g.endT, durationS: Math.max(0, g.endT - g.startT) }));
}

function titleOf(session: Session, replay: Replay): string {
  const name = replay.info.name || session.name || 'Session';
  return name.toUpperCase().replace(' (SIM)', '');
}

/** Build the view model for an already-loaded session. Pure and synchronous. */
export function buildReplayView(session: Session, params: ReplayParams, fixture: FixtureSpec | null): ReplayView {
  const damaged = params.gaps > 0 ? punchGap(session, params.gaps) : session;
  const replay = buildReplay(damaged, { ghostSync: params.ghost, ghost: !params.noGhost });
  return {
    session: damaged,
    replay,
    trusted: damaged.integrity?.scoreTrusted !== false,
    untrustedBody: damaged.integrity?.message || 'The recording is valid; the judgement is not.',
    title: titleOf(damaged, replay),
    // one line per problem, in the engine's words: the dropouts are already in here, and saying
    // them again per window is how a two-problem recording came to announce four
    warnings: [...replay.warnings],
    gaps: gapWindows(replay),
    fixture,
  };
}
