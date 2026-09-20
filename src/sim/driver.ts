import { clamp, degToRad } from '../engine/types';
import type { Path } from './track';
import { Prng } from './prng';

/**
 * Scripted drift driver. Plans a speed profile v(s) and a slip-angle command β_cmd(s)
 * for each lap; the kinematic integrator tracks the command with a second-order response
 * whose damping depends on phase (under-damped initiation with an optional feint, calmer
 * hold, gentle exit) and whose angular acceleration is bounded like a real car's.
 *
 * Skill knobs:
 *  - aggression 0..1  → target angles, corner speeds, feint probability
 *  - consistency 0..1 → wobble amplitude, correction events, lap-to-lap variation
 */
export interface DriverOptions {
  aggression: number;
  consistency: number;
  seed: number;
}

export interface Corner {
  startS: number;
  endS: number;
  apexS: number;
  /** +1 left (κ>0), −1 right. */
  direction: 1 | -1;
  /** Mean radius over the whole corner, metres. */
  radius: number;
  /** Radius at the apex (tightest point), metres. */
  apexRadius: number;
}

export interface DriftSegment {
  startS: number;
  endS: number;
  /** Target slip angle, radians, signed (β>0 = right-hand drift). */
  beta: number;
  /** True when this segment flows straight into the next one (a transition, no exit). */
  linked: boolean;
  cornerIndex: number;
}

export interface LapPlan {
  lap: number;
  segments: DriftSegment[];
  /** Target speed at each path sample index (m/s). */
  vTarget: Float64Array<ArrayBuffer>;
}

export function findCorners(path: Path): Corner[] {
  const kMin = 1 / 70; // radius below 70 m counts as a corner
  const s = path.samples;
  const m = s.length;
  const corners: Corner[] = [];
  let i = 0;
  while (i < m) {
    if (Math.abs(s[i].kappa) > kMin) {
      const dir: 1 | -1 = s[i].kappa > 0 ? 1 : -1;
      let j = i;
      let kSum = 0;
      let kMax = 0;
      let apex = i;
      while (j < m && Math.abs(s[j].kappa) > kMin * 0.6 && Math.sign(s[j].kappa) === dir) {
        kSum += Math.abs(s[j].kappa);
        if (Math.abs(s[j].kappa) > kMax) {
          kMax = Math.abs(s[j].kappa);
          apex = j;
        }
        j++;
      }
      const len = (j - i) * path.ds;
      if (len > 12) {
        corners.push({
          startS: s[i].s,
          endS: s[Math.min(j, m - 1)].s,
          apexS: s[apex].s,
          direction: dir,
          radius: 1 / (kSum / (j - i)),
          apexRadius: 1 / kMax,
        });
      }
      i = j;
    } else i++;
  }
  return corners;
}

function targetAngleForRadius(radius: number, aggression: number): number {
  // R=15 → ~47°, R=40 → ~33°, R=60 → ~22°, scaled by aggression 0.75..1.15
  const deg = clamp(50 - 0.55 * (radius - 10), 14, 52) * (0.75 + 0.4 * aggression);
  return degToRad(deg);
}

function smoothArray(v: Float64Array, halfCells: number, closed: boolean): Float64Array<ArrayBuffer> {
  const m = v.length;
  const out = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let acc = 0;
    let n = 0;
    for (let k = -halfCells; k <= halfCells; k++) {
      let ii = i + k;
      if (closed) ii = ((ii % m) + m) % m;
      else if (ii < 0 || ii >= m) continue;
      acc += v[ii];
      n++;
    }
    out[i] = acc / n;
  }
  return out;
}

