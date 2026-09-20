/**
 * Scoring HONESTY — the regression tests for the judgement critique.
 *
 * Everything here runs the REAL modules end to end (`DriftDetector`, `DriftPipeline`), never a
 * perfect event derived from simulator truth. That is deliberate: the previous suite validated
 * the scorer against events it built itself, which is exactly why a spin the detector had
 * flagged could reach the results screen as a clean drift through 94 passing tests.
 *
 * Each test names the finding it pins down and the number that was measured.
 */
import { describe, expect, it } from 'vitest';
import { DriftDetector } from '../detect';
import { SPIN_ANGLE_DEG } from '../detect/options';
import { DriftPipeline } from '../pipeline';
import { simulateRun, type SimulatedRun, type TrackId } from '../../sim';
import { degToRad, radToDeg, type Grade, type Session, type SlipState } from '../types';
import { scoreSession, countTransitions, steadinessScore, angleScore, DEFAULT_SCORE_OPTIONS, LiveScorer } from './index';

// ── helpers ────────────────────────────────────────────────────────────────────────────────

/** A 100 Hz SlipState stream from a β(t) / speed(t) script. */
function synth(durS: number, f: (t: number) => { beta: number; speed: number }): SlipState[] {
  const out: SlipState[] = [];
  let x = 0;
  for (let i = 0; i <= Math.round(durS * 100); i++) {
    const t = i / 100;
    const { beta, speed } = f(t);
    x += speed * 0.01;
    const prev = i > 0 ? f(t - 0.01).beta : beta;
    out.push({
      t,
      beta,
      betaSigma: degToRad(0.8),
      heading: 0,
      course: beta,
      speed,
      // yaw consistent with the angle the driver is making, plus the corner's own rotation
      yawRate: 0.5 + (beta - prev) / 0.01,
      ay: 5,
      ax: 0,
      x,
      y: 0,
      valid: speed > 2,
    });
  }
  return out;
}

function detect(states: SlipState[]) {
  const det = new DriftDetector();
  for (const s of states) det.push(s);
  det.finish();
  return det;
}

/** Drive a simulated run through the whole pipeline, exactly as the app does. */
function drive(run: SimulatedRun): DriftPipeline {
  const p = new DriftPipeline({});
  const gps = run.gps.slice().sort((a, b) => a.t - b.t);
  let j = 0;
  for (let i = 0; i < run.motion.length; i++) {
    while (j < gps.length && gps[j].t <= run.motion[i].t) {
      p.pushGps(gps[j]);
      j++;
    }
    p.pushMotion(run.motion[i]);
  }
  while (j < gps.length) {
    p.pushGps(gps[j]);
    j++;
  }
  p.finish();
  return p;
}

const drivePipe = (track: TrackId, o: Parameters<typeof simulateRun>[1]) => drive(simulateRun(track, o));

// ── finding 1: a spin must reach the results screen ────────────────────────────────────────

describe('finding 1 — a spin the detector flagged reaches the score', () => {
  it('a 40° slide whose speed collapses to zero is a spin in BOTH the detector and scoreSession', () => {
    // measured before: the HUD said "CHAIN LOST −230 → total 0" while scoreSession returned
    // spins=0, grade A, total 330, quality 100 and fired PERFECT EXIT
    const states = synth(6, (t) => ({ beta: t > 1 ? degToRad(40) : 0, speed: t < 2.5 ? 14 : Math.max(0, 14 - (t - 2.5) * 20) }));
    const det = detect(states);
    expect(det.events.length).toBeGreaterThan(0);
    expect(det.events.some((e) => e.spin)).toBe(true);

    const b = scoreSession(det.events, states, null);
    expect(b.spins).toBe(det.events.filter((e) => e.spin).length);
    expect(b.spins).toBeGreaterThan(0);
    expect(b.total).toBe(0); // the chain was lost, so nothing banked
    expect(b.qualityParts.spinFactor).toBeLessThan(1);
    for (const d of Object.values(b.perDrift)) {
      if (!d.spun) continue;
      expect(d.cleanExit).toBe(false);
      expect(d.callouts.some((c) => c.kind === 'perfect-exit')).toBe(false);
    }
  });

  it('spins, transitions and drift count agree with the detector over a whole simulated run', () => {
    for (const track of ['harbor', 'touge'] as TrackId[]) {
      const pipe = drivePipe(track, { seed: 3, laps: 2, aggression: 1.0, consistency: 0.3 });
      const b = pipe.breakdown!;
      const drifts = pipe.drifts;
      expect(b.drifts).toBe(drifts.length);
      expect(b.spins).toBe(drifts.filter((e) => e.spin).length);
      // finding 21: ONE transition rule, so the two counts are equal by construction
      expect(b.transitions).toBe(drifts.reduce((a, e) => a + e.transitions, 0));
      for (const e of drifts) expect(b.perDrift[e.id].transitions, `drift ${e.id}`).toBe(e.transitions);
    }
  }, 120_000);
});

// ── finding 2: the 81× wheel-sawing exploit ────────────────────────────────────────────────

