import { existsSync, readFileSync } from 'node:fs';
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
  CAMERA_TUNING,
  severityOf,
  shakeAt,
  smokeAt,
  trailValueAt,
  worldToScreen,
  type CameraMode,
  type Replay,
} from './index';
import { sessionFromSimulation } from './fixtures';
import { peakCallout, refusedLabel, IDENTITY_TOLERANCE } from './build';
import { replayChains, resolveOptions } from '../score';
import { FIXTURES, buildFixtureSession } from '../../ui/results/fixture';
import { isPointsClaim } from '../../ui/replay/palette';

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

  it('a drift is a drift, not a whole lap — unless it is a linked chain', () => {
    // FINDING 9: a 28 s "drift" shaded 70 % of the telemetry strip end to end.
    // ROUND-3 FINDING 3: but the length cutter must not sever a switchback, so a chain is
    // allowed to run long. Everything else is capped.
    for (const seg of replay.segments) {
      expect(seg.durationS).toBeGreaterThanOrEqual(0.6);
      // a chain is one drift, but its length is bounded by what it links: 10 s + 8 s each
      expect(seg.durationS).toBeLessThanOrEqual(10 + 8 * seg.transitions + 0.2);
    }
    expect(replay.segments.length).toBeGreaterThanOrEqual(8);
  });

  it('never cuts a switchback, and bounds a chain by its transition count', () => {
    // ROUND-3 FINDING 3: the cutter took the deepest interior |β| minimum, which in a linked
    // sequence IS the transition — so it severed precisely the beat that owns the magenta
    // callout, flash, shake and haptic. It now cuts through the middle of the longest LOBE.
    // ROUND-4 FINDING 2: but "has a transition" must not license any duration, so the cap is
    // `maxDurationS + chainBonusS × transitions` (10 s + 8 s each).
    const hz = 100;
    const flick = (totalS: number, amp = 35) => {
      const truth = [];
      for (let i = 0; i < totalS * hz; i++) {
        const t = i / hz;
        const beta = degToRad(amp) * Math.tanh((totalS / 2 - t) * 3); // one fast flick, no settle
        truth.push({ t, x: 20 * t, y: 0, heading: 0, course: beta, speed: 20, beta, yawRate: 0, ay: 0, ax: 0, drifting: Math.abs(beta) > degToRad(5) });
      }
      return sessionFromSimulation({ trackId: 'harbor', motion: [], gps: [], truth, mount: [], lapTimes: [], corners: [], centreLine: [], originLat: 0, originLon: 0, plans: [], meta: {} } as unknown as SimulatedRun, { track: false });
    };
    // within the allowance (14 s, one transition → 18 s): one drift, transition intact
    const short = flick(14);
    expect(short.drifts.length).toBe(1);
    expect(short.drifts[0].transitions).toBe(1);
    const sr = buildReplay(short);
    expect(sr.segments.length).toBe(1);
    expect(sr.markers.filter((m) => m.kind === 'transition').length).toBe(1);

    // over the allowance (30 s on one transition): it IS cut, but the flick survives — the cut
    // lands mid-lobe, so the direction change still lives inside one of the pieces
    const long = flick(30);
    expect(long.drifts.length).toBeGreaterThan(1);
    expect(long.drifts.reduce((n, d) => n + d.transitions, 0)).toBeGreaterThanOrEqual(1);
    for (const d of long.drifts) expect(d.durationS).toBeLessThanOrEqual(10 + 8 * d.transitions + 0.2);

    // a long SAME-direction slide has no transition to protect and is capped at 10 s
    const flat = [];
    for (let i = 0; i < 30 * hz; i++) {
      const t = i / hz;
      flat.push({ t, x: 20 * t, y: 0, heading: 0, course: degToRad(35), speed: 20, beta: degToRad(35), yawRate: 0, ay: 0, ax: 0, drifting: true });
    }
    const straight = sessionFromSimulation({ trackId: 'harbor', motion: [], gps: [], truth: flat, mount: [], lapTimes: [], corners: [], centreLine: [], originLat: 0, originLon: 0, plans: [], meta: {} } as unknown as SimulatedRun, { track: false });
    expect(straight.drifts.length).toBeGreaterThan(1);
    for (const d of straight.drifts) {
      expect(d.transitions).toBe(0);
      expect(d.durationS).toBeLessThanOrEqual(10.2);
    }
  });

  it('grades span the scale across driver skill, and so does severity', () => {
    // ROUND-3 FINDING 2: splitting one 28 s drift into seven collapsed every grade to C,
    // because the fixture graded on points PER DRIFT. It grades on points per second now,
    // which is invariant to how a run is cut up.
    const grades = new Set<string>();
    const severities = new Set<string>();
    for (const track of ['harbor', 'touge'] as const) {
      for (const [aggression, consistency] of [
        [0.15, 0.2],
        [0.6, 0.6],
        [1.0, 1.0],
      ] as Array<[number, number]>) {
        for (const seed of [1, 2]) {
          const ses = sessionFromSimulation(simulateRun(track, { seed, laps: 2, aggression, consistency }));
          const rep = buildReplay(ses);
          grades.add(ses.score.grade);
          severities.add(rep.info.severity);
        }
      }
    }
    expect(grades.size).toBeGreaterThanOrEqual(3);
    expect(severities.size).toBeGreaterThanOrEqual(2);
    // the gold S chip and the muted D chip must both be reachable, or the grade colour is dead
    expect(grades.has('S') || grades.has('A')).toBe(true);
    expect(grades.has('D') || grades.has('C')).toBe(true);
    // 16 simulated runs through the scorer: comfortably over the 5 s default on a loaded machine,
    // and a timeout is a red check that says nothing about the code
  }, 120_000);
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

  it('the session headline describes the run, not its biggest spike', () => {
    // ROUND-4 FINDING 4: `info.severity` came from the single peak, so one 71° save relabelled
    // a whole session "spin". It is the band of the 90th percentile of |β| while drifting now.
    expect(replay.info.typicalAngle).toBeLessThan(replay.info.peakAngle);
    expect(replay.info.typicalAngle).toBeGreaterThan(0);
    expect(replay.info.severity).toBe(severityOf(replay.info.typicalAngle));
    // a single huge spike in an otherwise gentle run must NOT set the headline
    const gentle = buildReplay({
      ...session,
      drifts: session.drifts.map((d, i) => (i === 0 ? d : d)),
    });
    expect(gentle.info.severity).toBe(replay.info.severity);
    // and it still moves with how the run was actually driven
    const mild = buildReplay(sessionFromSimulation(simulateRun('harbor', { seed: 1, laps: 2, aggression: 0.15, consistency: 0.2 })));
    const wild = buildReplay(sessionFromSimulation(simulateRun('harbor', { seed: 1, laps: 2, aggression: 1, consistency: 1 })));
    expect(wild.info.typicalAngle).toBeGreaterThan(mild.info.typicalAngle);
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

  // NOTE: this session's `score.total` is BY CONSTRUCTION the sum of its per-drift totals and it
  // contains no spin, so it cannot express a lost chain. The fixture-wide version of this test —
  // "the replay and the results screen count the same run" at the bottom of this file — is the
  // one that can fail; keep both.
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

  it('the spin beat comes from DriftEvent.spin, not from an angle band', () => {
    // ROUND-6 FINDING 2: the beat was chosen by the |β| ≥ 65° band, so a drift the engine had
    // marked as a spin got "SAVED IT 118°" and a 68° angle the driver HELD got the spin's word
    // and its red. `d.spin` was read nowhere in build.ts. This test is written around the flag,
    // over a session that actually contains one, because the old one asserted SAVED IT for
    // every spin beat of a session that has no spins at all and could therefore never fail.
    const spun = sessionFromSimulation(run);
    const big = [...spun.drifts].sort((a, b) => b.peakAngle - a.peakAngle)[0];
    const held = [...spun.drifts].sort((a, b) => b.peakAngle - a.peakAngle)[1];
    big.spin = true;
    held.spin = false;
    const r = buildReplay(spun);
    const beat = (id: number, kind: 'spin' | 'peak') => r.events.find((e) => e.driftId === id && e.kind === kind);
    const spinBeat = beat(big.id, 'spin')!;
    expect(spinBeat).toBeDefined();
    expect(spinBeat.label).toBe(`LOST IT ${Math.round(radToDeg(big.peakAngle))}°`);
    expect(beat(big.id, 'peak')).toBeUndefined();
    // the held angle keeps its own wording and never borrows the spin's
    expect(beat(held.id, 'spin')).toBeUndefined();
    const heldBeat = beat(held.id, 'peak');
    if (heldBeat) {
      expect(heldBeat.label).not.toMatch(/LOST IT/);
      expect(spinBeat.priority).toBeGreaterThan(heldBeat.priority);
    }
    // the words themselves: SAVED IT is an angle past the spin edge that was HELD
    expect(peakCallout(true, degToRad(118))).toBe('LOST IT 118°');
    expect(peakCallout(false, degToRad(70))).toBe('SAVED IT 70°');
    expect(peakCallout(false, degToRad(93))).toBe('SAVED IT 93°');
    expect(peakCallout(false, degToRad(50))).toBe('BIG ANGLE');
    // and the segment carries the engine's verdict for anything else that has to draw it
    expect(r.segments.find((g) => g.driftId === big.id)!.spin).toBe(true);
    expect(r.segments.find((g) => g.driftId === held.id)!.spin).toBe(false);
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

describe('contracts a second renderer must not have to remember', () => {
  it('withholds the headline score entirely when the run is untrusted', () => {
    // ROUND-5 FINDING 1: `totalPoints`/`grade` were populated even for a run the engine refuses
    // to publish. Both renderers suppressed it because both were told to — discipline, not
    // structure. They are null now, so the type stops a consumer that forgets to look.
    expect(replay.info.trusted).toBe(true);
    expect(replay.info.totalPoints).not.toBeNull();
    expect(replay.info.grade).not.toBeNull();
    expect(replay.info.untrustedMessage).toBe('');

    const doubted: Session = {
      ...session,
      score: { ...session.score, trusted: false },
      integrity: { ...session.integrity, scoreTrusted: false, message: 'Phone was moving in the cradle' },
    };
    const r = buildReplay(doubted);
    expect(r.info.trusted).toBe(false);
    expect(r.info.totalPoints).toBeNull();
    expect(r.info.grade).toBeNull();
    expect(r.info.untrustedMessage).toBe('Phone was moving in the cradle');
    // the shape of the run is still there — it is data about the run, not a claim about it
    expect(r.trail.score[r.trail.n - 1]).toBeGreaterThan(0);
    // either flag alone is enough to withhold it
    expect(buildReplay({ ...session, score: { ...session.score, trusted: false } }).info.grade).toBeNull();
    expect(buildReplay({ ...session, integrity: { ...session.integrity, scoreTrusted: false } }).info.grade).toBeNull();
    // and there is always something to show instead
    expect(buildReplay({ ...session, score: { ...session.score, trusted: false } }).info.untrustedMessage.length).toBeGreaterThan(0);
  });

  it('marks dead-reckoned positions so both renderers dash the same stretches', () => {
    // ROUND-5 FINDING 2: the estimator propagates through a GPS dropout, so the trail is
    // continuous and nothing distinguished a measured corner from a guessed one. Each renderer
    // was deriving its own windows from session.gps with its own threshold.
    const hz = 100;
    const states = line(3000, () => ({}));
    const gps = [];
    for (let t = 0; t <= 30; t += 1) {
      if (t > 10 && t < 18) continue; // an 8 s hole
      gps.push({ t, lat: 0, lon: 0, speed: 20, course: 90, hAcc: 4 });
    }
    const r = buildReplay(synthetic(states, { gps }));
    expect(r.gapWindows.length).toBe(1);
    expect(r.gapWindows[0].startT).toBeCloseTo(10 - r.t0, 1);
    expect(r.gapWindows[0].endT).toBeCloseTo(18 - r.t0, 1);
    expect(r.warnings.join(' ')).toMatch(/dropout/);
    let measured = 0;
    let reckoned = 0;
    for (let k = 0; k < r.trail.n; k++) {
      const t = r.trail.t[k] + r.t0;
      if (t > 11 && t < 17) {
        expect(r.trail.measured[k]).toBe(0);
        reckoned++;
      } else if (t > 2 && t < 9) {
        expect(r.trail.measured[k]).toBe(1);
        measured++;
      }
    }
    expect(reckoned).toBeGreaterThan(50);
    expect(measured).toBeGreaterThan(50);
    // a clean run has nothing to dash
    const clean = buildReplay(synthetic(line(3000, () => ({})), { gps: Array.from({ length: 31 }, (_, i) => ({ t: i, lat: 0, lon: 0, speed: 20, course: 90, hAcc: 4 })) }));
    expect(clean.gapWindows).toEqual([]);
    for (let k = 0; k < clean.trail.n; k++) expect(clean.trail.measured[k]).toBe(1);
    // a useless fix (hAcc 400 m) is not a measurement
    const junk = buildReplay(synthetic(line(600, () => ({})), { gps: Array.from({ length: 7 }, (_, i) => ({ t: i, lat: 0, lon: 0, speed: 20, course: 90, hAcc: 400 })) }));
    expect(junk.gapWindows.length).toBeGreaterThan(0);
  });

  it('cues a highlight at the moment, not at the start of the run-up', () => {
    // ROUND-5 FINDING 3: `inT` is the start of the whole drift, up to 25 s before the peak on a
    // chain, so "jump to the best moment" landed on the run-up.
    expect(replay.highlights.length).toBeGreaterThan(0);
    for (const h of replay.highlights) {
      expect(h.cueT).toBeGreaterThanOrEqual(h.inT - 1e-9);
      expect(h.cueT).toBeLessThanOrEqual(h.t + 1e-9);
      expect(h.t - h.cueT).toBeLessThanOrEqual(replay.options.highlightLeadS + 1e-9);
    }
    // on a long chain the cue really is much later than the drift start
    const chained = replay.highlights.filter((h) => h.t - h.inT > 10);
    expect(chained.length).toBeGreaterThan(0);
    for (const h of chained) expect(h.cueT - h.inT).toBeGreaterThan(5);
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
  it('is NEVER the car being watched, and is distance-synced so it stays on screen', () => {
    // FINDING 1: the ghost was the same lap for 47 % of the replay — a cyan outline sitting
    // exactly on the white car, which reads as a rendering glitch.
    // ROUND-3: it is now synced by DISTANCE, so instead of being an off-screen badge 88 % of
    // the time it sits beside the car showing the reference line through the same corner.
    expect(replay.ghost).not.toBeNull();
    expect(replay.laps.length).toBe(2);
    for (const lap of replay.laps) {
      expect(lap.ghostRef).toBeGreaterThanOrEqual(0);
      expect(lap.ghostRef).not.toBe(lap.index);
    }
    let samples = 0;
    let onScreen = 0;
    let identical = 0;
    const seps: number[] = [];
    for (let t = 0; t <= replay.durationS; t += 0.25) {
      const g = ghostPoseAt(replay, t);
      if (!g) continue;
      const p = poseAt(replay, t);
      samples++;
      // it must always come from a different lap than the one being watched
      expect(g.lapIndex).not.toBe(p.lap);
      if (g.x === p.x && g.y === p.y && g.heading === p.heading) identical++;
      const d = Math.hypot(g.x - p.x, g.y - p.y);
      seps.push(d);
      if (d < 45) onScreen++;
    }
    expect(samples).toBeGreaterThan(300);
    expect(identical).toBe(0);
    // within 45 m is roughly "inside the chase frame"
    expect(onScreen / samples).toBeGreaterThan(0.95);
    seps.sort((a, b) => a - b);
    expect(seps[Math.floor(seps.length / 2)]).toBeLessThan(15);
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

  it('the reference is the best-points lap, sampled at the car\'s distance into the lap', () => {
    const best = replay.laps.find((l) => l.best)!;
    expect(replay.ghost!.lapIndex).toBe(best.index);
    expect(replay.ghost!.criterion).toBe('points');
    for (const lap of replay.laps) expect(lap.points).toBeLessThanOrEqual(best.points + 1e-6);
    // distance sync: the ghost has covered the same distance into its lap as the car has into its
    const other = replay.laps.find((l) => !l.best)!;
    const trail = replay.trail;
    const distInto = (t: number, lap: typeof best) => trailValueAt(trail, trail.dist, t) - trailValueAt(trail, trail.dist, lap.startT);
    for (const frac of [0.2, 0.45, 0.7, 0.9]) {
      const t = other.startT + other.durationS * frac;
      const g = ghostPoseAt(replay, t)!;
      expect(g.lapIndex).toBe(best.index);
      const carDist = distInto(t, other);
      const ghostDist = distInto(best.startT + g.tau, best);
      expect(ghostDist).toBeCloseTo(carDist, 0);
      // and the pose really is the reference lap at that moment
      const ref = poseAt(replay, best.startT + g.tau);
      expect(g.x).toBeCloseTo(ref.x, 1);
      expect(g.y).toBeCloseTo(ref.y, 1);
    }
    expect(ghostPoseAt(replay, 0.2)).toBeNull();
    expect(lapAt(replay, -1)).toBeNull();
  });

  it('offers time-sync as an alternative, with identical gaps', () => {
    // ROUND-4 FINDING 1: distance-sync keeps the ghost on screen, but some players want a car
    // to chase. Both modes report the same delta; only the POSE differs.
    const timed = buildReplay(session, { ghostSync: 'time' });
    const other = timed.laps.find((l) => !l.best)!;
    let far = 0;
    let n = 0;
    for (let t = other.startT + 2; t < other.endT - 2; t += 0.5) {
      const gd = ghostPoseAt(replay, t)!;
      const gt = ghostPoseAt(timed, t)!;
      expect(gd.sync).toBe('distance');
      expect(gt.sync).toBe('time');
      // the numbers a driver reads are the same in both modes
      expect(gt.gapS).toBeCloseTo(gd.gapS, 6);
      expect(gt.gapPoints).toBeCloseTo(gd.gapPoints, 6);
      const p = poseAt(timed, t);
      if (Math.hypot(gt.x - p.x, gt.y - p.y) > 45) far++;
      n++;
    }
    // time-sync really is the off-screen one: that is the trade it exists to offer
    expect(far / n).toBeGreaterThan(0.5);
  });
});

describe('real pipeline sessions', () => {
  // The frames render the REAL pipeline output when it exists, so the critic sees what the app
  // actually scores rather than what the fixture guesses.
  const files = ['artifacts/session-harbor.json', 'artifacts/session-touge.json'].filter((f) => existsSync(f));
  it.runIf(files.length > 0)('build a valid replay with laps, drifts and a real grade', () => {
    for (const file of files) {
      const ses = JSON.parse(readFileSync(file, 'utf8')) as Session;
      const rep = buildReplay(ses);
      expect(rep.warnings).toEqual([]);
      expect(rep.trail.n).toBeGreaterThan(100);
      expect(rep.segments.length).toBeGreaterThan(0);
      expect(rep.info.totalPoints).toBeGreaterThan(1000);
      expect(['S', 'A', 'B', 'C', 'D']).toContain(rep.info.grade);
      for (let k = 0; k < rep.trail.n; k++) expect(Number.isFinite(rep.trail.x[k])).toBe(true);
      const cam = new ReplayCamera('chase', { w: 390, h: 844 });
      let prev = cam.update(rep, 0, 1 / 60);
      for (let t = 1 / 60; t <= rep.durationS; t += 1 / 60) {
        const st = cam.update(rep, t, 1 / 60);
        expect(Math.abs(wrapAngle(st.rotation - prev.rotation))).toBeLessThanOrEqual(CAMERA_LIMITS.maxRotation / 60 + 1e-9);
        prev = st;
      }
    }
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

  it('opens pointing the right way and never whips at the start', () => {
    // ROUND-3 FINDING 1 (regression): `lastRotationTarget = 0` made the heading-seed branch dead
    // code, so every chase/cinematic replay opened ~90° wrong and swept a quarter turn in the
    // first second — 2.24°/frame, 57 frames over 0.5°/frame. Round 1 peaked at 0.55°/frame.
    for (const mode of ['chase', 'cinematic'] as CameraMode[]) {
      const cam = new ReplayCamera(mode, vp);
      let prev = cam.update(replay, 0, dt);
      const p0 = poseAt(replay, 0);
      expect(Math.abs(wrapAngle(prev.rotation - (Math.PI / 2 - p0.heading)))).toBeLessThan(0.05);
      let maxEarly = 0;
      let over = 0;
      for (let t = dt; t <= 3; t += dt) {
        const s = cam.update(replay, t, dt);
        const d = Math.abs(wrapAngle(s.rotation - prev.rotation));
        maxEarly = Math.max(maxEarly, d);
        if (d > degToRad(0.5)) over++;
        prev = s;
      }
      expect(over).toBe(0);
      expect(maxEarly).toBeLessThan(degToRad(0.5));
    }
    // a fresh camera on a PARKED car still seeds from the heading, and reset() re-arms it
    const cam = new ReplayCamera('chase', vp);
    const a = cam.update(replay, 0, dt);
    cam.reset();
    const b = cam.update(replay, 0, dt);
    expect(b.rotation).toBeCloseTo(a.rotation, 9);
  });

  it('overview frames the ACTION, fills the frame, and does not rotate', () => {
    // ROUND-6 FINDING 12: the shot was fitted to `bounds`, which carries 15 m (or 5 %) of
    // padding on every side for culling — so the circuit floated inside a margin, filling
    // barely half the frame. It is fitted to `content` (the trail and the track, unpadded)
    // with only the camera's own 4 %.
    const cam = new ReplayCamera('overview', vp);
    const s = cam.update(replay, 10, dt);
    expect(s.rotation).toBe(0);
    const b = replay.content;
    for (const c of [worldToScreen(s, b.minX, b.minY), worldToScreen(s, b.maxX, b.maxY), worldToScreen(s, b.minX, b.maxY), worldToScreen(s, b.maxX, b.minY)]) {
      expect(c.x).toBeGreaterThanOrEqual(-1e-6);
      expect(c.x).toBeLessThanOrEqual(vp.w + 1e-6);
      expect(c.y).toBeGreaterThanOrEqual(-1e-6);
      expect(c.y).toBeLessThanOrEqual(vp.h + 1e-6);
    }
    // and it really fills it: the binding axis covers at least 90 % of the viewport
    const fillX = ((b.maxX - b.minX) * s.zoom) / vp.w;
    const fillY = ((b.maxY - b.minY) * s.zoom) / vp.h;
    expect(Math.max(fillX, fillY)).toBeGreaterThan(0.9);
    // the padded bounds are strictly larger, so fitting them would have shown a smaller circuit
    const padded = replay.bounds;
    expect(padded.maxX - padded.minX).toBeGreaterThan(b.maxX - b.minX);
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

  it('a cut fades in REAL time, so it clears while paused', () => {
    // ROUND-5 FINDING 4: the cross-fade was measured in replay time, so a mode switch on a
    // paused frame left the screen 55 % black forever.
    const cam = new ReplayCamera('overview', vp);
    cam.update(replay, 30, dt);
    cam.setMode('chase');
    const cut = cam.update(replay, 30, dt);
    expect(cut.cut).toBe(true);
    expect(cut.cutFade).toBe(1);
    // PAUSED: replay time frozen, real frames still arriving
    let st = cut;
    let frames = 0;
    for (; frames < 60 && st.cutFade > 0; frames++) st = cam.update(replay, 30, dt);
    expect(st.cutFade).toBe(0);
    expect(frames).toBeLessThanOrEqual(Math.ceil(CAMERA_LIMITS.cutFadeS / dt) + 2);
    // and a long stall does not leave it stuck either
    const cam2 = new ReplayCamera('overview', vp);
    cam2.update(replay, 30, dt);
    cam2.setMode('chase');
    cam2.update(replay, 30, dt);
    expect(cam2.update(replay, 30, 0.5).cutFade).toBe(0);
  });

  it('keeps the car inside the frame: look-ahead is a fraction of what is visible, on both axes', () => {
    // ROUND-5 FINDING 5: look-ahead was a distance in metres while the zoom fits the SHORTER
    // side, so a zoomed-in cinematic frame on a tall portrait stage pushed the car past the
    // bottom of the visible band — one frame had it half under the scrubber. At full cinematic
    // zoom the old target put it 456 px below centre, off the bottom of an 844 pt screen.
    //
    // IT RAN ON ONE RUN AND ONE AXIS: `harbor` seed 1, and only `.y`, and only downwards. The x
    // axis is not decoration — cinematic sways ±1.2 m laterally, and the fixture whose camera
    // actually strains (`handheld`, whose recorded position teleports) leaves the portrait action
    // rectangle on its LEFT edge, not its bottom. Both axes are checked here, and
    // "every fixture, both follow modes" is the sweep below in the fixture suite; the frame the
    // viewer really sees is `safeFrame` in src/ui/replay/layout.ts, swept in replay-ui.test.ts.
    const tall = { w: 390, h: 844 };
    const cap = CAMERA_TUNING.maxLookFrac * Math.min(tall.w, tall.h);
    const bandBottom = tall.h - 96 - 34; // the renderer's bottom bar + scrubber
    for (const mode of ['chase', 'cinematic'] as CameraMode[]) {
      // the TARGET obeys the cap (jumpTo snaps to it, with no smoothing lag). Cinematic tilts
      // the frame by up to ±0.025 rad of sway, which swings ~1 px of the lateral offset onto
      // the vertical axis; nothing else may exceed the cap.
      const slack = mode === 'cinematic' ? 1.5 : 1e-3;
      const exact = new ReplayCamera(mode, tall);
      for (let t = 0; t <= replay.durationS; t += 0.25) {
        const st = exact.jumpTo(replay, t);
        const p = poseAt(replay, t);
        const sp = worldToScreen(st, p.x, p.y);
        const dx = sp.x - tall.w / 2;
        const dy = sp.y - tall.h / 2;
        // The target is the pose plus a look-ahead ALONG THE COURSE plus (cinematic) a ±1.2 m
        // lateral sway, so what the cap bounds is the LENGTH of that offset, in whatever
        // direction the frame is rotated — it points straight up only while the car is moving
        // fast enough for the rotation to have caught its course. Bound the length, which is
        // the exact claim, and the vertical separately, which is the axis the chrome is on.
        const sway = mode === 'cinematic' ? CAMERA_TUNING.swayOffsetM * st.zoom : 0;
        expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(cap + sway + slack);
        expect(Math.abs(dy)).toBeLessThanOrEqual(cap + slack);
      }
      // and the smoothed camera stays close to it, and well clear of the chrome
      const cam = new ReplayCamera(mode, tall);
      let worst = -Infinity;
      cam.update(replay, 0, dt);
      for (let t = dt; t <= replay.durationS; t += dt) {
        const st = cam.update(replay, t, dt);
        const p = poseAt(replay, t);
        worst = Math.max(worst, worldToScreen(st, p.x, p.y).y - tall.h / 2);
      }
      expect(worst).toBeLessThanOrEqual(cap * 1.4); // spring lag only
      expect(tall.h / 2 + worst).toBeLessThan(bandBottom - 40);
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

/**
 * THE FIXTURES, ALL OF THEM.
 *
 * The suite used to prove its most important property — "the replay's running score ends at the
 * session total" — against one simulated harbour run whose total is by construction the sum of
 * its per-drift scores, with no spin in it. That session cannot express a lost chain, so the
 * test could not fail while the replay printed 27 468 points against the results screen's 18 486.
 *
 * These run over every scenario the app ships, built the way the screens build them
 * (`buildFixtureSession`, real scorer, real pipeline for four of them), and they assert
 * RELATIONSHIPS rather than numbers, so a retune of the scorer moves them without breaking them.
 */
describe('the replay and the results screen count the same run', () => {
  const names = Object.keys(FIXTURES);
  const built = new Map<string, { session: Session; replay: Replay }>();

  beforeAll(() => {
    for (const name of names) {
      const s = buildFixtureSession(FIXTURES[name]);
      built.set(name, { session: s, replay: buildReplay(s) });
    }
  }, 120_000);

  it.each(names)('%s: the running total ends at the session total and never decreases', (name) => {
    const { session, replay: r } = built.get(name)!;
    const sc = r.trail.score;
    for (let i = 1; i < sc.length; i++) expect(sc[i]).toBeGreaterThanOrEqual(sc[i - 1] - 1e-6);
    // THE REAL ASSERTION. `info.totalPoints` is DEFINED as `session.score.total` when it is
    // finite, so comparing the two is an identity that cannot fail — that is what let the
    // fabricated per-drift scores through for a whole round. What has to agree is the number the
    // replay BUILDS for itself, sample by sample, and the number the results screen prints.
    expect(Math.round(sc[sc.length - 1])).toBe(session.score.total);
    if (!r.info.trusted) expect(r.info.totalPoints).toBeNull();
  });

  it.each(names)('%s: every scored slide exists on the replay too', (name) => {
    const { session, replay: r } = built.get(name)!;
    expect(r.segments.length).toBe(session.drifts.length);
    expect(r.info.driftCount).toBe(session.drifts.length);
    for (const d of session.drifts) {
      const seg = r.segments.find((g) => g.driftId === d.id);
      expect(seg, `drift ${d.id} (${d.startT.toFixed(1)}–${d.endT.toFixed(1)} s) has no segment`).toBeDefined();
      expect(seg!.spin).toBe(d.spin === true);
      // the printed peak is the DETECTOR's, which is the number the results screen prints
      expect(radToDeg(seg!.peakAngle)).toBeCloseTo(radToDeg(d.peakAngle), 6);
      expect(seg!.samplePeakAngle).toBeGreaterThanOrEqual(seg!.peakAngle - 1e-9);
    }
    if (session.drifts.length > 0) {
      const peak = Math.max(...session.drifts.map((d) => d.peakAngle));
      expect(radToDeg(r.info.peakAngle)).toBeCloseTo(radToDeg(peak), 6);
    }
  });

  it.each(names)('%s: a lost chain adds nothing, and says so', (name) => {
    const { session, replay: r } = built.get(name)!;
    // AGAINST THE SCORER, NOT AGAINST ITSELF. This used to compute the expectation by calling
    // the replay's own copy of the chain rule, so it asserted the implementation against the
    // implementation and could not see the two disagreeing about which drifts banked.
    // `replayChains` is the rule's owner (src/engine/score/session.ts) and is reached here
    // independently of anything the replay builder touched.
    const lost = new Set(
      replayChains(session.drifts, session.states, resolveOptions())
        .scored.filter((d) => d.lost)
        .map((d) => d.id),
    );
    for (const seg of r.segments) {
      expect(seg.lost, `drift ${seg.driftId}`).toBe(lost.has(seg.driftId));
      if (!seg.lost) continue;
      expect(seg.points).toBe(0);
      expect(seg.grossPoints).toBeGreaterThanOrEqual(0);
      const exit = r.events.find((e) => e.kind === 'exit' && e.driftId === seg.driftId)!;
      expect(exit.points).toBe(0);
      expect(exit.label).not.toMatch(/^\+/);
      // a slide that risked nothing announces nothing; one that risked points names them
      expect(exit.label).toMatch(seg.grossPoints > 0 ? (seg.spin ? /^CHAIN LOST −/ : /^AT RISK \+/) : /^$/);
      // nothing accrues across a drift whose chain was lost
      expect(r.trail.score[seg.endIndex]).toBeCloseTo(r.trail.score[seg.startIndex], 6);
    }
    // the total of everything that DID bank is the session total
    const banked = r.segments.filter((g) => !g.lost).reduce((a, g) => a + g.points, 0);
    expect(Math.round(banked)).toBe(session.score.total);
  });

  /**
   * THE SWEEP, and it is where the headline defect lived.
   *
   * The eight default fixtures all happen to have every `perDrift.total > 0`, so a replay that
   * treated "scored zero" as "no score data" agreed with the results screen on every one of them
   * and fabricated points on 28 of 112 fixture × seed runs — `rough` on 12 of 14 seeds, with a
   * running total reaching 7 953 on runs the engine scored 0. Nothing here reads a number off
   * the replay and compares it with the same number; every assertion crosses from the replay to
   * the scorer.
   */
  it('over a seed sweep: the replay never invents a score and never disagrees about what banked', () => {
    const seeds = [1, 2, 3, 5, 7, 11, 13, 17, 23, 42, 77, 101];
    let runs = 0;
    let driftsChecked = 0;
    const fabricated: string[] = [];
    const disagreed: string[] = [];
    const mismatched: string[] = [];
    for (const name of Object.keys(FIXTURES)) {
      for (const seed of seeds) {
        const s = buildFixtureSession({ ...FIXTURES[name], seed });
        const r = buildReplay(s);
        runs++;
        const lost = new Set(
          replayChains(s.drifts, s.states, resolveOptions())
            .scored.filter((d) => d.lost)
            .map((d) => d.id),
        );
        for (const seg of r.segments) {
          const ds = s.score.perDrift[seg.driftId];
          driftsChecked++;
          // what the scorer published is what the replay draws — including a published 0
          if (ds && Math.abs(seg.grossPoints - ds.total) > 1e-6) fabricated.push(`${name} s${seed} drift ${seg.driftId}: scorer ${ds.total.toFixed(1)} → replay ${seg.grossPoints.toFixed(1)}`);
          if (seg.lost !== lost.has(seg.driftId)) disagreed.push(`${name} s${seed} drift ${seg.driftId}`);
          // and a slide worth nothing makes no claim about points, anywhere it is named
          if (!(seg.points > 0)) {
            const exit = r.events.find((e) => e.kind === 'exit' && e.driftId === seg.driftId);
            if (exit && /\+\s*0\b/.test(exit.label)) fabricated.push(`${name} s${seed} drift ${seg.driftId}: exit ticker "${exit.label}"`);
            const hl = r.highlights.find((h) => h.driftId === seg.driftId);
            if (hl && /PTS/.test(hl.label)) fabricated.push(`${name} s${seed} drift ${seg.driftId}: highlight "${hl.label}"`);
          }
        }
        if (Math.round(r.trail.score[r.trail.n - 1]) !== s.score.total) {
          mismatched.push(`${name} s${seed}: trail ${r.trail.score[r.trail.n - 1].toFixed(1)} vs session ${s.score.total}`);
        }
      }
    }
    expect(runs).toBeGreaterThanOrEqual(90);
    expect(driftsChecked).toBeGreaterThan(300);
    expect(fabricated.slice(0, 6).join('\n')).toBe('');
    expect(disagreed.slice(0, 6).join('\n')).toBe('');
    expect(mismatched.slice(0, 6).join('\n')).toBe('');
  }, 600_000);

  it.each(names)('%s: β = course − heading holds, sample by sample', (name) => {
    const { session, replay: r } = built.get(name)!;
    const worstOf = (b: number, c: number, h: number) => Math.abs(wrapAngle(b - (c - h)));
    let states = 0;
    for (const st of session.states) states = Math.max(states, worstOf(st.beta, st.course, st.heading));
    let trail = 0;
    for (let k = 0; k < r.trail.n; k++) trail = Math.max(trail, worstOf(r.trail.beta[k], r.trail.course[k], r.trail.heading[k]));
    // the SESSION has to be a possible car before the builder ever sees it…
    expect(radToDeg(states)).toBeLessThan(0.01);
    // …and the trail it draws has to stay one
    expect(trail).toBeLessThan(IDENTITY_TOLERANCE);
    expect(r.warnings.join(' ')).not.toMatch(/disagrees with the heading/);
  });

  /**
   * THE PAN LIMITER IS A RAIL, NOT THE SHAPE OF THE SHOT — and the claim is now measured per
   * fixture rather than asserted once on the harbour run the rest of the camera suite uses.
   *
   * "The camera never touches its own limiter" stopped being true and nothing noticed: on
   * `handheld` the clamp fires on 74 chase frames and 78 cinematic ones. It fires because the
   * RECORDING teleports — the estimated position steps 9.28 m between two trail samples 50 ms
   * apart, 186 m/s against a reported 19.6 m/s — and turning that into a 0.15 s pan instead of a
   * one-frame jump is exactly what the rail is for. The property that has to hold is therefore
   * the conditional one, which is falsifiable: a clamped frame requires a recording that jumped,
   * and a recording that does not jump leaves the spring real headroom.
   */
  it('the pan limiter only fires where the recording itself jumps', () => {
    const dt = 1 / 60;
    const vp = { w: 393, h: 560 };
    for (const name of names) {
      const { replay: r } = built.get(name)!;
      let implied = 0;
      for (let i = 1; i < r.trail.n; i++) implied = Math.max(implied, Math.hypot(r.trail.x[i] - r.trail.x[i - 1], r.trail.y[i] - r.trail.y[i - 1]) * r.trail.hz);
      // a position that moves three times faster than the car ever did is not the car
      const teleports = implied > 3 * Math.max(1, r.info.maxSpeed);
      for (const mode of ['chase', 'cinematic'] as CameraMode[]) {
        const cam = new ReplayCamera(mode, vp);
        let prev = cam.update(r, 0, dt);
        let clamped = 0;
        let worst = 0;
        for (let t = dt; t <= r.durationS; t += dt) {
          const s = cam.update(r, t, dt);
          const pan = Math.hypot(s.cx - prev.cx, s.cy - prev.cy) / dt;
          worst = Math.max(worst, pan);
          if (pan > CAMERA_LIMITS.maxPan - 1e-6) clamped++;
          prev = s;
        }
        const where = `${name}/${mode}: ${clamped} clamped frames, peak ${worst.toFixed(1)} m/s, worst recorded step ${implied.toFixed(1)} m/s against ${r.info.maxSpeed.toFixed(1)} m/s driven`;
        if (!teleports) {
          expect(clamped, where).toBe(0);
          // and with room to spare, so the spring is what the viewer is watching
          expect(worst, where).toBeLessThan(0.8 * CAMERA_LIMITS.maxPan);
        }
      }
    }
  }, 300_000);

  /**
   * THE SAME LOOK-AHEAD CAP, ON EVERY FIXTURE AND BOTH AXES.
   *
   * The camera suite's own version of this runs on one simulated harbour run. The fixture whose
   * camera actually strains is `handheld`, and it is not in that suite. Measured here over all
   * eight × chase and cinematic at 0.25 s: |Δy| peaks at 85.8 pt in chase — the cap, exactly —
   * and 86.1 in cinematic (the ±1.4° sway swinging a pixel of the lateral offset onto the
   * vertical); |Δx| is ≤ 3.1 pt in chase and 14.9–38.4 in cinematic, which is the ±1.2 m sway
   * at that frame's own zoom. Nothing here depends on those numbers: the bound is recomputed
   * from the tuning and this frame's zoom.
   */
  it('the look-ahead cap holds on every fixture, on both axes', () => {
    const tall = { w: 390, h: 844 };
    const cap = CAMERA_TUNING.maxLookFrac * Math.min(tall.w, tall.h);
    for (const name of names) {
      const { replay: r } = built.get(name)!;
      for (const mode of ['chase', 'cinematic'] as CameraMode[]) {
        const slack = mode === 'cinematic' ? 1.5 : 1e-3;
        const cam = new ReplayCamera(mode, tall);
        for (let t = 0; t <= r.durationS; t += 0.25) {
          const st = cam.jumpTo(r, t);
          const p = poseAt(r, t);
          const sp = worldToScreen(st, p.x, p.y);
          const sway = mode === 'cinematic' ? CAMERA_TUNING.swayOffsetM * st.zoom : 0;
          const where = `${name}/${mode} t=${t.toFixed(2)}`;
          expect(Math.hypot(sp.x - tall.w / 2, sp.y - tall.h / 2), where).toBeLessThanOrEqual(cap + sway + slack);
          expect(Math.abs(sp.y - tall.h / 2), where).toBeLessThanOrEqual(cap + slack);
        }
      }
    }
  }, 300_000);

  /**
   * A SLIDE THE ENGINE PAID NOTHING FOR SAYS WHY, IN THE ENGINE'S OWN WORDS.
   *
   * `hero` on seed 13 is a trusted S-grade run (23 982 points) whose drift 3 — 46.43–49.36 s of
   * session clock, 44.38–47.31 s of replay clock — had all 2.93 s of it refused by the integrity
   * monitor, so the scorer published `total: 0` for it. The replay drew that slide a full ember
   * ribbon with a halo, an ember start tick and an ember end dot, banked nothing, and said
   * nothing: the ribbon and the silence disagreed and no frame said which was right, while the
   * results screen printed the session's own 9.36 s / 11.4 % one screen away.
   *
   * The eight default fixtures have every per-drift total above zero, which is why this needs a
   * seed — the same reason the fabricated-score defect survived a round.
   */
  it('a slide the monitor refused names the seconds instead of banking a number', () => {
    const s = buildFixtureSession({ ...FIXTURES.hero, seed: 13 });
    const r = buildReplay(s);
    expect(s.score.trusted).toBe(true);
    expect(s.integrity.suppressedS).toBeGreaterThan(1);
    const refused = r.segments.filter((g) => !g.lost && g.points === 0 && g.suppressedS > 0);
    expect(refused.length, 'hero seed 13 has exactly one refused slide, drift 3').toBe(1);
    const seg = refused[0];
    expect(seg.driftId).toBe(3);
    // the segment carries the ENGINE's duration, not one re-derived here — clamped to the
    // drift's own length exactly as the scorer clamps it (`stats.implausibleS`, drift.ts), because
    // `suppressedS` is measured BETWEEN samples and can land a few milliseconds past the end
    const drift = s.drifts.find((d) => d.id === seg.driftId)!;
    expect(seg.suppressedS).toBe(Math.min(drift.suppressedS, drift.durationS));
    expect(drift.suppressedS).toBeGreaterThanOrEqual(drift.durationS - 1e-9); // all of it

    const label = refusedLabel(seg);
    expect(label).toBe('2.9 S DID NOT COUNT');
    // it is a measurement, not a score: the untrusted gate must leave it alone, the way it
    // leaves "LOST IT 118°" alone
    expect(isPointsClaim(label)).toBe(false);
    // and it reaches BOTH places the exit of a slide is drawn
    const exit = r.events.find((e) => e.kind === 'exit' && e.driftId === seg.driftId)!;
    expect(exit.label).toBe(label);
    expect(exit.points).toBe(0);
    const end = r.markers.find((m) => m.kind === 'drift-end' && m.driftId === seg.driftId)!;
    expect(end.label).toBe(label);
    expect(end.suppressedS).toBeCloseTo(seg.suppressedS, 9);

    // no "+0" anywhere, and the running total is untouched across it
    expect(exit.label).not.toMatch(/[+\u2212-]\s*\d/);
    expect(r.trail.score[seg.endIndex]).toBeCloseTo(r.trail.score[seg.startIndex], 6);
    expect(Math.round(r.trail.score[r.trail.n - 1])).toBe(s.score.total);
  }, 120_000);

  /** The other two shapes of a zero: they have nothing to say, and say nothing. */
  it('a lost chain and an honest zero are not given the monitor\'s reason', () => {
    expect(refusedLabel({ lost: true, points: 0, suppressedS: 4 })).toBe('');
    expect(refusedLabel({ lost: false, points: 0, suppressedS: 0 })).toBe('');
    expect(refusedLabel({ lost: false, points: 1250, suppressedS: 4 })).toBe('');
    expect(refusedLabel({ lost: false, points: 0, suppressedS: 6.14 })).toBe('6.1 S DID NOT COUNT');
    // and across the shipped eight, nothing changed: none of them has a refused slide
    for (const name of names) {
      const { replay: r } = built.get(name)!;
      for (const seg of r.segments) {
        if (refusedLabel(seg) === '') continue;
        expect(seg.points, `${name} drift ${seg.driftId}`).toBe(0);
        expect(seg.lost).toBe(false);
      }
    }
  });

  it.each(names)('%s: the run is drawn to the end of it', (name) => {
    const { session, replay: r } = built.get(name)!;
    for (const d of session.drifts) {
      expect(d.startT - r.t0).toBeGreaterThanOrEqual(-1e-6);
      expect(d.endT - r.t0).toBeLessThanOrEqual(r.durationS + 1e-6);
    }
    expect(r.warnings.join(' ')).not.toMatch(/fell outside the replay window/);
  });
});