export function planLap(path: Path, corners: Corner[], lap: number, opt: DriverOptions, startFromRest = false): LapPlan {
  const rng = new Prng(opt.seed * 7919 + lap * 104729 + 17);
  const jitterAngle = degToRad(5) * (1 - opt.consistency);
  const jitterEntry = 8 * (1 - opt.consistency);
  const segments: DriftSegment[] = [];
  const speedFactor = 0.8 + 0.35 * opt.aggression;
  const cornerSpeedFor = (c: Corner) => {
    const aLat = 5.2 * speedFactor; // sustained lateral accel while drifting ≈ 0.55 g × aggression
    return clamp(Math.sqrt(aLat * c.radius), 9, path.def.vTop);
  };
  for (let ci = 0; ci < corners.length; ci++) {
    const c = corners[ci];
    const v = cornerSpeedFor(c);
    const lead = clamp(0.8 * v, 8, 22) + rng.gauss() * jitterEntry; // initiate before turn-in
    const target = targetAngleForRadius(c.radius, opt.aggression) + rng.gauss() * jitterAngle;
    // β sign: nose points INSIDE the corner → β = −direction·|β|
    const beta = -c.direction * Math.max(target, degToRad(10));
    segments.push({
      startS: c.startS - lead,
      endS: c.endS - clamp(0.25 * v, 3, 10),
      beta,
      linked: false,
      cornerIndex: ci,
    });
  }
  // Link corners that follow each other closely: the command flows straight from one
  // target angle into the next, so β swings through zero once (a transition) with no exit.
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const nextIdx = i + 1 < segments.length ? i + 1 : path.def.closed ? 0 : -1;
    if (nextIdx < 0) break;
    const next = segments[nextIdx];
    const wrap = nextIdx === 0 && i !== 0 ? path.length : 0;
    const gap = next.startS + wrap - seg.endS;
    if (gap < 55 && gap > -20) {
      seg.linked = true;
      seg.endS = next.startS + wrap; // hand over directly
    }
  }
  // Speed profile: curvature limit (smoothed so corner-entry speeds settle early), then
  // forward (throttle) and backward (brake) passes with gentle limits, then a light
  // smoothing so v̇ is continuous — real drift driving is throttle-held with one or two
  // brake applications per corner, not a min-time bang-bang profile.
  const m = path.samples.length;
  let vTarget: Float64Array<ArrayBuffer> = new Float64Array(m);
  const vTop = path.def.vTop * speedFactor;
  const kMin = 1 / 70;
  for (let i = 0; i < m; i++) {
    const k = Math.abs(path.samples[i].kappa);
    const vCurve = k > 1e-4 ? Math.sqrt((4.6 * speedFactor) / k) : Infinity;
    vTarget[i] = Math.min(vTop, vCurve);
  }
  vTarget = smoothArray(vTarget, Math.round(5 / path.ds), path.def.closed); // ±5 m
  const aAccStraight = 2.6 * (0.8 + 0.4 * opt.aggression);
  const aAccCorner = 1.5;
  const aBrk = 4.5;
  const accAt = (i: number) => (Math.abs(path.samples[i].kappa) > kMin ? aAccCorner : aAccStraight);
  const passes = path.def.closed ? 3 : 1;
  for (let p = 0; p < passes; p++) {
    for (let i = 1; i < m; i++) {
      vTarget[i] = Math.min(vTarget[i], Math.sqrt(vTarget[i - 1] ** 2 + 2 * accAt(i) * path.ds));
    }
    if (path.def.closed) vTarget[0] = Math.min(vTarget[0], Math.sqrt(vTarget[m - 1] ** 2 + 2 * accAt(0) * path.ds));
    for (let i = m - 2; i >= 0; i--) {
      vTarget[i] = Math.min(vTarget[i], Math.sqrt(vTarget[i + 1] ** 2 + 2 * aBrk * path.ds));
    }
    if (path.def.closed) vTarget[m - 1] = Math.min(vTarget[m - 1], Math.sqrt(vTarget[0] ** 2 + 2 * aBrk * path.ds));
  }
  if (!path.def.closed) {
    for (let i = 0; i < m; i++) {
      const remaining = path.samples[m - 1].s - path.samples[i].s;
      vTarget[i] = Math.min(vTarget[i], Math.sqrt(2 * aBrk * remaining) + 0.5);
    }
  }
  vTarget = smoothArray(vTarget, Math.round(4 / path.ds), path.def.closed && !startFromRest); // ±4 m
  if (startFromRest) {
    // the first lap accelerates out of the parked phase — no lap speed carried across the line
    vTarget[0] = Math.min(vTarget[0], 0.5);
    for (let i = 1; i < m; i++) vTarget[i] = Math.min(vTarget[i], Math.sqrt(vTarget[i - 1] ** 2 + 2 * accAt(i) * path.ds));
  }
  return { lap, segments, vTarget };
}

