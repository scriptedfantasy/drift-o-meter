/**
 * What a card and a row are allowed to print in their slots.
 *
 * These encode the engine's own contracts, so they are the tests that fail first if anyone
 * quietly reverses one: `SessionIntegrity.scoreTrusted` ("a consumer MUST NOT present the
 * total… offer the run as a recording") and `SessionBreakdown.angleDrifts` ("lower than
 * `drifts` means a screen should say so").
 *
 * The points slot the first of those was written against is gone. The rule is not: a run the
 * engine refused publishes NO judged figure, and the slots that replaced the points — the
 * angle, the slide count, the time sideways — each have to refuse in their own right.
 */
import { describe, expect, it } from 'vitest';

import type { SessionIndexEntry, SlideMark } from '../../platform';
import { angleText, holdText, rowFootnote, runShapeText, slidesText, speedText } from './labels';
import { runStateColor, runStateOf } from './runState';

function entry(over: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    id: 'r1',
    name: 'Run r1',
    driverId: null,
    startedAt: 1_000,
    durationS: 127,
    total: 23_050,
    grade: 'A',
    drifts: 8,
    track: 'Harbor Circuit',
    trusted: true,
    heldPeakDeg: 52.8,
    peakHeldS: 0,
    peakEntryKmh: 0,
    longestChainPoints: 11_734,
    spins: 0,
    slides: [],
    mount: 'rigid',
    calibrationQuality: 0.74,
    calibrationForwardResolved: true,
    integrityMessage: '',
    ...over,
  };
}

function slide(startFrac: number, endFrac: number, deg: number, spun: 0 | 1 = 0): SlideMark {
  return [startFrac, endFrac, deg, spun];
}

describe('the state a run’s slot is in', () => {
  it('is judged only when the engine vouched for the run', () => {
    expect(runStateOf(true)).toEqual({ kind: 'judged' });
    expect(runStateOf(false)).toEqual({ kind: 'void' });
    // Unknown is not a licence to present one: an entry written before `trusted` existed.
    expect(runStateOf(undefined)).toEqual({ kind: 'pending' });
  });

  it('colours the refusal as a refusal, not as an achievement', () => {
    // The letters carried this signal and their colours went with them. Red for a run the
    // engine threw out is the part that may not go: it is the one thing on the home screen a
    // driver has to be able to pick out without reading anything.
    const refused = runStateColor({ kind: 'void' }, 52.8);
    expect(refused).not.toBe(runStateColor({ kind: 'judged' }, 52.8));
    expect(refused).not.toBe(runStateColor({ kind: 'pending' }, 0));
    // …and it does not depend on the angle the refused run claims, which is the number the
    // refusal is about.
    expect(runStateColor({ kind: 'void' }, 85)).toBe(refused);
  });

  it('gives a judged run the colour of the angle it held, and nothing for an angle it did not', () => {
    expect(runStateColor({ kind: 'judged' }, 20)).not.toBe(runStateColor({ kind: 'judged' }, 68));
    expect(runStateColor({ kind: 'judged' }, 0)).not.toBe(runStateColor({ kind: 'judged' }, 40));
  });
});

describe('the angle slot', () => {
  it('rounds the held peak and marks it with a degree sign', () => {
    expect(angleText(entry(), false)).toBe('53°');
  });

  it('claims no angle for a run that was not believed', () => {
    // The raw peak of a hand-held recording came out at 85° — bigger than any trusted run.
    expect(angleText(entry({ heldPeakDeg: 85 }), true)).toBe('--');
  });

  it('claims no angle for a run that held nothing', () => {
    expect(angleText(entry({ heldPeakDeg: 0 }), false)).toBe('--');
  });
});

describe('how long it was held', () => {
  // `SessionIndexEntry.peakHeldS`, which is the engine's `timeAtAngleS` for the slide the angle
  // came off — not the whole slide's length, which this printed while the index had nothing
  // better and which claimed 27 s at 53° for a slide that was at 53° for four of them.
  it('keeps a tenth while the number is small and drops it once it is not', () => {
    expect(holdText(2.44)).toBe('2.4s');
    expect(holdText(12.4)).toBe('12s');
  });

  it('says nothing when nothing was held', () => {
    expect(holdText(0)).toBe('--');
    expect(holdText(Number.NaN)).toBe('--');
  });
});

