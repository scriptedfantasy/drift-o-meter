import type { DriftEvent, DriftPhase, SlipState } from '../types';
import { type DetectOptions, type TransitionRule, TransitionCounter, resolveOptions } from './options';

/**
 * Drift detector — a real-time state machine over the 100 Hz SlipState stream.
 *
 *   idle ──entry gates──▶ entry ──held entryHoldS──▶ drifting ◀──▶ exit (hold) ──held exitHoldS──▶ (pending merge) ──▶ event
 *                                                       │  ▲
 *                                                 sign change (quick swing) = transition, drift continues
 *
 * Every decision is taken on lightly filtered signals (first-order, `filterTauS`), and every
 * debounce is a leaky timer: it grows while its condition holds and unwinds `timerDecayRatio`
 * times faster while it does not, so an isolated noisy sample never resets a hold.
 *
 * Time placement follows a human judge rather than the thresholds: the event starts where |β|
 * last rose through `exitAngle` before the 8° confirmation (backdated, ≤ onsetMaxLookbackS) and
 * ends where |β| dropped below `exitAngle` for good, not where the 600 ms hold expired.
 *
 * Initiations that begin with a Scandinavian-flick FEINT — a brief, small excursion the wrong
 * way that reverses straight into the slide — start at the flick: that is where the car left
 * straight running. The flick is part of the initiation, never a transition, which is enforced
 * generally by only counting a swing once the new side has been held `transitionMinDwellS`.
 *
 * A finished drift is kept "pending" for `mergeGapS`; a new drift confirmed inside that window
 * re-opens it (one linked event). `completed` is therefore emitted up to mergeGapS after the
 * exit, except for spins / stops / finish(), which close at once.
 */

export interface LiveDrift {
  id: number;
  startT: number;
  durationS: number;
  /** Current |β|, radians. */
  angle: number;
  peakAngle: number;
  /** Current side: +1 right-hand drift (β>0), −1 left. */
  direction: 1 | -1;
  transitions: number;
  speed: number;
  /** Running mean / std-dev of |β| over the sustained portion so far. */
  meanAngle: number;
  angleStdDev: number;
  distanceM: number;
  /** True on the sample where a spin was detected (the drift ends there). */
  spin: boolean;
}

export interface DetectorOutput {
  phase: DriftPhase;
  live: LiveDrift | null;
  /** A finalised event, on the sample where it is finalised. Also appended to `events`. */
  completed: DriftEvent | null;
  /** Index of this sample in the stream of pushed samples (0-based). */
  sampleIndex: number;
}

type Mode = 'idle' | 'entry' | 'drifting' | 'exit' | 'recover';

interface Rec {
  t: number;
  idx: number;
  /** Filtered |β|. */
  b: number;
  sign: 1 | -1;
  speed: number;
  yaw: number;
  ay: number;
  dt: number;
}

/** One departure from straight running: |β| above `feintAngle` on one side. */
interface Excursion {
  startT: number;
  startIdx: number;
  sign: 1 | -1;
  peak: number;
  /** Last time |β| was still above the level. */
  endT: number;
}

interface Snapshot {
  peak: number;
  peakT: number;
  speedSum: number;
  speedN: number;
  minSpeed: number;
  dist: number;
  peakYaw: number;
  peakAy: number;
  transitions: number;
  nArr: number;
}

class Drift {
  startT: number;
  startIdx: number;
  entrySpeed: number;
  initialDirection: 1 | -1;
  /** Direction changes, counted by the ONE shared rule (see options.ts). */
  readonly tc: TransitionCounter;
  peak = 0;
  peakT: number;
  speedSum = 0;
  speedN = 0;
  minSpeed = Infinity;
  dist = 0;
  peakYaw = 0;
  peakAy = 0;
  /** Valid samples: time and filtered |β|. */
  tArr: number[] = [];
  bArr: number[] = [];
  // running Welford over the sustained portion (lagged by statsEdgeS)
  wN = 0;
  wMean = 0;
  wM2 = 0;
  wCommitted = 0;
  spin = false;
  /** Set when the drift has ended (pending merge). */
  endT = NaN;
  endIdx = -1;
  snap: Snapshot | null = null;

