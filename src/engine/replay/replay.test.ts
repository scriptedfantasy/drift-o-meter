import { beforeAll, describe, expect, it } from 'vitest';
import { simulateRun, type SimulatedRun } from '../../sim';
import { degToRad, radToDeg, wrapAngle, type Session, type SlipState } from '../types';
import {
  activeEvents,
  buildReplay,
  CAMERA_LIMITS,
  formatPoints,
  ghostPoseAt,
  lapAt,
  liveSmoke,
  poseAt,
  ReplayCamera,
  screenToWorld,
  scrubTelemetry,
  SEVERITY_EDGES,
  severityOf,
  shakeAt,
  smokeAt,
  worldToScreen,
  type CameraMode,
  type Replay,
} from './index';
import { sessionFromSimulation } from './fixtures';

let run: SimulatedRun;
let session: Session;
let replay: Replay;

beforeAll(() => {
  run = simulateRun('harbor', { seed: 1, laps: 2 });
  session = sessionFromSimulation(run);
  replay = buildReplay(session);
});

/** A synthetic session of `n` 100 Hz samples driving straight at 20 m/s. */
function line(n: number, f: (i: number) => Partial<SlipState>): SlipState[] {
  const out: SlipState[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / 100;
    out.push({ t, beta: 0, betaSigma: 0.02, heading: 0, course: 0, speed: 20, yawRate: 0, ay: 0, ax: 0, x: 20 * t, y: 0, valid: true, ...f(i) });
  }
  return out;
}

function synthetic(states: SlipState[], extra: Partial<Session> = {}): Session {
  return {
    version: 1,
    id: 'x',
    name: 'probe',
    startedAt: 0,
    durationS: states.length / 100,
    motion: [],
    gps: [],
    states,
    drifts: [],
    score: null as never,
    track: null,
    calibration: { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], quality: 1, forwardResolved: true, t: 0 },
    meta: {},
    ...extra,
  } as Session;
}

describe('fixture', () => {
  it('fills a session from simulator truth', () => {
    expect(session.states.length).toBe(run.truth.length);
    expect(session.drifts.length).toBeGreaterThanOrEqual(4);
    expect(session.score.total).toBeGreaterThan(1000);
    expect(session.track?.closed).toBe(true);
    expect(session.track?.laps.length).toBe(2);
    for (const d of session.drifts) {
      expect(d.endT).toBeGreaterThan(d.startT);
      expect(session.score.perDrift[d.id].total).toBeGreaterThan(0);
    }
  });

  it('a drift is a drift, not a whole lap: every segment is 0.6–12 s', () => {
    // FINDING 9: a 28 s "drift" shaded 70 % of the telemetry strip end to end.
    for (const seg of replay.segments) {
      expect(seg.durationS).toBeGreaterThanOrEqual(0.6);
      expect(seg.durationS).toBeLessThanOrEqual(12);
    }
    const longest = Math.max(...replay.segments.map((s) => s.durationS));
    expect(longest).toBeLessThan(12);
    expect(replay.segments.length).toBeGreaterThanOrEqual(8);
  });
});

