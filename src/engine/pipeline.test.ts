/**
 * End-to-end test of the whole engine: simulated sensors → DriftPipeline → Session.
 *
 * Every scenario feeds a COMPLETE simulated run through `pushMotion` / `pushGps` interleaved in
 * timestamp order, exactly as the live app will, with real mount calibration and real slip
 * estimation in the loop — so the numbers here are the honest whole-system numbers, not the
 * per-module ones (each module's own test feeds it perfect inputs from the layer above).
 *
 * Recall is measured against the simulator's contiguous `truth.drifting` intervals, merged when
 * they are less than MERGE_GAP_S apart and dropped below MIN_TRUTH_S (a slide shorter than the
 * detector's own minimum duration is not a drift anyone would count). An interval counts as
 * detected when one drift event overlaps at least half of it.
 */
import { describe, expect, it } from 'vitest';
import { simulateRun, type SimulateOptions, type SimulatedRun, type TrackId } from '../sim';
import { buildReplay } from './replay';
import { DriftPipeline, type DriftPipelineOptions, type LiveFrame } from './pipeline';
import { radToDeg, type MotionSample, type Session, type TruthSample } from './types';

// ─────────────────────────────────────────────────────────────────── helpers

/** Path of the first non-finite number anywhere in `v`, or null. Handles typed arrays. */
function findNonFinite(v: unknown, path: string): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? null : path;
  if (v === null || typeof v !== 'object') return null;
  if (ArrayBuffer.isView(v)) {
    const a = v as unknown as ArrayLike<number>;
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return `${path}[${i}]`;
    return null;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const r = findNonFinite(v[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  for (const k of Object.keys(v as object)) {
    const r = findNonFinite((v as Record<string, unknown>)[k], `${path}.${k}`);
    if (r) return r;
  }
  return null;
}

const MERGE_GAP_S = 0.5;
const MIN_TRUTH_S = 0.7;

function truthIntervals(truth: TruthSample[]): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < truth.length; i++) {
    if (truth[i].drifting && start < 0) start = i;
    if (!truth[i].drifting && start >= 0) {
      raw.push([truth[start].t, truth[i - 1].t]);
      start = -1;
    }
  }
  if (start >= 0) raw.push([truth[start].t, truth[truth.length - 1].t]);
  const merged: Array<[number, number]> = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv[0] - last[1] < MERGE_GAP_S) last[1] = iv[1];
    else merged.push([iv[0], iv[1]]);
  }
  return merged.filter(([a, b]) => b - a >= MIN_TRUTH_S);
}

/** Feed a whole run through a pipeline the way the app does: fixes first, then the sample. */
function drive(p: DriftPipeline, run: SimulatedRun, onFrame?: (f: LiveFrame, i: number) => void): void {
  const gps = run.gps.slice().sort((a, b) => a.t - b.t);
  let j = 0;
  for (let i = 0; i < run.motion.length; i++) {
    while (j < gps.length && gps[j].t <= run.motion[i].t) {
      p.pushGps(gps[j]);
      j++;
    }
    const f = p.pushMotion(run.motion[i]);
    if (onFrame) onFrame(f, i);
  }
  while (j < gps.length) {
    p.pushGps(gps[j]);
    j++;
  }
}

interface Metrics {
  name: string;
  samples: number;
  drifts: number;
  truthDrifts: number;
  /** Truth intervals at least half covered by one detected drift. */
  recall: number;
  /** Fraction of truth drifting seconds covered by detected drifts. */
  timeRecall: number;
  points: number;
  grade: string;
  angle: number;
  consistency: number;
  quality: number;
  speed: number;
  style: number;
  laps: number;
  peakDeg: number;
  ms: number;
  usPerSample: number;
  finishMs: number;
  liveBytesPerSample: number;
  jsonMB: number;
}

interface Scenario {
  name: string;
  run: SimulatedRun;
  pipeline: DriftPipeline;
  session: Session;
  metrics: Metrics;
  /** Path of the first non-finite frame field seen during the run, or null. */
  badFrame: string | null;
  /** Description of the first non-monotonic frame, or null. */
  badTime: string | null;
  mountStates: Set<string>;
  lastIntegrityMessage: string;
  maxLapProgress: number;
  callouts: number;
  /** Best calibration quality reached, and whether forward was ever resolved. */
  maxCalibrationQuality: number;
  everForwardResolved: boolean;
}