  constructor(
    public id: number,
    r: Rec,
    rule: TransitionRule,
  ) {
    this.startT = r.t;
    this.startIdx = r.idx;
    this.entrySpeed = r.speed;
    this.initialDirection = r.sign;
    this.tc = new TransitionCounter(rule, r.t, r.sign, r.yaw);
    this.peakT = r.t;
  }

  get side(): 1 | -1 {
    return this.tc.side;
  }

  get transitions(): number {
    return this.tc.transitions;
  }

  get transitionPhaseUntil(): number {
    return this.tc.phaseUntil;
  }

  add(r: Rec): void {
    this.tArr.push(r.t);
    this.bArr.push(r.b);
    if (r.b > this.peak) {
      this.peak = r.b;
      this.peakT = r.t;
    }
    this.speedSum += r.speed;
    this.speedN++;
    if (r.speed < this.minSpeed) this.minSpeed = r.speed;
    this.dist += r.speed * r.dt;
    const ya = Math.abs(r.yaw);
    if (ya > this.peakYaw) this.peakYaw = ya;
    const aa = Math.abs(r.ay);
    if (aa > this.peakAy) this.peakAy = aa;
  }

  snapshot(): Snapshot {
    return {
      peak: this.peak,
      peakT: this.peakT,
      speedSum: this.speedSum,
      speedN: this.speedN,
      minSpeed: this.minSpeed,
      dist: this.dist,
      peakYaw: this.peakYaw,
      peakAy: this.peakAy,
      transitions: this.transitions,
      nArr: this.tArr.length,
    };
  }

  /** Commit samples older than `edge` (and past the leading edge) to the live Welford stats. */
  commitLive(now: number, edge: number): void {
    const lo = this.startT + edge;
    const hi = now - edge;
    while (this.wCommitted < this.tArr.length && this.tArr[this.wCommitted] < hi) {
      const t = this.tArr[this.wCommitted];
      if (t >= lo) {
        const x = this.bArr[this.wCommitted];
        this.wN++;
        const d = x - this.wMean;
        this.wMean += d / this.wN;
        this.wM2 += d * (x - this.wMean);
      }
      this.wCommitted++;
    }
  }

}

function meanStd(tArr: number[], bArr: number[], n: number, lo: number, hi: number): { mean: number; std: number } {
  let cnt = 0;
  let mean = 0;
  let m2 = 0;
  for (let i = 0; i < n; i++) {
    const t = tArr[i];
    if (t < lo || t > hi) continue;
    const x = bArr[i];
    cnt++;
    const d = x - mean;
    mean += d / cnt;
    m2 += d * (x - mean);
  }
  if (cnt === 0) return { mean: NaN, std: NaN };
  return { mean, std: cnt > 1 ? Math.sqrt(m2 / cnt) : 0 };
}

/** Time/index at which |β| crossed `level` between two valid samples (linear; clamps to the samples). */
function crossing(prev: Rec | null, cur: Rec, level: number): { t: number; idx: number } {
  if (!prev || cur.t <= prev.t || prev.b === cur.b) return { t: cur.t, idx: cur.idx };
  let f = (level - prev.b) / (cur.b - prev.b);
  if (!(f >= 0)) f = 0;
  if (f > 1) f = 1;
  return { t: prev.t + f * (cur.t - prev.t), idx: prev.idx + Math.round(f * (cur.idx - prev.idx)) };
}

export class DriftDetector {
  readonly opts: DetectOptions;
  /** Finalised events, in order. */
  readonly events: DriftEvent[] = [];
  /**
   * Compatibility view of `DriftEvent.spin`, derived from `events` — NOT a side map.
   * The spin verdict lives on the event itself; nothing in the engine reads this.
   * @deprecated read `DriftEvent.spin`.
   */
  get spins(): ReadonlyMap<number, boolean> {
    const m = new Map<number, boolean>();
    for (const e of this.events) m.set(e.id, e.spin);
    return m;
  }

