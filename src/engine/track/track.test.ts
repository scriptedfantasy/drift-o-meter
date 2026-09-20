import { describe, expect, it } from 'vitest';
import { simulateRun, type SimulatedRun } from '../../sim/index';
import { Prng } from '../../sim/prng';
import type { DriftEvent, Lap, SlipState, TrackModel } from '../types';
import { TrackBuilder, lapConsistency, type TrackTick } from './index';

/**
 * SlipStates = simulator truth + a realistic estimator error, per axis:
 *   constant bias (1.5 m, random direction)
 *   + slowly varying wander, σ ≈ 0.8 m: white gaussian through two first-order low-passes
 *     (τ = 20 s, then 3 s) — 'smooth', the brief's "slowly varying offset";
 *     'rough' keeps only the first stage (an Ornstein–Uhlenbeck process, which random-walks
 *     ~0.2 m per second and is a much harsher curvature-noise source)
 *   + 0.3 m white noise per sample; speed gets 0.1 m/s white noise.
 * Total offset is 1–3 m most of the time.
 */
type NoiseMode = 'smooth' | 'rough';

function makeStates(run: SimulatedRun, seed: number, mode: NoiseMode = 'smooth'): SlipState[] {
  const rng = new Prng(seed * 1000003 + 7);
  const biasAng = rng.range(0, Math.PI * 2);
  const bias = { x: 1.5 * Math.cos(biasAng), y: 1.5 * Math.sin(biasAng) };
  const tau1 = 20;
  const tau2 = 3;
  const sigma = 0.8;
  let ox = 0;
  let oy = 0;
  let fx = 0;
  let fy = 0;
  const step = (dt: number): void => {
    const a = Math.exp(-dt / tau1);
    const q = sigma * Math.sqrt(1 - a * a);
    ox = a * ox + q * rng.gauss();
    oy = a * oy + q * rng.gauss();
    const a2 = Math.exp(-dt / tau2);
    fx = a2 * fx + (1 - a2) * ox;
    fy = a2 * fy + (1 - a2) * oy;
  };
  for (let k = 0; k < 6000; k++) step(0.01); // warm-up: start at a typical wander, not zero
  let prevT = run.truth[0].t;
  const out: SlipState[] = new Array(run.truth.length);
  for (let i = 0; i < run.truth.length; i++) {
    const tr = run.truth[i];
    step(Math.max(1e-3, tr.t - prevT));
    prevT = tr.t;
    const ex = mode === 'smooth' ? fx / 0.93 : ox; // the second stage loses a little variance
    const ey = mode === 'smooth' ? fy / 0.93 : oy;
    out[i] = {
      t: tr.t,
      beta: tr.beta,
      betaSigma: 0.02,
      heading: tr.heading,
      course: tr.course,
      speed: Math.max(0, tr.speed + 0.1 * rng.gauss()),
      yawRate: tr.yawRate,
      ay: tr.ay,
      ax: tr.ax,
      x: tr.x + bias.x + ex + 0.3 * rng.gauss(),
      y: tr.y + bias.y + ey + 0.3 * rng.gauss(),
      valid: tr.speed > 2,
    };
  }
  return out;
}

/** True start-line crossing times: the line through the start position, perpendicular to the initial heading. */
function truthCrossings(run: SimulatedRun): number[] {
  const h0 = run.truth[0].heading;
  const ux = Math.cos(h0);
  const uy = Math.sin(h0);
  const x0 = run.truth[0].x;
  const y0 = run.truth[0].y;
  const cross: number[] = [];
  for (let i = 1; i < run.truth.length; i++) {
    const a = run.truth[i - 1];
    const b = run.truth[i];
    const da = (a.x - x0) * ux + (a.y - y0) * uy;
    const db = (b.x - x0) * ux + (b.y - y0) * uy;
    const lat = Math.abs(-(a.x - x0) * uy + (a.y - y0) * ux);
    if (da < 0 && db >= 0 && lat < 12 && b.speed > 1) cross.push(a.t + (da / (da - db)) * (b.t - a.t));
  }
  return cross;
}

/** Distance actually driven (truth), metres — the honest length reference for an open run with run-off. */
function truthDistance(run: SimulatedRun): number {
  let d = 0;
  for (let i = 1; i < run.truth.length; i++) d += Math.hypot(run.truth[i].x - run.truth[i - 1].x, run.truth[i].y - run.truth[i - 1].y);
  return d;
}

