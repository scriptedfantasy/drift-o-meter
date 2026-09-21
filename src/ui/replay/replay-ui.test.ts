/**
 * Tests for the replay SCREEN's own modules.
 *
 * There were none — 3 000+ lines of `src/ui/replay/` with no test behind any of it, including
 * the two modules that shipped the round's severity-2 defects: a kerb whose offset folded into a
 * red wedge across the road, and a second GPS-gap rule that disagreed with the engine's and
 * doubled the warning list.
 *
 * What can be tested here is what does not need a GPU: the pure geometry (`kerbs.ts`), the view
 * model (`source.ts` — the gap windows and the warnings), the layout arithmetic (`layout.ts`) and
 * the colour ramp (`palette.ts`). `geometry.ts` and `scene.ts` import Skia and are verified by
 * the screenshot harness instead; `kerbs.ts` exists as a separate module precisely so the part of
 * the geometry that can be wrong arithmetically is reachable from here.
 */
import { describe, expect, it, beforeAll } from 'vitest';

import { buildReplay, formatPoints, SEVERITY_EDGES, type Replay } from '../../engine/replay';
import { degToRad, radToDeg, type Session } from '../../engine/types';
import { FIXTURES, buildFixtureSession } from '../results/fixture';
import {
  crosses,
  distanceToPath,
  FOLD_SPAN,
  KERB_OPTIONS,
  kerbContours,
  MAX_TURN_RAD,
  minSeparation,
  offsetRuns,
  pathLength,
  segmentsCross,
  selfIntersections,
  smoothPolyline,
  splitAtSpikes,
  splitBetweenRuns,
  type Pt,
} from './kerbs';
import { replayLayout } from './layout';
import { fmtTime, headlinePoints, heatColor, isPointsClaim, ribbonScale } from './palette';
import { buildReplayView, gapWindows } from './view';
import { parseReplayParams } from './params';

const TRACKED = ['good', 'rough', 'handheld', 'touge', 'hero'] as const;

/** The sharpest turn in a polyline, radians. */
function sharpestTurn(run: Pt[]): number {
  let worst = 0;
  for (let i = 1; i + 1 < run.length; i++) {
    const ax = run[i][0] - run[i - 1][0];
    const ay = run[i][1] - run[i - 1][1];
    const bx = run[i + 1][0] - run[i][0];
    const by = run[i + 1][1] - run[i][1];
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))));
  }
  return worst;
}

const built = new Map<string, { session: Session; replay: Replay }>();
beforeAll(() => {
  for (const name of Object.keys(FIXTURES)) {
    const session = buildFixtureSession(FIXTURES[name]);
    built.set(name, { session, replay: buildReplay(session) });
  }
}, 120_000);