const BASE: DriftPipelineOptions = { gpsLatencyS: 0.45, startedAt: Date.UTC(2026, 0, 1), id: 'test-session' };

function scenario(name: string, track: TrackId, sim: SimulateOptions, pipe: DriftPipelineOptions = {}): Scenario {
  const run = simulateRun(track, { laps: 2, ...sim });
  const pipeline = new DriftPipeline({ ...BASE, name, ...pipe });
  let badFrame: string | null = null;
  let badTime: string | null = null;
  let prevT = -Infinity;
  const mountStates = new Set<string>();
  let lastIntegrityMessage = '';
  let maxLapProgress = 0;
  let callouts = 0;
  let maxCalibrationQuality = 0;
  let everForwardResolved = false;
  drive(pipeline, run, (f, i) => {
    if (!badFrame) badFrame = findNonFinite(f, `frame[${i}]`);
    if (!badTime && !(f.t > prevT)) badTime = `frame[${i}] t=${f.t} after ${prevT}`;
    prevT = f.t;
    mountStates.add(f.integrity.mount);
    lastIntegrityMessage = f.integrity.message;
    if (f.lap.progress > maxLapProgress) maxLapProgress = f.lap.progress;
    if (f.calibration.quality > maxCalibrationQuality) maxCalibrationQuality = f.calibration.quality;
    if (f.calibration.forwardResolved) everForwardResolved = true;
    callouts += f.score.callouts.length;
  });
  const liveBytes = pipeline.diagnostics.approxBytes;
  const session = pipeline.finish({ track, seed: sim.seed ?? 1 });

  // timed passes: a fresh pipeline, no instrumentation, JIT already warm from the pass above.
  // The streaming cost (what has to fit in 10 ms per sample) is measured apart from finish(),
  // which is a one-off offline pass over the whole run. Best of two, to damp scheduler noise.
  let ms = Infinity;
  let finishMs = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    const timed = new DriftPipeline({ ...BASE, name, ...pipe });
    const t0 = performance.now();
    drive(timed, run);
    const t1 = performance.now();
    timed.finish();
    const t2 = performance.now();
    ms = Math.min(ms, t1 - t0);
    finishMs = Math.min(finishMs, t2 - t1);
  }

  const intervals = truthIntervals(run.truth);
  let covered = 0;
  let overlapS = 0;
  let truthS = 0;
  for (const [a, b] of intervals) {
    truthS += b - a;
    let best = 0;
    for (const d of session.drifts) {
      const ov = Math.min(b, d.endT) - Math.max(a, d.startT);
      if (ov > 0) overlapS += ov;
      if (ov > best) best = ov;
    }
    if (best >= 0.5 * (b - a)) covered++;
  }
  const metrics: Metrics = {
    name,
    samples: run.motion.length,
    drifts: session.drifts.length,
    truthDrifts: intervals.length,
    recall: intervals.length ? covered / intervals.length : 1,
    timeRecall: truthS > 0 ? overlapS / truthS : 1,
    points: session.score.total,
    grade: session.score.grade,
    angle: session.score.angle,
    consistency: session.score.consistency,
    quality: session.score.quality,
    speed: session.score.speed,
    style: session.score.style,
    laps: session.track ? session.track.laps.length : 0,
    peakDeg: radToDeg(session.drifts.reduce((m, d) => Math.max(m, d.peakAngle), 0)),
    ms,
    usPerSample: (ms * 1000) / run.motion.length,
    finishMs,
    liveBytesPerSample: liveBytes / Math.max(1, run.motion.length),
    jsonMB: JSON.stringify(session).length / 1048576,
  };
  return {
    name, run, pipeline, session, metrics, badFrame, badTime, mountStates,
    lastIntegrityMessage, maxLapProgress, callouts, maxCalibrationQuality, everForwardResolved,
  };
}

/** Just the verdict of one run — for the seed-to-seed spread the grade assertion needs. */
function verdict(track: TrackId, sim: SimulateOptions): { seed: number; grade: string; combined: number } {
  const run = simulateRun(track, { laps: 2, ...sim });
  const p = new DriftPipeline({ ...BASE, name: 'verdict' });
  drive(p, run);
  const session = p.finish();
  const b = p.breakdown as { combined: number } | null;
  return { seed: sim.seed ?? 0, grade: session.score.grade, combined: b ? b.combined : 0 };
}

