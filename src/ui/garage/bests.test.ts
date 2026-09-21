/**
 * The rules the board IS, as opposed to the pixels it draws.
 *
 * Every one of these is an honesty rule that would otherwise live only in a component: that a
 * run the engine refused to vouch for can never hold a place however big its numbers are, that
 * the angle on the board is the one the driver HELD, that a run nobody claimed is listed like
 * anybody else's, and that forgetting a driver does not delete their driving.
 *
 * Nothing here asserts a number the engine produced — only relationships between them.
 */
import { describe, expect, it } from 'vitest';

import { NO_DRIVER_LABEL, type Driver, type Roster } from '../../platform/drivers';
import type { SessionIndexEntry, SlideMark } from '../../platform';
import { groupByNight } from './groups';
import { boardTrack, driverStandings, lastRunStanding, runsOf, trackKeyOf, UNTRACKED } from './bests';

function driver(id: string, name: string): Driver {
  return { id, name, createdAt: 1_000 };
}

function roster(drivers: Driver[], activeId: string | null = null): Roster {
  return { version: 1, drivers, activeId };
}

const LUKAS = driver('d-lukas', 'Lukas');
const MARCO = driver('d-marco', 'Marco');
const SAM = driver('d-sam', 'Sam');

/**
 * One slide, as the index stores it: start and end as fractions of the run, the angle HELD
 * through it, and whether it spun. `durationS` below is 100, so a span of 0.1 is ten seconds.
 */
function slide(startFrac: number, endFrac: number, deg: number, spun: 0 | 1 = 0): SlideMark {
  return [startFrac, endFrac, deg, spun];
}

function entry(over: Partial<SessionIndexEntry> & { id: string }): SessionIndexEntry {
  const heldPeakDeg = over.heldPeakDeg ?? 40;
  return {
    name: `Run ${over.id}`,
    driverId: null,
    startedAt: 1_000,
    durationS: 100,
    total: 10_000,
    grade: 'B',
    drifts: 1,
    track: 'Harbor Circuit',
    trusted: true,
    heldPeakDeg,
    longestChainPoints: 4_000,
    spins: 0,
    // A trace that agrees with the headline figure by default, the way a real entry's does —
    // `summarizeSession` writes both from the same per-slide measurement.
    slides: [slide(0, 0.1, heldPeakDeg)],
    mount: 'rigid',
    calibrationQuality: 0.8,
    calibrationForwardResolved: true,
    integrityMessage: '',
    ...over,
  };
}

function row(standings: ReturnType<typeof driverStandings>, driverId: string | null) {
  return standings.find((s) => s.driverId === driverId);
}

