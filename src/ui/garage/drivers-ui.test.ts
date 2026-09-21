/**
 * The two facts the garage derives from a run's trace, and the sentence it asks before it
 * forgets somebody.
 *
 * Both exist because the garage reads NO session bodies: how long the car was sideways and how
 * long the biggest angle lasted are arithmetic over `SessionIndexEntry.slides`, not two more
 * fields for somebody to forget to write. If either stopped being derivable from the index,
 * the leaderboard would need a body read to draw a row — which is the property the whole
 * screen is built on (`npx tsx tools/analysis/storage-census.ts`).
 */
import { describe, expect, it } from 'vitest';

import { MAX_DRIVERS, NO_DRIVER_LABEL } from '../../platform/drivers';
import type { SessionIndexEntry, SlideMark } from '../../platform';
import { addErrorText, driverHandle, removeDriverCopy } from './driverCopy';
import { peakHold, sidewaysSeconds } from './runFacts';

function slide(startFrac: number, endFrac: number, deg: number, spun: 0 | 1 = 0): SlideMark {
  return [startFrac, endFrac, deg, spun];
}

function run(durationS: number, slides: SlideMark[]): Pick<SessionIndexEntry, 'durationS' | 'slides'> {
  return { durationS, slides };
}

describe('time sideways', () => {
  it('adds up every slide on the run’s own clock', () => {
    expect(sidewaysSeconds(run(100, [slide(0, 0.1, 40), slide(0.5, 0.62, 51)]))).toBeCloseTo(22, 6);
  });

  it('counts a spin, because the car really was sideways', () => {
    // The spin is excluded from the ANGLE everywhere, and that is not an inconsistency: this
    // measures time, which happened, and the angle is a claim about control, which it is not.
    const both = run(100, [slide(0, 0.1, 40), slide(0.3, 0.4, 61, 1)]);
    expect(sidewaysSeconds(both)).toBeCloseTo(20, 6);
    expect(peakHold(both).deg).toBe(40);
  });

  it('is nothing at all when nothing slid, and survives a nonsense duration', () => {
    expect(sidewaysSeconds(run(100, []))).toBe(0);
    expect(sidewaysSeconds(run(Number.NaN, [slide(0, 0.5, 40)]))).toBe(0);
  });
});

describe('the biggest angle held, and for how long', () => {
  it('takes the biggest, and the length of the slide that held it', () => {
    const r = run(100, [slide(0, 0.2, 38), slide(0.4, 0.44, 52), slide(0.7, 0.8, 41)]);
    expect(peakHold(r).deg).toBe(52);
    expect(peakHold(r).slideS).toBeCloseTo(4, 6);
  });

  it('prefers the longer of two slides at the same angle, which is the board’s tie-break', () => {
    expect(peakHold(run(100, [slide(0, 0.02, 56), slide(0.5, 0.58, 56)])).slideS).toBeCloseTo(8, 6);
  });

  it('is nothing for a run of nothing but spins, whatever angles they reached', () => {
    // 118° on the shipped fixtures, and the biggest number in most runs. A spin is not a
    // candidate, here or on the board.
    expect(peakHold(run(100, [slide(0, 0.3, 118, 1)]))).toEqual({ deg: 0, slideS: 0 });
  });
});

describe('what the garage says about the roster', () => {
  it('names each refusal without naming the field that refused it', () => {
    expect(addErrorText('empty')).toMatch(/needs a name/i);
    expect(addErrorText('duplicate')).toMatch(/already on the list/i);
    expect(addErrorText('full')).toContain(String(MAX_DRIVERS));
    expect(addErrorText(null)).toBeNull();
  });

  it('gives a driver a handle a route file can name, which their id is not', () => {
    // A driver id is the clock plus four random characters, so it is different on every run of
    // the harness — a testID built from one can never be named in `tools/harness/routes.mjs`.
    expect(driverHandle({ id: 'd-whatever', name: 'Lukas' })).toBe('lukas');
    expect(driverHandle({ id: 'd-x', name: 'Ana María' })).toBe('ana-mar-a');
    expect(driverHandle(null)).toBe('unassigned');
    // Two ids, one name: the handle follows the name, which is what a demo set fixes.
    expect(driverHandle({ id: 'a', name: 'Sam' })).toBe(driverHandle({ id: 'b', name: 'Sam' }));
  });

  it('tells the truth about what forgetting a driver costs: the name, not the runs', () => {
    // The dangerous copy here is the one that says "this cannot be undone" and stops. What
    // cannot be undone is the NAME on those runs; the driving itself stays on the phone and is
    // listed as unassigned, and a confirmation that implied otherwise would be asking someone
    // to agree to a deletion that is not going to happen.
    const copy = removeDriverCopy('Marco', 6);
    expect(copy.title).toContain('Marco');
    expect(copy.body).toMatch(/nothing is deleted/i);
    expect(copy.body.toLowerCase()).toContain(NO_DRIVER_LABEL.toLowerCase());
    expect(copy.body).toMatch(/6 runs stay/);
    expect(copy.detail).toMatch(/6 runs become/i);
    // …and it does not promise they can be put back, because adding the name again mints a new
    // id and nothing reunites the two.
    expect(copy.body).toMatch(/does not reclaim/i);
  });

  it('promises nothing about runs a driver has not got', () => {
    const copy = removeDriverCopy('Sam', 0);
    expect(copy.body).toMatch(/no runs stored/i);
    expect(copy.body.toLowerCase()).not.toContain(NO_DRIVER_LABEL.toLowerCase());
    expect(copy.detail).toBe('No stored runs');
  });

  it('counts one run in the singular', () => {
    expect(removeDriverCopy('Lukas', 1).body).toMatch(/run stays/);
    expect(removeDriverCopy('Lukas', 1).detail).toMatch(/^1 run becomes/);
  });
});
