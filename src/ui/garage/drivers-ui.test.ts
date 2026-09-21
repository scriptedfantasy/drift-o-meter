/**
 * The one fact the garage still derives from a run's trace, and the sentence it asks before it
 * forgets somebody.
 *
 * Time sideways is arithmetic over `SessionIndexEntry.slides`, because the garage reads NO
 * session bodies and a row has to be able to say what a run was made of from the index alone.
 *
 * There was a `peakHold` beside it, deriving the peak slide's length from the same marks. The
 * index now publishes `peakHeldS` and `peakEntryKmh` off the same slide as `heldPeakDeg`, so
 * the derivation is gone and its tests with it: a second opinion computed here could pick a
 * different slide than the index did whenever two peaks tied, and the row would print an angle
 * from one corner and a hold from another as if they were one sentence.
 */
import { describe, expect, it } from 'vitest';

import { MAX_DRIVERS, NO_DRIVER_LABEL } from '../../platform/drivers';
import type { SessionIndexEntry, SlideMark } from '../../platform';
import { addErrorText, driverHandle, removeDriverCopy } from './driverCopy';
import { sidewaysSeconds } from './runFacts';

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
    expect(sidewaysSeconds(run(100, [slide(0, 0.1, 40), slide(0.3, 0.4, 61, 1)]))).toBeCloseTo(20, 6);
  });

  it('is nothing at all when nothing slid, and survives a nonsense duration', () => {
    expect(sidewaysSeconds(run(100, []))).toBe(0);
    expect(sidewaysSeconds(run(Number.NaN, [slide(0, 0.5, 40)]))).toBe(0);
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
