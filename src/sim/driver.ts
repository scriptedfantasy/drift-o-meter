import { clamp, degToRad } from '../engine/types';
import type { Path } from './track';
import { Prng } from './prng';

/**
 * Scripted drift driver. Plans a speed profile v(s) and a slip-angle command β_cmd(s)
 * for each lap, then the kinematic integrator tracks the command with a second-order
 * response (snappy, slightly under-damped initiation; calmer exit).
 *
 * Skill knobs:
 *  - aggression 0..1  → target angles and corner speeds
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
  radius: number;
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
  vTarget: Float64Array;
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

export function planLap(path: Path, corners: Corner[], lap: number, opt: DriverOptions): LapPlan {
  const rng = new Prng(opt.seed * 7919 + lap * 104729 + 17);
  const jitterAngle = degToRad(5) * (1 - opt.consistency);
  const jitterEntry = 8 * (1 - opt.consistency);
  const segments: DriftSegment[] = [];
  const speedFactor = 0.8 + 0.35 * opt.aggression;
  const cornerSpeedFor = (c: Corner) => {
    // sustained lateral accel while drifting ~ 0.55 g scaled by aggression
    const aLat = 5.2 * speedFactor;
    return clamp(Math.sqrt(aLat * c.radius), 9, path.def.vTop);
  };
  for (let ci = 0; ci < corners.length; ci++) {
    const c = corners[ci];
    const v = cornerSpeedFor(c);
    const lead = clamp(0.8 * v, 8, 22) + rng.gauss() * jitterEntry; // initiate before turn-in
    const target = targetAngleForRadius(c.radius, opt.aggression) + rng.gauss() * jitterAngle;
    // β sign: nose points INSIDE the corner → β = −direction·|β|
    const beta = -c.direction * Math.max(target, degToRad(10));
    const next = corners[ci + 1] ?? (path.def.closed ? corners[0] : undefined);
    let linked = false;
    if (next) {
      const gap = next.startS - c.endS + (next === corners[0] && path.def.closed ? path.length : 0);
      linked = gap < 55 && gap > -20;
    }
    segments.push({
      startS: c.startS - lead,
      endS: c.endS - clamp(0.25 * v, 3, 10),
      beta,
      linked,
      cornerIndex: ci,
    });
  }
  // Speed profile: curvature limit, then forward (accel) and backward (brake) passes.
  const m = path.samples.length;
  const vTarget = new Float64Array(m);
  const vTop = path.def.vTop * speedFactor;
  for (let i = 0; i < m; i++) {
    const k = Math.abs(path.samples[i].kappa);
    const vCurve = k > 1e-4 ? Math.sqrt((5.2 * speedFactor) / k) : Infinity;
    vTarget[i] = Math.min(vTop, vCurve);
  }
  const aAcc = 3.2 * (0.8 + 0.4 * opt.aggression);
  const aBrk = 6.5;
  const passes = path.def.closed ? 3 : 1;
  for (let p = 0; p < passes; p++) {
    for (let i = 1; i < m; i++) {
      const vPrev = vTarget[i - 1];
      vTarget[i] = Math.min(vTarget[i], Math.sqrt(vPrev * vPrev + 2 * aAcc * path.ds));
    }
    if (path.def.closed) vTarget[0] = Math.min(vTarget[0], Math.sqrt(vTarget[m - 1] ** 2 + 2 * aAcc * path.ds));
    for (let i = m - 2; i >= 0; i--) {
      const vNext = vTarget[i + 1];
      vTarget[i] = Math.min(vTarget[i], Math.sqrt(vNext * vNext + 2 * aBrk * path.ds));
    }
    if (path.def.closed) vTarget[m - 1] = Math.min(vTarget[m - 1], Math.sqrt(vTarget[0] ** 2 + 2 * aBrk * path.ds));
  }
  if (!path.def.closed) {
    // start from a rolling start and coast to a stop at the end
    for (let i = 0; i < m; i++) {
      vTarget[i] = Math.min(vTarget[i], 6 + Math.sqrt(2 * aAcc * path.samples[i].s));
      const remaining = path.samples[m - 1].s - path.samples[i].s;
      vTarget[i] = Math.min(vTarget[i], Math.sqrt(2 * aBrk * remaining) + 0.5);
    }
  }
  return { lap, segments, vTarget };
}

/** Second-order tracker for β: snappy under-damped initiation, calmer hold and exit. */
export class BetaTracker {
  beta = 0;
  betaDot = 0;
  private lastCmd = 0;
  private wobblePhase: number[];
  private wobbleFreq: number[];
  private correction = 0;
  private correctionT = 0;
  private rng: Prng;
  constructor(private opt: DriverOptions) {
    this.rng = new Prng(opt.seed * 31 + 5);
    this.wobblePhase = [this.rng.range(0, 6.28), this.rng.range(0, 6.28), this.rng.range(0, 6.28)];
    this.wobbleFreq = [0.35, 0.6, 0.9].map((f) => f * this.rng.range(0.85, 1.15));
  }
  step(cmd: number, t: number, dt: number): void {
    const entering = Math.abs(cmd) > Math.abs(this.lastCmd) + 1e-6 || Math.sign(cmd) !== Math.sign(this.lastCmd);
    // natural frequency / damping per phase
    let wn: number;
    let zeta: number;
    if (cmd === 0) {
      wn = 2 * Math.PI * 0.55;
      zeta = 0.95;
    } else if (entering && Math.abs(this.beta) < Math.abs(cmd) * 0.9) {
      wn = 2 * Math.PI * 1.1;
      zeta = 0.55; // initiation flick with overshoot
    } else {
      wn = 2 * Math.PI * 0.8;
      zeta = 0.85;
    }
    // wobble + occasional corrections model driver consistency
    const wob = (1 - this.opt.consistency) * 0.16;
    let ref = cmd;
    if (cmd !== 0) {
      let w = 0;
      for (let i = 0; i < 3; i++) w += Math.sin(2 * Math.PI * this.wobbleFreq[i] * t + this.wobblePhase[i]) / (i + 1);
      ref = cmd * (1 + wob * w);
      if (this.rng.next() < dt * 0.4 * (1 - this.opt.consistency)) {
        this.correction = degToRad(6) * this.rng.gauss() * Math.sign(cmd);
        this.correctionT = t;
      }
      ref += this.correction * Math.exp(-(t - this.correctionT) / 0.5);
    }
    const acc = wn * wn * (ref - this.beta) - 2 * zeta * wn * this.betaDot;
    this.betaDot += acc * dt;
    this.beta += this.betaDot * dt;
    this.lastCmd = cmd;
  }
}