// ───────────────────────────────────────────────────────── the runs under test
// Grades move with the seed even at fixed driver settings: across harbor seeds 1–6 a "good
// driver" scores 67–77 on the scorer's 0–100 combined scale, and the A threshold (75) sits in
// the middle of that spread, so single-seed grades flip with any upstream retune. The verdict
// is therefore taken over three seeds (below), and the scenarios that carry the rest of the
// assertions use the seeds that have been stable across the engine's retunes.
const GOOD = { aggression: 0.8, consistency: 0.85 };
const SLOPPY = { aggression: 0.3, consistency: 0.3 };

const harborGood = scenario('harbor-good', 'harbor', { seed: 3, laps: 2, ...GOOD });
const harborSloppy = scenario('harbor-sloppy', 'harbor', { seed: 1, laps: 2, ...SLOPPY });
const tougeGood = scenario('touge-good', 'touge', { seed: 1, ...GOOD });
const harborLoose = scenario('harbor-loose', 'harbor', { seed: 3, laps: 2, looseness: 1, ...GOOD });
const all = [harborGood, harborSloppy, tougeGood, harborLoose];

// ─────────────────────────────────────────────────────────────────── the tests

const GOOD_VERDICTS: Array<{ seed: number; grade: string; combined: number }> = [];
const SLOPPY_VERDICTS: Array<{ seed: number; grade: string; combined: number }> = [];