  /** Next drift id. Monotonic: an id is never handed to a second drift, not even after a twitch is dropped. */
  private nextId = 1;
  private readonly tRule: TransitionRule;
  private sampleIndex = -1;
  private lastT: number | null = null;
  private lastValidT: number | null = null;
  private lastValidIdx = -1;
  private lastSpeed = 0;
  private invalidSince: number | null = null;
  private invalidSnap: Snapshot | null = null;
  private fInit = false;
  private fBeta = 0;
  private fYaw = 0;
  private fAy = 0;
  private hist: Rec[] = [];
  /** Last valid sample, for interpolating threshold crossings across gaps. */
  private prev: Rec | null = null;
  private onsetT: number | null = null;
  private onsetIdx = 0;
  /** Current excursion out of the straight band (|β| ≥ feintAngle) and the one before it. */
  private exc: Excursion | null = null;
  private prevExc: Excursion | null = null;
  /** End of the newest finalised event: no later drift may be backdated before it. */
  private lastEventEndT = -Infinity;
  /** No start may be backdated before this (first valid sample after a blind gap > invalidHoldS). */
  private floorT = -Infinity;
  private floorIdx = 0;
  private floorPending = false;
  private mode: Mode = 'idle';
  private cand: { startT: number; startIdx: number; sign: 1 | -1; peak: number; dist: number } | null = null;
  private entryTimer = 0;
  private drift: Drift | null = null;
  private exitTimer = 0;
  private holdStartT = 0;
  private holdStartIdx = 0;
  private pending: Drift | null = null;
  private recoverTimer = 0;

  constructor(opts?: Partial<DetectOptions>) {
    this.opts = resolveOptions(opts);
    const o = this.opts;
    this.tRule = {
      angleRad: o.transitionAngle,
      minDwellS: o.transitionMinDwellS,
      maxSwingS: o.transitionMaxSwingS,
      yawRate: o.transitionYawRate,
      phaseHoldS: o.transitionPhaseHoldS,
    };
  }

  reset(): void {
    this.events.length = 0;
    this.nextId = 1;
    this.sampleIndex = -1;
    this.lastT = null;
    this.lastValidT = null;
    this.lastValidIdx = -1;
    this.lastSpeed = 0;
    this.invalidSince = null;
    this.invalidSnap = null;
    this.fInit = false;
    this.fBeta = this.fYaw = this.fAy = 0;
    this.hist = [];
    this.prev = null;
    this.onsetT = null;
    this.exc = null;
    this.prevExc = null;
    this.lastEventEndT = -Infinity;
    this.floorT = -Infinity;
    this.floorIdx = 0;
    this.floorPending = false;
    this.mode = 'idle';
    this.cand = null;
    this.entryTimer = 0;
    this.drift = null;
    this.exitTimer = 0;
    this.pending = null;
    this.recoverTimer = 0;
  }

  /** Close whatever is open at the end of a run. Returns the event it produced, if any. */
  finish(): DriftEvent | null {
    let out: DriftEvent | null = null;
    if (this.drift && (this.mode === 'drifting' || this.mode === 'exit')) {
      const d = this.drift;
      if (this.mode === 'exit') {
        d.endT = this.holdStartT;
        d.endIdx = this.holdStartIdx;
      } else if (this.invalidSnap) {
        d.snap = this.invalidSnap;
        d.endT = this.lastValidT ?? d.startT;
        d.endIdx = this.lastValidIdx;
      } else {
        d.snap = null;
        d.endT = this.lastValidT ?? d.startT;
        d.endIdx = Math.max(this.lastValidIdx, d.startIdx);
      }
      out = this.finalize(d);
    } else if (this.pending) {
      out = this.finalize(this.pending);
    }
    this.drift = null;
    this.pending = null;
    this.cand = null;
    this.entryTimer = 0;
    this.exitTimer = 0;
    this.invalidSnap = null;
    this.mode = 'idle';
    return out;
  }