describe('finding 2 — sawing the wheel is not worth more than drifting', () => {
  const run30 = (f: (t: number) => number) => {
    const states = synth(36, (t) => ({ beta: t > 3 && t < 33 ? f(t) : 0, speed: 55 / 3.6 }));
    const det = detect(states);
    return { b: scoreSession(det.events, states, null), det };
  };

  it('a 2.5 Hz ±12° saw scores far LESS than one clean 40° slide (was 572 345 against 7 082)', () => {
    const clean = run30(() => degToRad(40));
    const saw = run30((t) => degToRad(12) * (Math.sin(2 * Math.PI * 1.25 * t) > 0 ? 1 : -1));
    expect(saw.b.total).toBeLessThan(clean.b.total);
    // the saw never HOLDS a side for the rule's dwell, so it earns no transitions at all
    expect(saw.b.transitions).toBe(0);
    const sawBonus = Object.values(saw.b.perDrift).reduce((a, d) => a + d.bonus, 0);
    expect(sawBonus).toBeLessThan(0.5 * saw.b.total + 1);
  });

  it('a legitimate 0.5 Hz manji is worth less than a whole skilled session', () => {
    const manji = run30((t) => degToRad(30) * (Math.sin(2 * Math.PI * 0.25 * t) > 0 ? 1 : -1));
    const session = drivePipe('harbor', { seed: 1, laps: 2, aggression: 0.8, consistency: 0.85 }).breakdown!;
    expect(manji.b.total).toBeLessThan(session.total);
  }, 120_000);

  it('the per-drift transition bonus is capped however many transitions there are', () => {
    const many = run30((t) => degToRad(30) * (Math.sin(2 * Math.PI * 0.4 * t) > 0 ? 1 : -1));
    const perDrift = Object.values(many.b.perDrift);
    for (const d of perDrift) {
      const paid = d.callouts.filter((c) => c.kind === 'transition');
      expect(paid.length).toBeLessThanOrEqual(DEFAULT_SCORE_OPTIONS.transitionBonusMaxPerDrift);
    }
  });
});

// ── finding 3: consistency must not drop the drifts that are inconsistent ──────────────────

describe('finding 3 — an unsettled drift is scored, never dropped', () => {
  it('a long drift whose angle never settles drags consistency down instead of leaving the average', () => {
    // a 20 s slide the driver never settles: 0.6 Hz correction kicks, ±9°
    const wander = synth(26, (t) => ({ beta: t > 3 && t < 23 ? degToRad(35 + 9 * Math.sin(2 * Math.PI * 0.6 * (t - 3))) : 0, speed: 60 / 3.6 }));
    const det = detect(wander);
    const b = scoreSession(det.events, wander, null);
    expect(b.drifts).toBeGreaterThan(0);
    // it is judged (the score exists) and it is judged BADLY
    expect(b.steadiness).toBeLessThan(75);
    // and a rock-steady slide of the same length is judged well, so the scale still works
    const steady = synth(26, (t) => ({ beta: t > 3 && t < 23 ? degToRad(35) : 0, speed: 60 / 3.6 }));
    const bs = scoreSession(detect(steady).events, steady, null);
    expect(bs.steadiness).toBeGreaterThan(b.steadiness + 20);
  });

  it('near-zero jitter over a sub-2 s window cannot claim 100', () => {
    // the rule: a perfect residual measured over nothing is not evidence of steadiness
    expect(steadinessScore(0, DEFAULT_SCORE_OPTIONS, 0)).toBeLessThan(45);
    expect(steadinessScore(0, DEFAULT_SCORE_OPTIONS, 0.5)).toBeLessThan(80);
    expect(steadinessScore(0, DEFAULT_SCORE_OPTIONS, 2)).toBe(100);
    expect(steadinessScore(0, DEFAULT_SCORE_OPTIONS, 10)).toBe(100);
    // and end to end: a 2 s slide is real, steady, and far too short to prove steadiness
    const short = synth(8, (t) => ({ beta: t > 3 && t < 5 ? degToRad(30) : 0, speed: 60 / 3.6 }));
    const b = scoreSession(detect(short).events, short, null);
    const d = Object.values(b.perDrift)[0];
    expect(d.stats.jitterDeg).toBeLessThan(0.25);
    expect(d.stats.plateauS).toBeLessThan(2);
    expect(d.consistency).toBeLessThan(100);
    expect(b.steadiness).toBeLessThan(100);
  });

  it('the more consistent driver scores the higher consistency, over matched pairs', () => {
    // measured before: the LESS consistent driver won 54 % of matched pairs on points and 9 %
    // on grade, because the drift that never settled was excluded from the average
    let wins = 0;
    let pairs = 0;
    for (const track of ['harbor', 'touge'] as TrackId[]) {
      for (const seed of [1, 2]) {
        for (const agg of [0.6, 1.0]) {
          const lo = drivePipe(track, { seed, laps: 2, aggression: agg, consistency: 0.2 }).breakdown!;
          const hi = drivePipe(track, { seed, laps: 2, aggression: agg, consistency: 0.95 }).breakdown!;
          pairs++;
          if (hi.consistency > lo.consistency) wins++;
        }
      }
    }
    expect(wins).toBe(pairs);
  }, 120_000);
});

// ── finding 4: the integrity monitor must be listened to ───────────────────────────────────