describe('the board', () => {
  it('lets no run the engine refused hold a place, however big its angle', () => {
    // A hand-held recording beats everything on the raw number. It is a run, and it is not a
    // record: the integrity monitor is the only thing between 85° and the top of this list.
    const standings = driverStandings(
      [
        entry({ id: 'fake', driverId: LUKAS.id, startedAt: 3, heldPeakDeg: 85, trusted: false }),
        entry({ id: 'real', driverId: LUKAS.id, startedAt: 2, heldPeakDeg: 41 }),
      ],
      roster([LUKAS]),
    );
    const lukas = row(standings, LUKAS.id);
    expect(lukas?.runs).toBe(2);
    expect(lukas?.scored).toBe(1);
    expect(lukas?.id).toBe('real');
    expect(lukas?.peakDeg).toBe(41);
    expect(lukas?.empty).toBe(false);
  });

  it('ranks by the biggest angle held', () => {
    const standings = driverStandings(
      [
        entry({ id: 'l', driverId: LUKAS.id, heldPeakDeg: 56 }),
        entry({ id: 'm', driverId: MARCO.id, heldPeakDeg: 61 }),
        entry({ id: 's', driverId: SAM.id, heldPeakDeg: 49 }),
      ],
      roster([LUKAS, MARCO, SAM]),
    );
    expect(standings.map((s) => s.name)).toEqual(['Marco', 'Lukas', 'Sam']);
    expect(standings.map((s) => s.rank)).toEqual([1, 2, 3]);
  });

  it('breaks a tie on the angle with how long it was held', () => {
    // The definition of "best drift" is biggest angle, LONGEST HELD. Same 56° either side, so
    // the only thing left to separate them is the slide that carried it: 8 s against 2 s.
    const standings = driverStandings(
      [
        entry({ id: 'brief', driverId: LUKAS.id, heldPeakDeg: 56, slides: [slide(0, 0.02, 56)] }),
        entry({ id: 'long', driverId: MARCO.id, heldPeakDeg: 56, slides: [slide(0, 0.08, 56)] }),
      ],
      roster([LUKAS, MARCO]),
    );
    expect(standings.map((s) => s.name)).toEqual(['Marco', 'Lukas']);
    expect(row(standings, MARCO.id)?.slideS).toBeCloseTo(8, 6);
    expect(row(standings, LUKAS.id)?.slideS).toBeCloseTo(2, 6);
  });

  it('takes the driver’s own best run when they have several, and the longer of two equals', () => {
    const standings = driverStandings(
      [
        entry({ id: 'later', driverId: LUKAS.id, startedAt: 3, heldPeakDeg: 52, slides: [slide(0, 0.03, 52)] }),
        entry({ id: 'longer', driverId: LUKAS.id, startedAt: 2, heldPeakDeg: 52, slides: [slide(0, 0.09, 52)] }),
        entry({ id: 'smaller', driverId: LUKAS.id, startedAt: 1, heldPeakDeg: 47 }),
      ],
      roster([LUKAS]),
    );
    expect(row(standings, LUKAS.id)?.id).toBe('longer');
    expect(row(standings, LUKAS.id)?.runs).toBe(3);
  });

  it('gives a driver who held nothing a row, a dash and no place', () => {
    // A night of nothing but spins holds no angle at all. "0°, 1st" would be the board awarding
    // a place for failing to get sideways, and dropping the row would look like lost runs.
    const standings = driverStandings(
      [
        entry({ id: 'held', driverId: MARCO.id, heldPeakDeg: 44 }),
        entry({ id: 'spun', driverId: LUKAS.id, heldPeakDeg: 0, spins: 4, drifts: 4, slides: [slide(0, 0.1, 61, 1)] }),
      ],
      roster([LUKAS, MARCO]),
    );
    expect(standings.map((s) => s.name)).toEqual(['Marco', 'Lukas']);
    const lukas = row(standings, LUKAS.id);
    expect(lukas?.empty).toBe(true);
    expect(lukas?.rank).toBe(0);
    expect(lukas?.peakDeg).toBe(0);
    // …and the run is still counted as a run, and its time sideways is still measured: the car
    // WAS sideways, which is a fact about the clock rather than a claim about control.
    expect(lukas?.runs).toBe(1);
    expect(lukas?.sidewaysS).toBeCloseTo(10, 6);
  });

  it('claims no time sideways for a run the engine refused', () => {
    // Time sideways is a claim about SLIDING, and the monitor did not believe the sliding. The
    // unassigned row in the shipped `night` set holds exactly one run — the hand-held one — and
    // this column read "1:19 sideways" next to an angle the same row prints as a dash.
    const standings = driverStandings(
      [
        entry({ id: 'refused', driverId: LUKAS.id, trusted: false, slides: [slide(0, 0.6, 85)] }),
        entry({ id: 'believed', driverId: LUKAS.id, heldPeakDeg: 44, slides: [slide(0, 0.1, 44)] }),
      ],
      roster([LUKAS]),
    );
    expect(row(standings, LUKAS.id)?.runs).toBe(2);
    // 10 s from the believed run, and not one of the refused run's 60.
    expect(row(standings, LUKAS.id)?.sidewaysS).toBeCloseTo(10, 6);
  });

  it('never lets a spin be the angle that ranks a driver', () => {
    const standings = driverStandings(
      [entry({ id: 'mixed', driverId: LUKAS.id, heldPeakDeg: 38, drifts: 2, spins: 1, slides: [slide(0, 0.1, 38), slide(0.2, 0.4, 61, 1)] })],
      roster([LUKAS]),
    );
    expect(row(standings, LUKAS.id)?.peakDeg).toBe(38);
    expect(row(standings, LUKAS.id)?.slideS).toBeCloseTo(10, 6);
  });
});