describe('buildReplay', () => {
  it('bounds contain every trail point (with padding)', () => {
    const { bounds, trail } = replay;
    for (let i = 0; i < trail.n; i++) {
      expect(trail.x[i]).toBeGreaterThan(bounds.minX);
      expect(trail.x[i]).toBeLessThan(bounds.maxX);
      expect(trail.y[i]).toBeGreaterThan(bounds.minY);
      expect(trail.y[i]).toBeLessThan(bounds.maxY);
    }
    expect(bounds.maxX - bounds.minX).toBeGreaterThan(200);
  });

  it('trail length matches duration × 20 Hz ± 1 and times are uniform', () => {
    expect(Math.abs(replay.trail.n - replay.durationS * 20)).toBeLessThanOrEqual(1.5);
    expect(replay.trail.t[0]).toBe(0);
    expect(replay.trail.t[replay.trail.n - 1]).toBeCloseTo(replay.durationS, 1);
    expect(replay.telemetry.n).toBe(Math.round(replay.durationS * 10) + 1);
  });

  it('trims dead air: the replay opens and closes on a moving car', () => {
    expect(poseAt(replay, 0).speed).toBeLessThan(3);
    expect(poseAt(replay, 4).speed).toBeGreaterThan(8);
    // the simulator idles 3 s before the run; the replay must not show all of it
    expect(replay.t0).toBeGreaterThan(1);
    expect(replay.durationS).toBeLessThan(run.truth[run.truth.length - 1].t - 1);
  });

  it('segments cover ≥ 95 % of truth drifting samples and nothing else', () => {
    let drifting = 0;
    let covered = 0;
    let idleMarked = 0;
    let idle = 0;
    for (const tr of run.truth) {
      const t = tr.t - replay.t0;
      if (t < 0 || t > replay.durationS) continue;
      const p = poseAt(replay, t);
      // the fixture splits a linked sequence at |β| valleys, so the settle between two corners
      // is legitimately NOT part of either drift
      const settled = Math.abs(tr.beta) < degToRad(10);
      if (tr.drifting && !settled) {
        drifting++;
        if (p.phase === 'drifting') covered++;
      } else if (!tr.drifting) {
        idle++;
        if (p.phase === 'drifting') idleMarked++;
      }
    }
    expect(covered / drifting).toBeGreaterThanOrEqual(0.95);
    expect(idleMarked / idle).toBeLessThan(0.05);
    for (const seg of replay.segments) {
      expect(seg.intensity.length).toBe(seg.endIndex - seg.startIndex + 1);
      for (let i = 0; i < seg.intensity.length; i++) {
        const b = Math.abs(replay.trail.beta[seg.startIndex + i]);
        const expected = Math.min(1, Math.max(0, (b - degToRad(8)) / (degToRad(60) - degToRad(8))));
        expect(seg.intensity[i]).toBeCloseTo(expected, 3);
      }
      expect(seg.points).toBe(session.score.perDrift[seg.driftId].total);
    }
  });

  it('escalates past the simulator ceiling: intensity and severity are absolute', () => {
    // FINDING 4: intensityHi was 45°, exactly the sim's peak, so 70° looked like 45°.
    expect(radToDeg(replay.options.intensityHi)).toBeGreaterThanOrEqual(55);
    expect(radToDeg(replay.info.peakAngle)).toBeLessThan(radToDeg(replay.options.intensityHi));
    expect(severityOf(degToRad(5))).toBe('none');
    expect(severityOf(degToRad(15))).toBe('hold');
    expect(severityOf(degToRad(30))).toBe('big');
    expect(severityOf(degToRad(50))).toBe('extreme');
    expect(severityOf(degToRad(70))).toBe('spin');
    expect(severityOf(degToRad(-70))).toBe('spin');
    // and the intensity of a 70° slide really is higher than a 45° one
    const i45 = (degToRad(45) - replay.options.intensityLo) / (replay.options.intensityHi - replay.options.intensityLo);
    const i70 = Math.min(1, (degToRad(70) - replay.options.intensityLo) / (replay.options.intensityHi - replay.options.intensityLo));
    expect(i70).toBeGreaterThan(i45 + 0.1);
  });

  it('cumulative score ends at the session total and never decreases', () => {
    const sc = replay.trail.score;
    for (let i = 1; i < sc.length; i++) expect(sc[i]).toBeGreaterThanOrEqual(sc[i - 1] - 1e-6);
    expect(sc[sc.length - 1]).toBeCloseTo(session.score.total, 3);
    for (let i = 0; i < replay.trail.n; i++) {
      expect(replay.trail.multiplier[i]).toBeGreaterThanOrEqual(1);
      expect(replay.trail.chain[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('smoke: sane count, behind the car, opposing travel, with seed and heat', () => {
    const { smoke, trail } = replay;
    let over15 = 0;
    for (let i = 0; i < trail.n; i++) if (Math.abs(trail.beta[i]) > degToRad(15)) over15++;
    const maxExpected = over15 / trail.hz / 0.15;
    expect(smoke.length).toBeGreaterThan(maxExpected * 0.25);
    expect(smoke.length).toBeLessThan(maxExpected);
    for (let i = 1; i < smoke.length; i++) expect(smoke[i].birthT).toBeGreaterThanOrEqual(smoke[i - 1].birthT);
    for (const p of smoke) {
      const pose = poseAt(replay, p.birthT);
      expect(Math.abs(pose.beta)).toBeGreaterThan(degToRad(15) - 0.01);
      const along = (p.x - pose.x) * Math.cos(pose.heading) + (p.y - pose.y) * Math.sin(pose.heading);
      expect(along).toBeCloseTo(-2.2, 1);
      const lateral = -(p.x - pose.x) * Math.sin(pose.heading) + (p.y - pose.y) * Math.cos(pose.heading);
      expect(Math.abs(lateral)).toBeCloseTo(0.9, 1);
      // the puff always leaves the tyre backwards along the direction of travel
      const dot = p.vx * Math.cos(pose.course) + p.vy * Math.sin(pose.course);
      expect(dot).toBeLessThan(0);
      expect(p.seed).toBeGreaterThanOrEqual(0);
      expect(p.seed).toBeLessThanOrEqual(1);
      expect(p.heat).toBeGreaterThan(0);
      const st = smokeAt(p, p.birthT + 0.5)!;
      expect(st).not.toBeNull();
      expect(st.radius).toBeGreaterThan(p.size);
      expect(st.heat).toBeLessThan(p.heat);
      expect(smokeAt(p, p.birthT + p.life + 0.01)).toBeNull();
    }
    // spread: puffs must not sit in a tube on the racing line
    const spread = smoke.map((p) => Math.hypot(p.vx, p.vy));
    expect(Math.max(...spread)).toBeGreaterThan(2.5);
    const alive = liveSmoke(smoke, smoke[10].birthT + 0.5);
    expect(alive.length).toBeGreaterThan(0);
  });

  it('markers and events carry a lap index so a renderer can retire old laps', () => {
    // FINDING 3: lap-1 markers were still drawn on lap 2, twice, with colliding labels.
    const lapped = replay.markers.filter((m) => m.lapIndex >= 0);
    expect(lapped.length).toBeGreaterThan(replay.markers.length * 0.8);
    for (const lap of replay.laps) {
      const mine = replay.markers.filter((m) => m.lapIndex === lap.index);
      expect(mine.length).toBeGreaterThan(3);
      for (const m of mine) {
        if (m.kind === 'lap') continue;
        expect(m.t).toBeGreaterThanOrEqual(lap.startT - 1e-6);
        expect(m.t).toBeLessThanOrEqual(lap.endT + 1e-6);
      }
    }
    // no two markers of the same kind on the SAME lap collide in world space
    for (const kind of ['transition', 'drift-peak'] as const) {
      for (const lap of replay.laps) {
        const ms = replay.markers.filter((m) => m.kind === kind && m.lapIndex === lap.index);
        for (let i = 0; i < ms.length; i++) {
          for (let j = i + 1; j < ms.length; j++) {
            expect(Math.hypot(ms[i].x - ms[j].x, ms[i].y - ms[j].y)).toBeGreaterThan(8);
          }
        }
      }
    }
    for (const m of replay.markers) expect(m.priority).toBeGreaterThan(0);
  });

  it('events drive the motion language: slam 1.8 → 1.0, shake decays, priority wins', () => {
    expect(replay.events.length).toBeGreaterThan(10);
    const peak = replay.events.find((e) => e.kind === 'exit')!;
    expect(peak).toBeDefined();
    const at0 = activeEvents(replay, peak.t)[0];
    expect(at0.scale).toBeCloseTo(1.8, 1);
    const at32 = activeEvents(replay, peak.t + 0.32).find((e) => e.kind === peak.kind && e.t === peak.t)!;
    expect(at32.scale).toBeCloseTo(1.0, 1);
    expect(at0.opacity).toBe(1);
    const late = activeEvents(replay, peak.t + peak.holdS + 0.5).find((e) => e.t === peak.t);
    expect(late).toBeUndefined();
    // shake is bounded and short
    let maxShake = 0;
    for (let t = 0; t < replay.durationS; t += 0.05) maxShake = Math.max(maxShake, shakeAt(replay, t));
    expect(maxShake).toBeGreaterThan(0.2);
    expect(maxShake).toBeLessThanOrEqual(1);
    expect(shakeAt(replay, peak.t + 0.3)).toBe(0);
    // every active event is sorted by priority
    const evs = activeEvents(replay, replay.events[3].t + 0.05, 8);
    for (let i = 1; i < evs.length; i++) expect(evs[i].priority).toBeLessThanOrEqual(evs[i - 1].priority);
  });

  it('highlights rank the run and stay inside it', () => {
    expect(replay.highlights.length).toBe(replay.segments.length);
    for (const h of replay.highlights) {
      expect(h.inT).toBeGreaterThanOrEqual(0);
      expect(h.outT).toBeLessThanOrEqual(replay.durationS + 1e-6);
      expect(h.t).toBeGreaterThanOrEqual(h.inT);
      expect(h.t).toBeLessThanOrEqual(h.outT);
    }
    expect(replay.highlights[0].points).toBeGreaterThanOrEqual(replay.highlights[replay.highlights.length - 1].points - 1);
  });

  it('works without a track model and from truth only', () => {
    const noTrack = buildReplay({ ...session, track: null });
    expect(noTrack.ghost).toBeNull();
    expect(noTrack.laps.length).toBe(0);
    const truthOnly = buildReplay({ ...session, states: [] });
    expect(truthOnly.trail.n).toBe(replay.trail.n);
    expect(poseAt(truthOnly, 30).x).toBeCloseTo(poseAt(replay, 30).x, 6);
    const empty = buildReplay({ ...session, states: [], truth: undefined, drifts: [] });
    expect(empty.trail.n).toBeGreaterThan(0);
    expect(empty.warnings.length).toBeGreaterThan(0);
    expect(() => poseAt(empty, 0)).not.toThrow();
  });
});

describe('robustness (bad data must not destroy the replay)', () => {
  it('one NaN speed sample does not poison the trail, dist or the camera', () => {
    // FINDING 2: one NaN at t=10 left 1203 of ~1800 camera frames non-finite, forever.
    const s = synthetic(line(3000, (i) => (i === 1000 ? { speed: NaN } : {})));
    const r = buildReplay(s);
    for (let k = 0; k < r.trail.n; k++) {
      expect(Number.isFinite(r.trail.speed[k])).toBe(true);
      expect(Number.isFinite(r.trail.dist[k])).toBe(true);
      expect(Number.isFinite(r.trail.x[k])).toBe(true);
    }
    expect(r.warnings.length).toBeGreaterThan(0);
    for (const mode of ['chase', 'cinematic', 'overview'] as CameraMode[]) {
      const cam = new ReplayCamera(mode, { w: 390, h: 844 });
      let bad = 0;
      cam.update(r, 0, 1 / 60);
      for (let t = 1 / 60; t <= r.durationS; t += 1 / 60) {
        const st = cam.update(r, t, 1 / 60);
        if (![st.cx, st.cy, st.zoom, st.rotation].every(Number.isFinite)) bad++;
      }
      expect(bad).toBe(0);
    }
  });

  it('NaN β emits no smoke and leaves every array finite', () => {
    const s = synthetic(line(600, (i) => (i > 200 ? { beta: NaN } : {})));
    const r = buildReplay(s);
    expect(r.smoke.length).toBe(0);
    for (let k = 0; k < r.trail.n; k++) {
      expect(Number.isFinite(r.trail.beta[k])).toBe(true);
      expect(Number.isFinite(r.trail.intensity[k])).toBe(true);
    }
    // a NaN β must never slip through the smoke guards into a particle at NaN coordinates
    const s2 = synthetic(line(900, (i) => ({ beta: i > 300 && i < 600 ? NaN : degToRad(30) })));
    const r2 = buildReplay(s2);
    for (const p of r2.smoke) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.vx)).toBe(true);
    }
  });

  it('NaN positions and an all-NaN run degrade gracefully with warnings', () => {
    const r = buildReplay(synthetic(line(3000, (i) => (i > 1000 && i < 1500 ? { x: NaN, y: NaN } : {}))));
    for (let k = 0; k < r.trail.n; k++) expect(Number.isFinite(r.trail.x[k])).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/position/);
    const all = buildReplay(synthetic(line(600, () => ({ x: NaN, y: NaN }))));
    expect(all.warnings.join(' ')).toMatch(/SIGNAL LOST/);
  });

  it('one out-of-order timestamp does not collapse the replay', () => {
    // FINDING 16: a 6 s session became durationS 0.05 with no warning.
    const st = line(600, () => ({}));
    st[300] = { ...st[300], t: 0.5 };
    const r = buildReplay(synthetic(st));
    expect(r.durationS).toBeGreaterThan(4);
    expect(r.trail.n).toBeGreaterThan(80);
    expect(r.warnings.join(' ')).toMatch(/out-of-order/);
  });

  it('β interpolates on the shortest arc across ±π', () => {
    // FINDING 12: 178° → −178° read as 178, 0, −178: a phantom 0° that killed the glow,
    // suppressed smoke and planted a TRANSITION marker in the middle of a spin.
    const states: SlipState[] = [
      { t: 0, beta: degToRad(178), betaSigma: 0, heading: 0, course: degToRad(178), speed: 20, yawRate: 0, ay: 0, ax: 0, x: 0, y: 0, valid: true },
      { t: 0.1, beta: degToRad(-178), betaSigma: 0, heading: 0, course: degToRad(-178), speed: 20, yawRate: 0, ay: 0, ax: 0, x: 2, y: 0, valid: true },
      { t: 0.2, beta: degToRad(-175), betaSigma: 0, heading: 0, course: degToRad(-175), speed: 20, yawRate: 0, ay: 0, ax: 0, x: 4, y: 0, valid: true },
    ];
    const r = buildReplay(synthetic(states));
    for (let k = 0; k < r.trail.n; k++) expect(Math.abs(radToDeg(r.trail.beta[k]))).toBeGreaterThan(170);
    for (let t = 0; t <= r.durationS; t += 0.005) expect(Math.abs(radToDeg(poseAt(r, t).beta))).toBeGreaterThan(170);
  });
});

describe('poseAt', () => {
  it('interpolates continuously, including across heading wraps', () => {
    const truth = run.truth;
    const rawMax = (f: (i: number) => number, wrap: boolean) => {
      let m = 0;
      for (let i = 0, j = 0; i < truth.length; i++) {
        while (j < truth.length - 1 && truth[j + 1].t - truth[i].t <= 0.07) j++;
        const d = wrap ? Math.abs(wrapAngle(f(j) - f(i))) : Math.abs(f(j) - f(i));
        if (d > m) m = d;
      }
      return m;
    };
    const boundHeading = rawMax((i) => truth[i].heading, true) / 6 + 1e-6;
    const boundCourse = rawMax((i) => truth[i].course, true) / 6 + 1e-6;
    const boundSpeed = rawMax((i) => truth[i].speed, false) / 6 + 1e-6;
    const boundPos = rawMax((i) => truth[i].x, false) / 6 + rawMax((i) => truth[i].y, false) / 6 + 1e-6;
    const dt = 1 / 120;
    let prev = poseAt(replay, 0);
    let wraps = 0;
    for (let t = dt; t <= replay.durationS; t += dt) {
      const p = poseAt(replay, t);
      expect(Math.abs(wrapAngle(p.heading - prev.heading))).toBeLessThanOrEqual(boundHeading);
      expect(Math.abs(wrapAngle(p.course - prev.course))).toBeLessThanOrEqual(boundCourse);
      expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeLessThanOrEqual(boundPos);
      expect(Math.abs(p.speed - prev.speed)).toBeLessThanOrEqual(boundSpeed);
      expect(Math.abs(wrapAngle(p.beta - prev.beta))).toBeLessThan(0.1);
      if (Math.sign(p.heading) !== Math.sign(prev.heading) && Math.abs(p.heading) > 3) wraps++;
      prev = p;
    }
    expect(wraps).toBeGreaterThan(0);
    expect(poseAt(replay, -5).t).toBe(0);
    expect(poseAt(replay, 1e9).t).toBe(replay.durationS);
    expect(poseAt(replay, NaN).t).toBe(0);
    const mid = poseAt(replay, replay.segments[1].peakT);
    expect(mid.phase).toBe('drifting');
    expect(mid.severity).not.toBe('none');
  });

  it('scrubTelemetry returns the nearest 10 Hz sample', () => {
    const s = scrubTelemetry(replay, 30.04);
    expect(s.index).toBe(300);
    expect(s.t).toBeCloseTo(30, 6);
    expect(s.speed).toBeCloseTo(poseAt(replay, 30).speed, 2);
    expect(scrubTelemetry(replay, -1).index).toBe(0);
    expect(scrubTelemetry(replay, 1e6).index).toBe(replay.telemetry.n - 1);
  });

  it('formatPoints never leaves a wide gap in a score', () => {
    // FINDING 8: "13 672" had a 35 px thousands gap (74 % of a digit width) and parsed as two
    // numbers at arm's length. One rule, in the engine, so both renderers agree.
    expect(formatPoints(7273)).toBe('7273');
    expect(formatPoints(99999)).toBe('99999');
    expect(formatPoints(123456)).toBe('123,456');
    expect(formatPoints(-15)).toBe('-15');
    expect(formatPoints(NaN)).toBe('0');
    for (const v of [0, 1, 850, 7273, 16140, 99999]) expect(formatPoints(v)).not.toMatch(/[\s\u2009\u200a,]/);
  });
});

describe('ghost', () => {
  it('is NEVER the car being watched', () => {
    // FINDING 1: the ghost was the same lap for 47 % of the replay — a cyan outline sitting
    // exactly on the white car, which reads as a rendering glitch.
    expect(replay.ghost).not.toBeNull();
    expect(replay.laps.length).toBe(2);
    for (const lap of replay.laps) {
      expect(lap.ghostRef).toBeGreaterThanOrEqual(0);
      expect(lap.ghostRef).not.toBe(lap.index);
    }
    let samples = 0;
    let identical = 0;
    let minSep = Infinity;
    for (let t = 0; t <= replay.durationS; t += 0.25) {
      const g = ghostPoseAt(replay, t);
      if (!g) continue;
      const p = poseAt(replay, t);
      const d = Math.hypot(g.x - p.x, g.y - p.y);
      samples++;
      if (d < 0.5) identical++;
      minSep = Math.min(minSep, d);
      expect(g.lapIndex).not.toBe(p.lap);
    }
    expect(samples).toBeGreaterThan(300);
    expect(identical).toBe(0);
    expect(minSep).toBeGreaterThan(1);
  });

  it('reports a true, stable time gap and a points gap', () => {
    // the rendered gap used to be gapM / instantaneous speed: ±15 % flicker on a constant gap.
    const lap = replay.laps[1];
    const gaps: number[] = [];
    for (let t = lap.startT + 5; t < lap.endT - 5; t += 0.5) {
      const g = ghostPoseAt(replay, t)!;
      expect(Number.isFinite(g.gapS)).toBe(true);
      expect(Number.isFinite(g.gapPoints)).toBe(true);
      gaps.push(g.gapS);
    }
    expect(gaps.length).toBeGreaterThan(50);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // the two laps differ by a near-constant offset; the reported gap must not swing with speed
    const spread = Math.max(...gaps) - Math.min(...gaps);
    expect(Math.abs(mean)).toBeGreaterThan(0.5);
    expect(spread).toBeLessThan(1.5);
    // sign convention: positive = the car is ahead of the ghost
    const fast = replay.laps.find((l) => l.fastest)!;
    const slowLap = replay.laps.find((l) => !l.fastest)!;
    const gFast = ghostPoseAt(replay, fast.startT + fast.durationS * 0.5)!;
    const gSlow = ghostPoseAt(replay, slowLap.startT + slowLap.durationS * 0.5)!;
    // positive = the car reached this point of the lap sooner than the reference lap did
    expect(gFast.gapS).toBeGreaterThan(0);
    expect(gSlow.gapS).toBeLessThan(0);
  });

  it('the reference is the best-points lap, and the ghost pose matches that lap', () => {
    const best = replay.laps.find((l) => l.best)!;
    expect(replay.ghost!.lapIndex).toBe(best.index);
    expect(replay.ghost!.criterion).toBe('points');
    for (const lap of replay.laps) expect(lap.points).toBeLessThanOrEqual(best.points + 1e-6);
    // watching a non-best lap: the ghost is the best lap at the same lap-relative time
    const other = replay.laps.find((l) => !l.best)!;
    const tau = 20;
    const g = ghostPoseAt(replay, other.startT + tau)!;
    const ref = poseAt(replay, best.startT + tau);
    expect(g.lapIndex).toBe(best.index);
    expect(g.x).toBeCloseTo(ref.x, 3);
    expect(g.y).toBeCloseTo(ref.y, 3);
    expect(ghostPoseAt(replay, 0.2)).toBeNull();
    expect(lapAt(replay, -1)).toBeNull();
  });
});

describe('camera', () => {
  const vp = { w: 390, h: 844 };
  const dt = 1 / 60;

  it.each(['overview', 'chase', 'cinematic'] as CameraMode[])('%s: per-frame deltas bounded at 60 fps across the whole run', (mode) => {
    const cam = new ReplayCamera(mode, vp);
    let prev = cam.update(replay, 0, dt);
    expect(prev.cut).toBe(false); // the opening frame is not a cut: it must not flash
    let maxPan = 0;
    let maxRot = 0;
    let maxZoom = 0;
    let n = 0;
    for (let t = dt; t <= replay.durationS; t += dt) {
      const s = cam.update(replay, t, dt);
      expect(s.cut).toBe(false);
      maxPan = Math.max(maxPan, Math.hypot(s.cx - prev.cx, s.cy - prev.cy));
      maxRot = Math.max(maxRot, Math.abs(wrapAngle(s.rotation - prev.rotation)));
      maxZoom = Math.max(maxZoom, Math.abs(Math.log(s.zoom / prev.zoom)));
      expect([s.cx, s.cy, s.zoom, s.rotation].every(Number.isFinite)).toBe(true);
      prev = s;
      n++;
    }
    expect(n).toBeGreaterThan(5000);
    expect(maxPan).toBeLessThanOrEqual(CAMERA_LIMITS.maxPan * dt + 1e-9);
    expect(maxRot).toBeLessThanOrEqual(CAMERA_LIMITS.maxRotation * dt + 1e-9);
    expect(maxZoom).toBeLessThanOrEqual(CAMERA_LIMITS.maxZoomLog * dt + 1e-9);
    if (mode === 'overview') {
      expect(maxPan).toBe(0);
      expect(maxRot).toBe(0);
    } else {
      expect(maxPan).toBeLessThan(0.9);
      expect(maxRot).toBeLessThan(0.045);
    }
  });

  it('overview fits the bounds with padding and no rotation', () => {
    const cam = new ReplayCamera('overview', vp);
    const s = cam.update(replay, 10, dt);
    expect(s.rotation).toBe(0);
    const b = replay.bounds;
    for (const c of [worldToScreen(s, b.minX, b.minY), worldToScreen(s, b.maxX, b.maxY), worldToScreen(s, b.minX, b.maxY), worldToScreen(s, b.maxX, b.minY)]) {
      expect(c.x).toBeGreaterThanOrEqual(-1e-6);
      expect(c.x).toBeLessThanOrEqual(vp.w + 1e-6);
      expect(c.y).toBeGreaterThanOrEqual(-1e-6);
      expect(c.y).toBeLessThanOrEqual(vp.h + 1e-6);
    }
  });

  it('chase framing: speed-adaptive span, travel direction up, look-ahead bounded', () => {
    // FINDING 5: a fixed 60 m span made the 9 m road 15 % of frame width at every speed.
    const cam = new ReplayCamera('chase', vp);
    let minSpan = Infinity;
    let maxSpan = 0;
    let slowSpan = 0;
    let fastSpan = 0;
    let slowV = Infinity;
    let fastV = 0;
    let s = cam.update(replay, 0, dt);
    for (let t = dt; t <= replay.durationS; t += dt) {
      s = cam.update(replay, t, dt);
      const span = Math.min(vp.w, vp.h) / s.zoom;
      minSpan = Math.min(minSpan, span);
      maxSpan = Math.max(maxSpan, span);
      const v = poseAt(replay, t).speed;
      if (v < slowV && v > 2) {
        slowV = v;
        slowSpan = span;
      }
      if (v > fastV) {
        fastV = v;
        fastSpan = span;
      }
    }
    expect(minSpan).toBeGreaterThan(15);
    expect(maxSpan).toBeLessThan(60);
    expect(fastSpan).toBeGreaterThan(slowSpan + 8); // it really does adapt
    // travel direction up, car below centre, look-ahead ahead of the car
    const courseRate = (t: number) => wrapAngle(poseAt(replay, t + 0.1).course - poseAt(replay, t - 0.1).course) / 0.2;
    let tStraight = -1;
    for (let t = 5; t < replay.durationS - 5 && tStraight < 0; t += 0.1) {
      let ok = poseAt(replay, t).speed > 12;
      for (let u = t - 0.8; ok && u <= t; u += 0.1) ok = Math.abs(courseRate(u)) < 0.05;
      if (ok) tStraight = t;
    }
    expect(tStraight).toBeGreaterThan(0);
    const cam2 = new ReplayCamera('chase', vp);
    let s2 = cam2.update(replay, 0, dt);
    for (let t = dt; t <= tStraight; t += dt) s2 = cam2.update(replay, t, dt);
    const p = poseAt(replay, tStraight);
    const sp = worldToScreen(s2, p.x, p.y);
    expect(sp.x).toBeGreaterThan(vp.w * 0.25);
    expect(sp.x).toBeLessThan(vp.w * 0.75);
    expect(sp.y).toBeGreaterThan(vp.h / 2 - 5);
    const ahead = worldToScreen(s2, p.x + 10 * Math.cos(p.course), p.y + 10 * Math.sin(p.course));
    expect(ahead.y).toBeLessThan(sp.y);
    expect(Math.abs(wrapAngle(s2.rotation - (Math.PI / 2 - p.course)))).toBeLessThan(0.06);
  });

  it('cinematic zooms in during drifts without overshoot', () => {
    const cam = new ReplayCamera('cinematic', vp);
    const chase = new ReplayCamera('chase', vp);
    let zoomStraight = Infinity;
    let zoomDrift = 0;
    let ratioMax = 0;
    cam.update(replay, 0, dt);
    chase.update(replay, 0, dt);
    for (let t = dt; t <= replay.durationS; t += dt) {
      const s = cam.update(replay, t, dt);
      const c = chase.update(replay, t, dt);
      const p = poseAt(replay, t);
      ratioMax = Math.max(ratioMax, s.zoom / c.zoom);
      if (p.phase === 'idle' && p.speed > 10) zoomStraight = Math.min(zoomStraight, s.zoom / c.zoom);
      if (p.intensity > 0.75) zoomDrift = Math.max(zoomDrift, s.zoom / c.zoom);
    }
    expect(zoomStraight).toBeLessThan(0.95);
    expect(zoomDrift).toBeGreaterThan(1.15);
    expect(ratioMax).toBeLessThanOrEqual(1.62);
  });

  it('a mode switch is a CUT: one flagged frame, then bounded again', () => {
    // FINDING 11: the smoothed switch took 3.08 s saturating both hard limits — 170°/s of
    // world rotation on a phone. A camera change is a cut with a 120 ms cross-fade instead.
    const cam = new ReplayCamera('overview', vp);
    let prev = cam.update(replay, 30, dt);
    for (let t = 30 + dt; t <= 35; t += dt) prev = cam.update(replay, t, dt);
    cam.setMode('chase');
    const cut = cam.update(replay, 35 + dt, dt);
    expect(cut.cut).toBe(true);
    expect(cut.cutFade).toBe(1);
    const chaseRef = new ReplayCamera('chase', vp).update(replay, 35 + dt, dt);
    expect(cut.zoom).toBeCloseTo(chaseRef.zoom, 6); // arrives immediately, no 3 s ramp
    expect(Math.abs(wrapAngle(cut.rotation - chaseRef.rotation))).toBeLessThan(1e-9);
    let p2 = cut;
    let fadeGone = false;
    for (let t = 35 + 2 * dt; t <= 37; t += dt) {
      const s = cam.update(replay, t, dt);
      expect(s.cut).toBe(false);
      expect(Math.hypot(s.cx - p2.cx, s.cy - p2.cy)).toBeLessThanOrEqual(CAMERA_LIMITS.maxPan * dt + 1e-9);
      expect(Math.abs(wrapAngle(s.rotation - p2.rotation))).toBeLessThanOrEqual(CAMERA_LIMITS.maxRotation * dt + 1e-9);
      if (t > 35 + CAMERA_LIMITS.cutFadeS + 2 * dt) {
        expect(s.cutFade).toBe(0);
        fadeGone = true;
      }
      p2 = s;
    }
    expect(fadeGone).toBe(true);
    // a smooth switch is still available and still obeys the limits
    const smooth = new ReplayCamera('overview', vp);
    let q = smooth.update(replay, 30, dt);
    smooth.setMode('chase', { smooth: true });
    for (let t = 30 + dt; t <= 34; t += dt) {
      const s = smooth.update(replay, t, dt);
      expect(s.cut).toBe(false);
      expect(Math.abs(wrapAngle(s.rotation - q.rotation))).toBeLessThanOrEqual(CAMERA_LIMITS.maxRotation * dt + 1e-9);
      q = s;
    }
  });

  it('worldToScreen / screenToWorld round trip', () => {
    const cam = { cx: 120.5, cy: -33.2, zoom: 6.5, rotation: 2.1, w: 390, h: 844, cut: false, cutFade: 0 };
    for (const [x, y] of [
      [0, 0],
      [120.5, -33.2],
      [300, 400],
      [-50, 12.25],
    ]) {
      const s = worldToScreen(cam, x, y);
      const w = screenToWorld(cam, s.x, s.y);
      expect(w.x).toBeCloseTo(x, 9);
      expect(w.y).toBeCloseTo(y, 9);
    }
    const c = worldToScreen(cam, cam.cx, cam.cy);
    expect(c.x).toBeCloseTo(195, 9);
    expect(c.y).toBeCloseTo(422, 9);
    const up = worldToScreen({ ...cam, rotation: 0 }, cam.cx, cam.cy + 10);
    expect(up.y).toBeCloseTo(422 - 65, 9);
  });
});