describe('finding 4 — a phone loose in its mount scores less, not more', () => {
  const base = { seed: 1, laps: 2, aggression: 0.8, consistency: 0.7 } as const;

  it('looseness never pays, and a compromised run refuses to vouch for its score', () => {
    // measured before: rigid 25 046, looseness 0.75 → 35 159 (+40 %), looseness 1.0 → 30 615
    const rigid = drivePipe('harbor', { ...base, looseness: 0 }).breakdown!;
    expect(rigid.integrity.scoreTrusted).toBe(true);
    // the coordinator's sweep: the gap between 0.25 and 1.0 is where a mid-loose mount hid
    for (const looseness of [0.25, 0.4, 0.6, 0.7, 0.85, 1.0]) {
      const b = drivePipe('harbor', { ...base, looseness }).breakdown!;
      expect(b.total, `looseness ${looseness}`).toBeLessThan(rigid.total);
      expect(b.integrity.scoreTrusted, `looseness ${looseness}`).toBe(false);
      expect(b.integrity.implausibleDriftFraction, `looseness ${looseness}`).toBeGreaterThan(DEFAULT_SCORE_OPTIONS.integrityMaxImplausibleFraction);
      expect(b.integrity.message.length, `looseness ${looseness}`).toBeGreaterThan(0);
    }
  }, 120_000);

  it('a calibration that cannot resolve which way the car points vetoes the score', () => {
    const pipe = drivePipe('harbor', { ...base, looseness: 0.7 });
    const diag = pipe.diagnostics;
    expect(diag.calibrationForwardResolved || diag.calibrationQuality < 0.3).toBe(true);
    expect(pipe.breakdown!.integrity.scoreTrusted).toBe(false);
  }, 120_000);
});

// ── GPS dropouts: dead reckoning is a measurement for a few seconds, then it is not ────────

describe('a GPS dropout keeps scoring while the estimate is still a measurement', () => {
  /** Drive a run frame by frame, keeping the truth alongside. */
  const driveFrames = (o: Parameters<typeof simulateRun>[1], cutGpsAfterS = Infinity) => {
    const run = simulateRun('harbor', o);
    const p = new DriftPipeline({});
    const gps = run.gps.slice().sort((a, b) => a.t - b.t);
    let j = 0;
    let lastFixT = -Infinity;
    const frames: Array<{ t: number; sinceFix: number; errDeg: number; counting: boolean; drifting: boolean; dPoints: number }> = [];
    let prev = 0;
    for (let i = 0; i < run.motion.length; i++) {
      while (j < gps.length && gps[j].t <= run.motion[i].t) {
        if (gps[j].t <= cutGpsAfterS) {
          p.pushGps(gps[j]);
          lastFixT = gps[j].t;
        }
        j++;
      }
      const f = p.pushMotion(run.motion[i]);
      frames.push({
        t: f.t,
        sinceFix: f.t - lastFixT,
        errDeg: Math.abs(radToDeg(f.state.beta - run.truth[i].beta)),
        counting: f.score.counting,
        drifting: f.phase !== 'idle',
        dPoints: f.score.total - prev,
      });
      prev = f.score.total;
    }
    p.finish();
    return { run, pipe: p, frames };
  };

  it('a few seconds without a fix is still accurate, still counting, and still paid', () => {
    const { frames } = driveFrames({ seed: 1, laps: 2, aggression: 0.8, consistency: 0.7, gpsDropouts: true });
    const inGap = frames.filter((f) => f.sinceFix > 1.5 && f.drifting);
    expect(inGap.length, 'this run is meant to drift through GPS dropouts').toBeGreaterThan(100);

    // the estimate is still tracking the truth: measured mean 1.4–3.2°, worse than 5° never
    const meanErr = inGap.reduce((a, f) => a + f.errDeg, 0) / inGap.length;
    const earned = inGap.reduce((a, f) => a + Math.max(0, f.dPoints), 0);
    const counting = inGap.filter((f) => f.counting).length / inGap.length;
    process.stdout.write(
      `\nGPS DROPOUTS: ${inGap.length} drifting samples with no fix, mean |β| error ${meanErr.toFixed(2)}°, ` +
        `${(100 * counting).toFixed(0)} % counting, ${Math.round(earned)} points earned\n`,
    );
    expect(meanErr, 'dead reckoning drifted off inside a short gap').toBeLessThan(5);
    // those points are EARNED: the car really was sideways and the angle was right
    expect(earned).toBeGreaterThan(0);
    // The great majority still counts. The minority that does not is doubted for a stated
    // reason at that instant (measured: slip inconsistent with the g-forces, or the forward
    // axis unresolvable without fixes) — never a blanket "there is no fix, so no points".
    expect(counting, 'a short gap should not stop the scorer').toBeGreaterThan(0.75);
  }, 120_000);

  it('once the estimator loses its course lock, nothing is scored and the engine says so', () => {
    // a dropout the simulator cannot produce: GPS simply stops. Past `courseTimeoutS` the slip
    // angle stops tracking truth — measured mean error 8.6° at 10–20 s, 24° at 40–80 s — and
    // the engine must already be refusing to pay by then.
    const CUT = 40;
    const { frames } = driveFrames({ seed: 1, laps: 2, aggression: 0.8, consistency: 0.7 }, CUT);
    const blind = frames.filter((f) => f.t > CUT + 12);
    expect(blind.length).toBeGreaterThan(500);
    const earned = blind.reduce((a, f) => a + Math.max(0, f.dPoints), 0);
    const counting = blind.filter((f) => f.counting).length;
    const meanErr = blind.reduce((a, f) => a + f.errDeg, 0) / blind.length;
    process.stdout.write(
      `TOTAL OUTAGE: ${blind.length} samples past ${CUT + 12} s, mean |β| error ${meanErr.toFixed(1)}°, ` +
        `${counting} counting, ${Math.round(earned)} points earned\n`,
    );
    expect(meanErr, 'the estimate should have degraded — if not, this test proves nothing').toBeGreaterThan(5);
    expect(earned, 'points were awarded from an extrapolation').toBe(0);
    expect(counting, 'the engine claimed to be scoring while blind').toBe(0);
    // the contrast is the point: a few seconds without a fix keeps scoring, a lost course lock
    // does not, and one boolean on the frame tells a display which of the two it is looking at
    const shortGap = driveFrames({ seed: 1, laps: 2, aggression: 0.8, consistency: 0.7, gpsDropouts: true }).frames.filter((f) => f.sinceFix > 1.5 && f.drifting);
    expect(shortGap.filter((f) => f.counting).length / shortGap.length).toBeGreaterThan(0.5);
  }, 120_000);
});

