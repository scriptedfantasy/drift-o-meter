/**
 * What the last-run card's plot is allowed to draw — checked against runs the real engine really
 * scored, and against the geometry the canvas is handed.
 *
 * The defect these exist for was on screen under a green suite. Every spun slide was stored and
 * drawn at `DriftEvent.peakAngle` (118° on the shipped fixtures) on an axis captioned "HELD
 * ANGLE THROUGH THE RUN · 60° TOP", clamped to that ceiling — so three spins drew as three
 * identical full-height walls directly over the same card's "HELD ANGLE 18°", and a run whose
 * angle the card prints as `--` had its angles drawn anyway. `summary.test.ts` asserted only
 * `deg > 0` for each mark, which 118° satisfies.
 *
 * So these are MAXIMA and identities, not floors: a floor proves something drew, and the claims
 * here are all about what is NOT drawn (docs/CRITIC.md, rule 15).
 */
import { describe, expect, it } from 'vitest';

import { radToDeg, type Session } from '../../engine/types';
// Straight from the module, not the platform barrel: the barrel pulls in expo-sensors.
import { summarizeSession, type SlideMark } from '../../platform/sessionStore';
import { ANGLE_STOPS, angleColor, MAX_ANGLE_DEG } from '../theme';
import { buildFixtureSession, FIXTURES } from '../results/fixture';
import { measuredCount, traceBars, traceLegend, TRACE_CEILING_DEG } from './trace';

/** Runs that between them cover every state the plot has: spins, none, and a refused run. */
const CASES = ['spin', 'sloppy', 'touge', 'good', 'hero', 'handheld'] as const;

/**
 * The per-slide measurements, from whichever place this session keeps them — the same order
 * `sessionStore`'s own accessor uses. `Session.driftStats` is the home; a run stored before it
 * existed has them inside the scorer's per-drift record, and a test that only knew the old
 * place would go green against a session that has neither.
 */
function statsOf(s: Session, id: number): { heldPeakDeg: number; spun: boolean } | null {
  type Stats = { heldPeakDeg: number; spun: boolean };
  const own = s.driftStats as Record<number, Stats> | undefined;
  if (own?.[id]) return own[id];
  const per = s.score?.perDrift as unknown as Record<number, { stats?: Stats }> | undefined;
  return per?.[id]?.stats ?? null;
}

describe('the ceiling the axis is captioned with', () => {
  it('is the shared angle ramp’s own full scale, not a number typed in here', () => {
    // It WAS the last knot of the scorer's angle curve, and the points took that curve with
    // them. The rule the old assertion carried is the one that matters and it survives the
    // move: the number the axis is captioned with has to come from somewhere else, or it goes
    // quietly false the next time the scale changes. `ANGLE_STOPS` is where angles get their
    // colour, so the top of this axis is now the same degree as the top of the dial's sweep —
    // 60 here against 70 there is why one 64° hold drew full-height in the garage and
    // nine-tenths of the way round on the drive screen.
    expect(TRACE_CEILING_DEG).toBe(MAX_ANGLE_DEG);
    expect(MAX_ANGLE_DEG).toBe(ANGLE_STOPS[ANGLE_STOPS.length - 1].deg);
    // …and the last stop really is the top of the ramp, so the caption means "as far as this
    // app draws an angle" rather than "as far as the stops happen to be listed".
    for (const stop of ANGLE_STOPS) expect(stop.deg).toBeLessThanOrEqual(MAX_ANGLE_DEG);
    // The colour at the ceiling is the colour the ramp ends on, which is what makes a mark at
    // the top of the axis read as the limit rather than as a high score.
    expect(angleColor(MAX_ANGLE_DEG).toLowerCase()).toBe(ANGLE_STOPS[ANGLE_STOPS.length - 1].color.toLowerCase());
  });
});