/** Minimal DriftEvents from the truth's `drifting` flag (the detect module is built by another agent). */
function syntheticDrifts(run: SimulatedRun): DriftEvent[] {
  const drifts: DriftEvent[] = [];
  const tr = run.truth;
  let i = 0;
  while (i < tr.length) {
    if (!tr[i].drifting) {
      i++;
      continue;
    }
    let j = i;
    while (j < tr.length && tr[j].drifting) j++;
    const seg = tr.slice(i, j);
    if (seg[seg.length - 1].t - seg[0].t >= 0.5) {
      let peak = 0;
      let peakT = seg[0].t;
      let sumA = 0;
      let sumV = 0;
      let minV = Infinity;
      let peakYaw = 0;
      let peakAy = 0;
      for (const s of seg) {
        const a = Math.abs(s.beta);
        if (a > peak) {
          peak = a;
          peakT = s.t;
        }
        sumA += a;
        sumV += s.speed;
        minV = Math.min(minV, s.speed);
        peakYaw = Math.max(peakYaw, Math.abs(s.yawRate));
        peakAy = Math.max(peakAy, Math.abs(s.ay));
      }
      drifts.push({
        id: drifts.length,
        startT: seg[0].t,
        endT: seg[seg.length - 1].t,
        durationS: seg[seg.length - 1].t - seg[0].t,
        peakAngle: peak,
        peakAngleT: peakT,
        meanAngle: sumA / seg.length,
        angleStdDev: 0,
        transitions: 0,
        entrySpeed: seg[0].speed,
        meanSpeed: sumV / seg.length,
        minSpeed: minV,
        distanceM: (sumV / seg.length) * (seg[seg.length - 1].t - seg[0].t),
        peakYawRate: peakYaw,
        peakLateralAccel: peakAy,
        initialDirection: seg[0].beta >= 0 ? 1 : -1,
        spin: false,
        suppressedS: 0,
        sampleStart: i,
        sampleEnd: j - 1,
      });
    }
    i = j;
  }
  return drifts;
}

function runBuilder(states: SlipState[]): { builder: TrackBuilder; ticks: TrackTick[]; model: TrackModel | null; wallMs: number } {
  const builder = new TrackBuilder();
  const ticks: TrackTick[] = [];
  const t0 = performance.now();
  for (const s of states) {
    const tick = builder.push(s);
    if (tick.lapCompleted) ticks.push(tick);
  }
  const model = builder.build();
  return { builder, ticks, model, wallMs: performance.now() - t0 };
}

/**
 * A found corner matches a truth corner when it turns the same way and its apex is within 25 m.
 * Long truth corners (> 20 m) must additionally be covered by a same-direction found corner whose
 * span overlaps theirs: the sections are what the scorer assigns drifts to, so those must be right
 * even where the apex of a multi-lobe sweeper is ambiguous.
 */