// ── the durable fallback: a session re-scored from storage, with no per-sample mask ────────

describe('a stored session re-scores without the per-sample mask', () => {
  /** Exactly what a results screen does with a session loaded from disk. */
  const reScore = (stored: Session) =>
    scoreSession(stored.drifts, stored.states, stored.track, undefined, {
      integrity: { mount: stored.integrity.mount, physics: stored.integrity.physics, gps: stored.integrity.gps, message: stored.integrity.message },
    });

  it('lands within a few percent of the live total on a partially-suppressed run', () => {
    // looseness 0.2: the monitor doubts part of several slides and all of one, and still
    // trusts the run overall — the case where the number actually gets published
    const pipe = drivePipe('harbor', { seed: 1, laps: 2, aggression: 0.8, consistency: 0.7, looseness: 0.2 });
    const live = pipe.finish();
    const stored = JSON.parse(JSON.stringify(live)) as Session;

    // the fallback is on the event and survived JSON
    for (const d of stored.drifts) expect(Number.isFinite(d.suppressedS), `drift ${d.id}`).toBe(true);
    const partial = stored.drifts.filter((d) => d.suppressedS > 0.01 && d.suppressedS < d.durationS - 0.01);
    expect(partial.length, 'this run is meant to exercise PARTIAL suppression').toBeGreaterThan(0);
    expect(stored.integrity.suppressedS).toBeGreaterThan(1);
    expect(live.score.trusted).toBe(true);

    const re = reScore(stored);
    const err = Math.abs(re.total - live.score.total) / Math.max(1, live.score.total);
    process.stdout.write(
      `\nRE-SCORE FROM STORAGE: live ${live.score.total} → ${re.total} (${(100 * err).toFixed(1)} %), ` +
        `${partial.length} partially and ${stored.drifts.filter((d) => d.suppressedS >= d.durationS - 0.01).length} fully suppressed slides of ${stored.drifts.length}\n`,
    );
    expect(err, `re-score drifted ${(100 * err).toFixed(1)} % from the live total`).toBeLessThan(0.04);
    // and it reproduces the VERDICT exactly, which is the part a screen must obey
    expect(re.integrity.scoreTrusted).toBe(live.score.trusted);
    expect(re.integrity.implausibleDriftFraction).toBeCloseTo(live.integrity.implausibleDriftFraction, 2);
  }, 120_000);

  it('reproduces the refusal exactly on a run the monitor did not believe', () => {
    // a fully-suppressed run: the points cannot be reconstructed from a per-drift duration —
    // the live pass also stopped the multiplier growing and stopped time-based callouts firing —
    // but the REFUSAL must survive storage, because that is what forbids showing them
    const live = drivePipe('harbor', { seed: 1, laps: 2, aggression: 0.8, consistency: 0.7, looseness: 0.4 }).finish();
    const stored = JSON.parse(JSON.stringify(live)) as Session;
    expect(live.score.trusted).toBe(false);
    const re = reScore(stored);
    expect(re.integrity.scoreTrusted).toBe(false);
    expect(re.integrity.implausibleDriftFraction).toBeCloseTo(live.integrity.implausibleDriftFraction, 2);
    expect(re.integrity.suppressedS).toBeGreaterThan(0.5 * live.integrity.suppressedS);
    // it errs DOWNWARD on a refused run: over-stating a run nobody may publish is the failure
    // mode this whole finding was about
    expect(re.total).toBeLessThanOrEqual(live.score.total);
  }, 120_000);

  it('a clean run round-trips to the same total', () => {
    const live = drivePipe('touge', { seed: 1, laps: 2, aggression: 0.8, consistency: 0.7 }).finish();
    const stored = JSON.parse(JSON.stringify(live)) as Session;
    expect(stored.drifts.every((d) => d.suppressedS === 0)).toBe(true);
    expect(reScore(stored).total).toBe(live.score.total);
  }, 120_000);
});