describe('kerbs: an offset that cannot fold', () => {
  it('offsets a straight line by exactly the offset distance', () => {
    const line: Pt[] = Array.from({ length: 12 }, (_, i) => [i * 2, 0] as Pt);
    const runs = offsetRuns(line, 5);
    expect(runs).toHaveLength(1);
    for (const [, y] of runs[0]) expect(y).toBeCloseTo(5, 6);
  });

  it('refuses to fold an offset larger than the radius it is turning inside', () => {
    // a 6 m radius circle, offset 5.3 m towards its own centre: the naive offset turns inside
    // out (every point lands within 0.7 m of the centre and the contour reverses)
    const circle: Pt[] = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI;
      circle.push([6 * Math.cos(a), 6 * Math.sin(a)]);
    }
    // travelling anticlockwise the centre is to the LEFT, which is where +d points
    const runs = offsetRuns(circle, 5.3);
    for (const run of runs) {
      expect(selfIntersections(run)).toBe(0);
      for (const [x, y] of run) expect(Math.hypot(x, y)).toBeGreaterThan(1.5);
    }
  });

  it('smoothing keeps the endpoints and shortens nothing', () => {
    const wobbly: Pt[] = Array.from({ length: 9 }, (_, i) => [i, i % 2 ? 0.6 : -0.6] as Pt);
    const smooth = smoothPolyline(wobbly);
    expect(smooth[0]).toEqual(wobbly[0]);
    expect(smooth[smooth.length - 1]).toEqual(wobbly[wobbly.length - 1]);
    const amplitude = Math.max(...smooth.slice(1, -1).map((p) => Math.abs(p[1])));
    expect(amplitude).toBeLessThan(0.3);
  });

  it('segmentsCross ignores shared endpoints and finds a real crossing', () => {
    expect(segmentsCross([0, 0], [1, 0], [1, 0], [2, 1])).toBe(false);
    expect(segmentsCross([0, 0], [2, 0], [1, -1], [1, 1])).toBe(true);
    expect(segmentsCross([0, 0], [2, 0], [0, 1], [2, 1])).toBe(false);
  });

  it.each(TRACKED)('%s: no kerb crosses another kerb', (name) => {
    const { replay } = built.get(name)!;
    const roadPts: Pt[] = replay.track!.path.map((p) => [p.x, p.y] as Pt);
    const parts = kerbContours(roadPts, replay.track!.closed, replay.track!.corners);
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        // two kerbs crossing render as a translucent red X lying over the asphalt
        expect(crosses(parts[i], parts[j])).toBe(false);
      }
    }
  });

  it.each(TRACKED)('%s: the road edge lines do not fold or spike either', (name) => {
    const { replay } = built.get(name)!;
    const track = replay.track!;
    const src: Pt[] = track.path.map((p) => [p.x, p.y] as Pt);
    const loop = track.closed ? [...src, src[0]] : src;
    for (const d of [4.35, -4.35]) {
      const runs = offsetRuns(loop, d);
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        // FOLD_SPAN, not every pair: a lap-long contour passing near itself at a hairpin is two
        // bits of road, not a fold (see splitAtCrossings)
        expect(selfIntersections(run, FOLD_SPAN)).toBe(0);
        for (let i = 1; i < run.length; i++) {
          expect(Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1])).toBeLessThan(8);
        }
        // and nothing zig-zags: a drawn contour never turns more sharply than a hairpin
        expect(sharpestTurn(run)).toBeLessThanOrEqual(MAX_TURN_RAD + 1e-9);
      }
      // …AND NOT ACROSS THE BREAKS EITHER. Every test above is inside ONE run, which is how
      // `handheld` came to draw its left edge as 35 pieces with 20 crossings BETWEEN them —
      // overlapping quads on the verge and a Y-shaped spur into empty space. A fold that
      // straddles a break is still a fold.
      for (let i = 0; i < runs.length; i++) {
        for (let j = i + 1; j < runs.length; j++) {
          expect(crosses(runs[i], runs[j]), `${name} d=${d}: run ${i} crosses run ${j}`).toBe(false);
        }
      }
    }
  });

  it('cuts two pieces of one contour apart where they cross, and leaves separate ones alone', () => {
    const a: Pt[] = Array.from({ length: 9 }, (_, i) => [i, 0] as Pt);
    const b: Pt[] = Array.from({ length: 9 }, (_, i) => [4, i - 4] as Pt);
    const kept = splitBetweenRuns([a, b]);
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) expect(crosses(kept[i], kept[j])).toBe(false);
    }
    // the first run is kept whole and the second is cut, not thrown away
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(kept.flat().length).toBeGreaterThan(a.length);
    const apart: Pt[][] = [a, a.map(([x, y]) => [x, y + 30] as Pt)];
    expect(splitBetweenRuns(apart)).toEqual(apart);
  });

  it('a 60° turn on a 2 m step is not a kerb', () => {
    // the old bound was 100°, which passed a 94° kerb turn and a 99° road-edge turn on the
    // hand-held fixture: a 1.7 m radius on a road 9.5 m wide
    expect((MAX_TURN_RAD * 180) / Math.PI).toBeCloseTo(60, 6);
    const elbow: Pt[] = [
      [0, 0],
      [2, 0],
      [4, 0],
      [5, 1.9],
      [7, 1.9],
      [9, 1.9],
    ];
    for (const run of splitAtSpikes(elbow)) expect(sharpestTurn(run)).toBeLessThanOrEqual(MAX_TURN_RAD + 1e-9);
  });

  it('a spike is cut out, and a smooth line is left alone', () => {
    const straight: Pt[] = Array.from({ length: 10 }, (_, i) => [i, 0] as Pt);
    expect(splitAtSpikes(straight)).toEqual([straight]);
    const spiked: Pt[] = [...straight.slice(0, 5), [4.2, 6], ...straight.slice(5)];
    const cut = splitAtSpikes(spiked);
    expect(cut.length).toBeGreaterThan(1);
    for (const run of cut) expect(sharpestTurn(run)).toBeLessThanOrEqual(MAX_TURN_RAD + 1e-9);
    expect(cut.flat()).not.toContainEqual([4.2, 6]);
  });

  it.each(TRACKED)('%s: every drawn kerb is a stripe on the edge of the road, not debris', (name) => {
    // WHAT THE FOLD TESTS LET THROUGH IS NOT AUTOMATICALLY A KERB. On `handheld` they left 28
    // runs, 14 of them 3.2–8.6 m fragments, some sitting 0.5–2.7 m from the centre line of a
    // 9.5 m road (i.e. on the racing line) and eight pairs within 1.6 m of each other — which is
    // the floating red-and-grey chevron and the overlapping quads on the verge. Ten survive now.
    const { replay } = built.get(name)!;
    const roadPts: Pt[] = replay.track!.path.map((p) => [p.x, p.y] as Pt);
    const parts = kerbContours(roadPts, replay.track!.closed, replay.track!.corners);
    expect(parts.length).toBeGreaterThan(0);
    for (const run of parts) {
      expect(pathLength(run), 'a fragment is not a painted stripe').toBeGreaterThanOrEqual(KERB_OPTIONS.minDrawM);
      const nearest = Math.min(...run.map((p) => distanceToPath(p, roadPts)));
      expect(nearest, 'a kerb is on the EDGE of the road').toBeGreaterThanOrEqual(KERB_OPTIONS.minOffsetFrac * KERB_OPTIONS.offsetM);
    }
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        // they are stroked 1.1 m wide, so two nearer than that are one smear
        expect(minSeparation(parts[i], parts[j]), `kerb ${i} smears into kerb ${j}`).toBeGreaterThanOrEqual(KERB_OPTIONS.minGapM);
      }
    }
  });

  it.each(TRACKED)('%s: no kerb crosses itself or the road it belongs to', (name) => {
    const { replay } = built.get(name)!;
    const track = replay.track;
    expect(track).not.toBeNull();
    const roadPts: Pt[] = track!.path.map((p) => [p.x, p.y] as Pt);
    const parts = kerbContours(roadPts, track!.closed, track!.corners);
    expect(parts.length).toBeGreaterThan(0);
    for (const run of parts) {
      // ROUND-6 FINDING 6: a folded offset drew a translucent red triangle across the asphalt.
      expect(selfIntersections(run)).toBe(0);
      // and no kerb may ever lie over the racing line
      for (let i = 0; i + 1 < run.length; i++) {
        for (let j = 0; j + 1 < roadPts.length; j++) {
          expect(segmentsCross(run[i], run[i + 1], roadPts[j], roadPts[j + 1])).toBe(false);
        }
      }
      // no single step may jump further than the road it was built from
      for (let i = 1; i < run.length; i++) {
        expect(Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1])).toBeLessThan(5);
      }
    }
  });
});