  push(s: SlipState): DetectorOutput {
    const o = this.opts;
    const idx = ++this.sampleIndex;
    const t = s.t;
    let dt = this.lastT === null ? 0 : t - this.lastT;
    if (!(dt > 0)) dt = 0;
    if (dt > o.maxDtS) dt = o.maxDtS;
    this.lastT = t;
    let completed: DriftEvent | null = null;

    if (!s.valid || !Number.isFinite(s.beta) || !Number.isFinite(s.speed)) {
      // ---- invalid sample: freeze, then bail out after invalidHoldS ----
      if (this.invalidSince === null) {
        this.invalidSince = t;
        if (this.drift && this.mode === 'drifting') this.invalidSnap = this.drift.snapshot();
      }
      const streak = t - this.invalidSince;
      if (this.drift) this.drift.dist += this.lastSpeed * dt;
      if (this.pending) this.pending.dist += this.lastSpeed * dt;
      let live: LiveDrift | null = null;
      let phase: DriftPhase | null = null;
      if (streak > o.invalidHoldS) {
        // blind for too long: whatever happens next is a new story
        this.onsetT = null;
        this.exc = null;
        this.prevExc = null;
        this.prev = null;
        this.floorPending = true;
        if (this.mode === 'entry') {
          this.cand = null;
          this.entryTimer = 0;
          this.mode = 'idle';
        } else if ((this.mode === 'drifting' || this.mode === 'exit') && this.drift) {
          const d = this.drift;
          const endT = this.mode === 'exit' ? this.holdStartT : (this.lastValidT ?? d.startT);
          const endIdx = this.mode === 'exit' ? this.holdStartIdx : this.lastValidIdx;
          if (this.mode === 'drifting') d.snap = this.invalidSnap;
          live = this.liveOf(d, endT, this.fInit ? Math.abs(this.fBeta) : 0, this.lastSpeed);
          completed = this.endDrift(endT, endIdx);
          phase = 'exit';
        }
      }
      completed = completed ?? this.expirePending(t);
      return this.output(t, idx, this.fInit ? Math.abs(this.fBeta) : 0, this.lastSpeed, completed, live, phase);
    }

    // ---- valid sample ----
    if (this.invalidSince !== null) {
      const gap = this.lastValidT === null ? Infinity : t - this.lastValidT;
      if (gap > o.filterResetGapS) {
        // stale filter state would lag for several samples: re-seed from this sample
        this.fInit = false;
      }
      this.invalidSince = null;
      this.invalidSnap = null;
    }
    if (this.floorPending) {
      this.floorPending = false;
      this.floorT = t;
      this.floorIdx = idx;
    }
    if (!this.fInit) {
      this.fBeta = s.beta;
      this.fYaw = s.yawRate;
      this.fAy = s.ay;
      this.fInit = true;
    } else {
      const a = o.filterTauS > 0 ? 1 - Math.exp(-dt / o.filterTauS) : 1;
      this.fBeta += a * (s.beta - this.fBeta);
      this.fYaw += a * (s.yawRate - this.fYaw);
      this.fAy += a * (s.ay - this.fAy);
    }
    const b = Math.abs(this.fBeta);
    const sign: 1 | -1 = this.fBeta >= 0 ? 1 : -1;
    const speed = s.speed;
    const r: Rec = { t, idx, b, sign, speed, yaw: this.fYaw, ay: this.fAy, dt };
    this.lastValidT = t;
    this.lastValidIdx = idx;
    this.lastSpeed = speed;

    // history for backdating the start
    this.hist.push(r);
    const keep = Math.max(o.onsetMaxLookbackS, o.feintLookbackS) + Math.max(3 * o.entryHoldS, 1) + 0.2;
    while (this.hist.length > 1 && this.hist[0].t < t - keep) this.hist.shift();

    // onset tracking: last upward crossing of exitAngle (interpolated across a gap)
    if (this.onsetT === null) {
      if (b >= o.exitAngle) {
        const c = crossing(this.prev, r, o.exitAngle);
        this.onsetT = c.t;
        this.onsetIdx = c.idx;
      }
    } else if (b < o.exitAngle - o.onsetHysteresis) {
      this.onsetT = null;
    }
    const prev = this.prev;
    this.prev = r;
    // excursions out of the straight band: the one before the current one is the feint candidate
    if (this.exc && (b < o.feintAngle - o.onsetHysteresis || (sign !== this.exc.sign && b >= o.feintAngle))) {
      this.prevExc = this.exc;
      this.exc = null;
    }
    if (this.exc) {
      if (b > this.exc.peak) this.exc.peak = b;
      this.exc.endT = t;
    } else if (b >= o.feintAngle) {
      const c = crossing(prev, r, o.feintAngle);
      this.exc = { startT: c.t, startIdx: c.idx, sign, peak: b, endT: t };
    }

    const sigmaMargin = o.entrySigmaK > 0 && Number.isFinite(s.betaSigma) ? o.entrySigmaK * Math.max(0, s.betaSigma) : 0;
    const entryCond =
      b > o.entryAngle + sigmaMargin &&
      speed > o.entrySpeed &&
      (Math.abs(this.fAy) > o.entryLateralAccel || Math.abs(this.fYaw) > o.entryYawRate);
    const stopCond = speed < o.exitSpeed;
    const spinCond = b > o.spinAngle || (stopCond && b > o.spinMinAngle);

    // the pending drift keeps collecting in case it is re-opened
    if (this.pending) {
      this.pending.add(r);
      this.trackSide(this.pending, r);
    }

    let live: LiveDrift | null = null;
    let phase: DriftPhase | null = null;

    switch (this.mode) {
      case 'recover': {
        if (stopCond) {
          this.mode = 'idle';
          this.recoverTimer = 0;
        } else if (b < o.entryAngle) {
          this.recoverTimer += dt;
          if (this.recoverTimer >= o.exitHoldS) {
            this.mode = 'idle';
            this.recoverTimer = 0;
          }
        } else {
          this.recoverTimer = Math.max(0, this.recoverTimer - o.timerDecayRatio * dt);
        }
        break;
      }
      case 'idle': {
        if (entryCond) {
          this.cand = { startT: t, startIdx: idx, sign, peak: b, dist: 0 };
          this.entryTimer = dt;
          this.mode = 'entry';
          if (this.entryTimer >= o.entryHoldS) completed = this.confirmEntry(r, completed);
        }
        break;
      }
      case 'entry': {
        const c = this.cand!;
        if (b > c.peak) c.peak = b;
        c.dist += speed * dt;
        if (entryCond) {
          this.entryTimer += dt;
          if (this.entryTimer >= o.entryHoldS) completed = this.confirmEntry(r, completed);
        } else {
          this.entryTimer -= o.timerDecayRatio * dt;
          if (this.entryTimer <= 0 || stopCond) {
            this.entryTimer = 0;
            this.cand = null;
            this.mode = 'idle';
          }
        }
        break;
      }
      case 'drifting':
      case 'exit': {
        const d = this.drift!;
        // A linked drift is one drift because its transitions hold it together, so its
        // allowance grows with them: maxDurationS + chainBonusS per transition. Past that it
        // is a section of road, not a drift, and it is cut — mid-lobe, at least minLobeCutS
        // clear of the last transition, so the cut can never sever the flick that links it.
        const cap = o.maxDurationS + o.chainBonusS * d.transitions;
        if (
          !spinCond &&
          t - d.startT > cap &&
          b >= o.entryAngle &&
          t - d.tc.lastTransitionT >= o.minLobeCutS &&
          t - d.tc.sideSinceT >= o.minLobeCutS
        ) {
          d.add(r);
          this.trackSide(d, r);
          d.snap = null;
          live = this.liveOf(d, t, b, speed);
          completed = this.endDrift(t, idx, true) ?? completed;
          phase = 'exit';
          break;
        }
        if (spinCond) {
          d.add(r);
          d.spin = true;
          d.snap = null;
          live = this.liveOf(d, t, b, speed);
          completed = this.endDrift(t, idx, true) ?? completed;
          this.mode = 'recover';
          this.recoverTimer = 0;
          phase = 'exit';
          break;
        }
        if (stopCond) {
          d.add(r);
          d.snap = null;
          live = this.liveOf(d, t, b, speed);
          completed = this.endDrift(t, idx, true) ?? completed;
          phase = 'exit';
          break;
        }
        if (b < o.exitAngle) {
          if (this.exitTimer <= 0) {
            d.snap = d.snapshot();
            const c = prev && prev.b >= o.exitAngle ? crossing(prev, r, o.exitAngle) : { t, idx };
            this.holdStartT = c.t;
            this.holdStartIdx = c.idx;
          }
          d.add(r);
          this.trackSide(d, r);
          this.exitTimer += dt;
          this.mode = 'exit';
          if (this.exitTimer >= o.exitHoldS) {
            live = this.liveOf(d, this.holdStartT, b, speed);
            this.endDrift(this.holdStartT, this.holdStartIdx);
            phase = 'exit';
            break;
          }
        } else {
          d.add(r);
          this.trackSide(d, r);
          if (this.exitTimer > 0) {
            this.exitTimer = Math.max(0, this.exitTimer - o.timerDecayRatio * dt);
            if (this.exitTimer === 0) {
              d.snap = null;
              this.mode = 'drifting';
            }
          }
        }
        break;
      }
    }

    const exp = this.expirePending(t);
    if (exp) completed = completed ?? exp;
    return this.output(t, idx, b, speed, completed, live, phase);
  }

