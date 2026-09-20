/**
 * Replay screen query parameters.
 *
 * Two audiences:
 *  • the results screen, which deep-links into a moment (`t`, `drift`) and, for a fixture run,
 *    says which session to rebuild (`fixture`, `source`);
 *  • the screenshot harness, which needs a deterministic frame (`cam`, `play`, `rate`, `hl`,
 *    `scrub`, `ui`, `motion`) and a way to photograph the bad-data path (`gaps`).
 *
 * Everything is optional and clamped; an unparseable value is ignored rather than throwing, so a
 * hand-typed URL can never break the screen. See tools/harness/README.md for the full table.
 */
import type { CameraMode } from '../../engine/replay';
import { clamp } from '../../engine/types';

export type UiMode = 'auto' | 'pinned' | 'hidden';
export type MotionMode = 'system' | 'reduce' | 'full';
export type GhostSync = 'distance' | 'time';

export interface ReplayParams {
  /** Seek here on open, replay-relative seconds. */
  t: number | null;
  /** Seek to this drift and highlight it. */
  driftId: number | null;
  /** Jump to the nth-best highlight on open (1-based). */
  highlight: number | null;
  cam: CameraMode | null;
  play: boolean | null;
  rate: number | null;
  /** Open with the playhead grabbed at this fraction of the run (0..1) — a drag, frozen. */
  scrub: number | null;
  ghost: GhostSync;
  /** Hide the ghost entirely. */
  noGhost: boolean;
  /** Blank the recorded positions for this many seconds mid-run (a tunnel). */
  gaps: number;
  ui: UiMode;
  motion: MotionMode;
}

type Raw = Record<string, string | string[] | undefined>;

function str(params: Raw, key: string): string | undefined {
  const v = params[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() !== '' ? s.trim() : undefined;
}

function num(params: Raw, key: string, lo: number, hi: number): number | null {
  const s = str(params, key);
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? clamp(n, lo, hi) : null;
}

function flag(params: Raw, key: string): boolean | null {
  const s = str(params, key)?.toLowerCase();
  if (s === undefined) return null;
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return null;
}

const CAMS: Record<string, CameraMode> = {
  overview: 'overview',
  track: 'overview',
  map: 'overview',
  chase: 'chase',
  cinematic: 'cinematic',
  cine: 'cinematic',
};

export function parseReplayParams(params: Raw): ReplayParams {
  const cam = str(params, 'cam')?.toLowerCase();
  const rate = num(params, 'rate', 0.25, 4);
  const ui = str(params, 'ui')?.toLowerCase();
  const motion = str(params, 'motion')?.toLowerCase();
  const ghost = str(params, 'ghost')?.toLowerCase();
  const drift = num(params, 'drift', 0, 1e6);
  return {
    t: num(params, 't', 0, 1e6),
    driftId: drift === null ? null : Math.round(drift),
    highlight: (() => {
      const h = num(params, 'hl', 1, 64);
      return h === null ? null : Math.round(h);
    })(),
    cam: cam && CAMS[cam] ? CAMS[cam] : null,
    play: flag(params, 'play'),
    rate: rate === null ? null : nearestRate(rate),
    scrub: num(params, 'scrub', 0, 1),
    ghost: ghost === 'time' ? 'time' : 'distance',
    noGhost: ghost === 'off' || ghost === 'none' || flag(params, 'ghost') === false,
    gaps: num(params, 'gaps', 0, 60) ?? 0,
    ui: ui === '1' || ui === 'pinned' || ui === 'on' ? 'pinned' : ui === '0' || ui === 'hidden' || ui === 'off' ? 'hidden' : 'auto',
    motion: motion === 'reduce' ? 'reduce' : motion === 'full' ? 'full' : 'system',
  };
}

/** The three speeds the transport offers; anything else snaps to the nearest one. */
export const RATES = [0.5, 1, 2] as const;

export function nearestRate(rate: number): number {
  let best: number = RATES[1];
  for (const r of RATES) if (Math.abs(r - rate) < Math.abs(best - rate)) best = r;
  return best;
}
