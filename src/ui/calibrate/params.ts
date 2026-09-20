/**
 * Calibration-screen query parameters (web / the screenshot harness).
 *
 * `src/platform/simParams.ts` already owns which recording is played (`sim`, `rate`, `seed`,
 * `laps`, `looseness`, `dropouts`). These say WHERE in it to stop, and how the phone is sitting
 * in the car — so a critic can photograph "vertical settled, forward not resolved yet" instead
 * of whatever the screen happens to look like two seconds after it loads.
 *
 *   ?at=6.5      feed the calibrator every sample up to 6.5 s of the recording at once
 *   ?hold=1      stop there, so the same URL gives the same pixels
 *   ?mount=flat-console|landscape-dash|portrait-vent
 *                REGENERATE the recording with the phone physically sitting that way. Not a
 *                presentational override: the simulator really puts the phone on the console,
 *                and the screen reads it back out of the gravity vector like any other mount.
 *
 * Every one of these is a no-op on a device source — there is nothing to seek in live sensors.
 */
import type { MountPreset } from '../../sim';

export interface CalibrateParams {
  /** Recording seconds to warp to before drawing anything. NaN = play from the start. */
  at: number;
  /** Freeze once `at` is reached. */
  hold: boolean;
  /** Simulated mount preset, or null to leave the recording alone. */
  mount: MountPreset | null;
}

export const DEFAULT_CALIBRATE_PARAMS: CalibrateParams = { at: NaN, hold: false, mount: null };

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const MOUNTS: readonly MountPreset[] = ['portrait-vent', 'landscape-dash', 'flat-console', 'random'];

function toParams(input: string | URLSearchParams | null | undefined): URLSearchParams {
  if (!input) return new URLSearchParams();
  if (input instanceof URLSearchParams) return input;
  return new URLSearchParams(input.startsWith('?') ? input.slice(1) : input);
}

export function parseCalibrateParams(input: string | URLSearchParams | null | undefined): CalibrateParams {
  const p = toParams(input);
  const rawAt = p.get('at');
  const at = rawAt === null || rawAt.trim() === '' ? NaN : Number(rawAt);
  const mount = (p.get('mount') ?? '').trim().toLowerCase();
  return {
    at: Number.isFinite(at) && at > 0 ? at : NaN,
    hold: TRUTHY.has((p.get('hold') ?? '').toLowerCase()),
    mount: (MOUNTS as readonly string[]).includes(mount) ? (mount as MountPreset) : null,
  };
}