describe('DriftPipeline end to end', () => {
  for (const s of all) {
    it(`${s.name}: no NaN in any frame field, frames monotonic in t`, () => {
      expect(s.badFrame).toBeNull();
      expect(s.badTime).toBeNull();
      expect(s.metrics.samples).toBeGreaterThan(5000);
      expect(s.pipeline.diagnostics.droppedSamples).toBe(0);
      expect(s.pipeline.frame).not.toBeNull();
    });

    it(`${s.name}: the finished Session is finite, self-consistent and complete`, () => {
      const session = s.session;
      expect(findNonFinite(session, 'session')).toBeNull();
      expect(session.version).toBe(1);
      expect(session.states.length).toBe(s.metrics.samples);
      // motion is decimated to 50 Hz for storage (docs/ARCHITECTURE.md)
      expect(session.motion.length).toBeGreaterThan(0.45 * s.metrics.samples);
      expect(session.motion.length).toBeLessThan(0.55 * s.metrics.samples);
      expect(session.gps.length).toBeGreaterThan(10);
      expect(session.durationS).toBeGreaterThan(30);
      expect(session.calibration.r).toHaveLength(9);
      expect(Object.keys(session.score.perDrift).length).toBe(session.drifts.length);
      for (const d of session.drifts) {
        expect(d.endT).toBeGreaterThan(d.startT);
        expect(d.sampleStart).toBeGreaterThanOrEqual(0);
        expect(d.sampleEnd).toBeLessThan(session.states.length);
        // the sample indices must address the same drift the timestamps describe
        expect(session.states[d.sampleStart].t).toBeCloseTo(d.startT, 0);
        expect(session.states[d.sampleEnd].t).toBeCloseTo(d.endT, 0);
      }
    });
  }

  it('detects drifts with a recall of at least 0.8 against the simulator ground truth', () => {
    for (const s of [harborGood, harborSloppy, tougeGood]) {
      expect(s.metrics.truthDrifts).toBeGreaterThan(2);
      expect(s.metrics.recall).toBeGreaterThanOrEqual(0.8);
      expect(s.metrics.timeRecall).toBeGreaterThan(0.7);
      // a sane count: one linked drift can span several truth slides (the detector merges across
      // gaps shorter than mergeGapS), and noise must not invent many
      expect(s.metrics.drifts).toBeGreaterThanOrEqual(Math.ceil(0.5 * s.metrics.truthDrifts));
      expect(s.metrics.drifts).toBeLessThanOrEqual(Math.ceil(1.8 * s.metrics.truthDrifts));
    }
  });

  it('grades a good driver A or S and a sloppy one C or D', () => {
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    GOOD_VERDICTS.push(
      { seed: 3, grade: harborGood.session.score.grade, combined: (harborGood.pipeline.breakdown as { combined: number }).combined },
      verdict('harbor', { seed: 1, ...GOOD }),
      verdict('harbor', { seed: 2, ...GOOD }),
    );
    SLOPPY_VERDICTS.push(
      { seed: 1, grade: harborSloppy.session.score.grade, combined: (harborSloppy.pipeline.breakdown as { combined: number }).combined },
      verdict('harbor', { seed: 2, ...SLOPPY }),
      verdict('harbor', { seed: 3, ...SLOPPY }),
    );
    // the verdict of the system, not of one lucky seed: the majority of three runs
    expect(GOOD_VERDICTS.filter((v) => v.grade === 'S' || v.grade === 'A').length).toBeGreaterThanOrEqual(2);
    expect(SLOPPY_VERDICTS.filter((v) => v.grade === 'C' || v.grade === 'D').length).toBeGreaterThanOrEqual(2);
    // and the invariant behind the grades: the same track driven well scores clearly higher
    expect(mean(GOOD_VERDICTS.map((v) => v.combined))).toBeGreaterThan(mean(SLOPPY_VERDICTS.map((v) => v.combined)) + 15);
    expect(harborGood.session.score.consistency).toBeGreaterThan(harborSloppy.session.score.consistency);
  });

  it('finds both laps of a closed track and reports lap progress', () => {
    expect(harborGood.metrics.laps).toBe(2);
    expect(harborGood.session.track).not.toBeNull();
    const track = harborGood.session.track as NonNullable<Session['track']>;
    expect(track.closed).toBe(true);
    expect(track.lengthM).toBeGreaterThan(200);
    expect(track.corners.length).toBeGreaterThan(2);
    expect(harborGood.maxLapProgress).toBeGreaterThan(0.9);
    // an open road has no laps but still yields a point-to-point model
    expect(tougeGood.metrics.laps).toBe(0);
    expect(tougeGood.session.track).not.toBeNull();
    expect((tougeGood.session.track as NonNullable<Session['track']>).closed).toBe(false);
  });

  it('fires HUD callouts and keeps the live score consistent with the frame contract', () => {
    expect(harborGood.callouts).toBeGreaterThan(5);
    const f = harborGood.pipeline.frame as LiveFrame;
    expect(f.score.total).toBeGreaterThan(0);
    expect(f.score.multiplier).toBeGreaterThanOrEqual(1);
    // the calibration is judged over the run: quality sags as the car rolls to a stop, because
    // a parked car gives the forward axis nothing to work with
    expect(harborGood.maxCalibrationQuality).toBeGreaterThan(0.4);
    expect(harborGood.everForwardResolved).toBe(true);
    expect(f.calibration.quality).toBeGreaterThanOrEqual(0);
    expect(f.calibration.r).toHaveLength(9);
  });

  it('survives a JSON round trip unchanged and is accepted by buildReplay()', () => {
    for (const s of [harborGood, tougeGood]) {
      const json = JSON.stringify(s.session);
      const back = JSON.parse(json) as Session;
      // NaN/Infinity would come back as null: a stable re-serialisation proves neither happened
      expect(JSON.stringify(back)).toBe(json);
      expect(findNonFinite(back, 'session')).toBeNull();
      expect(back.states.length).toBe(s.session.states.length);
      expect(back.drifts.length).toBe(s.session.drifts.length);
      expect(back.score.grade).toBe(s.session.score.grade);

      const replay = buildReplay(back);
      expect(findNonFinite(replay.trail, 'trail')).toBeNull();
      expect(replay.trail.t.length).toBeGreaterThan(100);
      expect(replay.durationS).toBeGreaterThan(30);
      expect(replay.segments.length).toBe(back.drifts.length);
      expect(replay.info.driftCount).toBe(back.drifts.length);
      // Was `replay.info.grade`. The grade is gone; the point of the line was that a session
      // put through JSON and back describes the same run, so it now checks a fact the replay
      // measures for itself rather than one it copied off the scorer.
      expect(replay.info.trusted).toBe(back.integrity.scoreTrusted);
      expect(replay.info.peakAngle).toBeCloseTo(
        back.drifts.reduce((m, d) => Math.max(m, Math.abs(d.peakAngle)), 0),
        6,
      );
      expect(replay.markers.length).toBeGreaterThan(0);
      expect(Number.isFinite(replay.bounds.minX)).toBe(true);
    }
  });

  it('reset() restores a pristine pipeline: a second run equals a fresh instance', () => {
    const run = harborGood.run;
    const opts: DriftPipelineOptions = { ...BASE, name: 'determinism' };
    const reused = new DriftPipeline(opts);
    drive(reused, run);
    const first = JSON.stringify(reused.finish({ track: 'harbor' }));

    reused.reset();
    expect(reused.frame).toBeNull();
    expect(reused.states).toHaveLength(0);
    expect(reused.drifts).toHaveLength(0);
    expect(reused.track).toBeNull();
    expect(reused.diagnostics.samples).toBe(0);

    drive(reused, run);
    const second = JSON.stringify(reused.finish({ track: 'harbor' }));
    const fresh = new DriftPipeline(opts);
    drive(fresh, run);
    const third = JSON.stringify(fresh.finish({ track: 'harbor' }));

    expect(second).toBe(third);
    expect(first).toBe(third);
  });

  it('surfaces a loose-mount integrity message when the phone is hand-held', () => {
    expect(harborLoose.mountStates.has('loose')).toBe(true);
    expect(harborLoose.pipeline.diagnostics.mount).toBe('loose');
    expect(harborLoose.lastIntegrityMessage).toMatch(/mount|hand-?held/i);
    // ... and a rigidly mounted phone is never called loose
    expect(harborGood.mountStates.has('loose')).toBe(false);
    expect(harborGood.pipeline.diagnostics.integrityMessage.length).toBeGreaterThan(0);
  });

  it('guards NaN, ±Infinity and out-of-order samples at the boundary', () => {
    const run = simulateRun('harbor', { seed: 1, laps: 1, ...GOOD });
    const p = new DriftPipeline({ ...BASE, name: 'guards' });
    const gps = run.gps.slice().sort((a, b) => a.t - b.t);
    let j = 0;
    let bad: string | null = null;
    for (let i = 0; i < run.motion.length; i++) {
      while (j < gps.length && gps[j].t <= run.motion[i].t) p.pushGps(gps[j++]);
      const m = run.motion[i];
      // every 500th sample is corrupted the way a real sensor feed corrupts them
      const poison =
        i % 500 === 100
          ? { ...m, accel: { x: NaN, y: m.accel.y, z: m.accel.z } }
          : i % 500 === 200
            ? { ...m, rotationRate: { x: Infinity, y: m.rotationRate.y, z: m.rotationRate.z } }
            : i % 500 === 300
              ? { ...m, t: NaN }
              : i % 500 === 400
                ? { ...m, t: m.t - 5 }
                : m;
      if (i % 500 === 250) p.pushGps({ ...gps[Math.min(j, gps.length - 1)], speed: NaN, course: NaN, hAcc: NaN });
      if (i % 500 === 350) p.pushGps({ ...gps[Math.min(j, gps.length - 1)], lat: NaN, lon: NaN });
      const f = p.pushMotion(poison);
      if (!bad) bad = findNonFinite(f, `frame[${i}]`);
    }
    const session = p.finish();
    const d = p.diagnostics;
    expect(bad).toBeNull();
    expect(findNonFinite(session, 'session')).toBeNull();
    expect(d.droppedSamples).toBeGreaterThan(5); // the NaN and the backwards timestamps
    expect(d.nanGuards).toBeGreaterThan(5);
    expect(d.droppedGps).toBeGreaterThan(0);
    expect(session.states.length).toBe(d.samples);
    expect(JSON.stringify(JSON.parse(JSON.stringify(session)))).toBe(JSON.stringify(session));
    // and the run is still judged: a few poisoned samples must not cost the session
    expect(session.drifts.length).toBeGreaterThan(1);
  });

  it('survives the degenerate cases an app hits: no samples, a bad first sample, finish() twice', () => {
    const empty = new DriftPipeline({ ...BASE, name: 'empty' });
    expect(empty.frame).toBeNull();
    const s0 = empty.finish();
    expect(s0.states).toHaveLength(0);
    expect(s0.drifts).toHaveLength(0);
    expect(s0.motion).toHaveLength(0);
    expect(s0.track).toBeNull();
    expect(s0.score.grade).toBe('D');
    expect(findNonFinite(s0, 'session')).toBeNull();
    expect(JSON.stringify(JSON.parse(JSON.stringify(s0)))).toBe(JSON.stringify(s0));

    // a first sample the platform mangled: still a usable frame, no state committed
    const p = new DriftPipeline({ ...BASE, name: 'bad-first' });
    const zero = { x: 0, y: 0, z: 0 };
    const f = p.pushMotion({ t: NaN, accel: zero, gravity: { x: 0, y: 0, z: -9.81 }, rotationRate: zero });
    expect(findNonFinite(f, 'frame')).toBeNull();
    expect(f.phase).toBe('idle');
    expect(p.diagnostics.droppedSamples).toBe(1);
    expect(p.states).toHaveLength(0);

    // reading `states` mid-run materialises the history; the sample indices must still line up
    const mid = new DriftPipeline({ ...BASE, name: 'mid-read' });
    const motion = tougeGood.run.motion;
    const fixes = tougeGood.run.gps.slice().sort((a, b) => a.t - b.t);
    let k = 0;
    for (let i = 0; i < motion.length; i++) {
      while (k < fixes.length && fixes[k].t <= motion[i].t) mid.pushGps(fixes[k++]);
      mid.pushMotion(motion[i]);
      if (i === (motion.length >> 1)) {
        expect(mid.states).toHaveLength(i + 1);
        expect(mid.diagnostics.statesMaterialised).toBe(true);
      }
    }
    const midSession = mid.finish();
    expect(midSession.states).toHaveLength(motion.length);
    for (const d of midSession.drifts) {
      expect(midSession.states[d.sampleStart].t).toBeCloseTo(d.startT, 0);
      expect(midSession.states[d.sampleEnd].t).toBeCloseTo(d.endT, 0);
    }
    expect(midSession.score.total).toBe(tougeGood.session.score.total);

    // "calibrate" tapped before the first sample must not freeze the calibration snapshot
    const early = new DriftPipeline({ ...BASE, name: 'calibrate-first' });
    early.markStationary();
    drive(early, tougeGood.run);
    expect((early.frame as LiveFrame).calibration.t).toBeGreaterThan(1);
    expect(early.diagnostics.samples).toBe(tougeGood.metrics.samples);

    // finish() is idempotent: the second call must not duplicate the closing drift
    const twice = new DriftPipeline({ ...BASE, name: 'twice' });
    drive(twice, tougeGood.run);
    const a = twice.finish({ pass: 1 });
    const b = twice.finish({ pass: 1 });
    expect(b.drifts.length).toBe(a.drifts.length);
    expect(b.score.total).toBe(a.score.total);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('prints the end-to-end metrics table', () => {
    const head =
      'scenario        samples drifts truth recall timeRec   points grade  angle  cons  qual speed style laps   peak  driveMs  µs/smp finishMs  live B/s   JSON MB';
    const rows = all.map((s) => {
      const m = s.metrics;
      return (
        m.name.padEnd(15) +
        String(m.samples).padStart(8) +
        String(m.drifts).padStart(7) +
        String(m.truthDrifts).padStart(6) +
        m.recall.toFixed(2).padStart(7) +
        m.timeRecall.toFixed(2).padStart(8) +
        String(m.points).padStart(9) +
        m.grade.padStart(6) +
        m.angle.toFixed(1).padStart(7) +
        m.consistency.toFixed(1).padStart(6) +
        m.quality.toFixed(1).padStart(6) +
        m.speed.toFixed(1).padStart(6) +
        m.style.toFixed(1).padStart(6) +
        String(m.laps).padStart(5) +
        (m.peakDeg.toFixed(1) + '°').padStart(7) +
        m.ms.toFixed(1).padStart(9) +
        m.usPerSample.toFixed(2).padStart(8) +
        m.finishMs.toFixed(1).padStart(9) +
        m.liveBytesPerSample.toFixed(0).padStart(10) +
        m.jsonMB.toFixed(2).padStart(10)
      );
    });
    const d = harborGood.pipeline.diagnostics;
    const table =
      '\nDriftPipeline end-to-end (simulated sensors → pipeline → Session; 100 Hz = 10 000 µs/sample budget)\n' +
      head +
      '\n' +
      rows.join('\n') +
      '\n\nharbor-good diagnostics: ' +
      `calibration q=${d.calibrationQuality.toFixed(2)} forward=${d.calibrationForwardResolved} mount=${d.mount} gps=${d.gps} ` +
      `dropped=${d.droppedSamples} nanGuards=${d.nanGuards} reopenedDrifts=${d.reopenedDrifts} storedMotion=${d.storedMotion}\n` +
      `                         "${d.integrityMessage}"\n` +
      `harbor grade spread:     good ${GOOD_VERDICTS.map((v) => `s${v.seed}:${v.grade}(${v.combined.toFixed(0)})`).join(' ')}` +
      `   sloppy ${SLOPPY_VERDICTS.map((v) => `s${v.seed}:${v.grade}(${v.combined.toFixed(0)})`).join(' ')}\n`;
    process.stdout.write(table);
    expect(rows.length).toBe(all.length);
  });
});

/**
 * The run's verdict is what the monitor saw while the car was being driven, not what it saw
 * when STOP was tapped.
 *
 * The way a run ends is that the car stops and somebody picks the phone up. When the verdict
 * was read at STOP, those last seconds decided it: this harbor run read `rigid` on every sample
 * it was driven for, came out `loose` with its calibration reset to 0 by the knock, and the
 * garage printed "the phone was moving in its mount" over it until the next run replaced it.
 */
describe('the verdict belongs to the drive, not to how it was stopped', () => {
  type Ending = 'at speed' | 'parked' | 'lifted out';

  function stopped(ending: Ending, looseness: number): { session: Session; atStop: string } {
    const run = simulateRun('harbor', { seed: 3, laps: 2, looseness });
    const p = new DriftPipeline({ ...BASE, name: `ending-${ending}` });
    drive(p, run);
    const last = run.motion[run.motion.length - 1];
    const fix = run.gps.reduce((a, b) => (b.t > a.t ? b : a));
    const g0 = last.gravity;
    let t = last.t;
    const still: Omit<MotionSample, 't' | 'gravity'> = { accel: { x: 0, y: 0, z: 0 }, rotationRate: { x: 0, y: 0, z: 0 } };
    if (ending !== 'at speed') {
      // Six seconds parked with the phone still in the cradle, GPS reporting a standstill.
      for (let k = 1; k <= 600; k++) {
        t += 0.01;
        if (k % 100 === 0) p.pushGps({ ...fix, t, speed: 0 });
        p.pushMotion({ t, gravity: g0, ...still });
      }
    }
    if (ending === 'lifted out') {
      // Three seconds of lifting it out of the cradle towards the driver's face, to tap STOP.
      for (let k = 1; k <= 300; k++) {
        t += 0.01;
        const s = k * 0.01;
        const tilt = Math.sin((Math.PI / 2) * Math.min(1, s)) + 0.15 * Math.sin(2 * Math.PI * 1.7 * s);
        const rate = (s < 1 ? (Math.PI / 2) * Math.cos((Math.PI / 2) * s) : 0) + 0.15 * 2 * Math.PI * 1.7 * Math.cos(2 * Math.PI * 1.7 * s);
        const c = Math.cos(tilt);
        const n = Math.sin(tilt);
        if (k % 100 === 0) p.pushGps({ ...fix, t, speed: 0 });
        p.pushMotion({
          t,
          accel: { x: 0.3 * Math.sin(37 * s), y: 0.3 * Math.cos(29 * s), z: 0.3 * Math.sin(23 * s) },
          gravity: { x: g0.x, y: c * g0.y - n * g0.z, z: n * g0.y + c * g0.z },
          rotationRate: { x: rate, y: 0.4 * Math.sin(2 * Math.PI * 2.3 * s), z: 0.3 * Math.cos(2 * Math.PI * 1.1 * s) },
        });
      }
    }
    const atStop = p.integrity.state.mount;
    return { session: p.finish(), atStop };
  }

  it('a rigid mount stays rigid when the phone is lifted out to stop the run', () => {
    const clean = stopped('at speed', 0).session;
    const lifted = stopped('lifted out', 0);
    // The premise: at the instant STOP was tapped, the monitor really was saying `loose`.
    expect(lifted.atStop).toBe('loose');
    expect(clean.integrity.mount).toBe('rigid');
    expect(lifted.session.integrity.mount).toBe('rigid');
    expect(lifted.session.meta.mount).toBe('rigid');
    // ...and the calibration published is the one the drive ran on, not the one the knock reset.
    expect(lifted.session.calibration.forwardResolved).toBe(true);
    expect(lifted.session.calibration.quality).toBeCloseTo(clean.calibration.quality, 2);
    expect(lifted.session.integrity.scoreTrusted).toBe(clean.integrity.scoreTrusted);
  });

  it('a loose mount stays loose when it goes quiet after the car has parked', () => {
    const parked = stopped('parked', 1);
    // At STOP the phone had been sitting still for six seconds and the monitor had relaxed.
    expect(parked.atStop).not.toBe('loose');
    expect(parked.session.integrity.mount).toBe('loose');
    expect(parked.session.meta.mount).toBe('loose');
    expect(stopped('lifted out', 1).session.integrity.mount).toBe('loose');
  });
});
