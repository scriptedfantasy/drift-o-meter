/**
 * When the garage is allowed to mention calibration, and what it says when it does.
 *
 * Calibration is not a step (docs/DESIGN.md), so the default answer is silence. These are the
 * four cases where the LAST RUN left evidence, plus the case that matters most: that the
 * monitor's own sentence is carried verbatim and kept on its own line rather than glued into a
 * template.
 */
import { describe, expect, it } from 'vitest';

import { calibrationBand } from '../../engine/integrity';
import type { SessionIndexEntry } from '../../platform';
import { mountAdvice } from './advice';

/**
 * Qualities picked by asking the engine which band they are in, not by writing thresholds down
 * here. That is the whole point of `calibrationBand`: a screen — or its test — that knows where
 * an edge is can invent a fourth one.
 */
function qualityIn(band: ReturnType<typeof calibrationBand>): number {
  for (let q = 0; q <= 1.0001; q += 0.01) if (calibrationBand(q, true) === band) return Math.round(q * 100) / 100;
  throw new Error(`no quality lands in "${band}"`);
}

function entry(over: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    id: 'r1',
    name: 'Run r1',
    startedAt: 1_000,
    durationS: 120,
    total: 10_000,
    grade: 'B',
    drifts: 6,
    track: 'Harbor Circuit',
    trusted: true,
    heldPeakDeg: 40,
    longestChainPoints: 4_000,
    spins: 0,
    slides: [],
    mount: 'rigid',
    calibrationQuality: qualityIn('sharp'),
    calibrationForwardResolved: true,
    integrityMessage: '',
    ...over,
  };
}

describe('mountAdvice', () => {
  it('says nothing at all about a clean run, and nothing about no runs', () => {
    expect(mountAdvice(entry())).toBeNull();
    expect(mountAdvice(null)).toBeNull();
  });

  it('leads with the rejection when the engine threw the run out', () => {
    const a = mountAdvice(entry({ trusted: false, integrityMessage: 'Phone looks hand-held — clip it into a rigid mount to score drifts.' }));
    expect(a?.concern).toBe('rejected');
    expect(a?.level).toBe('bad');
    // The monitor's sentence, verbatim and on its own, never concatenated into the body.
    expect(a?.quote).toBe('Phone looks hand-held — clip it into a rigid mount to score drifts.');
    expect(a?.body).not.toContain('hand-held');
    expect(a?.body).toMatch(/nothing from that drive was scored/i);
  });

  it('still says the run was thrown out when the monitor had no sentence for it', () => {
    const a = mountAdvice(entry({ trusted: false, integrityMessage: '' }));
    expect(a?.concern).toBe('rejected');
    expect(a?.quote).toBeNull();
  });

  it('warns about a loose mount on a run that was scored anyway', () => {
    const a = mountAdvice(entry({ mount: 'loose' }));
    expect(a?.concern).toBe('loose');
    expect(a?.level).toBe('bad');
  });

  it('says so when the forward axis was never resolved, whatever the confidence', () => {
    const a = mountAdvice(entry({ calibrationQuality: qualityIn('sharp'), calibrationForwardResolved: false }));
    expect(a?.concern).toBe('unresolved');
    expect(a?.level).toBe('warn');
    expect(a?.title).toMatch(/which way the car points/i);
  });

  it('reports a mount the engine could not make sense of, with the confidence it reached', () => {
    const q = qualityIn('unusable');
    const a = mountAdvice(entry({ calibrationQuality: q }));
    expect(a?.concern).toBe('unresolved');
    expect(a?.body).toContain(`${Math.round(q * 100)}%`);
  });

  it('does NOT disown a run the engine was willing to score', () => {
    // The screen used to carry its own 0.4. Anything the engine calls scorable is scored here.
    for (const band of ['trusted', 'sharp'] as const) {
      expect(mountAdvice(entry({ calibrationQuality: qualityIn(band) }))).toBeNull();
    }
  });

  it('mentions an unsteady mount last, and quietly', () => {
    const a = mountAdvice(entry({ mount: 'suspect' }));
    expect(a?.concern).toBe('suspect');
    expect(a?.level).toBe('warn');
  });

  it('prefers the worse finding when a run has more than one', () => {
    const bad = qualityIn('unusable');
    expect(mountAdvice(entry({ trusted: false, mount: 'loose', calibrationQuality: bad }))?.concern).toBe('rejected');
    expect(mountAdvice(entry({ mount: 'loose', calibrationQuality: bad }))?.concern).toBe('loose');
    expect(mountAdvice(entry({ mount: 'suspect', calibrationQuality: bad }))?.concern).toBe('unresolved');
  });

  it('claims nothing about calibration it does not know', () => {
    // An entry written before the fields existed carries −1, not 0. 0 with an unresolved axis
    // would read as "never calibrated" and would put a warning over every run a driver already
    // had — including the runs the engine happily scored before the fields were added.
    expect(mountAdvice(entry({ calibrationQuality: -1, calibrationForwardResolved: false }))).toBeNull();
    expect(mountAdvice(entry({ calibrationQuality: 0 }))?.concern).toBe('unresolved');
  });
});