describe('source: one gap rule, one warning per problem', () => {
  const params = parseReplayParams({});

  it.each(TRACKED)('%s: the gaps are the engine’s, not a second derivation', (name) => {
    const { session, replay } = built.get(name)!;
    const view = buildReplayView(session, params, null);
    expect(view.gaps.map((g) => [g.startT, g.endT])).toEqual(replay.gapWindows.map((g) => [g.startT, g.endT]));
    for (const g of view.gaps) expect(g.durationS).toBeCloseTo(g.endT - g.startT, 9);
    // every window has to agree with the mask the renderer dashes
    for (const g of view.gaps) {
      const mid = Math.round(((g.startT + g.endT) / 2) * replay.trail.hz);
      expect(replay.trail.measured[mid]).toBe(0);
    }
  });

  it.each(TRACKED)('%s: the warning list says each problem once', (name) => {
    const { session, replay } = built.get(name)!;
    const view = buildReplayView(session, params, null);
    // ROUND-6 FINDING 7: the plate announced "4 PROBLEMS WITH THIS RECORDING" over two problems,
    // because the UI re-derived the dropouts and appended its own sentence for each one.
    expect(view.warnings).toEqual(replay.warnings);
    expect(new Set(view.warnings).size).toBe(view.warnings.length);
    const dropouts = view.warnings.filter((w) => /dropout|dead.reckon|no GPS fix/i.test(w));
    expect(dropouts.length).toBeLessThanOrEqual(1);
  });

  it('a damaged recording reports the hole once, through the engine', () => {
    const { session } = built.get('good')!;
    const damaged = buildReplayView(session, { ...params, gaps: 6 }, null);
    expect(damaged.gaps.length).toBeGreaterThan(0);
    expect(damaged.gaps[0].durationS).toBeGreaterThan(4);
    expect(damaged.warnings).toEqual(damaged.replay.warnings);
    const dropouts = damaged.warnings.filter((w) => /dropout/i.test(w));
    expect(dropouts).toHaveLength(1);
  });

  it('an untrusted run keeps its refusal and its reason', () => {
    const { session } = built.get('handheld')!;
    const view = buildReplayView(session, params, null);
    expect(view.trusted).toBe(false);
    expect(view.untrustedBody.length).toBeGreaterThan(10);
    expect(view.replay.info.totalPoints).toBeNull();
    expect(view.replay.info.grade).toBeNull();
  });
});

