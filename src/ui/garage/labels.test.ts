/**
 * What a card and a row are allowed to print in their number slots.
 *
 * These encode the engine's own contracts, so they are the tests that fail first if anyone
 * quietly reverses one: `SessionIntegrity.scoreTrusted` ("a consumer MUST NOT present the
 * total… offer the run as a recording") and `SessionBreakdown.angleDrifts` ("lower than
 * `drifts` means a screen should say so").
 */
import { describe, expect, it } from 'vitest';

import type { SessionIndexEntry } from '../../platform';
import { gradeStateColor, gradeStateOf } from './grade';
import { angleText, pointsText, rowFootnote, slidesText } from './labels';

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

describe('the grade slot', () => {
  it('is a letter only when the engine vouched for the run', () => {
    expect(gradeStateOf('A', true)).toEqual({ kind: 'grade', grade: 'A' });
    expect(gradeStateOf('A', false)).toEqual({ kind: 'void' });
    // Unknown is not a licence to award one: an entry written before `trusted` existed.
    expect(gradeStateOf('A', undefined)).toEqual({ kind: 'pending' });
  });

  it('colours the refusal as a refusal, not as a grade', () => {
    expect(gradeStateColor({ kind: 'void' })).not.toBe(gradeStateColor({ kind: 'grade', grade: 'A' }));
    expect(gradeStateColor({ kind: 'pending' })).not.toBe(gradeStateColor({ kind: 'grade', grade: 'D' }));
  });
});

describe('the points slot', () => {
  it('prints the total of a run the engine published', () => {
    expect(pointsText(entry(), 'grade')).toEqual({ value: '23,050', note: null });
  });

  it('prints NO total for a run the engine refused, and offers the recording instead', () => {
    const slot = pointsText(entry({ total: 155, trusted: false }), 'void');
    expect(slot.value).toBe('--');
    expect(slot.value).not.toContain('155');
    expect(slot.note).toBe('Recording · 2:07');
    // "A floor, not a measurement" WAS the claim: a floor is a claim about the total.
    expect(slot.note).not.toMatch(/floor/i);
  });

  it('prints no total before the verdict has arrived either', () => {
    expect(pointsText(entry(), 'pending').value).toBe('--');
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

describe('a row footnote', () => {
  it('names what the number above it is', () => {
    expect(rowFootnote(entry(), 'grade')).toBe('53° held');
    expect(rowFootnote(entry({ heldPeakDeg: 0 }), 'grade')).toBe('no angle held');
  });

  it('says a recording is a recording', () => {
    expect(rowFootnote(entry({ trusted: false }), 'void')).toBe('recording only');
  });
});