describe.each(CASES)('the %s run’s plot', (name) => {
  const session = buildFixtureSession({ ...FIXTURES[name] });
  const entry = summarizeSession(session);
  const believed = entry.trusted;

  it('puts every slide the run had on the plot, in order and inside it', () => {
    const bars = traceBars(entry.slides, { believed });
    expect(bars).toHaveLength(session.drifts.length);
    let previous = -1;
    for (const bar of bars) {
      expect(bar.x0).toBeGreaterThanOrEqual(0);
      expect(bar.x1).toBeLessThanOrEqual(1);
      expect(bar.x1).toBeGreaterThanOrEqual(bar.x0);
      expect(bar.x0).toBeGreaterThanOrEqual(previous);
      previous = bar.x0;
    }
  });

  it('draws nothing above the ceiling the caption states', () => {
    for (const bar of traceBars(entry.slides, { believed })) expect(bar.height).toBeLessThanOrEqual(1);
  });

  it('gives a height only to an angle the card is willing to state', () => {
    for (const [i, bar] of traceBars(entry.slides, { believed }).entries()) {
      const spun = entry.slides[i][3] === 1;
      if (!believed || spun) {
        expect(bar.kind).toBe('footprint');
        expect(bar.height).toBe(0);
      } else {
        expect(bar.kind).toBe('held');
        expect(bar.height).toBeCloseTo(Math.min(1, Math.max(0.06, entry.slides[i][2] / TRACE_CEILING_DEG)), 6);
      }
    }
  });

  it('never calls a mark a held angle in the caption when it is not one', () => {
    const legend = traceLegend(entry.slides, { believed });
    if (measuredCount(entry.slides, believed) === 0) {
      expect(legend.left).not.toMatch(/held angle/i);
      expect(legend.right).not.toContain('°');
    } else {
      expect(legend.left).toMatch(/held angle/i);
      expect(legend.right).toContain(`${TRACE_CEILING_DEG}°`);
    }
  });
});

describe('a spun slide', () => {
  // `sloppy` at seed 12 is the run `garage-spun.png` photographs: three spins whose held peaks
  // are 66.4°, 68.5° and 44.2° and whose instantaneous peaks are all 118.0°. The instantaneous
  // figure is what the index used to carry, and all three drew identically because all three
  // saturated the 60° ceiling — the card said HELD ANGLE 18° over three 60°+ walls.
  const session = buildFixtureSession({ ...FIXTURES.sloppy, seed: 12 });
  const entry = summarizeSession(session);
  const spunAt = entry.slides.map((m, i) => [m, i] as const).filter(([m]) => m[3] === 1);

  it('really is in this run, and really did reach past the ceiling', () => {
    expect(spunAt.length).toBeGreaterThan(1);
    for (const [, i] of spunAt) expect(radToDeg(Math.abs(session.drifts[i].peakAngle))).toBeGreaterThan(TRACE_CEILING_DEG);
  });

  it('stores the engine’s own held peak, never the instantaneous one', () => {
    for (const [mark, i] of spunAt) {
      const stats = statsOf(session, session.drifts[i].id);
      expect(stats).not.toBeNull();
      expect(mark[2]).toBeCloseTo(Math.round((stats?.heldPeakDeg ?? 0) * 10) / 10, 6);
      expect(mark[2]).toBeLessThan(radToDeg(Math.abs(session.drifts[i].peakAngle)));
    }
  });

  it('is drawn with no height either way — below the ceiling or above it', () => {
    // The ambiguous case, which is where a partial-credit bug would live (rule 14): a spin the
    // axis COULD hold and a spin it could not, and neither may be on it.
    //
    // The fixture used to supply both: at the old 60° ceiling its two spins held 44.2° and
    // 68.5°, one either side. The ceiling is now the shared ramp's full scale (70°), so both of
    // the real ones fit, and the over-ceiling half of the case is made here instead of asserted
    // out of a fixture that no longer has it.
    const held = spunAt.map(([m]) => m[2]);
    expect(Math.min(...held)).toBeLessThan(TRACE_CEILING_DEG);
    const footprint = { x0: expect.any(Number), x1: expect.any(Number), height: 0, kind: 'footprint' };
    for (const [, i] of spunAt) expect(traceBars(entry.slides)[i]).toEqual(footprint);
    const past: SlideMark = [0.1, 0.2, TRACE_CEILING_DEG + 12, 1];
    expect(traceBars([past])[0]).toEqual(footprint);
    // …and the same mark, unspun, WOULD have been drawn at the ceiling — so the zero above is
    // the spin rule doing the work rather than the clamp swallowing it.
    expect(traceBars([[past[0], past[1], past[2], 0]])[0].height).toBe(1);
  });

  it('leaves the tallest ridge agreeing with the number printed under it', () => {
    // The card prints `heldPeakDeg` as HELD ANGLE. Nothing on the plot may stand taller.
    const tallest = Math.max(...traceBars(entry.slides).map((b) => b.height));
    expect(tallest).toBeCloseTo(entry.heldPeakDeg / TRACE_CEILING_DEG, 6);
  });
});