// ── finding 5: one spin threshold, and never a silent cliff ────────────────────────────────

describe('finding 5 — the detector and the scorer use ONE spin threshold', () => {
  it('there is no 76–85° dead band: the two modules agree at every angle', () => {
    expect(DEFAULT_SCORE_OPTIONS.spinAngleDeg).toBe(SPIN_ANGLE_DEG);
    // exactly AT the threshold the two filters (0.05 s first-order vs 0.1 s moving average)
    // sit on opposite sides of a float, so the pair 74.5 / 75.5 brackets it instead
    for (const deg of [60, 70, 74.5, 75.5, 76, 80, 84, 86, 90, 110]) {
      const states = synth(14, (t) => ({ beta: t > 3 && t < 11 ? degToRad(deg) : 0, speed: 60 / 3.6 }));
      const det = detect(states);
      const b = scoreSession(det.events, states, null);
      const detSpun = det.events.some((e) => e.spin);
      expect(b.spins > 0, `${deg}°`).toBe(detSpun);
      // and when points collapse, the run SAYS a spin happened — never a silent 378
      if (detSpun) {
        expect(b.spins, `${deg}°`).toBeGreaterThan(0);
        expect(b.qualityParts.spinFactor, `${deg}°`).toBeLessThan(1);
        expect(Object.values(b.perDrift).some((d) => d.lost), `${deg}°`).toBe(true);
      }
    }
  });
});

// ── the angle component: only angle the driver CONTROLLED, and a top worth reaching ────────

describe('the angle component counts controlled angle, and its top is not free', () => {
  /** `n` clean slides at `deg`, optionally followed by slides that spin out at `spinDeg`. */
  const run = (deg: number, n: number, spinDeg = 0, spins = 0) => {
    const seg = 8; // 6 s of slide + 2 s straight
    const states = synth(seg * (n + spins) + 2, (t) => {
      const k = Math.floor(t / seg);
      const p = t - k * seg;
      const sliding = p > 1 && p < 7;
      if (!sliding) return { beta: 0, speed: 60 / 3.6 };
      const d = k < n ? deg : spinDeg;
      // a spin runs away past the threshold instead of being held
      const b = k < n ? d : Math.min(d, 20 + (p - 1) * 30);
      return { beta: degToRad(b), speed: 60 / 3.6 };
    });
    const det = detect(states);
    return { b: scoreSession(det.events, states, null), det };
  };

  it('a slide that spun does not lend its angle to the score', () => {
    // measured on the sloppy fixture: ANGLE 100/100 — higher than the showcase run's 96 — off
    // three slides it had LOST, while the eight it actually drove averaged 17°, worth 0
    const clean = run(32, 3);
    const withSpin = run(32, 3, 85, 2);
    expect(withSpin.b.spins).toBeGreaterThan(0);
    expect(withSpin.b.angleDrifts).toBeLessThan(withSpin.b.drifts);
    // the spins reached far bigger angles, and the component is unmoved by them
    const spunPeak = Math.max(...Object.values(withSpin.b.perDrift).filter((d) => d.spun).map((d) => d.stats.heldPeakDeg));
    const heldPeak = Math.max(...Object.values(withSpin.b.perDrift).filter((d) => !d.spun).map((d) => d.stats.heldPeakDeg));
    expect(spunPeak).toBeGreaterThan(heldPeak);
    expect(Math.abs(withSpin.b.angle - clean.b.angle), 'the spins moved the angle component').toBeLessThan(2);
  });

  it('a driver who spins their biggest slides never out-scores a tidier one on angle', () => {
    // the shape of the two fixtures the screen puts side by side
    const showcase = run(40, 6);
    const sloppy = run(17, 8, 90, 3);
    expect(sloppy.b.spins).toBe(3);
    expect(showcase.b.angle, 'the showcase run must out-score the sloppy one on angle').toBeGreaterThan(sloppy.b.angle);
    // and the sloppy run gets what its CONTROLLED slides are worth, not what its spins reached
    expect(sloppy.b.angle).toBeLessThan(20);
  });

  it('over a skill sweep, the component is provably measured over the non-spun drifts only', () => {
    for (const track of ['harbor', 'touge'] as TrackId[])
      for (const [aggression, consistency] of [
        [1.0, 0.2],
        [0.8, 0.8],
        [0.3, 0.3],
      ] as Array<[number, number]>) {
        const b = drivePipe(track, { seed: 2, laps: 2, aggression, consistency }).breakdown!;
        const kept = Object.values(b.perDrift).filter((d) => !d.spun);
        expect(b.angleDrifts).toBe(kept.length);
        let sw = 0;
        let sv = 0;
        for (const d of kept) {
          const w = Math.max(DEFAULT_SCORE_OPTIONS.minWeightS, d.stats.durationS);
          sw += w;
          sv += w * d.stats.heldPeakDeg;
        }
        const expected = kept.length ? angleScore(sw > 0 ? sv / sw : 0, DEFAULT_SCORE_OPTIONS, b.trackFactor) : 0;
        expect(b.angle, `${track} ${aggression}/${consistency}`).toBeCloseTo(expected, 1);
      }
  }, 120_000);

  it('the top of the angle scale is not reached by any angle a driver could hold and keep', () => {
    const o = DEFAULT_SCORE_OPTIONS;
    // 100 must cost more than "get sideways once": every angle short of a spin still climbs
    expect(angleScore(37, o)).toBeLessThan(angleScore(44, o));
    expect(angleScore(44, o)).toBeLessThan(angleScore(55, o));
    expect(angleScore(55, o)).toBeLessThanOrEqual(angleScore(SPIN_ANGLE_DEG, o));
    expect(angleScore(44, o)).toBeLessThan(100);
    // and the scale is monotone everywhere, with no plateau below the spin threshold
    for (let d = 24; d < 59; d++) expect(angleScore(d + 1, o), `${d}° → ${d + 1}°`).toBeGreaterThan(angleScore(d, o));
  });
});