  // ---- internals ----

  private confirmEntry(r: Rec, completed: DriftEvent | null): DriftEvent | null {
    const o = this.opts;
    const c = this.cand!;
    let startT = c.startT;
    let startIdx = c.startIdx;
    if (this.onsetT !== null && this.onsetT < c.startT) {
      startT = this.onsetT;
      startIdx = this.onsetIdx;
    }
    // a fresh initiation may begin with a flick the OTHER way (Scandinavian feint): the drift
    // started when the car first left straight running, not at the crossing on the final side
    let lookback = o.onsetMaxLookbackS;
    const feint = this.feintBefore(c.sign, startT);
    if (feint) {
      startT = feint.startT;
      startIdx = feint.startIdx;
      lookback = o.feintLookbackS;
    }
    if (startT < c.startT - lookback) {
      startT = c.startT - lookback;
      startIdx = -1;
    }
    if (this.hist.length && startT < this.hist[0].t) {
      startT = this.hist[0].t;
      startIdx = -1;
    }
    if (startT < this.floorT) {
      startT = this.floorT;
      startIdx = this.floorIdx;
    }

    let out = completed;
    if (this.pending) {
      if (startT - this.pending.endT < o.mergeGapS) {
        // re-open the pending drift as one linked event; it already holds the gap samples
        const d = this.pending;
        this.pending = null;
        d.endT = NaN;
        d.endIdx = -1;
        d.snap = null;
        this.drift = d;
        this.cand = null;
        this.entryTimer = 0;
        this.exitTimer = 0;
        this.mode = 'drifting';
        return out;
      }
      out = out ?? this.finalize(this.pending);
      this.pending = null;
    }
    // never reach back into an event that has already been closed
    if (startT < this.lastEventEndT) {
      startT = this.lastEventEndT;
      startIdx = -1;
    }
    let first = 0;
    while (first < this.hist.length && this.hist[first].t < startT) first++;
    const firstRec = this.hist[first] ?? r;
    if (startIdx < 0) startIdx = firstRec.idx;

    const d = new Drift(this.nextId++, firstRec, this.tRule);
    d.startT = startT;
    d.startIdx = startIdx;
    for (let i = first; i < this.hist.length; i++) d.add(this.hist[i]);
    // the samples before the confirmation (feint included) are part of the initiation, never a
    // direction change: the side starts at the side the entry was confirmed on
    d.initialDirection = c.sign;
    d.tc.restart(r.t, startT, c.sign, r.yaw);
    this.drift = d;
    this.cand = null;
    this.entryTimer = 0;
    this.exitTimer = 0;
    this.mode = 'drifting';
    return out;
  }

