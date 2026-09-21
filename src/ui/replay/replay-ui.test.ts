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

import { buildReplay, formatPoints, poseAt, ReplayCamera, SEVERITY_EDGES, severityOf, worldToScreen, type CameraMode, type Replay } from '../../engine/replay';
import { degToRad, radToDeg, type Session } from '../../engine/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { replayLayout, safeFrame } from './layout';
import { NO_HEAT, fmtTime, headlinePoints, heatColor, heatOf, isPointsClaim, ribbonScale, tintOf } from './palette';
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
   * The band's shader is a gradient in normalised space — ember to 55 % of its height, gold at
   * 80 %, red at the top — so a run scaled to its own maximum paints those words at whatever
   * its maximum happens to be. A clean lap did: 4.18° at 80 % of the band, next to `good`'s real
   * 55.54° at 85 %.
   *
   * THE TEST THAT USED TO BE HERE CARRIED THIS TITLE AND COULD NOT FAIL (CRITIC.md rule 16). It
   * asserted `ribbonScale(r) >= SEVERITY_EDGES.spin` and `>= r.telemetry.maxAngle` over every
   * fixture — both restatements of `Math.max(spin, 1.05 * maxAngle)`, false for no input — while
   * the property in its own title was not true of half the fixtures: 65.0° on clean/good/touge
   * against 123.9° on sloppy and spin, which put `sloppy`'s 65° spin edge at 52.5 % of its band,
   * in the ember zone, under a world drawing the same angle gold-to-red. EQUALITY is the claim.
   */
  it('the scrub band is the same scale on a clean lap as on a lap full of spins', () => {
    const clean = built.get('clean')!.replay;
    const good = built.get('good')!.replay;
    expect(clean.segments.length).toBe(0);
    // ONE scale, the spin edge, on every fixture — the assertion the title makes
    for (const name of Object.keys(FIXTURES)) {
      const r = built.get(name)!.replay;
      expect(ribbonScale(r), name).toBe(SEVERITY_EDGES.spin);
    }
    // …including every fixture the old `Math.max(spin, 1.05 * maxAngle)` gave a band of its own:
    // hero 67.0°, rough 73.5°, handheld 87.9°, sloppy and spin 123.9° (measured, degrees).
    const hadOwnBand: Record<string, number> = { hero: 67.0, rough: 73.5, handheld: 87.9, sloppy: 123.9, spin: 123.9 };
    for (const [name, oldDeg] of Object.entries(hadOwnBand)) {
      const r = built.get(name)!.replay;
      expect(radToDeg(Math.max(SEVERITY_EDGES.spin, r.telemetry.maxAngle * 1.05)), name).toBeCloseTo(oldDeg, 1);
      expect(ribbonScale(r), name).toBe(SEVERITY_EDGES.spin);
    }
    // so a given |β| is the same height everywhere, and the spin edge is the top of the band
    const heightOf = (r: Replay, beta: number) => Math.min(1, beta / ribbonScale(r));
    for (const name of Object.keys(FIXTURES)) {
      const r = built.get(name)!.replay;
      expect(heightOf(r, degToRad(40)), name).toBeCloseTo(heightOf(good, degToRad(40)), 12);
      expect(heightOf(r, SEVERITY_EDGES.spin), name).toBe(1);
    }
    // and a clean lap draws a flat line rather than filling the band
    expect(clean.telemetry.maxAngle / ribbonScale(clean)).toBeLessThan(0.15);
    expect(good.telemetry.maxAngle / ribbonScale(good)).toBeGreaterThan(0.6);
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

/**
 * THE TRUST/SLIDE GATE, and the guard that it is actually reached.
 *
 * This is the biggest change of the last two rounds and NOTHING executable stood behind it.
 * `heat`/`tint` were module-private one-liners in `scene.ts`; no test imported `scene.ts` at all;
 * `heatColor` was tested, but that is the UNGATED ramp; and the four harness frames whose whole
 * point is the ABSENCE of ember carried only `expectCanvas`. So the gate regressed twice without
 * anything going red — first to 39 716 ember pixels on a lap stamped NOT SCORED, then to 818 in
 * a cluster two inches under the words.
 *
 * Two tests, because the defect has two halves and only the second one can catch it:
 *  1. the RULE, swept — what the gate does with a colour it is handed;
 *  2. the REACH, read off the renderers' own source — whether every colour that comes off the
 *     ramp is handed to it at all. The bug was never in the rule. It was in the four draw calls
 *     that never called it, and the only thing that can see those is the text of the file.
 */
describe('the heat gate', () => {
  const SWEEP = [0, 1, 4.2, 7.9, 8, 8.1, 20, 24.9, 25, 40, 55, 64.9, 65, 70, 90, 118, 180].map(degToRad);

  it('an untrusted recording is handed the neutral for every angle there is', () => {
    for (const b of SWEEP) {
      expect(heatOf(b, false), `${radToDeg(b).toFixed(1)}°`).toBe(NO_HEAT);
      expect(heatOf(-b, false)).toBe(NO_HEAT);
    }
    expect(heatOf(NaN, false)).toBe(NO_HEAT);
    // …and so is every colour the ramp itself can produce, wherever it was worked out
    for (const b of SWEEP) expect(tintOf(heatColor(b), false)).toBe(NO_HEAT);
    expect(tintOf(HOT_CHUNK, false)).toBe(NO_HEAT);
  });

  it('below the 8° hold edge the engine says NOT SLIDING, and nothing draws a slide colour', () => {
    // the hero numeral has always greyed here (`p.severity !== 'none'`); the L/R chevron beside
    // it, the world slip label, the slip arc and the playhead dot did not, because `heatColor`
    // returns identical ember from 0° to 40°. One frame said both things about the same 4.2°.
    for (const b of SWEEP) {
      const expected = severityOf(b) === 'none' ? NO_HEAT : heatColor(b);
      expect(heatOf(b, true), `${radToDeg(b).toFixed(1)}°`).toBe(expected);
      expect(heatOf(-b, true), `-${radToDeg(b).toFixed(1)}°`).toBe(expected);
    }
    expect(heatOf(degToRad(7.9), true)).toBe(NO_HEAT);
    expect(heatOf(SEVERITY_EDGES.hold, true)).toBe(heatColor(SEVERITY_EDGES.hold));
    expect(heatOf(NaN, true)).toBe(NO_HEAT);
    // a trusted run's ramp is otherwise untouched: the gate adds a floor, it does not re-ramp
    expect(tintOf(heatColor(degToRad(70)), true)).toBe(heatColor(degToRad(70)));
  });

  /**
   * EVERY DRAW SITE, read off the source of both renderers.
   *
   * A colour that comes off the escalation ramp — `colors.ember`/`EMBER`, `colors.gold`/`GOLD`,
   * anything `heatColor()` returned, a chunk colour `geometry.ts` pre-computed off it — may only
   * reach a paint through `heat(`, `driftHeat(` or `tint(`. Anything else has to be named below
   * with a reason, which is the point: adding an ungated ember draw is a two-line change and this
   * makes the second line a sentence someone has to write.
   */
  const GATE = /(?:^|[^A-Za-z_$])(?:heat|driftHeat|tint)\s*\(/;
  const RAMP = /colors\.ember|colors\.gold|\bEMBER\b|\bGOLD\b|heatColor\s*\(|chunk\.color/;

  /** Lines that legitimately hold a ramp token outside the gate, each with why. */
  const EXEMPT: Array<{ needle: string; why: string }> = [
    { needle: 'const EMBER = colors.ember', why: 'the token definition itself' },
    { needle: 'const GOLD = colors.gold', why: 'the token definition itself' },
    { needle: "p.phase === 'drifting' ? colors.ember : WHITE", why: 'the POINTS numeral, drawn only inside the trusted headline (headlinePoints returns null otherwise)' },
    { needle: "p.phase === 'drifting' ? EMBER : WHITE", why: 'same, in the SVG renderer, inside its `if (r.info.trusted)` branch' },
    { needle: 'width: cw, height: 17 }, fillPaint(f, colors.ember, fade)', why: 'the multiplier chip, inside the same trusted headline block' },
    { needle: 'height="17" rx="3" fill="${EMBER}"', why: 'the multiplier chip, inside `p.multiplier > 1.05 && r.info.trusted`' },
    { needle: 'width: w, height: 18 }, fillPaint(f, colors.ember)', why: 'the scrub time bubble: UI chrome for the clock, not a claim about a slide' },
    { needle: "e.kind === 'exit' ? EMBER : CYAN", why: 'the callout beat colour, keyed by BEAT and not by severity (`eventColor` in palette.ts is the app\'s copy of the same switch)' },
    { needle: '[grade] ?? colors.ember', why: 'the grade reveal, which returns early on `f.noScore`' },
    { needle: '[r.info.grade] ?? EMBER', why: 'the grade chip in the SVG footer, inside `if (finished && r.info.grade)`' },
    { needle: 'i % 3 === 0 ? colors.gold : colors.ember', why: 'the grade reveal particles, after the same early return' },
    { needle: 'stop-color="${EMBER}"', why: 'the scrub ribbon gradient definition; the untrusted branch draws MUTED and never references it' },
    { needle: 'fillPaint(f, colors.gold, 0.8)', why: 'the highlight pips above the scrub band: a bookmark marker, not a severity' },
    { needle: 'strokePaint(f, colors.gold, 1, 0.55 * h.alpha', why: 'the highlight chip border \u2014 the same bookmark gold as the pips it names' },
    { needle: "kicker, lay.w / 2, top + 17, { color: colors.gold", why: 'the highlight chip kicker, same bookmark gold' },
  ];

  it.each([
    ['src/ui/replay/scene.ts', 'the app'],
    ['tools/analysis/render-replay.ts', 'the harness'],
  ])('%s spends no ramp colour outside the gate', (rel) => {
    const src = readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8');
    const leaks: string[] = [];
    const usedExemptions = new Set<string>();
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
      if (!RAMP.test(code)) return;
      if (GATE.test(code)) return;
      const hit = EXEMPT.find((e) => code.includes(e.needle));
      if (hit) {
        usedExemptions.add(hit.needle);
        return;
      }
      leaks.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
    expect(leaks, `ungated ramp colour:\n${leaks.join('\n')}`).toEqual([]);
    expect(usedExemptions.size, 'every exemption still describes a real line').toBeGreaterThan(0);
  });

  it('the exemption list is not a way to keep dead entries', () => {
    const src = [
      readFileSync(join(__dirname, 'scene.ts'), 'utf8'),
      readFileSync(join(__dirname, '..', '..', '..', 'tools/analysis/render-replay.ts'), 'utf8'),
    ].join('\n');
    for (const e of EXEMPT) expect(src.includes(e.needle), `stale exemption: ${e.needle} (${e.why})`).toBe(true);
  });
});

/** The white-hot core `geometry.ts` mixes into a chunk colour — still a ramp colour. */
const HOT_CHUNK = '#FFB08A';

/**
 * THE SAFE FRAME: the car is on screen on every frame of every fixture, in both orientations.
 *
 * The camera's pan limiter saturates on `handheld` — 74 chase and 78 cinematic frames of 6 819 —
 * because that recording's own estimated position steps 9.28 m between two trail samples 50 ms
 * apart (185.6 m/s against 37.0 m/s driven), and following a teleport at 60 m/s means lagging it.
 * Against the raw camera that costs the viewer the car: 27 chase frames outside the portrait
 * action rect, up to 40.0 pt past its left edge, worst at t = 20.35 s; 12 in cinematic; 0 on
 * every other fixture. The screen does not draw from the raw camera — `safeFrame` holds the
 * frame — and this is the sweep that says so, at the same 60 fps, on the mapping the pixels
 * actually come from. Raising the limiter was never the alternative: it would let a 186 m/s jump
 * through in the middle of a corner.
 */
describe('safeFrame: the car never leaves the band the viewer can see', () => {
  const SCREENS = [
    { name: 'portrait', w: 393, h: 852 },
    { name: 'landscape', w: 852, h: 393 },
  ];
  const dt = 1 / 60;

  it.each(SCREENS)('$name: raw camera vs the frame the renderer draws', (screen) => {
    const lay = replayLayout(screen.w, screen.h, { top: 0, bottom: 0, left: 0, right: 0 }, 2);
    let rawWorst = 0;
    let rawFrames = 0;
    for (const name of Object.keys(FIXTURES)) {
      const r = built.get(name)!.replay;
      for (const mode of ['chase', 'cinematic'] as CameraMode[]) {
        const act = lay.action;
        const cam = new ReplayCamera(mode, act);
        for (let t = 0; t <= r.durationS; t += dt) {
          const st = cam.update(r, t, dt);
          const p = poseAt(r, t);
          // what the raw camera would have put on screen, centred on the action rect
          const raw = worldToScreen({ ...st, w: act.w, h: act.h }, p.x, p.y);
          const rawOut = Math.max(-raw.x, raw.x - act.w, -raw.y, raw.y - act.h);
          if (rawOut > 0) {
            rawFrames++;
            rawWorst = Math.max(rawWorst, rawOut);
          }
          // what the renderer actually draws
          const sf = safeFrame(st, p.x, p.y, act);
          const sp = worldToScreen(sf, p.x, p.y);
          expect(sp.x, `${name} ${mode} t=${t.toFixed(2)} x`).toBeGreaterThanOrEqual(act.x);
          expect(sp.x, `${name} ${mode} t=${t.toFixed(2)} x`).toBeLessThanOrEqual(act.x + act.w);
          expect(sp.y, `${name} ${mode} t=${t.toFixed(2)} y`).toBeGreaterThanOrEqual(act.y);
          expect(sp.y, `${name} ${mode} t=${t.toFixed(2)} y`).toBeLessThanOrEqual(act.y + act.h);
        }
      }
    }
    // and the thing being guarded against is real on this grid, not hypothetical: in portrait
    // the raw camera leaves the rectangle, which is why the frame is held
    if (screen.name === 'portrait') {
      expect(rawFrames).toBeGreaterThan(0);
      expect(rawWorst).toBeGreaterThan(20);
    }
  });

  it('holds the car inside the fraction it promises, and moves nothing else', () => {
    const lay = replayLayout(393, 852, { top: 0, bottom: 0, left: 0, right: 0 }, 2);
    const act = lay.action;
    const cam = { cx: 0, cy: 0, zoom: 10, rotation: 0, w: act.w, h: act.h, cut: false, cutFade: 0 };
    // a car dead centre leaves the frame exactly where the action rect is
    const centred = safeFrame(cam, 0, 0, act);
    expect(centred.w / 2).toBeCloseTo(act.x + act.w / 2, 9);
    expect(centred.h / 2).toBeCloseTo(act.y + act.h / 2, 9);
    // the camera itself is never touched — only where the result is printed
    for (const [x, y] of [[40, 0], [-40, 0], [0, 40], [0, -40], [60, -60]] as Array<[number, number]>) {
      const sf = safeFrame(cam, x, y, act);
      expect(sf.cx).toBe(cam.cx);
      expect(sf.cy).toBe(cam.cy);
      expect(sf.zoom).toBe(cam.zoom);
      expect(sf.rotation).toBe(cam.rotation);
      const sp = worldToScreen(sf, x, y);
      expect(Math.abs(sp.x - (act.x + act.w / 2))).toBeLessThanOrEqual(act.w * 0.34 + 1e-9);
      expect(Math.abs(sp.y - (act.y + act.h / 2))).toBeLessThanOrEqual(act.h * 0.32 + 1e-9);
    }
  });
});
