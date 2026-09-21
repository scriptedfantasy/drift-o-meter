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

import { buildReplay, exitLabel, poseAt, ReplayCamera, SEVERITY_EDGES, severityOf, worldToScreen, type CameraMode, type Replay } from '../../engine/replay';
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
import { NO_HEAT, eventColor, fmtTime, heatColor, heatOf, ribbonScale, tintOf } from './palette';
import { MAX_ANGLE_DEG, angleColor, colors } from '../theme';
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

  /**
   * THE REFUSAL COMES FROM THE INTEGRITY MONITOR, and from nothing else.
   *
   * `buildReplayView` read `session.score.trusted` — the mirror the scorer kept of
   * `SessionIntegrity.scoreTrusted` so that a scored object could never be separated from
   * permission to show it. The score is gone; the monitor is what survives, and a run it will
   * not vouch for still has to play in grey with the reason on it.
   */
  it('an untrusted run keeps its refusal and its reason, from the monitor', () => {
    const { session } = built.get('handheld')!;
    const view = buildReplayView(session, params, null);
    expect(session.integrity.scoreTrusted).toBe(false);
    expect(view.trusted).toBe(false);
    expect(view.replay.info.trusted).toBe(false);
    expect(view.untrustedBody.length).toBeGreaterThan(10);
    // the monitor alone decides: flipping its verdict flips the screen's
    const believed = buildReplayView({ ...session, integrity: { ...session.integrity, scoreTrusted: true } }, params, null);
    expect(believed.trusted).toBe(true);
    const doubted = buildReplayView({ ...built.get('good')!.session, integrity: { ...built.get('good')!.session.integrity, scoreTrusted: false } }, params, null);
    expect(doubted.trusted).toBe(false);
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
  /**
   * THE REPLAY'S RAMP IS THE DIAL'S RAMP, not a second one that happens to look similar.
   *
   * `heatColor` was a private ember → gold → red escalation with its knots at the severity edges;
   * the dial swept `ANGLE_STOPS` and the review's slide list printed `angleColor`, so the same
   * 56° was three colours on three screens. This asserts the IDENTITY rather than the shape of
   * the ramp: a test that only checked "flat, then escalating" would pass for either function.
   */
  it('the ramp is the theme\'s angle ramp, degree for degree', () => {
    for (const d of [0, 4, 8, 20, 39, 40, 48, 55, 62, 70, 90, 118, 180]) {
      expect(heatColor(degToRad(d)), `${d}°`).toBe(angleColor(d));
      expect(heatColor(degToRad(-d)), `-${d}°`).toBe(angleColor(d));
    }
    // it is absolute and it escalates: flat green to 40°, then up the ramp into the car's red.
    // (`angleColor` composes its hex lowercase, the tokens are written upper — same colour.)
    const hex = (c: string) => c.toLowerCase();
    expect(heatColor(degToRad(20))).toBe(heatColor(degToRad(39)));
    expect(hex(heatColor(degToRad(20)))).toBe(hex(colors.green));
    expect(heatColor(degToRad(50))).not.toBe(heatColor(degToRad(20)));
    expect(hex(heatColor(degToRad(MAX_ANGLE_DEG)))).toBe(hex(colors.red));
    // past the top of the scale it saturates rather than wrapping back down the ramp
    expect(hex(heatColor(degToRad(90)))).toBe(hex(colors.red));
    expect(hex(heatColor(degToRad(180)))).toBe(hex(colors.red));
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
   * The band's shader is a gradient in normalised space, so a run scaled to its own maximum
   * paints the ramp's colours at whatever that maximum happens to be. A clean lap did: 4.18° at
   * 80 % of the band, next to `good`'s real 55.54° at 85 %.
   *
   * THE CEILING IS `MAX_ANGLE_DEG`, not the 65° spin edge it used to be chosen as here. That was
   * a third ceiling in an app that already had two — the dial's 70° and the garage trace's 60° —
   * so the same 64° hold drew at three heights on three screens. One number, read off the last
   * knot of `ANGLE_STOPS`, so the top of the band is exactly where the ramp finishes turning red.
   *
   * THE TEST THAT USED TO BE HERE CARRIED THIS TITLE AND COULD NOT FAIL (CRITIC.md rule 16). It
   * asserted `ribbonScale(r) >= SEVERITY_EDGES.spin` and `>= r.telemetry.maxAngle` over every
   * fixture — both restatements of `Math.max(spin, 1.05 * maxAngle)`, false for no input.
   * EQUALITY is the claim.
   */
  it('the scrub band is the same scale on a clean lap as on a lap full of spins', () => {
    const clean = built.get('clean')!.replay;
    const good = built.get('good')!.replay;
    expect(clean.segments.length).toBe(0);
    // ONE scale, the app's angle ceiling, on every fixture — the assertion the title makes
    for (const name of Object.keys(FIXTURES)) {
      const r = built.get(name)!.replay;
      expect(radToDeg(ribbonScale(r)), name).toBeCloseTo(MAX_ANGLE_DEG, 12);
    }
    // …including every fixture the old `Math.max(spin, 1.05 * maxAngle)` gave a band of its own:
    // hero 67.0°, rough 73.5°, handheld 87.9°, sloppy and spin 123.9° (measured, degrees).
    const hadOwnBand: Record<string, number> = { hero: 67.0, rough: 73.5, handheld: 87.9, sloppy: 123.9, spin: 123.9 };
    for (const [name, oldDeg] of Object.entries(hadOwnBand)) {
      const r = built.get(name)!.replay;
      expect(radToDeg(Math.max(SEVERITY_EDGES.spin, r.telemetry.maxAngle * 1.05)), name).toBeCloseTo(oldDeg, 1);
      expect(radToDeg(ribbonScale(r)), name).toBeCloseTo(MAX_ANGLE_DEG, 12);
    }
    // so a given |β| is the same height everywhere, and the top of the band is the top of the ramp
    const heightOf = (r: Replay, beta: number) => Math.min(1, beta / ribbonScale(r));
    for (const name of Object.keys(FIXTURES)) {
      const r = built.get(name)!.replay;
      expect(heightOf(r, degToRad(40)), name).toBeCloseTo(heightOf(good, degToRad(40)), 12);
      expect(heightOf(r, degToRad(MAX_ANGLE_DEG)), name).toBe(1);
    }
    // the height a slide sits at and the colour it is drawn in come off the SAME scale: the
    // band's top is the ramp's last knot, which is what a gradient built from `ANGLE_STOPS`
    // needs in order to paint each knot at the height that angle really is
    expect(heatColor(ribbonScale(good)).toLowerCase()).toBe(colors.red.toLowerCase());
    // and a clean lap draws a flat line rather than filling the band
    expect(clean.telemetry.maxAngle / ribbonScale(clean)).toBeLessThan(0.15);
    expect(good.telemetry.maxAngle / ribbonScale(good)).toBeGreaterThan(0.6);
  });

  /**
   * A BEAT'S COLOUR IS KEYED BY WHAT KIND OF MOMENT IT IS, never by severity.
   *
   * The switch used to spend four separate tokens — magenta for a transition, gold for a peak,
   * ember for an exit, cyan for everything else — three of which named hues the app no longer
   * paints. What is left is the palette: red is the limit and what went wrong, blue is structure.
   */
  it('a beat takes the limit\'s red or the structure blue, and nothing else', () => {
    // the limit, and the recording going wrong: both are red, and both match the plate or the
    // marker a driver reads the same fact off elsewhere on the frame
    expect(eventColor('spin')).toBe(colors.red);
    expect(eventColor('refused')).toBe(colors.red);
    for (const kind of ['transition', 'exit', 'entry', 'lap', 'finish'] as const) {
      expect(eventColor(kind), kind).toBe(colors.blue);
    }
    // `peak` is the one beat that SAYS an angle, so the renderers colour it off the ramp instead
    // (`drawCallout`); the fallback here must still be a token and never a deprecated one
    expect([colors.blue, colors.red]).toContain(eventColor('peak'));
  });
});

describe('what the screen prints about a run', () => {
  /**
   * EVERY LABEL ON THIS SCREEN IS A MEASUREMENT NOW, on every fixture, trusted or not.
   *
   * This replaces five tests that guarded the withholding machinery: `headlinePoints` (which
   * number the top-right readout was), `isPointsClaim` (which labels were awards), and the two
   * halves of the rule — an untrusted run makes no claim, a scored one does and the gate catches
   * it. There is nothing left to withhold, so the property worth keeping is the stronger one:
   * NOTHING the replay draws is a score, anywhere, on any run. It is written as a sweep over
   * every label of every fixture because that is what the five tests between them were reaching
   * for, and it fails the moment a number without a unit comes back.
   */
  it.each(Object.keys(FIXTURES))('%s: no label anywhere is a score', (name) => {
    const { replay: r } = built.get(name)!;
    // A SIGNED number, or any of the score vocabulary. `\u00d7N` is deliberately NOT here: the
    // multiplier chip is gone, and "TRANSITION \u00d73" counts direction changes, which is a
    // thing the driver did.
    const claim = /[+\u2212]\s*\d|\bPTS\b|\bPOINTS\b|CHAIN LOST|AT RISK|\bGRADE\b/;
    for (const e of r.events) expect(claim.test(e.label), `event "${e.label}"`).toBe(false);
    for (const m of r.markers) expect(claim.test(m.label), `marker "${m.label}"`).toBe(false);
    for (const h of r.highlights) expect(claim.test(h.label), `highlight "${h.label}"`).toBe(false);
    // …and every exit label is the one the engine's rule produces for that slide
    for (const seg of r.segments) {
      const end = r.markers.find((m) => m.kind === 'drift-end' && m.driftId === seg.driftId)!;
      expect(end.label).toBe(exitLabel(seg));
    }
  });

  /**
   * A REFUSED RECORDING STILL SHOWS WHAT IT MEASURED. It plays, it says LOST IT 118°, it counts
   * its transitions; what it loses is the RAMP — every angle on the frame goes to the neutral
   * grey, because a phone waved in a parked car produces large angles that the colour would
   * otherwise dress up as driving.
   */
  it('an untrusted run shows what it measured, in grey', () => {
    const { session, replay: r } = built.get('handheld')!;
    expect(session.integrity.scoreTrusted).toBe(false);
    expect(r.info.trusted).toBe(false);
    const shown = r.events.filter((e) => e.label !== '').map((e) => e.label);
    expect(shown.some((l) => /^LOST IT \d+\u00b0$/.test(l))).toBe(true);
    expect(shown.some((l) => /^TRANSITION/.test(l))).toBe(true);
    // every slide on THIS recording was refused outright, so every exit names the seconds the
    // monitor would not believe rather than a hold — and the trusted run one line down still
    // reports its holds, so the two are a difference the screen can show
    expect(shown.filter((l) => /DID NOT COUNT$/.test(l)).length).toBe(r.segments.length);
    expect(shown.some((l) => /^HELD /.test(l))).toBe(false);
    const good = built.get('good')!.replay;
    expect(good.events.filter((e) => /^HELD \d+\.\d S$/.test(e.label)).length).toBeGreaterThan(4);
    // and every colour the frame would have spent on an angle is refused
    for (const seg of r.segments) expect(heatOf(seg.peakAngle, r.info.trusted)).toBe(NO_HEAT);
    expect(heatOf(degToRad(70), r.info.trusted)).toBe(NO_HEAT);
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
    // it, the world slip label, the slip arc and the playhead dot did not, because the ramp is
    // identical from 0° to 40°. One frame said both things about the same 4.2°.
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
   * A colour that comes off the angle ramp — `angleColor`/`heatColor`, the theme's `ANGLE_STOPS`
   * themselves, `colors.green`/`greenHot` (its first two knots), a chunk colour `geometry.ts`
   * pre-computed off it — may only reach a paint through `heat(`, `driftHeat(` or `tint(`.
   * Anything else has to be named below with a reason, which is the point: adding an ungated
   * slide colour is a two-line change and this makes the second line a sentence someone writes.
   *
   * THE RAMP'S COLOURS ARE THE PALETTE'S COLOURS NOW, which is what the repaint changed here. The
   * ramp used to be ember and gold, two tokens nothing else on the screen spent, so the sweep
   * could name them and be done. It runs green → greenHot → red, and green is also the ghost and
   * red is also the alarm, so a sweep over every token would return a list of plates and chevrons
   * rather than a list of slide colours. `red` is therefore NOT swept — on this screen it is the
   * STOP colour (the REPLAY dot, the NOT SCORED plate, the DATA GAPS plate, the kerb dash), none
   * of which varies with an angle — and the ghost's green is spent through one named constant
   * (`GHOST` in palette.ts) rather than ten raw ones, so a raw `colors.green` anywhere in either
   * renderer is still a failure.
   */
  const GATE = /(?:^|[^A-Za-z_$])(?:heat|driftHeat|tint)\s*\(/;
  const RAMP = /colors\.(green|greenHot)\b|\bGREEN\b|heatColor\s*\(|angleColor\s*\(|ANGLE_STOPS|chunk\.color/;

  /** Lines that legitimately hold a ramp token outside the gate, each with why. */
  const EXEMPT: Array<{ needle: string; why: string }> = [
    {
      needle: 'import { ANGLE_STOPS, MAX_ANGLE_DEG, colors }',
      why: 'the import of the ramp itself, for the SVG ribbon gradient below',
    },
    {
      needle: 'const ribbonStops = ANGLE_STOPS.map(',
      why: 'the scrub ribbon gradient DEFINITION, built from the ramp so the strip and the trail cannot disagree; the untrusted branch draws MUTED and never references it (`resources.ts` builds the identical Skia shader)',
    },
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
    // Both current exemptions are in the SVG renderer, so a per-file "at least one was used"
    // assertion would fail on the app's file for being clean. Staleness is checked across both
    // files by the test below, which is where it belongs.
    expect(usedExemptions.size).toBeLessThanOrEqual(EXEMPT.length);
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
    const act = lay.action;
    let rawWorst = 0;
    let rawFrames = 0;
    let frames = 0;
    // Violations are COLLECTED and asserted once. Four `expect`s on each of ~74 000 frames is a
    // couple of seconds of assertion bookkeeping and nothing else, and a sweep that only fits
    // inside the default 5 s timeout when the machine is quiet is a red check waiting to happen.
    const off: string[] = [];
    for (const name of Object.keys(FIXTURES)) {
      const r = built.get(name)!.replay;
      for (const mode of ['chase', 'cinematic'] as CameraMode[]) {
        const cam = new ReplayCamera(mode, act);
        for (let t = 0; t <= r.durationS; t += dt) {
          frames++;
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
          const out = Math.max(act.x - sp.x, sp.x - (act.x + act.w), act.y - sp.y, sp.y - (act.y + act.h));
          if (out > 0 && off.length < 6) off.push(`${name}/${mode} t=${t.toFixed(2)}: ${out.toFixed(1)} pt outside`);
        }
      }
    }
    expect(off.join('\n'), `${frames} frames`).toBe('');
    // and the thing being guarded against is real on this grid, not hypothetical: in portrait
    // the raw camera leaves the rectangle, which is why the frame is held
    if (screen.name === 'portrait') {
      expect(rawFrames, `${frames} frames`).toBeGreaterThan(0);
      expect(rawWorst).toBeGreaterThan(20);
    }
  }, 120_000);

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