  /**
   * The flick that started an initiation, if there was one: a brief excursion the other way,
   * small and short, that reversed promptly into the slide being confirmed on `sign`.
   * Returns the point at which the car left straight running, i.e. where the drift really began.
   */
  private feintBefore(sign: 1 | -1, startT: number): Excursion | null {
    const o = this.opts;
    const f = this.prevExc;
    if (!f || f.sign === sign || f.startT >= startT) return null;
    if (f.peak > o.feintMaxAngle || f.endT - f.startT > o.feintMaxDurationS) return null;
    // the real slide has to follow the flick promptly, or they are two separate things
    const realStart = this.exc && this.exc.sign === sign ? this.exc.startT : startT;
    if (realStart - f.endT > o.feintReverseGapS) return null;
    return f;
  }

  /**
   * Follow which side the car is sliding on and count direction changes.
   *
   * Both sides of a swing must be held for `transitionMinDwellS` for it to be a transition: the
   * side being left has to have been held, and the new side is only PROVISIONAL until it has
   * been. An excursion that falls back to the side it came from inside that window is a feint
   * (or a twitch through zero), so it is cancelled instead of counted — an initiation that
   * flicks the wrong way first stays one drift with the transition count of the real swings.
   */
  private trackSide(d: Drift, r: Rec): void {
    d.tc.push(r.t, r.b, r.sign, r.yaw);
  }