describe('layout: nothing lands on top of the transport', () => {
  const insets = { top: 59, bottom: 34, left: 0, right: 0 };

  it('portrait: the scrub band, the transport and the bottom bar do not overlap', () => {
    const lay = replayLayout(393, 852, insets);
    expect(lay.controls.y + lay.controls.h).toBeLessThanOrEqual(lay.scrub.y);
    expect(lay.scrub.y + lay.scrub.h).toBeLessThanOrEqual(lay.h - lay.bottomBar + 1e-6);
    // the scrub time bubble is drawn 26 pt above the band while the transport is hidden, and
    // below it while the transport is up — either way it must stay on the screen
    expect(lay.scrub.y - 26).toBeGreaterThan(lay.stage.y);
    expect(lay.scrub.y + lay.scrub.h + 8 + 18).toBeLessThanOrEqual(lay.h);
  });

  it('landscape rearranges rather than squeezes', () => {
    const lay = replayLayout(852, 393, { ...insets, left: 59, right: 34 });
    expect(lay.landscape).toBe(true);
    expect(lay.action.h).toBeGreaterThan(120);
    expect(lay.info.y).toBeLessThan(lay.stage.y);
    expect(lay.readout.x).toBeLessThanOrEqual(852 - 34);
  });
});

describe('palette', () => {
  it('the heat ramp is absolute and escalates', () => {
    expect(heatColor(degToRad(20))).toBe(heatColor(degToRad(39)));
    expect(heatColor(degToRad(50))).not.toBe(heatColor(degToRad(20)));
    expect(heatColor(degToRad(90))).not.toBe(heatColor(degToRad(SEVERITY_EDGES.spin)));
    expect(heatColor(NaN)).toBe(heatColor(0));
  });

  it('the clock is always mm:ss.d', () => {
    expect(fmtTime(0)).toBe('00:00.0');
    expect(fmtTime(9.94)).toBe('00:09.9');
    expect(fmtTime(119.46)).toBe('01:59.5');
    expect(fmtTime(NaN)).toBe('00:00.0');
  });

  /**
   * The scrubber's |β| band is ABSOLUTE, and it has to be on every run or it is not a scale.
   *
   * The band's shader is a gradient in normalised space — red at the top means a spin — so a run
   * scaled to its own maximum draws red at whatever its maximum happens to be. A clean lap did:
   * 4.18° at 80 % of the band, next to `good`'s real 55.54° at 85 %.
   */
  it('the scrub band is the same scale on a clean lap as on a lap full of spins', () => {
    const clean = built.get('clean')!.replay;
    const good = built.get('good')!.replay;
    expect(clean.segments.length).toBe(0);
    expect(ribbonScale(clean)).toBeGreaterThanOrEqual(SEVERITY_EDGES.spin);
    // and a clean lap draws a flat line rather than filling the band
    expect(clean.telemetry.maxAngle / ribbonScale(clean)).toBeLessThan(0.15);
    expect(good.telemetry.maxAngle / ribbonScale(good)).toBeGreaterThan(0.6);
    // same |β|, same height, whichever run it is in
    expect(ribbonScale(clean)).toBe(SEVERITY_EDGES.spin);
    for (const name of Object.keys(FIXTURES)) {
      const r = built.get(name)!.replay;
      expect(ribbonScale(r)).toBeGreaterThanOrEqual(SEVERITY_EDGES.spin);
      expect(ribbonScale(r)).toBeGreaterThanOrEqual(r.telemetry.maxAngle);
    }
  });
});

