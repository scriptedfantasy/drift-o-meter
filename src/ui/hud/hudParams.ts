/**
 * HUD-only query parameters (web / the screenshot harness).
 *
 * `src/platform/simParams.ts` already owns `sim` / `rate` / `seed` / `laps` (which recording to
 * play). These are about WHICH MOMENT of that recording the HUD shows, so a critic — or the
 * harness — can capture the same frame every time instead of whatever t=0 happens to look like:
 *
 *   ?at=114.5     warp the run to 114.5 s of the recording (the pipeline is fed every sample up
 *                 to that instant at once, silently), then keep playing from there. Implies run=1.
 *   ?hold=1       stop at `at` and hold that frame: no further samples, deterministic pixels.
 *   ?run=1        arm and start the run on mount instead of showing the READY screen.
 *   ?integrity=loose|suspect|gps-poor|gps-none|physics
 *                 presentation-only override of `frame.integrity`, so the warning states can be
 *                 captured from a clean recording. It changes nothing upstream of the view.
 *
 * Unknown values are ignored; every parameter is a no-op on a device source (nothing to seek).
 */
import type { LiveFrame } from '../../engine/pipeline';

export interface HudParams {
  /** Recording time to warp to before showing anything, seconds. NaN = play from the start. */
  at: number;
  /** Freeze playback once `at` is reached. */
  hold: boolean;
  /** Start the run without the READY screen. */
  autoRun: boolean;
  /** Presentation override for the integrity block, or null. */
  integrity: LiveFrame['integrity'] | null;
}

export const DEFAULT_HUD_PARAMS: HudParams = { at: NaN, hold: false, autoRun: false, integrity: null };

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

const INTEGRITY_PRESETS: Record<string, LiveFrame['integrity']> = {
  loose: { mount: 'loose', physics: 'ok', gps: 'good', message: 'Phone is moving in the mount — tighten it' },
  suspect: { mount: 'suspect', physics: 'ok', gps: 'good', message: 'Mount is shaking — angles may read high' },
  'gps-poor': { mount: 'rigid', physics: 'ok', gps: 'poor', message: 'Weak GPS — drive into the open' },
  'gps-none': { mount: 'rigid', physics: 'ok', gps: 'none', message: 'No GPS fix — scoring is paused' },
  physics: { mount: 'rigid', physics: 'implausible', gps: 'good', message: 'Readings are not physically possible' },
  ok: { mount: 'rigid', physics: 'ok', gps: 'good', message: 'Tracking' },
};

function toParams(input: string | URLSearchParams | null | undefined): URLSearchParams {
  if (!input) return new URLSearchParams();
  if (input instanceof URLSearchParams) return input;
  return new URLSearchParams(input.startsWith('?') ? input.slice(1) : input);
}

export function parseHudParams(input: string | URLSearchParams | null | undefined): HudParams {
  const p = toParams(input);
  const rawAt = p.get('at');
  const at = rawAt === null || rawAt.trim() === '' ? NaN : Number(rawAt);
  const hold = TRUTHY.has((p.get('hold') ?? '').toLowerCase());
  const run = TRUTHY.has((p.get('run') ?? '').toLowerCase());
  const integrityKey = (p.get('integrity') ?? '').toLowerCase();
  return {
    at: Number.isFinite(at) && at > 0 ? at : NaN,
    hold,
    autoRun: run || (Number.isFinite(at) && at > 0),
    integrity: INTEGRITY_PRESETS[integrityKey] ?? null,
  };
}