describe('the speed the slide was entered at', () => {
  it('is whole km/h', () => {
    expect(speedText(78)).toBe('78');
    expect(speedText(71.4)).toBe('71');
  });

  it('is a dash at zero, never the figure 0', () => {
    // Zero means the run named no slide at all — the three figures a row prints arrive together
    // or not at all — and "0" under KM/H would be claiming the car was standing still.
    expect(speedText(0)).toBe('--');
    expect(speedText(Number.NaN)).toBe('--');
  });
});

describe('the slide count', () => {
  it('is a plain count when nothing was spun', () => {
    expect(slidesText(entry({ drifts: 8, spins: 0 }), false)).toEqual({ value: '8', note: null });
  });

  it('says how many of them the angle was measured over', () => {
    const slot = slidesText(entry({ drifts: 11, spins: 3 }), false);
    expect(slot.value).toBe('8 of 11');
    expect(slot.note).toBe('3 spun');
  });

  it('counts one spin in the singular', () => {
    expect(slidesText(entry({ drifts: 8, spins: 1 }), false).note).toBe('1 spun');
  });

  it('publishes no judged count on a run the monitor did not believe', () => {
    // `implausibleDriftFraction = 1.000`: nothing about the sliding was believed, so the slot
    // claims nothing — but the card DRAWS those seven slides, and `SLIDES --` over a plot with
    // seven countable marks is the screen refusing a number and then showing it. The note says
    // the same thing the trace's own caption says: recorded, not judged.
    expect(slidesText(entry({ drifts: 7, spins: 3 }), true)).toEqual({ value: '--', note: '7 recorded' });
    expect(slidesText(entry({ drifts: 1, spins: 1 }), true).note).toBe('1 recorded');
    // Nothing recorded, nothing to count.
    expect(slidesText(entry({ drifts: 0, spins: 0 }), true)).toEqual({ value: '--', note: null });
  });
});

describe('what a row says a run was made of', () => {
  it('counts the slides and adds up the time the car was sideways', () => {
    const line = runShapeText(entry({ durationS: 100, drifts: 2, slides: [slide(0, 0.1, 40), slide(0.3, 0.42, 51)] }), 'judged');
    expect(line).toBe('2 slides · 0:22 sideways');
  });

  it('names the spins in the same breath as the count', () => {
    const line = runShapeText(entry({ durationS: 100, drifts: 11, spins: 3, slides: [slide(0, 0.1, 40)] }), 'judged');
    expect(line).toMatch(/^8 of 11 slides · 3 spun/);
  });

  it('claims no time sideways at all on a run the monitor did not believe', () => {
    // Time sideways is a claim about SLIDING, and the monitor did not believe the sliding. The
    // recording's own length is a fact about the file, so that is what is offered instead.
    const line = runShapeText(entry({ durationS: 127, drifts: 7, spins: 3, slides: [slide(0, 0.5, 80)] }), 'void');
    expect(line).toBe('7 recorded · not judged');
    expect(line).not.toMatch(/sideways/);
    expect(runShapeText(entry({ drifts: 0, slides: [] }), 'void')).toBe('Recording · 2:07');
  });

  it('claims nothing before the verdict has arrived either', () => {
    expect(runShapeText(entry({ durationS: 100, drifts: 2, slides: [slide(0, 0.1, 40)] }), 'pending')).not.toMatch(/sideways/);
  });
});

describe('a row footnote', () => {
  it('names what the number above it is', () => {
    expect(rowFootnote(entry(), 'judged')).toBe('53° held');
    expect(rowFootnote(entry({ heldPeakDeg: 0 }), 'judged')).toBe('no angle held');
  });

  it('says a recording is a recording', () => {
    expect(rowFootnote(entry({ trusted: false }), 'void')).toBe('recording only');
  });
});