/**
 * Second-order tracker for β with phase-dependent damping and a bounded angular
 * acceleration (≤ 3.5 rad/s², about what a drift car's yaw dynamics allow).
 */
export class BetaTracker {
  beta = 0;
  betaDot = 0;
  private lastCmd = 0;
  private initiatingUntil = -1;
  private initiatingTarget = 0;
  private feintUntil = -1;
  private feintSign = 0;
  private wobblePhase: number[];
  private wobbleFreq: number[];
  private wobbleDrift: number[];
  private correction = 0;
  private correctionT = -10;
  private rng: Prng;
  readonly maxBetaAccel = 3.5; // rad/s² (initiation ≈0.8 s, transition peaks ≈110°/s)
  constructor(private opt: DriverOptions) {
    this.rng = new Prng(opt.seed * 31 + 5);
    this.wobblePhase = [0, 1, 2].map(() => this.rng.range(0, 6.28));
    this.wobbleFreq = [0.31, 0.53, 0.87].map((f) => f * this.rng.range(0.85, 1.15));
    this.wobbleDrift = [0, 1, 2].map(() => this.rng.range(-0.02, 0.02));
  }
  step(cmd: number, t: number, dt: number): void {
    const newSwing = cmd !== 0 && (Math.sign(cmd) !== Math.sign(this.lastCmd) || Math.abs(cmd) > Math.abs(this.lastCmd) + 0.05);
    if (newSwing) {
      this.initiatingUntil = t + 0.9;
      this.initiatingTarget = cmd;
      // Scandinavian-flick style feint before a fresh initiation (not on transitions)
      if (this.lastCmd === 0 && this.rng.next() < 0.35 + 0.5 * this.opt.aggression) {
        this.feintUntil = t + 0.28;
        this.feintSign = -Math.sign(cmd);
      }
    }
    const initiating = t < this.initiatingUntil && Math.abs(this.beta) < Math.abs(this.initiatingTarget) * 0.92;
    let wn: number;
    let zeta: number;
    if (cmd === 0) {
      wn = 2 * Math.PI * 0.5;
      zeta = 0.95; // gentle exit
    } else if (initiating) {
      wn = 2 * Math.PI * 1.0;
      zeta = 0.55; // flick with overshoot
    } else {
      wn = 2 * Math.PI * 0.75;
      zeta = 0.85; // hold
    }
    let ref = cmd;
    if (cmd !== 0) {
      if (t < this.feintUntil) {
        ref = this.feintSign * 0.25 * Math.abs(cmd);
      } else {
        // slow aperiodic wobble + occasional corrections model driver consistency
        const wob = (1 - this.opt.consistency) * 0.16;
        let w = 0;
        for (let i = 0; i < 3; i++) {
          this.wobblePhase[i] += this.wobbleDrift[i] * dt;
          w += Math.sin(2 * Math.PI * this.wobbleFreq[i] * t + this.wobblePhase[i]) / (i + 1);
        }
        ref = cmd * (1 + wob * w);
        if (this.rng.next() < dt * 0.4 * (1 - this.opt.consistency)) {
          this.correction = degToRad(6) * this.rng.gauss() * Math.sign(cmd);
          this.correctionT = t;
        }
        ref += this.correction * Math.exp(-(t - this.correctionT) / 0.5);
      }
    }
    let acc = wn * wn * (ref - this.beta) - 2 * zeta * wn * this.betaDot;
    acc = clamp(acc, -this.maxBetaAccel, this.maxBetaAccel);
    this.betaDot += acc * dt;
    this.beta += this.betaDot * dt;
    this.lastCmd = cmd;
  }
}