describe('a run the monitor did not believe', () => {
  // `handheld` at seed 9 is `garage-flagged-stats.png`: seven slides, all spun, held peaks from
  // 20.5° to 79.6°, instantaneous peaks 75–85°. The card prints ANGLE `--`, and a plot that
  // draws heights is the same claim in pixels.
  const entry = summarizeSession(buildFixtureSession({ ...FIXTURES.handheld, seed: 9 }));

  it('is refused by the engine and has slides anyway', () => {
    expect(entry.trusted).toBe(false);
    expect(entry.slides.length).toBeGreaterThan(1);
  });

  it('draws not one of them on the angle axis', () => {
    expect(measuredCount(entry.slides, false)).toBe(0);
    for (const bar of traceBars(entry.slides, { believed: false })) {
      expect(bar.kind).toBe('footprint');
      expect(bar.height).toBe(0);
    }
  });

  it('is captioned as the recording it is, with no ceiling claimed over it', () => {
    const legend = traceLegend(entry.slides, { believed: false });
    expect(legend.left).toBe('Recorded sliding');
    expect(legend.right).toBe('None of it believed');
    expect(legend.alarm).toBe(true);
  });

  it('would still draw its angles if it were believed — the refusal is the reason, not the data', () => {
    // Guards against "fixed" by zeroing the stored degrees, which would make every other test
    // here pass for the wrong reason.
    expect(measuredCount(entry.slides, true)).toBe(0); // all spun, so still nothing on the axis
    expect(Math.max(...entry.slides.map((m) => m[2]))).toBeGreaterThan(0);
  });
});

describe('the caption', () => {
  const held = (deg: number, spun: 0 | 1, at = 0): SlideMark => [at, at + 0.05, deg, spun];

  it('says what the axis is when every mark is on it', () => {
    expect(traceLegend([held(30, 0)])).toEqual({ left: 'Held angle through the run', right: `${TRACE_CEILING_DEG}° top`, alarm: false });
  });

  it('counts the marks that are not on it', () => {
    expect(traceLegend([held(30, 0), held(40, 1, 0.2)]).right).toBe(`${TRACE_CEILING_DEG}° top · 1 spun`);
    expect(traceLegend([held(30, 0), held(40, 1, 0.2), held(50, 1, 0.4)]).right).toBe(`${TRACE_CEILING_DEG}° top · 2 spun`);
  });

  it('stops heading an empty axis "held angle" when every slide was a spin', () => {
    const all = traceLegend([held(40, 1), held(50, 1, 0.3)]);
    expect(all.left).toBe('Recorded sliding');
    expect(all.right).toBe('2 spun · no angle held');
    expect(traceLegend([held(40, 1)]).right).toBe('Spun · no angle held');
  });

  it('says a grip lap is a grip lap', () => {
    expect(traceLegend([])).toEqual({ left: 'Nothing slid', right: 'Grip all the way', alarm: false });
  });
});

describe('the geometry', () => {
  it('keeps a ridge visible however small the angle, and never lets one leave the plot', () => {
    const bars = traceBars([
      [0, 0.1, 0.4, 0],
      [0.2, 0.3, TRACE_CEILING_DEG, 0],
      [0.4, 0.5, TRACE_CEILING_DEG * 3, 0],
    ]);
    expect(bars[0].height).toBeGreaterThan(0);
    expect(bars[1].height).toBe(1);
    expect(bars[2].height).toBe(1);
  });

  it('holds every mark inside the plot whatever the index says', () => {
    const bars = traceBars([
      [-3, 9, 40, 0],
      [0.9, 0.2, 40, 0],
      [0.3, 0.4, Number.NaN, 0],
    ]);
    for (const bar of bars) {
      expect(bar.x0).toBeGreaterThanOrEqual(0);
      expect(bar.x1).toBeLessThanOrEqual(1);
      expect(bar.x1).toBeGreaterThanOrEqual(bar.x0);
      expect(Number.isFinite(bar.height)).toBe(true);
      expect(bar.height).toBeLessThanOrEqual(1);
    }
  });
});
