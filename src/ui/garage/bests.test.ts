/**
 * The rules the personal-best board is, as opposed to the pixels it draws.
 *
 * Every one of these is an honesty rule that used to live only in a component: that a run the
 * engine refused to vouch for can never hold a record, that the angle on the board is the one
 * the driver held, and that a board of one run says so instead of pretending to be a board.
 * Point totals move when the scorer is tuned, so nothing here asserts a number the engine
 * produced — only relationships between them.
 */
import { describe, expect, it } from 'vitest';

import type { SessionIndexEntry } from '../../platform';
import { bestGradeOf, lastRunStanding, personalBests, trackKeyOf, UNTRACKED } from './bests';

function entry(over: Partial<SessionIndexEntry> & { id: string }): SessionIndexEntry {
  return {
    name: `Run ${over.id}`,
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
    calibrationQuality: 0.8,
    integrityMessage: '',
    ...over,
  };
}

function tile(bests: ReturnType<typeof personalBests>, track: string, key: string) {
  const panel = bests.find((b) => b.track === track);
  return panel?.records.find((r) => r.key === key);
}

describe('personal bests', () => {
  it('lets no untrusted run hold a record, however big its numbers are', () => {
    const bests = personalBests([
      entry({ id: 'real', startedAt: 2, total: 9_000, grade: 'B', heldPeakDeg: 41, longestChainPoints: 3_000 }),
      // A hand-held recording beats it on every raw number. It is a run, and it is not a record.
      entry({ id: 'fake', startedAt: 3, total: 90_000, grade: 'S', heldPeakDeg: 85, longestChainPoints: 60_000, trusted: false }),
    ]);
    const panel = bests[0];
    expect(panel.runs).toBe(2);
    expect(panel.scored).toBe(1);
    for (const r of panel.records) expect(r.id).not.toBe('fake');
    expect(tile(bests, 'Harbor Circuit', 'points')?.id).toBe('real');
    expect(bestGradeOf(panel)).toBe('B');
  });

  it('shows dashes rather than zeros on a track where nothing was scored', () => {
    const bests = personalBests([entry({ id: 'x', trusted: false })]);
    expect(bests[0].scored).toBe(0);
    for (const r of bests[0].records) {
      expect(r.empty).toBe(true);
      expect(r.value).toBe('--');
      expect(r.id).toBe('');
    }
  });

  it('takes the biggest angle from the held figure the index carries', () => {
    const bests = personalBests([
      entry({ id: 'a', startedAt: 1, heldPeakDeg: 52 }),
      entry({ id: 'b', startedAt: 2, heldPeakDeg: 47 }),
    ]);
    const angle = tile(bests, 'Harbor Circuit', 'angle');
    expect(angle?.id).toBe('a');
    expect(angle?.value).toBe('52°');
    expect(angle?.amount).toBe(52);
  });

  it('awards no angle record to a run that held nothing (a session of spins holds 0)', () => {
    const bests = personalBests([entry({ id: 'spun', heldPeakDeg: 0, spins: 4, drifts: 4 })]);
    const angle = tile(bests, 'Harbor Circuit', 'angle');
    expect(angle?.empty).toBe(true);
    // ... while the run still holds the records it genuinely earned
    expect(tile(bests, 'Harbor Circuit', 'points')?.id).toBe('spun');
  });

  it('notes an unbroken run only when one run holds the chain AND the points, at the same value', () => {
    const unbroken = personalBests([
      entry({ id: 'one', total: 30_046, longestChainPoints: 30_046 }),
      entry({ id: 'two', startedAt: 2, total: 12_000, longestChainPoints: 3_000 }),
    ]);
    expect(tile(unbroken, 'Harbor Circuit', 'chain')?.note).toBe('the whole run, unbroken');

    const split = personalBests([
      entry({ id: 'points', startedAt: 1, total: 30_000, longestChainPoints: 9_000 }),
      entry({ id: 'chain', startedAt: 2, total: 12_000, longestChainPoints: 11_000 }),
    ]);
    expect(tile(split, 'Harbor Circuit', 'chain')?.note).toBeUndefined();

    const almost = personalBests([entry({ id: 'near', total: 30_046, longestChainPoints: 29_000 })]);
    expect(tile(almost, 'Harbor Circuit', 'chain')?.note).toBeUndefined();
  });

  it('groups by track, most recently driven first, and names an unnamed road', () => {
    const bests = personalBests([
      entry({ id: 'h1', startedAt: 500, track: 'Harbor Circuit' }),
      entry({ id: 'm1', startedAt: 900, track: 'Mountain Pass' }),
      entry({ id: 'n1', startedAt: 100, track: null }),
    ]);
    expect(bests.map((b) => b.track)).toEqual(['Mountain Pass', 'Harbor Circuit', UNTRACKED]);
    expect(trackKeyOf({ track: '   ' })).toBe(UNTRACKED);
  });

  it('says a one-run board is a one-run board', () => {
    const one = personalBests([entry({ id: 'solo' })]);
    expect(one[0].framing).toMatch(/one scored run/i);
    const two = personalBests([entry({ id: 'a' }), entry({ id: 'b', startedAt: 2, total: 1 })]);
    expect(two[0].framing).toBeNull();
  });
});