function matchCorners(run: SimulatedRun, model: TrackModel): { matched: number; maxApexErrM: number; uncovered: number; apexErrs: string } {
  let matched = 0;
  let maxErr = 0;
  let uncovered = 0;
  const used = new Set<number>();
  const errs: string[] = [];
  for (const tc of run.corners) {
    let best = -1;
    let bestD = Infinity;
    model.corners.forEach((c, i) => {
      if (used.has(i) || c.direction !== tc.direction) return;
      const d = Math.hypot(c.x - tc.x, c.y - tc.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0 && bestD <= 25) {
      used.add(best);
      matched++;
      maxErr = Math.max(maxErr, bestD);
    }
    errs.push(`${tc.direction > 0 ? 'L' : 'R'}${tc.apexS.toFixed(0)}:${Number.isFinite(bestD) ? bestD.toFixed(0) : '-'}`);
    if (tc.endS - tc.startS > 20) {
      const covered = model.corners.some((c) => {
        if (c.direction !== tc.direction) return false;
        const spans = [
          [c.startS, c.endS],
          [c.startS - model.lengthM, c.endS - model.lengthM],
        ];
        return spans.some(([a, b]) => Math.min(b, tc.endS) - Math.max(a, tc.startS) > 5);
      });
      if (!covered) uncovered++;
    }
  }
  return { matched, maxApexErrM: maxErr, uncovered, apexErrs: errs.join(' ') };
}

const fmtCorners = (m: TrackModel): string =>
  m.corners.map((c) => `${c.direction > 0 ? 'L' : 'R'}${c.apexS.toFixed(0)}[${c.startS.toFixed(0)}-${c.endS.toFixed(0)}]r${c.radiusM.toFixed(0)}`).join(' ');

/** Walk a lap's true positions through projectToS: s must advance monotonically with no jumps > 5 m except the wrap. */
function projectionJumps(run: SimulatedRun, builder: TrackBuilder, model: TrackModel, tA: number, tB: number): number {
  let prevS = NaN;
  let maxJump = 0;
  let backwards = 0;
  for (const tr of run.truth) {
    if (tr.t < tA || tr.t > tB) continue;
    const p = builder.projectToS(tr.x, tr.y);
    expect(p).not.toBeNull();
    const s = p!.s;
    expect(Math.abs(p!.lateralM)).toBeLessThan(6);
    if (!Number.isNaN(prevS)) {
      let ds = s - prevS;
      if (model.closed && ds < -model.lengthM / 2) ds += model.lengthM; // the wrap
      if (ds < -0.5) backwards++;
      maxJump = Math.max(maxJump, Math.abs(ds));
    }
    prevS = s;
  }
  expect(backwards).toBe(0);
  return maxJump;
}

interface Metrics {
  name: string;
  laps: number;
  /** SIGNED worst lap-boundary error: a bias shows up as one sign in every row. */
  maxLapErrS: number;
  lenErrPct: number;
  cornersTrue: number;
  cornersFound: number;
  matched: number;
  maxApexErrM: number;
  uncovered: number;
  maxProjJumpM: number;
  consistency: number;
  wallMs: number;
}

const rows: Metrics[] = [];
/** Every signed lap-boundary error in the suite, for the "no systematic bias" assertion. */
const LAP_ERRORS: number[] = [];

/**
 * A dash, never "NaN": an open road legitimately has no lap error and no cross-lap consistency,
 * and a NaN printed for "not applicable" is how a real one hides in a metrics table later.
 */
function fmt(v: number, d = 2): string {
  return Number.isFinite(v) ? v.toFixed(d) : '—';
}

function printTable(): void {
  const head = ['run', 'laps', 'lapErr(s)±', 'lenErr(%)', 'cTrue', 'cFound', 'match', 'uncov', 'apexErr(m)', 'projJump(m)', 'consist', 'ms'];
  const lines = rows.map((r) => [
    r.name,
    String(r.laps),
    fmt(r.maxLapErrS, 3),
    fmt(r.lenErrPct, 2),
    String(r.cornersTrue),
    String(r.cornersFound),
    String(r.matched),
    String(r.uncovered),
    fmt(r.maxApexErrM, 1),
    fmt(r.maxProjJumpM, 2),
    fmt(r.consistency, 2),
    fmt(r.wallMs, 0),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  // process.stdout.write, never the console: vitest 5 swallows a test file's console output by
  // default, which is how a metrics table nobody could see stayed wrong for a whole round.
  const text = [
    '\nTRACK MODEL METRICS  (smooth = gating rows per the brief; rough = OU offset, looser gates)',
    head.map((h, i) => h.padEnd(widths[i])).join('  '),
    ...lines.map((l) => l.map((c, i) => c.padEnd(widths[i])).join('  ')),
  ].join('\n');
  process.stdout.write(text + '\n');
}

/** Everything a closed-circuit run must satisfy; `strict` = the brief's corner criteria, else the rough-noise gates. */
function checkHarbor(seed: number, mode: NoiseMode): void {
  const run = simulateRun('harbor', { laps: 3, seed });
  const states = makeStates(run, seed, mode);
  const { builder, ticks, model, wallMs } = runBuilder(states);
  expect(model).not.toBeNull();
  expect(model!.closed).toBe(true);
  expect(model!.gate).toBeDefined();

  // laps: count, boundaries (interpolated, vs truth crossings), sample ranges
  const laps: Lap[] = builder.laps;
  expect(laps.length).toBe(3);
  expect(ticks.length).toBe(3);
  expect(model!.laps.length).toBe(3);
  const crossings = truthCrossings(run);
  expect(crossings.length).toBe(3);
  expect(Math.abs(crossings[0] - run.lapTimes[1])).toBeLessThan(0.02);
  expect(Math.abs(crossings[1] - run.lapTimes[2])).toBeLessThan(0.02);
  const trueBoundaries = [run.lapTimes[0], ...crossings];
  let maxLapErr = 0;
  let worstSigned = 0;
  const signed: number[] = [];
  laps.forEach((lap, k) => {
    expect(lap.index).toBe(k);
    signed.push(lap.startT - trueBoundaries[k], lap.endT - trueBoundaries[k + 1]);
    for (const e of [lap.startT - trueBoundaries[k], lap.endT - trueBoundaries[k + 1]]) {
      if (Math.abs(e) > maxLapErr) {
        maxLapErr = Math.abs(e);
        worstSigned = e;
      }
    }
    expect(Math.abs(lap.durationS - (lap.endT - lap.startT))).toBeLessThan(1e-9);
    expect(lap.sampleEnd).toBeGreaterThan(lap.sampleStart);
    expect(states[lap.sampleStart].t).toBeLessThanOrEqual(lap.startT + 0.02);
    expect(states[lap.sampleEnd].t).toBeLessThanOrEqual(lap.endT);
    if (k > 0) expect(lap.sampleStart).toBe(laps[k - 1].sampleEnd + 1);
  });
  // Lap boundaries used to be 0.28–0.31 s late in EVERY row of this table — the time a car
  // takes to reach the 1 m/s "started" threshold from rest, charged to lap 1's start. What is
  // left is the position wander this noise model injects, which has no preferred sign.
  expect(Math.abs(signed[0]), 'run start').toBeLessThan(0.1);
  expect(maxLapErr).toBeLessThan(0.15);
  LAP_ERRORS.push(...signed);
  // the crossing time must not be snapped to a 10 ms sample boundary in every lap
  expect(laps.some((l) => Math.abs(l.endT * 100 - Math.round(l.endT * 100)) > 1e-3)).toBe(true);

  // reference-lap length and spacing
  const trueLen = run.centreLine[run.centreLine.length - 1].s + (run.centreLine[1].s - run.centreLine[0].s);
  const lenErrPct = (100 * (model!.lengthM - trueLen)) / trueLen;
  expect(Math.abs(lenErrPct)).toBeLessThan(3);
  expect(model!.refPath.length).toBe(Math.round(model!.lengthM));
  const step = model!.lengthM / model!.refPath.length;
  for (let i = 1; i < model!.refPath.length; i++) {
    const a = model!.refPath[i - 1];
    const b = model!.refPath[i];
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    expect(chord).toBeGreaterThan(0.9 * step); // chords across a polyline vertex are a little shorter than the arc step
    expect(chord).toBeLessThan(step + 1e-6);
    expect(b.s - a.s).toBeCloseTo(step, 9);
  }

  // corners
  const { matched, maxApexErrM, uncovered, apexErrs } = matchCorners(run, model!);
  process.stdout.write(`harbor s${seed} ${mode}: found ${fmtCorners(model!)} | apex err (m) vs truth: ${apexErrs}\n`);
  const countErr = Math.abs(model!.corners.length - run.corners.length);
  if (mode === 'smooth') {
    expect(countErr).toBeLessThanOrEqual(1);
    expect(maxApexErrM).toBeLessThan(15);
    expect(uncovered).toBe(0);
    expect(matched).toBeGreaterThanOrEqual(run.corners.length - 2);
  } else {
    expect(countErr).toBeLessThanOrEqual(2);
    expect(maxApexErrM).toBeLessThan(25);
    expect(uncovered).toBeLessThanOrEqual(1);
    expect(matched).toBeGreaterThanOrEqual(run.corners.length - 3);
  }
  model!.corners.forEach((c, i) => {
    expect(c.id).toBe(i);
    expect(c.endS).toBeGreaterThan(c.startS);
    expect(c.endS - c.startS).toBeGreaterThan(12);
    expect(c.radiusM).toBeGreaterThan(5);
    expect(c.radiusM).toBeLessThan(200);
    expect(c.apexS).toBeGreaterThanOrEqual(0);
    expect(c.apexS).toBeLessThan(model!.lengthM);
  });

  // projection along lap 2 (truth positions): monotonic, no jumps
  const maxProjJumpM = projectionJumps(run, builder, model!, run.lapTimes[1], run.lapTimes[2]);
  expect(maxProjJumpM).toBeLessThan(5);

  // live progress ticks once the model existed
  let progressSeen = 0;
  const b2 = new TrackBuilder();
  for (const s of states) {
    const tk = b2.push(s);
    if (!Number.isNaN(tk.progress)) {
      expect(tk.progress).toBeGreaterThanOrEqual(0);
      expect(tk.progress).toBeLessThan(1);
      progressSeen++;
    }
  }
  expect(progressSeen).toBeGreaterThan(states.length / 2);

  // cross-lap consistency with drifts derived from the truth
  const cons = lapConsistency(model!, syntheticDrifts(run), states);
  expect(cons.lapsCompared).toBe(3);
  expect(cons.available).toBe(true);
  expect(cons.perCorner.length).toBe(model!.corners.length);
  expect(cons.overall).toBeGreaterThan(0.6);
  expect(cons.overall).toBeLessThanOrEqual(1);
  let fullHits = 0;
  for (const pc of cons.perCorner) {
    expect(pc.laps.length).toBe(3);
    if (pc.hitRate === 1) {
      fullHits++;
      expect(pc.angleCV).toBeLessThan(0.3);
      expect(pc.entrySpreadM).toBeLessThan(20);
      for (const l of pc.laps) {
        expect(l!.peakAngleDeg).toBeGreaterThan(8);
        expect(l!.entrySpeed).toBeGreaterThan(5);
        expect(l!.entryS).toBeGreaterThanOrEqual(0);
        expect(l!.entryS).toBeLessThan(model!.lengthM);
      }
    }
  }
  // the scripted driver drifts every real corner every lap; only false corners on straights may be missed
  expect(fullHits).toBeGreaterThanOrEqual(matched - 1);

  rows.push({
    name: `harbor s${seed} ${mode}`,
    laps: laps.length,
    maxLapErrS: worstSigned,
    lenErrPct,
    cornersTrue: run.corners.length,
    cornersFound: model!.corners.length,
    matched,
    maxApexErrM,
    uncovered,
    maxProjJumpM,
    consistency: cons.overall,
    wallMs,
  });
}

describe('track model — harbor circuit (closed)', () => {
  for (const seed of [1, 2, 3]) {
    it(`detects 3 laps, the centre-line and the corners (seed ${seed})`, () => checkHarbor(seed, 'smooth'));
  }
  for (const seed of [1, 2, 3]) {
    it(`survives a rough (OU) estimator offset (seed ${seed})`, () => checkHarbor(seed, 'rough'));
  }

  it('never completes a lap in the first 40 s → open model, no crash', () => {
    const run = simulateRun('harbor', { laps: 3, seed: 1 });
    const states = makeStates(run, 11).filter((s) => s.t <= 40);
    const { builder, ticks, model } = runBuilder(states);
    expect(ticks.length).toBe(0);
    expect(builder.laps.length).toBe(0);
    expect(builder.model).not.toBeNull(); // build() keeps the open model
    expect(model).not.toBeNull();
    expect(model!.closed).toBe(false);
    expect(model!.laps).toEqual([]);
    expect(model!.gate).toBeUndefined();
    const trueLen = run.centreLine[run.centreLine.length - 1].s;
    expect(model!.lengthM).toBeGreaterThan(200);
    expect(model!.lengthM).toBeLessThan(trueLen);
    expect(model!.corners.length).toBeGreaterThanOrEqual(1);
    const last = states[states.length - 1];
    const p = builder.projectToS(last.x, last.y);
    expect(p).not.toBeNull();
    expect(p!.s).toBeGreaterThan(model!.lengthM - 15);
    const cons = lapConsistency(model!, syntheticDrifts(run), states);
    expect(cons.available).toBe(false);
    expect(cons.overall).toBe(0);
  });

  it('handles an empty or stationary run, NaN samples and reset()', () => {
    const b = new TrackBuilder();
    expect(b.build()).toBeNull();
    expect(b.projectToS(0, 0)).toBeNull();
    const still: SlipState = { t: 0, beta: 0, betaSigma: 0, heading: 0, course: 0, speed: 0, yawRate: 0, ay: 0, ax: 0, x: 3, y: 4, valid: false };
    for (let i = 0; i < 500; i++) {
      const tk = b.push({ ...still, t: i / 100 });
      expect(tk.lapCompleted).toBeNull();
      expect(tk.lapCount).toBe(0);
      expect(Number.isNaN(tk.progress)).toBe(true);
    }
    expect(b.build()).toBeNull();
    b.push({ ...still, t: 5, x: NaN, y: NaN });
    b.push({ ...still, t: 5.01, x: 3, y: 4 });
    b.reset();
    expect(b.laps.length).toBe(0);
    expect(b.model).toBeNull();
    expect(b.build()).toBeNull();
  });

  it('is deterministic and independent of the ENU origin', () => {
    const run = simulateRun('harbor', { laps: 2, seed: 5 });
    const states = makeStates(run, 5);
    const a = runBuilder(states).model!;
    const b = runBuilder(states.map((s) => ({ ...s, x: s.x + 5000, y: s.y - 3000 }))).model!;
    expect(a.laps.length).toBe(2);
    expect(b.laps.length).toBe(2);
    expect(b.lengthM).toBeCloseTo(a.lengthM, 6);
    expect(b.corners.length).toBe(a.corners.length);
    b.corners.forEach((c, i) => {
      expect(c.apexS).toBeCloseTo(a.corners[i].apexS, 6);
      expect(c.x - 5000).toBeCloseTo(a.corners[i].x, 6);
    });
    expect(b.laps[1].endT).toBeCloseTo(a.laps[1].endT, 9);
  });
});

describe('track model — mountain pass (point-to-point)', () => {
  it('builds an open model with ≥ 6 corners and no laps', () => {
    const run = simulateRun('touge', { seed: 1 });
    const states = makeStates(run, 21);
    const { builder, ticks, model, wallMs } = runBuilder(states);
    expect(ticks.length).toBe(0);
    expect(model).not.toBeNull();
    expect(model!.closed).toBe(false);
    expect(model!.laps).toEqual([]);
    expect(model!.corners.length).toBeGreaterThanOrEqual(6);
    const driven = truthDistance(run);
    const lenErrPct = (100 * (model!.lengthM - driven)) / driven;
    expect(Math.abs(lenErrPct)).toBeLessThan(3);
    const { matched, maxApexErrM, uncovered, apexErrs } = matchCorners(run, model!);
    process.stdout.write(`touge: found ${fmtCorners(model!)} | apex err (m) vs truth: ${apexErrs}\n`);
    expect(matched).toBeGreaterThanOrEqual(6);
    expect(maxApexErrM).toBeLessThan(15);
    expect(uncovered).toBe(0);
    const maxJump = projectionJumps(run, builder, model!, run.truth.find((t) => t.speed > 1)!.t, run.truth[run.truth.length - 1].t);
    expect(maxJump).toBeLessThan(5);
    const cons = lapConsistency(model!, syntheticDrifts(run), states);
    expect(cons.available).toBe(false);
    expect(cons.overall).toBe(0);
    expect(cons.perCorner.length).toBe(model!.corners.length);
    rows.push({
      name: 'touge s1 smooth',
      laps: 0,
      maxLapErrS: NaN,
      lenErrPct,
      cornersTrue: run.corners.length,
      cornersFound: model!.corners.length,
      matched,
      maxApexErrM,
      uncovered,
      maxProjJumpM: maxJump,
      consistency: NaN,
      wallMs,
    });
    printTable();
  });

  it('lap times carry no systematic bias: both signs, and the mean error is near zero', () => {
    // every row of the metrics table used to read 0.28–0.31 s, always positive
    expect(LAP_ERRORS.length).toBeGreaterThan(6);
    const mean = LAP_ERRORS.reduce((a, b) => a + b, 0) / LAP_ERRORS.length;
    const worst = Math.max(...LAP_ERRORS.map(Math.abs));
    process.stdout.write(`\nLAP BOUNDARY ERROR over ${LAP_ERRORS.length} boundaries: mean ${mean.toFixed(3)} s, worst |err| ${worst.toFixed(3)} s, ` +
      `${LAP_ERRORS.filter((e) => e > 0).length} late / ${LAP_ERRORS.filter((e) => e < 0).length} early\n`);
    expect(LAP_ERRORS.some((e) => e > 0), 'no lap boundary is ever late').toBe(true);
    expect(LAP_ERRORS.some((e) => e < 0), 'no lap boundary is ever early — that is a bias').toBe(true);
    expect(Math.abs(mean), 'mean signed error').toBeLessThan(0.06);
    expect(worst).toBeLessThan(0.15);
  });
});