  /** End the open drift at (endT, endIdx). Immediate closes finalise now; others wait in the merge window. */
  private endDrift(endT: number, endIdx: number, immediate = false): DriftEvent | null {
    const d = this.drift!;
    d.endT = endT;
    d.endIdx = endIdx;
    this.drift = null;
    this.exitTimer = 0;
    this.invalidSnap = null;
    if (this.mode !== 'recover') this.mode = 'idle';
    if (immediate || d.spin) return this.finalize(d);
    // a pending drift cannot coexist with an open one (confirmEntry merges or finalises it); keep order sane anyway
    const stale = this.pending ? this.finalize(this.pending) : null;
    this.pending = d;
    return stale;
  }

  private expirePending(now: number): DriftEvent | null {
    const p = this.pending;
    if (!p) return null;
    const o = this.opts;
    const age = now - p.endT;
    if (age <= o.mergeGapS) return null;
    // earliest start a drift confirmed later could still be backdated to
    let potential: number;
    if (this.mode === 'entry' && this.cand) {
      potential = Math.max(this.onsetT ?? this.cand.startT, this.cand.startT - o.onsetMaxLookbackS);
      const f = this.feintBefore(this.cand.sign, potential);
      if (f) potential = Math.max(f.startT, this.cand.startT - o.feintLookbackS);
    } else if (this.onsetT !== null) {
      potential = Math.max(this.onsetT, now - o.onsetMaxLookbackS);
      const f = this.exc ? this.feintBefore(this.exc.sign, potential) : null;
      if (f) potential = Math.max(f.startT, now - o.feintLookbackS);
    } else if (this.invalidSince !== null && this.prev) {
      // blind right now: an onset may still be interpolated back to the last valid sample
      potential = Math.max(this.prev.t, now - o.onsetMaxLookbackS);
    } else {
      potential = now;
    }
    potential = Math.max(potential, this.floorT);
    const canStillMerge = potential - p.endT < o.mergeGapS;
    if (canStillMerge && age <= o.mergeGapS + Math.max(o.onsetMaxLookbackS, o.feintLookbackS) + 3 * o.entryHoldS) return null;
    this.pending = null;
    return this.finalize(p);
  }

