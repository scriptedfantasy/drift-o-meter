import { describe, expect, it } from 'vitest';

import type { SessionIndexEntry } from '../../platform';
import { groupByNight } from './groups';

function at(id: string, iso: string): SessionIndexEntry {
  return {
    id,
    name: id,
    driverId: null,
    startedAt: new Date(iso).getTime(),
    durationS: 60,
    total: 1,
    grade: 'D',
    drifts: 0,
    track: null,
    trusted: true,
    heldPeakDeg: 0,
    longestChainPoints: 0,
    spins: 0,
    slides: [],
    mount: 'rigid',
    calibrationQuality: 1,
    calibrationForwardResolved: true,
    integrityMessage: '',
  };
}

describe('grouping the earlier runs by night', () => {
  it('keeps one evening together across midnight', () => {
    const groups = groupByNight([at('a', '2026-09-20T01:10:00'), at('b', '2026-09-19T23:40:00'), at('c', '2026-09-19T21:44:00')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].runs.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(groups[0].label).toMatch(/19 Sep$/);
  });

  it('starts a new night once the driver has been to bed', () => {
    const groups = groupByNight([at('a', '2026-09-20T22:00:00'), at('b', '2026-09-19T22:00:00')]);
    expect(groups.map((g) => g.runs.length)).toEqual([1, 1]);
    expect(groups[0].label).not.toBe(groups[1].label);
  });

  it('loses no run, and keeps them in the order it was given', () => {
    const entries = [at('a', '2026-09-20T22:00:00'), at('b', '2026-09-20T21:00:00'), at('c', '2026-09-18T20:00:00')];
    const groups = groupByNight(entries);
    expect(groups.flatMap((g) => g.runs.map((r) => r.id))).toEqual(['a', 'b', 'c']);
  });

  it('does not file an undated run under whichever night came before it', () => {
    const bad = { ...at('x', '2026-09-20T22:00:00'), startedAt: Number.NaN };
    const groups = groupByNight([at('a', '2026-09-20T22:00:00'), bad]);
    expect(groups).toHaveLength(2);
    expect(groups[1].label).toBe('Undated');
  });
});
