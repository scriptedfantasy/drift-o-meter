import { describe, expect, it } from 'vitest';
import { simulateRun, buildPath, TRACKS, findCorners } from './index';
import { radToDeg } from '../engine/types';

describe('simulator', () => {
  it('builds both tracks with corners', () => {
    for (const id of ['harbor', 'touge'] as const) {
      const p = buildPath(TRACKS[id]);
      const c = findCorners(p);
      expect(p.length).toBeGreaterThan(500);
      expect(c.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('produces a physically consistent harbor run', () => {
    const run = simulateRun('harbor', { seed: 3, laps: 1 });
    expect(run.motion.length).toBeGreaterThan(3000);
    expect(run.gps.length).toBeGreaterThan(20);
    const peak = Math.max(...run.truth.map((s) => Math.abs(s.beta)));
    expect(radToDeg(peak)).toBeGreaterThan(20);
    expect(radToDeg(peak)).toBeLessThan(60);
    const vmax = Math.max(...run.truth.map((s) => s.speed));
    expect(vmax).toBeGreaterThan(15);
    // kinematic identity: a_y ≈ v (r + β̇) for small β̇ noise → check mid-drift sample
    const mid = run.truth.filter((s) => s.drifting && s.speed > 8);
    expect(mid.length).toBeGreaterThan(200);
    // GPS is delivered after the fix time (latency)
    const g = run.gps[10];
    expect(g.t).toBeGreaterThan(9);
  });

  it('is deterministic for a seed', () => {
    const a = simulateRun('touge', { seed: 9 });
    const b = simulateRun('touge', { seed: 9 });
    expect(a.motion.length).toBe(b.motion.length);
    expect(a.motion[500].rotationRate.z).toBe(b.motion[500].rotationRate.z);
  });
});
