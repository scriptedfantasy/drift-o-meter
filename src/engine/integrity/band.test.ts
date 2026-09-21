/**
 * The bands exist so three screens cannot each invent their own edges. These tests therefore
 * assert the PROPERTY that makes that work — a band is never handed out that contradicts the
 * monitor's own veto — rather than restating the numbers, which would just be a fourth copy.
 */
import { describe, expect, it } from 'vitest';

import { bandIsScorable, calibrationBand, DEFAULT_INTEGRITY_OPTIONS, type CalibrationBand } from './index';

const VETO = DEFAULT_INTEGRITY_OPTIONS.minCalibrationQuality;

describe('calibrationBand', () => {
  it('an unresolved forward axis is not a low number, it is a missing fact', () => {
    // It stays unresolved at every quality, including a perfect one: the app does not know which
    // way the car points, so nothing about slip angle means anything.
    for (const q of [0, 0.2, 0.3, 0.5, 0.74, 0.75, 0.9, 1]) {
      expect(calibrationBand(q, false), `quality ${q}`).toBe('unresolved');
    }
  });

  it('never calls a run scorable that the monitor vetoed, and never vetoes one it scored', () => {
    // This is the whole point of the module: the lower edge IS the engine's veto, so a screen
    // cannot call a run unusable that the engine went on to score, or usable that it threw out.
    for (let q = 0; q <= 1.0001; q += 0.005) {
      const monitorBelieves = q >= VETO;
      const band = calibrationBand(q, true);
      expect(bandIsScorable(band), `quality ${q.toFixed(3)}`).toBe(monitorBelieves);
    }
  });

  it('climbs through the bands and never goes back down', () => {
    const rank: Record<CalibrationBand, number> = { unresolved: -1, unusable: 0, trusted: 1, sharp: 2 };
    let last = -Infinity;
    for (let q = 0; q <= 1.0001; q += 0.005) {
      const r = rank[calibrationBand(q, true)];
      expect(r, `quality ${q.toFixed(3)} went backwards`).toBeGreaterThanOrEqual(last);
      last = r;
    }
    expect(calibrationBand(1, true)).toBe('sharp');
    expect(calibrationBand(0, true)).toBe('unusable');
  });

  it('treats an absent quality the way the monitor does — it declines to veto on a number it never got', () => {
    for (const q of [NaN, Infinity, -Infinity]) {
      expect(calibrationBand(q, true)).toBe('trusted');
      expect(bandIsScorable(calibrationBand(q, true))).toBe(true);
    }
  });

  it('puts the sharp edge inside the range a real mount reaches', () => {
    // Measured peak quality across 48 track x mount x seed combinations is 0.618..0.864, median
    // 0.750 (`npx tsx tools/analysis/calibration-sweep.ts ceiling`). A sharp edge outside that
    // range would either be unreachable or meaningless, and `docs/DESIGN.md` carries a correction
    // block about exactly this number being asserted from too few runs.
    expect(calibrationBand(0.618, true)).toBe('trusted');
    expect(calibrationBand(0.864, true)).toBe('sharp');
  });
});