describe('a run with no driver', () => {
  it('gets a row of its own, named once, and is ranked like anybody else', () => {
    const standings = driverStandings(
      [
        entry({ id: 'nobody', driverId: null, heldPeakDeg: 64 }),
        entry({ id: 'lukas', driverId: LUKAS.id, heldPeakDeg: 56 }),
      ],
      roster([LUKAS]),
    );
    expect(standings.map((s) => s.name)).toEqual([NO_DRIVER_LABEL, 'Lukas']);
    expect(standings[0].driverId).toBeNull();
    expect(standings[0].rank).toBe(1);
  });

  it('is the same row as a run whose driver has been forgotten mid-season', () => {
    // Sam drove two of these and was then removed. His id survives on the runs and names
    // nobody, which `driverById` answers exactly as it answers null — one bucket, one row, and
    // the runs are LISTED rather than deleted or quietly handed to whoever is holding the phone.
    const entries = [
      entry({ id: 'orphan-a', driverId: SAM.id, startedAt: 4, heldPeakDeg: 49 }),
      entry({ id: 'orphan-b', driverId: SAM.id, startedAt: 3, heldPeakDeg: 45 }),
      entry({ id: 'nobody', driverId: null, startedAt: 2, heldPeakDeg: 30 }),
      entry({ id: 'lukas', driverId: LUKAS.id, startedAt: 1, heldPeakDeg: 56 }),
    ];
    const after = roster([LUKAS]);
    const standings = driverStandings(entries, after);
    expect(standings).toHaveLength(2);
    const unassigned = row(standings, null);
    expect(unassigned?.name).toBe(NO_DRIVER_LABEL);
    expect(unassigned?.runs).toBe(3);
    // Their best is still their best; it just has no name on it any more.
    expect(unassigned?.peakDeg).toBe(49);
    expect(unassigned?.id).toBe('orphan-a');
    // Not one run went missing.
    expect(standings.reduce((a, s) => a + s.runs, 0)).toBe(entries.length);
    // …and while Sam WAS on the roster, the same entries read as three separate people.
    expect(driverStandings(entries, roster([LUKAS, SAM]))).toHaveLength(3);
  });
});