describe('what the screen prints about a run', () => {
  it.each(Object.keys(FIXTURES))('%s: the headline agrees with the session, or is withheld', (name) => {
    const { session, replay } = built.get(name)!;
    if (session.score.trusted === false) {
      expect(replay.info.totalPoints).toBeNull();
      return;
    }
    // `info.totalPoints` IS `session.score.total` by construction, so comparing them is an
    // identity. What the screen has to agree with is the running number it draws while playing.
    expect(Math.round(replay.trail.score[replay.trail.n - 1])).toBe(session.score.total);
  });

  /**
   * THE STRING THE TOP HUD DRAWS, run rather than described.
   *
   * This used to be a comment \u2014 "what `drawTopHud` prints once the run has finished is
   * `info.totalPoints`" \u2014 with nothing executing it, which is how the renderer came to print
   * `pose.points` there for a whole round while the suite stayed green. `headlinePoints` is that
   * choice, lifted out of the Skia call so a test can make it.
   */
  describe('headlinePoints: which number the top-right readout is', () => {
    it('prints the running total while the run is playing', () => {
      expect(headlinePoints({ trusted: true, reveal: 0, totalPoints: 23050, posePoints: 17410 })).toBe('17410');
    });

    it('hands over to the SESSION TOTAL the moment the grade starts landing', () => {
      // the trail's own sum is a hair short of the total until its very last sample; the frame
      // the driver reads at the end has to be the number the results screen prints
      expect(headlinePoints({ trusted: true, reveal: 0.3, totalPoints: 23050, posePoints: 23049 })).toBe('23050');
    });

    it('prints nothing once the reveal owns the frame, so the total is never on screen twice', () => {
      expect(headlinePoints({ trusted: true, reveal: 1, totalPoints: 23050, posePoints: 23050 })).toBeNull();
    });

    it('prints nothing at all on a run the engine will not vouch for', () => {
      expect(headlinePoints({ trusted: false, reveal: 0, totalPoints: null, posePoints: 812 })).toBeNull();
      expect(headlinePoints({ trusted: false, reveal: 0.5, totalPoints: null, posePoints: 812 })).toBeNull();
    });

    it.each(Object.keys(FIXTURES))('%s: the last frame draws the session total, or no points', (name) => {
      const { session, replay: r } = built.get(name)!;
      const drawn = headlinePoints({ trusted: r.info.trusted, reveal: 0.5, totalPoints: r.info.totalPoints, posePoints: 0 });
      expect(drawn).toBe(session.score.trusted === false ? null : formatPoints(session.score.total));
    });
  });

  it('an untrusted run makes no points claim to withhold, and still shows what it measured', () => {
    const { session, replay: r } = built.get('handheld')!;
    expect(session.score.trusted).toBe(false);
    expect(r.info.totalPoints).toBeNull();
    expect(r.info.grade).toBeNull();
    // Every slide on this recording was refused, so every one of them is worth exactly 0 and the
    // replay makes no claim about points ANYWHERE \u2014 there is nothing for the renderer's gate to
    // withhold. This used to assert the opposite (`withheld.length > 0`), which only held
    // because the replay was inventing the numbers it was then careful not to show.
    for (const e of r.events) expect(isPointsClaim(e.label), `event "${e.label}"`).toBe(false);
    for (const m of r.markers) expect(isPointsClaim(m.label), `marker "${m.label}"`).toBe(false);
    for (const h of r.highlights) expect(h.label).not.toMatch(/PTS/);
    const shown = r.events.filter((e) => e.label !== '').map((e) => e.label);
    expect(shown.some((l) => /^LOST IT \d+\u00b0$/.test(l))).toBe(true);
    expect(shown.some((l) => /^TRANSITION/.test(l))).toBe(true);
  });

  it('a scored run with a lost chain DOES make claims, and the gate catches every one', () => {
    // the other half of the same rule: the withholding path has to have something real to
    // withhold, or "no points on screen" is true for the wrong reason
    const { replay: r } = built.get('spin')!;
    const claims = r.events.filter((e) => e.label && isPointsClaim(e.label)).map((e) => e.label);
    expect(claims.length).toBeGreaterThan(0);
    for (const label of claims) expect(label).toMatch(/CHAIN LOST|AT RISK|^\+/);
    for (const label of r.events.filter((e) => e.label && !isPointsClaim(e.label)).map((e) => e.label)) {
      expect(label).not.toMatch(/\d+\s*(PTS|POINTS)/);
    }
  });

  it('the points-claim rule keeps measurements and catches scores', () => {
    for (const claim of ['+1250', 'CHAIN LOST \u22128981', 'AT RISK +1380', '\u22128981', '+84 PTS']) {
      expect(isPointsClaim(claim)).toBe(true);
    }
    for (const measurement of ['LOST IT 118\u00b0', 'SAVED IT 70\u00b0', 'TRANSITION \u00d73', 'BIG ANGLE', 'LAP 2', 'FINISH', '54\u00b0']) {
      expect(isPointsClaim(measurement)).toBe(false);
    }
  });

  it.each(Object.keys(FIXTURES))('%s: the footer’s BEST is the detector’s peak', (name) => {
    const { session, replay } = built.get(name)!;
    if (session.drifts.length === 0) return;
    const best = Math.max(...session.drifts.map((d) => radToDeg(d.peakAngle)));
    const drawn = Math.max(...replay.segments.map((s) => radToDeg(s.peakAngle)));
    expect(Math.round(drawn)).toBe(Math.round(best));
  });
});