// ── finding 6: every grade reachable on every track ────────────────────────────────────────

describe('finding 6 — the grade uses its whole range on both tracks', () => {
  it('every letter is reachable on every track and no letter owns the grid', () => {
    // measured before: harbor gave S 0, A 7, B 70, C 23, D 0 over 200 runs, combined 48.7–77.6
    const AGG = [0.2, 0.6, 1.0];
    const CONS = [0.2, 0.6, 0.95];
    const SEEDS = [1, 2];
    const lines: string[] = ['\nGRADE REACHABILITY (aggression × consistency × seed, full pipeline)'];
    for (const track of ['harbor', 'touge'] as TrackId[]) {
      const grades: Grade[] = [];
      const byAgg = new Map<number, number[]>();
      let lo = Infinity;
      let hi = -Infinity;
      for (const aggression of AGG)
        for (const consistency of CONS)
          for (const seed of SEEDS) {
            const b = drivePipe(track, { seed, laps: 2, aggression, consistency }).breakdown!;
            grades.push(b.grade);
            lo = Math.min(lo, b.combined);
            hi = Math.max(hi, b.combined);
            byAgg.set(aggression, [...(byAgg.get(aggression) ?? []), b.combined]);
          }
      // driving harder must pay, on average: individual seeds may invert by a point or two when
      // the simulated driver gets less steady with aggression, but the trend may not
      const means = AGG.map((a) => {
        const v = byAgg.get(a) as number[];
        return v.reduce((x, y) => x + y, 0) / v.length;
      });
      lines.push(`${track.padEnd(7)} mean combined by aggression ${AGG.map((a, i) => `${a}→${means[i].toFixed(1)}`).join('  ')}`);
      for (let i = 1; i < means.length; i++) expect(means[i], `${track}: aggression ${AGG[i]} scores below ${AGG[i - 1]}`).toBeGreaterThan(means[i - 1]);
      const dist: Record<Grade, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
      for (const g of grades) dist[g]++;
      lines.push(
        `${track.padEnd(7)} ${(['S', 'A', 'B', 'C', 'D'] as Grade[]).map((g) => `${g}:${dist[g]}`).join(' ')}  ` +
          `combined ${lo.toFixed(1)}–${hi.toFixed(1)}  biggest letter ${((100 * Math.max(...Object.values(dist))) / grades.length).toFixed(0)}%`,
      );
      for (const g of ['S', 'A', 'B', 'C', 'D'] as Grade[]) expect(dist[g], `${track} grade ${g} is unreachable`).toBeGreaterThan(0);
      expect(Math.max(...Object.values(dist)) / grades.length, `${track}: one letter covers the grid`).toBeLessThanOrEqual(0.6);
      expect(hi - lo, `${track}: the scale is compressed`).toBeGreaterThan(35);
    }
    process.stdout.write(lines.join('\n') + '\n');
  }, 120_000);

  it('grades rise with skill: the best cell beats the worst by a wide margin on both tracks', () => {
    for (const track of ['harbor', 'touge'] as TrackId[]) {
      const best = drivePipe(track, { seed: 1, laps: 2, aggression: 1.0, consistency: 0.95 }).breakdown!;
      const worst = drivePipe(track, { seed: 1, laps: 2, aggression: 0.2, consistency: 0.2 }).breakdown!;
      expect(best.combined - worst.combined, track).toBeGreaterThan(25);
    }
  }, 120_000);
});

// ── finding 8: callouts that always fire and callouts that never fire are both non-events ──