describe('one driver’s run list', () => {
  const entries = [
    entry({ id: 'a', driverId: LUKAS.id, startedAt: new Date('2026-09-20T22:00:00').getTime() }),
    entry({ id: 'b', driverId: MARCO.id, startedAt: new Date('2026-09-20T21:30:00').getTime() }),
    entry({ id: 'c', driverId: LUKAS.id, startedAt: new Date('2026-09-20T21:00:00').getTime() }),
    entry({ id: 'd', driverId: null, startedAt: new Date('2026-09-18T20:00:00').getTime() }),
  ];

  it('keeps the index’s newest-first order, which is what night grouping assumes', () => {
    // `groupByNight` does not sort: it coalesces ADJACENT entries. Filtering a newest-first
    // list keeps it newest-first, so each night appears ONCE. Grouping first and splitting by
    // driver afterwards would print the same date heading two and three times down one screen.
    const mine = runsOf(entries, roster([LUKAS, MARCO]), LUKAS.id);
    expect(mine.map((e) => e.id)).toEqual(['a', 'c']);
    const nights = groupByNight(mine);
    expect(nights).toHaveLength(1);
    expect(nights[0].runs.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('selects the unassigned runs with a null driver', () => {
    expect(runsOf(entries, roster([LUKAS, MARCO]), null).map((e) => e.id)).toEqual(['d']);
    // Marco forgotten: his run joins the unassigned list rather than vanishing from every list.
    expect(runsOf(entries, roster([LUKAS]), null).map((e) => e.id)).toEqual(['b', 'd']);
  });
});

describe('the track the board is about', () => {
  it('names the track only when every run was driven on it', () => {
    expect(boardTrack([entry({ id: 'a', track: 'Mountain Pass' }), entry({ id: 'b', track: 'Mountain Pass' })])).toBe('Mountain Pass');
    expect(boardTrack([entry({ id: 'x', track: null })])).toBe(UNTRACKED);
    expect(boardTrack([])).toBeNull();
    expect(trackKeyOf({ track: '   ' })).toBe(UNTRACKED);
  });

  it('counts them instead when the board mixes tracks, because it ranks across all of them', () => {
    // The board's question is who has held the biggest angle, not who has held it here — so it
    // ranks across every run, and it may not then be captioned with one track's name. It read
    // "HARBOR CIRCUIT" over a board whose second place was set on a mountain road.
    const mixed = [entry({ id: 'a', track: 'Harbor Circuit' }), entry({ id: 'b', track: 'Mountain Pass' })];
    expect(boardTrack(mixed)).toBe('2 tracks');
    expect(boardTrack(mixed)).not.toMatch(/harbor/i);
  });
});

describe('what the last run did to the board', () => {
  const only = roster([LUKAS]);

  it('says nothing for a run the engine would not vouch for', () => {
    const last = entry({ id: 'void', driverId: LUKAS.id, trusted: false, startedAt: 9 });
    const standings = driverStandings([last, entry({ id: 'old', driverId: LUKAS.id })], only);
    expect(lastRunStanding(standings, last, only)).toBeNull();
  });

  it('calls a driver’s first judged run the bar, not a new record', () => {
    const last = entry({ id: 'first', driverId: LUKAS.id, startedAt: 9, heldPeakDeg: 53 });
    const standing = lastRunStanding(driverStandings([last], only), last, only);
    expect(standing?.onlyScoredRun).toBe(true);
    expect(standing?.isBest).toBe(true);
    expect(standing?.line).toMatch(/first judged run/i);
    expect(standing?.line).not.toMatch(/new /i);
    expect(standing?.line).toContain('53°');
  });

  it('says so when the run just done is the driver’s biggest angle', () => {
    const old = entry({ id: 'old', driverId: LUKAS.id, startedAt: 1, heldPeakDeg: 56 });
    const last = entry({ id: 'new', driverId: LUKAS.id, startedAt: 2, heldPeakDeg: 64, slides: [slide(0, 0.024, 64)] });
    const standing = lastRunStanding(driverStandings([last, old], only), last, only);
    expect(standing?.isBest).toBe(true);
    expect(standing?.behindDeg).toBeNull();
    expect(standing?.line).toBe('New biggest angle — 64°, in a 2.4 s slide');
  });

  it('measures the gap in degrees when it took nothing', () => {
    const old = entry({ id: 'old', driverId: LUKAS.id, startedAt: 1, heldPeakDeg: 60 });
    const last = entry({ id: 'new', driverId: LUKAS.id, startedAt: 2, heldPeakDeg: 56 });
    const standing = lastRunStanding(driverStandings([last, old], only), last, only);
    expect(standing?.isBest).toBe(false);
    expect(standing?.behindDeg).toBe(4);
    expect(standing?.line).toBe('4° off the biggest angle on this board');
  });

  it('compares against the DRIVER the run belongs to, not against the board leader', () => {
    // Marco's 64° is not Lukas's bar. The old board compared against the track, which put two
    // people's driving in one column and called the loser "4 off your best".
    const full = roster([LUKAS, MARCO]);
    const marco = entry({ id: 'm', driverId: MARCO.id, startedAt: 1, heldPeakDeg: 64 });
    const lukasOld = entry({ id: 'l1', driverId: LUKAS.id, startedAt: 2, heldPeakDeg: 50 });
    const last = entry({ id: 'l2', driverId: LUKAS.id, startedAt: 3, heldPeakDeg: 56 });
    const standing = lastRunStanding(driverStandings([last, lukasOld, marco], full), last, full);
    expect(standing?.isBest).toBe(true);
    expect(standing?.line).toMatch(/new biggest angle/i);
  });

  it('measures an unassigned run against the unassigned board row', () => {
    // Same 60° either side, so the board keeps the one that held it longer — which is the
    // ranking rule, and which leaves the run just done level rather than ahead.
    const old = entry({ id: 'old', driverId: null, startedAt: 1, heldPeakDeg: 60, slides: [slide(0, 0.12, 60)] });
    const last = entry({ id: 'new', driverId: null, startedAt: 2, heldPeakDeg: 60, slides: [slide(0, 0.03, 60)] });
    const standing = lastRunStanding(driverStandings([last, old], only), last, only);
    expect(standing?.line).toBe('Level with the biggest angle on this board');
  });
});