describe('what the last run did to the records', () => {
  it('says nothing for a run the engine would not vouch for', () => {
    const last = entry({ id: 'void', trusted: false, startedAt: 9 });
    const bests = personalBests([last, entry({ id: 'old' })]);
    expect(lastRunStanding(bests, last)).toBeNull();
  });

  it('calls the first scored run on a track the bar, not four new records', () => {
    const last = entry({ id: 'first', startedAt: 9 });
    const bests = personalBests([last]);
    const standing = lastRunStanding(bests, last);
    expect(standing?.onlyScoredRun).toBe(true);
    expect(standing?.records).toHaveLength(4);
    expect(standing?.line).toMatch(/first scored run/i);
    expect(standing?.line).not.toMatch(/new record/i);
  });

  it('names the records the last run took', () => {
    const old = entry({ id: 'old', startedAt: 1, total: 20_000, heldPeakDeg: 60, longestChainPoints: 9_000, grade: 'A' });
    const last = entry({ id: 'new', startedAt: 2, total: 12_000, heldPeakDeg: 64, longestChainPoints: 3_000, grade: 'B' });
    const standing = lastRunStanding(personalBests([last, old]), last);
    expect(standing?.records).toEqual(['angle']);
    expect(standing?.line).toBe('New record — biggest angle');
  });

  it('measures the gap when it took nothing', () => {
    const old = entry({ id: 'old', startedAt: 1, total: 24_233, heldPeakDeg: 60, longestChainPoints: 9_000, grade: 'S' });
    const last = entry({ id: 'new', startedAt: 2, total: 23_050, heldPeakDeg: 56, longestChainPoints: 3_000, grade: 'A' });
    const standing = lastRunStanding(personalBests([last, old]), last);
    expect(standing?.records).toEqual([]);
    expect(standing?.pointsBehind).toBe(24_233 - 23_050);
    expect(standing?.line).toBe('1,183 off your best here');
  });

  it('compares against the track the run was actually driven on', () => {
    const harbor = entry({ id: 'h', startedAt: 1, total: 40_000, track: 'Harbor Circuit', grade: 'S' });
    const otherHarbor = entry({ id: 'h2', startedAt: 2, total: 30_000, track: 'Harbor Circuit' });
    const touge = entry({ id: 't', startedAt: 3, total: 12_000, track: 'Mountain Pass' });
    const standing = lastRunStanding(personalBests([touge, otherHarbor, harbor]), touge);
    // The 40,000 on the other track is not this run's bar.
    expect(standing?.line).toMatch(/first scored run on Mountain Pass/i);
  });
});