describe('finding 8 — every callout fires sometimes and none fires always', () => {
  it('each discretionary kind lands between 8 % and 45 % of drifts over a seed sweep', () => {
    // measured before: high-speed 0 fires in 200 runs, perfect-exit 99.6 %, smooth 76.6 %
    const counts: Record<string, number> = {};
    let drifts = 0;
    for (const track of ['harbor', 'touge'] as TrackId[])
      for (const seed of [1, 2, 3])
        for (const [aggression, consistency] of [
          [0.5, 0.4],
          [0.9, 0.85],
        ] as Array<[number, number]>) {
          const b = drivePipe(track, { seed, laps: 2, aggression, consistency }).breakdown!;
          drifts += b.drifts;
          for (const d of Object.values(b.perDrift)) {
            const seen = new Set<string>();
            for (const c of d.callouts) {
              if (seen.has(c.kind)) continue; // one drift votes once per kind
              seen.add(c.kind);
              counts[c.kind] = (counts[c.kind] ?? 0) + 1;
            }
          }
        }
    const kinds = ['extreme-angle', 'long-drift', 'smooth', 'high-speed', 'manji', 'perfect-exit'];
    const rates = kinds.map((k) => `${k} ${(((counts[k] ?? 0) / drifts) * 100).toFixed(0)}%`);
    process.stdout.write(`\nCALLOUT FIRING over ${drifts} drifts: ${rates.join('  ')}\n`);
    for (const k of kinds) {
      const rate = (counts[k] ?? 0) / drifts;
      expect(rate, `${k} fires on ${(100 * rate).toFixed(0)}% of drifts`).toBeGreaterThanOrEqual(0.08);
      expect(rate, `${k} fires on ${(100 * rate).toFixed(0)}% of drifts`).toBeLessThanOrEqual(0.45);
    }
  }, 120_000);
});

// ── finding 10: one corner must not be the whole story, silently ───────────────────────────

describe('finding 10 — the results data says how much of the run was one corner', () => {
  it('reports best share, the median drift and a duration-normalised total', () => {
    const b = drivePipe('harbor', { seed: 1, laps: 2, aggression: 0.8, consistency: 0.8 }).breakdown!;
    expect(b.bestShare).toBeGreaterThan(0);
    expect(b.bestShare).toBeLessThanOrEqual(1);
    expect(b.medianDriftPoints).toBeGreaterThan(0);
    expect(b.pointsPerDriftSecond).toBeGreaterThan(0);
    expect(b.pointsPerDriftSecond * b.driftTimeS).toBeCloseTo(b.total, -2);
  }, 120_000);
});

// ── finding 11: driving fewer laps must not raise the grade ────────────────────────────────

describe('finding 11 — unproven cross-lap consistency is neutral, not absent', () => {
  it('one lap never out-scores two for the same driver', () => {
    // measured before: the same driver graded S over 1 lap and A over 2
    const rank: Record<Grade, number> = { D: 0, C: 1, B: 2, A: 3, S: 4 };
    for (const seed of [1, 2, 3]) {
      const one = drivePipe('harbor', { seed, laps: 1, aggression: 0.8, consistency: 0.85 }).breakdown!;
      const two = drivePipe('harbor', { seed, laps: 2, aggression: 0.8, consistency: 0.85 }).breakdown!;
      expect(one.crossLapConsistency, `seed ${seed}`).toBeNull();
      expect(two.crossLapConsistency, `seed ${seed}`).not.toBeNull();
      // the unproven term is scored NEUTRAL, so one lap cannot buy consistency by omission
      expect(one.consistency, `seed ${seed}`).toBeLessThan(one.steadiness);
      expect(rank[one.grade], `seed ${seed}: ${one.grade} over 1 lap vs ${two.grade} over 2`).toBeLessThanOrEqual(rank[two.grade]);
      expect(one.combined, `seed ${seed}`).toBeLessThanOrEqual(two.combined + 2.5);
    }
  }, 120_000);
});

// ── finding 15: steadiness must not improve when the sensors get noisier ───────────────────

describe('finding 15 — consistency is monotonic in sensor noise', () => {
  it('the same drift scored with more β noise never scores steadier', () => {
    // the mechanism, isolated from detection: one drift, the same shape, progressively noisier
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    const vals: number[] = [];
    for (const noiseDeg of [0, 0.5, 1, 2, 3]) {
      seed = 12345;
      const states = synth(26, (t) => ({ beta: t > 3 && t < 23 ? degToRad(35 + noiseDeg * 3.4 * rnd()) : 0, speed: 60 / 3.6 }));
      const det = detect(states);
      vals.push(scoreSession(det.events, states, null).steadiness);
    }
    process.stdout.write(`\nSTEADINESS vs INJECTED β NOISE: ${vals.map((v, i) => `${[0, 0.5, 1, 2, 3][i]}°→${v.toFixed(1)}`).join('  ')}\n`);
    for (let i = 1; i < vals.length; i++) expect(vals[i], `noise step ${i}`).toBeLessThanOrEqual(vals[i - 1] + 0.5);
  });

  it('steadiness never rises materially with injected sensor vibration', () => {
    // measured before: vibration 0 → 58.8, vibration 1 → 87.8 (grade B → A), because an
    // unbounded noise-floor estimate was subtracted from the jitter in quadrature
    const vals = [0, 1, 2, 3].map((vibration) => drivePipe('harbor', { seed: 1, laps: 2, aggression: 0.8, consistency: 0.7, vibration }).breakdown!.steadiness);
    process.stdout.write(`\nSTEADINESS vs VIBRATION: ${vals.map((v, i) => `${i}→${v.toFixed(1)}`).join('  ')}\n`);
    // end to end each vibration level is a different stream, so the detector finds slightly
    // different drifts; what must never come back is the +29 inversion (58.8 → 87.8) that an
    // unbounded noise-floor subtraction produced
    for (let i = 1; i < vals.length; i++) expect(vals[i], `vibration ${i} vs ${i - 1}`).toBeLessThanOrEqual(vals[i - 1] + 8);
    expect(vals[vals.length - 1]).toBeLessThan(vals[0]);
  }, 120_000);
});

