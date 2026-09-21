/**
 * What the engine's own calibration quality MEANS, in one place.
 *
 * WHY THIS EXISTS. Three screens were each comparing `MountCalibration.quality` against their own
 * private numbers: the calibration screen had `SHARP_QUALITY = 0.75`, the garage invented
 * `UNCALIBRATED = 0.4`, and the results screen wrote both as bare literals. So one run at 0.33 was
 * "Calibrated · ready to measure" on the calibration screen, "Mount never calibrated" on the
 * results screen, and grounds to send the driver back to calibrate from the garage — three
 * verdicts on one number, none of which the engine had given.
 *
 * Returning a BAND rather than exporting the thresholds is deliberate. Exported numbers just move
 * the duplication up a level: a screen that can see a threshold can invent a fourth one, and the
 * next screen to need a distinction will. A screen that can only ask which band a run is in
 * cannot disagree with the engine, because it never learns where the edges are.
 *
 * The bands, in the order a run climbs through them:
 *
 *  - `unresolved` — the forward axis was never found, so the app does not know which way the car
 *    points. Nothing about slip angle is meaningful. This is NOT a low number; it is a missing
 *    fact, and it stays `unresolved` at any quality.
 *  - `unusable` — the mount was understood so poorly that the recording cannot be judged.
 *  - `trusted` — good enough to score, with a caveat worth saying out loud: a few degrees of every
 *    measured angle still belong to the mount rather than to the car.
 *  - `sharp` — nothing that follows will be qualified for the mount.
 *
 * The lower edge is the engine's own veto (`IntegrityOptions.minCalibrationQuality`), not a
 * fourth number: below it the monitor refuses to believe the mount at all, so a screen calling
 * that run "usable" would be contradicting the module that threw it out.
 *
 * MEASURED, so the edges are not guesses. Across 48 track × mount × seed combinations at the
 * simulator's default vibration, peak quality runs 0.618–0.864 with a median of 0.750
 * (`npx tsx tools/analysis/calibration-sweep.ts ceiling`). `sharp` therefore names roughly the
 * better half of achievable mounts rather than an unreachable ideal — and any change to that
 * number must be re-derived across seeds, not from one run. See the correction block in
 * `docs/DESIGN.md` for why that warning is written down.
 */
import { DEFAULT_INTEGRITY_OPTIONS } from './monitor';

export type CalibrationBand = 'unresolved' | 'unusable' | 'trusted' | 'sharp';

/**
 * Above this, the mount contributes nothing worth qualifying a number for.
 *
 * Exported ONLY so a gauge can draw the mark — a dial that shows where the bar is genuinely needs
 * its position, and hiding it would just make the screen guess. It must never be compared
 * against to reach a verdict: that is what `calibrationBand` is for, and a screen doing its own
 * comparison is the duplication this module removes. Same for `CALIBRATION_BAR`, the engine's
 * own veto, re-exported here so a dial draws one scale from one source.
 */
export const CALIBRATION_SHARP = 0.75;
const SHARP = CALIBRATION_SHARP;

/** The engine's veto, for drawing the same scale. Never for deciding. */
export const CALIBRATION_BAR = DEFAULT_INTEGRITY_OPTIONS.minCalibrationQuality;

/**
 * Which band a calibration falls in.
 *
 * `quality` is `MountCalibration.quality` (0..1). A non-finite quality is treated as absent,
 * matching `IntegrityMonitor`, which declines to veto on a number it never received.
 */
export function calibrationBand(quality: number, forwardResolved: boolean): CalibrationBand {
  if (!forwardResolved) return 'unresolved';
  if (!Number.isFinite(quality)) return 'trusted';
  if (quality < DEFAULT_INTEGRITY_OPTIONS.minCalibrationQuality) return 'unusable';
  return quality >= SHARP ? 'sharp' : 'trusted';
}

/** True when the band is one the engine will score: `trusted` or `sharp`. */
export function bandIsScorable(band: CalibrationBand): boolean {
  return band === 'trusted' || band === 'sharp';
}

/**
 * HAS THE VERTICAL SETTLED? Two facts from `MountCalibrator.diagnostics()`, and no new number.
 *
 *  - `upAged`: the axis has had its settling time (`MountOptions.upSettleS` of gravity data,
 *    reset by a knock). On its own this says nothing about whether the axis is RIGHT — a phone
 *    waving in a hand ages in exactly like a bolted one, and reads 13 % quality while it does.
 *  - `upQuality` at or above the engine's own floor. `MountCalibrator.quality` is `upQuality`
 *    times a factor that is never above 1, so `quality <= upQuality` always: an up axis under
 *    the floor the monitor refuses a calibration below is BY ITSELF the reason the run would be
 *    refused. A light calling that settled would be contradicting the headline above it.
 *
 * Which is exactly what it did. The calibration screen kept `SETTLED_UP = 0.6` — a threshold on
 * `upQuality`, which is age × accelerometer fit — and a shaking cradle spoils the fit, so the
 * phase was READY while the VERTICAL light read "Settling" on 29,476 of 40,864 READY frames at
 * simulator looseness 0.1 and on 18,932 of 18,932 at 0.15. Because the floor here is the same
 * one `calibrationBand` refuses below, READY now implies settled by construction rather than by
 * luck: `npx tsx tools/analysis/calibration-sweep.ts warmup` reports 0 of them.
 */
export function verticalSettled(upQuality: number, upAged: boolean): boolean {
  if (!upAged) return false;
  if (!Number.isFinite(upQuality)) return true;
  return upQuality >= DEFAULT_INTEGRITY_OPTIONS.minCalibrationQuality;
}

/**
 * How far a scorable calibration sits between the engine's veto and the point where the mount
 * stops qualifying anything: 0 at the bar, 1 at sharp and above.
 *
 * This is for WORDING, not for verdicts. A screen may reasonably want to say "barely past the
 * bar" rather than "clear of it", and without this it would have to hold the two edges to work
 * that out — which is the duplication `calibrationBand` exists to remove. Handing back a
 * position on the engine's own scale lets prose vary by degree while leaving every threshold
 * inside this module. Below the bar, or with the forward axis unresolved, it is 0.
 */
export function calibrationHeadroom(quality: number, forwardResolved: boolean): number {
  if (!bandIsScorable(calibrationBand(quality, forwardResolved))) return 0;
  if (!Number.isFinite(quality)) return 1;
  const floor = DEFAULT_INTEGRITY_OPTIONS.minCalibrationQuality;
  return Math.max(0, Math.min(1, (quality - floor) / (SHARP - floor)));
}