  /** Build the DriftEvent; apply the twitch rule; record it. */
  private finalize(d: Drift): DriftEvent | null {
    const o = this.opts;
    const s: Snapshot = d.snap ?? d.snapshot();
    const durationS = d.endT - d.startT;
    if (!(durationS >= o.minDurationS) && !d.spin) return null;
    const lo = d.startT + o.statsEdgeS;
    const hi = d.endT - o.statsEdgeS;
    let ms = meanStd(d.tArr, d.bArr, s.nArr, lo, hi);
    if (!Number.isFinite(ms.mean)) ms = meanStd(d.tArr, d.bArr, s.nArr, d.startT, d.endT);
    if (!Number.isFinite(ms.mean)) ms = { mean: s.peak, std: 0 };
    const ev: DriftEvent = {
      id: d.id,
      startT: d.startT,
      endT: d.endT,
      durationS,
      peakAngle: s.peak,
      peakAngleT: s.peakT,
      meanAngle: ms.mean,
      angleStdDev: ms.std,
      transitions: s.transitions,
      entrySpeed: d.entrySpeed,
      meanSpeed: s.speedN > 0 ? s.speedSum / s.speedN : d.entrySpeed,
      minSpeed: Number.isFinite(s.minSpeed) ? s.minSpeed : d.entrySpeed,
      distanceM: s.dist,
      peakYawRate: s.peakYaw,
      peakLateralAccel: s.peakAy,
      initialDirection: d.initialDirection,
      spin: d.spin,
      // The detector sees no integrity verdict; the pipeline stamps the real figure.
      suppressedS: 0,
      sampleStart: d.startIdx,
      sampleEnd: d.endIdx,
    };
    this.events.push(ev);
    if (d.endT > this.lastEventEndT) this.lastEventEndT = d.endT;
    return ev;
  }

  private liveOf(d: Drift, now: number, angle: number, speed: number): LiveDrift {
    d.commitLive(now, this.opts.statsEdgeS);
    return {
      id: d.id,
      startT: d.startT,
      durationS: Math.max(0, now - d.startT),
      angle,
      peakAngle: d.peak,
      direction: d.side,
      transitions: d.transitions,
      speed,
      meanAngle: d.wN > 0 ? d.wMean : angle,
      angleStdDev: d.wN > 1 ? Math.sqrt(d.wM2 / d.wN) : 0,
      distanceM: d.dist,
      spin: d.spin,
    };
  }

  private output(
    t: number,
    idx: number,
    angle: number,
    speed: number,
    completed: DriftEvent | null,
    liveOverride: LiveDrift | null = null,
    phaseOverride: DriftPhase | null = null,
  ): DetectorOutput {
    let phase: DriftPhase;
    let live: LiveDrift | null = liveOverride;
    switch (this.mode) {
      case 'entry': {
        phase = 'entry';
        const c = this.cand!;
        let startT = Math.max(this.onsetT ?? c.startT, c.startT - this.opts.onsetMaxLookbackS, this.floorT);
        // preview the same feint backdating confirmEntry will apply, so the HUD's live start
        // does not jump when the entry is confirmed
        const f = this.feintBefore(c.sign, startT);
        if (f) startT = Math.max(f.startT, c.startT - this.opts.feintLookbackS, this.floorT, this.lastEventEndT);
        const p = this.pending;
        const id = p && startT - p.endT < this.opts.mergeGapS ? p.id : this.nextId;
        live = live ?? {
          id,
          startT,
          durationS: Math.max(0, t - startT),
          angle,
          peakAngle: c.peak,
          direction: c.sign,
          transitions: 0,
          speed,
          meanAngle: angle,
          angleStdDev: 0,
          distanceM: c.dist,
          spin: false,
        };
        break;
      }
      case 'drifting':
      case 'exit': {
        const d = this.drift!;
        phase = t < d.transitionPhaseUntil ? 'transition' : this.mode;
        live = live ?? this.liveOf(d, t, angle, speed);
        break;
      }
      default:
        phase = 'idle';
    }
    if (phaseOverride) phase = phaseOverride;
    return { phase, live, completed, sampleIndex: idx };
  }
}