// ── finding 20 / the O(n) LiveScorer.remember() ────────────────────────────────────────────

describe('the live scorer stays O(1) per sample past its 120 s window', () => {
  it('a 150 s run costs no more per sample after the ring fills than before', () => {
    // measured before: 70.5 µs/sample against 7.1 µs for the whole rest of the engine, because
    // the ring was re-`slice()`d on every push once it held 12 000 samples. Runs under two
    // minutes never reached it, which is why no test saw it.
    const o = DEFAULT_SCORE_OPTIONS;
    const n = Math.round(150 * 100);
    const states: SlipState[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / 100;
      states[i] = { t, beta: degToRad(30 * Math.sin(2 * Math.PI * 0.02 * t)), betaSigma: 0.01, heading: 0, course: 0, speed: 16, yawRate: 0.6, ay: 5, ax: 0, x: 16 * t, y: 0, valid: true };
    }
    const sc = new LiveScorer();
    const time = (from: number, to: number): number => {
      const t0 = performance.now();
      for (let i = from; i < to; i++) sc.push(states[i], null);
      return (performance.now() - t0) / (to - from);
    };
    const early = time(0, 2000); // the first 20 s: the ring is nowhere near full
    const late = time(n - 2000, n); // well past the 120 s window
    expect(sc.total).toBe(0);
    process.stdout.write(`\nLiveScorer.push: ${(early * 1000).toFixed(1)} µs/sample early, ${(late * 1000).toFixed(1)} µs/sample after the ${o.ringKeepS} s ring filled\n`);
    expect(late).toBeLessThan(Math.max(4 * early, 0.02));
  });
});

// ── finding 21: one transition rule, used by all three ─────────────────────────────────────

describe('finding 21 — there is one transition rule', () => {
  it('the detector, the scorer and countTransitions() agree on a feint', () => {
    // a 0.2 s flick to −12° inside a 30° slide: the bare sign-change rule called this 2
    const states = synth(14, (t) => ({ beta: t > 3 && t < 11 ? degToRad(t > 6 && t < 6.2 ? -12 : 30) : 0, speed: 60 / 3.6 }));
    const det = detect(states);
    const b = scoreSession(det.events, states, null);
    const beta = states.map((s) => s.beta);
    expect(countTransitions(beta, { t: states.map((s) => s.t), yawRate: states.map((s) => s.yawRate) })).toBe(0);
    expect(det.events.reduce((a, e) => a + e.transitions, 0)).toBe(0);
    expect(b.transitions).toBe(0);
  });

  it('a real swing is counted once by all three', () => {
    const states = synth(16, (t) => ({ beta: t < 3 || t > 13 ? 0 : degToRad(t < 8 ? 30 : -30), speed: 60 / 3.6 }));
    const det = detect(states);
    const b = scoreSession(det.events, states, null);
    expect(countTransitions(states.map((s) => s.beta), { t: states.map((s) => s.t), yawRate: states.map((s) => s.yawRate) })).toBe(1);
    expect(det.events.reduce((a, e) => a + e.transitions, 0)).toBe(1);
    expect(b.transitions).toBe(1);
  });
});

// ── the metrics table the critique asked to be able to READ ────────────────────────────────

describe('session metrics table', () => {
  it('prints what a run scores and why', () => {
    const rows: string[] = [
      '\nSESSION SCORING (full pipeline, 2 laps)',
      'run                     grade  comb  angle  cons  qual  speed style   total  best%  pts/s  drifts spins trusted',
    ];
    for (const [track, aggression, consistency] of [
      ['harbor', 0.8, 0.85],
      ['harbor', 0.3, 0.3],
      ['touge', 0.8, 0.85],
      ['touge', 0.3, 0.3],
      ['harbor', 1.0, 0.95],
    ] as Array<[TrackId, number, number]>) {
      const b = drivePipe(track, { seed: 1, laps: 2, aggression, consistency }).breakdown!;
      const p = (v: number, n = 6, d = 1) => v.toFixed(d).padStart(n);
      rows.push(
        `${`${track} agg${aggression} con${consistency}`.padEnd(23)} ${b.grade.padEnd(5)} ${p(b.combined, 5)} ${p(b.angle)} ${p(b.consistency)} ${p(b.quality)} ${p(b.speed)} ${p(b.style)} ` +
          `${String(b.total).padStart(7)} ${p(100 * b.bestShare, 6, 0)} ${p(b.pointsPerDriftSecond, 6, 0)} ${String(b.drifts).padStart(6)} ${String(b.spins).padStart(5)} ${String(b.integrity.scoreTrusted).padStart(7)}`,
      );
    }
    process.stdout.write(rows.join('\n') + '\n');
    expect(rows.length).toBeGreaterThan(2);
  }, 120_000);
});

/** Degrees, for the reader of the failures above. */
export const _deg = radToDeg;
