import { beforeAll, describe, expect, it } from 'vitest';
import { simulateRun, type SimulatedRun } from '../../sim';
import { degToRad, wrapAngle, type Session } from '../types';
import {
  buildReplay,
  CAMERA_LIMITS,
  ghostPoseAt,
  lapAt,
  liveSmoke,
  poseAt,
  ReplayCamera,
  screenToWorld,
  scrubTelemetry,
  sessionFromSimulation,
  smokeAt,
  worldToScreen,
  type CameraMode,
  type Replay,
} from './index';

let run: SimulatedRun;
let session: Session;
let replay: Replay;

beforeAll(() => {
  run = simulateRun('harbor', { seed: 1, laps: 2 });
  session = sessionFromSimulation(run);
  replay = buildReplay(session);
});

describe('fixture', () => {
  it('fills a session from simulator truth', () => {
    expect(session.states.length).toBe(run.truth.length);
    expect(session.drifts.length).toBeGreaterThanOrEqual(4);
    expect(session.score.total).toBeGreaterThan(1000);
    expect(session.track?.closed).toBe(true);
    expect(session.track?.laps.length).toBe(2);
    for (const d of session.drifts) {
      expect(d.endT).toBeGreaterThan(d.startT);
      expect(d.peakAngle).toBeGreaterThan(degToRad(8));
      expect(session.score.perDrift[d.id].total).toBeGreaterThan(0);
    }
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

  it('trail matches truth at sample times', () => {
    const t0 = replay.t0;
    for (const k of [400, 900, 1500, 2200]) {
      const tr = run.truth[k];
      const p = poseAt(replay, tr.t - t0);
      expect(p.x).toBeCloseTo(tr.x, 0);
      expect(p.y).toBeCloseTo(tr.y, 0);
      expect(Math.abs(wrapAngle(p.heading - tr.heading))).toBeLessThan(0.02);
      expect(p.beta).toBeCloseTo(tr.beta, 1);
      expect(p.speed).toBeCloseTo(tr.speed, 0);
    }
  });

  it('segments cover ≥ 95 % of truth drifting samples and nothing else', () => {
    let drifting = 0;
    let covered = 0;
    let idleMarked = 0;
    let idle = 0;
    for (const tr of run.truth) {
      const p = poseAt(replay, tr.t - replay.t0);
      if (tr.drifting) {
        drifting++;
        if (p.phase === 'drifting') covered++;
      } else {
        idle++;
        if (p.phase === 'drifting') idleMarked++;
      }
    }
    expect(covered / drifting).toBeGreaterThanOrEqual(0.95);
    expect(idleMarked / idle).toBeLessThan(0.03);
    // intensity mapping: 8° → 0, 45° → 1
    for (const seg of replay.segments) {
      expect(seg.intensity.length).toBe(seg.endIndex - seg.startIndex + 1);
      for (let i = 0; i < seg.intensity.length; i++) {
        const b = Math.abs(replay.trail.beta[seg.startIndex + i]);
        const expected = Math.min(1, Math.max(0, (b - degToRad(8)) / (degToRad(45) - degToRad(8))));
        expect(seg.intensity[i]).toBeCloseTo(expected, 3);
      }
      expect(seg.points).toBe(session.score.perDrift[seg.driftId].total);
    }
  });

  it('cumulative score ends at the session total and never decreases', () => {
    const sc = replay.trail.score;
    for (let i = 1; i < sc.length; i++) expect(sc[i]).toBeGreaterThanOrEqual(sc[i - 1] - 1e-6);
    expect(sc[sc.length - 1]).toBeCloseTo(session.score.total, 3);
    expect(replay.telemetry.maxPoints).toBeCloseTo(session.score.total, 0);
  });

  it('smoke: sane count, emitted behind the car while |β| > 15°, moving against travel', () => {
    const { smoke, trail } = replay;
    let over15 = 0;
    for (let i = 0; i < trail.n; i++) if (Math.abs(trail.beta[i]) > degToRad(15)) over15++;
    const expected = (over15 / trail.hz / 0.15) * 2; // two tyres per emission
    expect(smoke.length).toBeGreaterThan(expected * 0.7);
    expect(smoke.length).toBeLessThan(expected * 1.3);
    for (let i = 1; i < smoke.length; i++) expect(smoke[i].birthT).toBeGreaterThanOrEqual(smoke[i - 1].birthT);
    for (const p of smoke) {
      const pose = poseAt(replay, p.birthT);
      expect(Math.abs(pose.beta)).toBeGreaterThan(degToRad(15) - 0.01);
      // rear axle: 2.2 m behind the CG along −heading
      const along = (p.x - pose.x) * Math.cos(pose.heading) + (p.y - pose.y) * Math.sin(pose.heading);
      expect(along).toBeCloseTo(-2.2, 1);
      const lateral = -(p.x - pose.x) * Math.sin(pose.heading) + (p.y - pose.y) * Math.cos(pose.heading);
      expect(Math.abs(lateral)).toBeCloseTo(0.9, 1);
      // initial velocity opposes the travel direction
      const dot = p.vx * Math.cos(pose.course) + p.vy * Math.sin(pose.course);
      expect(dot).toBeLessThan(0);
      expect(p.life).toBeCloseTo(1.6, 6);
      const st = smokeAt(p, p.birthT + 0.8);
      expect(st).not.toBeNull();
      expect(st!.radius).toBeGreaterThan(p.size);
      expect(st!.opacity).toBeGreaterThan(0);
      expect(smokeAt(p, p.birthT + 1.7)).toBeNull();
    }
    const alive = liveSmoke(smoke, smoke[10].birthT + 0.5);
    expect(alive.length).toBeGreaterThan(0);
    for (const p of alive) expect(smoke[10].birthT + 0.5 - p.birthT).toBeLessThan(1.6);
  });

  it('markers cover every drift and lap, and transitions sit at a β zero crossing', () => {
    const kinds = (k: string) => replay.markers.filter((m) => m.kind === k);
    expect(kinds('drift-start').length).toBe(replay.segments.length);
    expect(kinds('drift-peak').length).toBe(replay.segments.length);
    expect(kinds('drift-end').length).toBe(replay.segments.length);
    expect(kinds('lap').length).toBe(replay.laps.length + 1);
    const transitions = kinds('transition');
    expect(transitions.length).toBeGreaterThanOrEqual(1);
    for (const m of transitions) {
      expect(Math.abs(poseAt(replay, m.t).beta)).toBeLessThan(degToRad(1)); // interpolated zero crossing
      expect(Math.abs(poseAt(replay, m.t - 0.8).beta)).toBeGreaterThan(degToRad(8));
      expect(Math.abs(poseAt(replay, m.t + 0.8).beta)).toBeGreaterThan(degToRad(8));
    }
    for (let i = 1; i < replay.markers.length; i++) expect(replay.markers[i].t).toBeGreaterThanOrEqual(replay.markers[i - 1].t);
  });

  it('works without a track model and from truth only', () => {
    const noTrack = buildReplay({ ...session, track: null });
    expect(noTrack.ghost).toBeNull();
    expect(noTrack.laps.length).toBe(0);
    expect(noTrack.trail.n).toBe(replay.trail.n);
    const truthOnly = buildReplay({ ...session, states: [] });
    expect(truthOnly.trail.n).toBe(replay.trail.n);
    expect(poseAt(truthOnly, 30).x).toBeCloseTo(poseAt(replay, 30).x, 6);
    const empty = buildReplay({ ...session, states: [], truth: undefined, drifts: [] });
    expect(empty.trail.n).toBeGreaterThan(0);
    expect(() => poseAt(empty, 0)).not.toThrow();
  });
});

describe('poseAt', () => {
  it('interpolates continuously, including across heading wraps', () => {
    // The contract: poseAt never adds discontinuity beyond what the source has. Linear
    // interpolation between 20 Hz samples spreads any raw step over 50 ms, so each 1/120 s step
    // is at most 1/6 of the largest raw change over a 70 ms window (50 ms + one 10 ms sample).
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
    // sanity on the source itself (the sim launches hard and has stepwise corrections; keep these loose)
    expect(boundHeading).toBeLessThan(0.2);
    const dt = 1 / 120;
    let prev = poseAt(replay, 0);
    let wraps = 0;
    let maxDh = 0;
    for (let t = dt; t <= replay.durationS; t += dt) {
      const p = poseAt(replay, t);
      const dh = Math.abs(wrapAngle(p.heading - prev.heading));
      maxDh = Math.max(maxDh, dh);
      expect(dh).toBeLessThanOrEqual(boundHeading);
      expect(Math.abs(wrapAngle(p.course - prev.course))).toBeLessThanOrEqual(boundCourse);
      expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeLessThanOrEqual(boundPos);
      expect(Math.abs(p.speed - prev.speed)).toBeLessThanOrEqual(boundSpeed);
      expect(Math.abs(p.beta - prev.beta)).toBeLessThan(0.1);
      if (Math.sign(p.heading) !== Math.sign(prev.heading) && Math.abs(p.heading) > 3) wraps++;
      prev = p;
    }
    expect(wraps).toBeGreaterThan(0); // the harbor lap really crosses ±π, and no step was a spin
    expect(maxDh).toBeLessThan(0.2);
    expect(poseAt(replay, -5).t).toBe(0);
    expect(poseAt(replay, 1e9).t).toBe(replay.durationS);
    const mid = poseAt(replay, replay.segments[1].peakT);
    expect(mid.phase).toBe('drifting');
    expect(mid.intensity).toBeGreaterThan(0.3);
  });

  it('scrubTelemetry returns the nearest 10 Hz sample', () => {
    const s = scrubTelemetry(replay, 30.04);
    expect(s.index).toBe(300);
    expect(s.t).toBeCloseTo(30, 6);
    expect(s.speed).toBeCloseTo(poseAt(replay, 30).speed, 2);
    expect(s.drifting).toBe(true);
    expect(scrubTelemetry(replay, -1).index).toBe(0);
    expect(scrubTelemetry(replay, 1e6).index).toBe(replay.telemetry.n - 1);
  });
});

describe('ghost', () => {
  it('picks the best lap and stays within 3 m of the trail when the current lap is the best lap', () => {
    expect(replay.ghost).not.toBeNull();
    const g = replay.ghost!;
    const best = replay.laps.find((l) => l.best)!;
    expect(best.index).toBe(g.lapIndex);
    for (const lap of replay.laps) expect(lap.points).toBeLessThanOrEqual(best.points + 1e-6);
    let n = 0;
    for (let t = best.startT; t <= best.endT; t += 0.25) {
      const gp = ghostPoseAt(replay, t)!;
      const p = poseAt(replay, t);
      expect(Math.hypot(gp.x - p.x, gp.y - p.y)).toBeLessThan(3);
      expect(Math.abs(gp.gapM)).toBeLessThan(3);
      expect(gp.inLap).toBe(true);
      n++;
    }
    expect(n).toBeGreaterThan(100);
  });

  it('is time-synchronised to the other lap and null outside laps', () => {
    const other = replay.laps.find((l) => !l.best)!;
    const g = replay.ghost!;
    const t = other.startT + 20;
    const gp = ghostPoseAt(replay, t)!;
    const ref = poseAt(replay, g.startT + 20);
    expect(gp.tau).toBeCloseTo(20, 6);
    expect(gp.x).toBeCloseTo(ref.x, 3);
    expect(gp.y).toBeCloseTo(ref.y, 3);
    expect(ghostPoseAt(replay, 0.5)).toBeNull();
    expect(lapAt(replay, 0.5)).toBeNull();
    // continuity of the ghost through its own lap end
    let prev = ghostPoseAt(replay, other.startT + g.durationS - 0.5)!;
    for (let dt = -0.5 + 1 / 60; dt <= 0.5; dt += 1 / 60) {
      const cur = ghostPoseAt(replay, other.startT + g.durationS + dt);
      if (!cur) break;
      expect(Math.hypot(cur.x - prev.x, cur.y - prev.y)).toBeLessThan(1);
      prev = cur;
    }
  });
});

describe('camera', () => {
  const vp = { w: 390, h: 844 };
  const dt = 1 / 60;

  it.each(['overview', 'chase', 'cinematic'] as CameraMode[])('%s: per-frame deltas bounded at 60 fps across the whole run', (mode) => {
    const cam = new ReplayCamera(mode, vp);
    let prev = cam.update(replay, 0, dt);
    let maxPan = 0;
    let maxRot = 0;
    let maxZoom = 0;
    let n = 0;
    for (let t = dt; t <= replay.durationS; t += dt) {
      const s = cam.update(replay, t, dt);
      maxPan = Math.max(maxPan, Math.hypot(s.cx - prev.cx, s.cy - prev.cy));
      maxRot = Math.max(maxRot, Math.abs(wrapAngle(s.rotation - prev.rotation)));
      maxZoom = Math.max(maxZoom, Math.abs(Math.log(s.zoom / prev.zoom)));
      expect(Number.isFinite(s.cx) && Number.isFinite(s.cy) && Number.isFinite(s.zoom) && Number.isFinite(s.rotation)).toBe(true);
      prev = s;
      n++;
    }
    expect(n).toBeGreaterThan(5000);
    expect(maxPan).toBeLessThanOrEqual(CAMERA_LIMITS.maxPan * dt + 1e-9); // 1.0 m / frame
    expect(maxRot).toBeLessThanOrEqual(CAMERA_LIMITS.maxRotation * dt + 1e-9); // 0.05 rad / frame
    expect(maxZoom).toBeLessThanOrEqual(CAMERA_LIMITS.maxZoomLog * dt + 1e-9); // 2 % / frame
    if (mode === 'overview') {
      expect(maxPan).toBe(0);
      expect(maxRot).toBe(0);
    } else {
      // and in practice much tighter than the hard limits
      expect(maxPan).toBeLessThan(0.85);
      expect(maxRot).toBeLessThan(0.02);
    }
  });

  it('overview fits the bounds with 8 % padding and no rotation', () => {
    const cam = new ReplayCamera('overview', vp);
    const s = cam.update(replay, 10, dt);
    expect(s.rotation).toBe(0);
    const b = replay.bounds;
    const corners = [worldToScreen(s, b.minX, b.minY), worldToScreen(s, b.maxX, b.maxY), worldToScreen(s, b.minX, b.maxY), worldToScreen(s, b.maxX, b.minY)];
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(-1e-6);
      expect(c.x).toBeLessThanOrEqual(vp.w + 1e-6);
      expect(c.y).toBeGreaterThanOrEqual(-1e-6);
      expect(c.y).toBeLessThanOrEqual(vp.h + 1e-6);
    }
    const ex = (b.maxX - b.minX) * 1.16;
    const ey = (b.maxY - b.minY) * 1.16;
    expect(s.zoom).toBeCloseTo(Math.min(vp.w / ex, vp.h / ey), 6);
  });

  it('chase follows the car with the travel direction up, ~60 m across the short side, look-ahead ≤ 12 m', () => {
    // find a moment on a straight: moving, with a steady course for the preceding 0.8 s
    const courseRate = (t: number) => wrapAngle(poseAt(replay, t + 0.1).course - poseAt(replay, t - 0.1).course) / 0.2;
    let tStraight = -1;
    for (let t = 5; t < replay.durationS - 5 && tStraight < 0; t += 0.1) {
      let ok = poseAt(replay, t).speed > 12;
      for (let u = t - 0.8; ok && u <= t; u += 0.1) ok = Math.abs(courseRate(u)) < 0.05;
      if (ok) tStraight = t;
    }
    expect(tStraight).toBeGreaterThan(0);
    const cam = new ReplayCamera('chase', vp);
    let s = cam.update(replay, 0, dt);
    for (let t = dt; t <= tStraight; t += dt) s = cam.update(replay, t, dt);
    const p = poseAt(replay, tStraight);
    expect(p.speed).toBeGreaterThan(12);
    expect(s.zoom).toBeCloseTo(390 / 60, 6);
    // the car is on screen, below the centre, and its course points up
    const sp = worldToScreen(s, p.x, p.y);
    expect(sp.x).toBeGreaterThan(vp.w * 0.25);
    expect(sp.x).toBeLessThan(vp.w * 0.75);
    expect(sp.y).toBeGreaterThan(vp.h / 2 - 5);
    expect(sp.y).toBeLessThan(vp.h / 2 + 12 * s.zoom + 40);
    const ahead = worldToScreen(s, p.x + 10 * Math.cos(p.course), p.y + 10 * Math.sin(p.course));
    expect(ahead.y).toBeLessThan(sp.y);
    expect(Math.abs(ahead.x - sp.x)).toBeLessThan(15);
    expect(Math.abs(wrapAngle(s.rotation - (Math.PI / 2 - p.course)))).toBeLessThan(0.06);
    // mid-corner the rotation lags by design (τ = 0.5 s), but never by more than ~0.7 × the course rate
    const tMid = Math.max(tStraight + 1, replay.segments[1].peakT);
    for (let t = tStraight + dt; t <= tMid; t += dt) s = cam.update(replay, t, dt);
    const q = poseAt(replay, tMid);
    expect(Math.abs(wrapAngle(s.rotation - (Math.PI / 2 - q.course)))).toBeLessThan(0.05 + 0.7 * Math.abs(courseRate(tMid)));
    // first update snaps: no start-up transient
    const fresh = new ReplayCamera('chase', vp);
    const a = fresh.update(replay, tMid, dt);
    expect(Math.abs(wrapAngle(a.rotation - (Math.PI / 2 - q.course)))).toBeLessThan(1e-9);
  });

  it('cinematic zooms in during drifts and mode switches stay bounded', () => {
    const cam = new ReplayCamera('cinematic', vp);
    let s = cam.update(replay, 0, dt);
    let zoomStraight = Infinity;
    let zoomDrift = 0;
    let zoomMax = 0;
    for (let t = dt; t <= replay.durationS; t += dt) {
      s = cam.update(replay, t, dt);
      const p = poseAt(replay, t);
      if (p.phase === 'idle' && p.speed > 10) zoomStraight = Math.min(zoomStraight, s.zoom);
      if (p.intensity > 0.9) zoomDrift = Math.max(zoomDrift, s.zoom);
      zoomMax = Math.max(zoomMax, s.zoom);
    }
    const base = 390 / 60;
    expect(zoomStraight).toBeLessThan(base * 0.9); // pulled back on straights (target 0.85×)
    expect(zoomDrift).toBeGreaterThan(base * 1.45); // zoomed in at full angle (target 1.6×)
    expect(zoomMax).toBeLessThanOrEqual(base * 1.6 + 1e-6); // critically damped: no overshoot
    // switching modes mid-run: still bounded per frame
    const sw = new ReplayCamera('overview', vp);
    let prev = sw.update(replay, 30, dt);
    sw.setMode('chase');
    for (let t = 30 + dt; t <= 40; t += dt) {
      const cur = sw.update(replay, t, dt);
      expect(Math.hypot(cur.cx - prev.cx, cur.cy - prev.cy)).toBeLessThanOrEqual(CAMERA_LIMITS.maxPan * dt + 1e-9);
      expect(Math.abs(Math.log(cur.zoom / prev.zoom))).toBeLessThanOrEqual(CAMERA_LIMITS.maxZoomLog * dt + 1e-9);
      expect(Math.abs(wrapAngle(cur.rotation - prev.rotation))).toBeLessThanOrEqual(CAMERA_LIMITS.maxRotation * dt + 1e-9);
      prev = cur;
    }
    // ...and converges to the chase target within a few seconds
    const chase = new ReplayCamera('chase', vp).update(replay, 40, dt);
    expect(Math.hypot(prev.cx - chase.cx, prev.cy - chase.cy)).toBeLessThan(6);
    expect(prev.zoom).toBeCloseTo(chase.zoom, 1);
  });

  it('worldToScreen / screenToWorld round trip', () => {
    const cam = { cx: 120.5, cy: -33.2, zoom: 6.5, rotation: 2.1, w: 390, h: 844 };
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
    // the centre maps to the viewport centre, and screen y grows downwards
    const c = worldToScreen(cam, cam.cx, cam.cy);
    expect(c.x).toBeCloseTo(195, 9);
    expect(c.y).toBeCloseTo(422, 9);
    const up = worldToScreen({ ...cam, rotation: 0 }, cam.cx, cam.cy + 10);
    expect(up.y).toBeCloseTo(422 - 65, 9);
  });
});
