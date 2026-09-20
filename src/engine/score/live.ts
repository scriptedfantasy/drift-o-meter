/**
 * LiveScorer — the real-time side. Feed it every SlipState plus the detector's live
 * phase; it returns a LiveTick the HUD can render directly (running total, at-risk chain
 * points, multiplier, callouts fired this tick, BANKED / CHAIN LOST moments).
 *
 * Chain rules (all numbers in ScoreOptions):
 *  - a drift that starts within `chainGapS` (3 s) of the previous clean exit inherits the
 *    multiplier and the chain count (LINK ×n from the 3rd drift);
 *  - the chain's points are AT RISK until `bankDelayS` (2 s) after a clean exit, then
 *    they bank ("BANKED +N"); a drift starting inside those 2 s keeps them at risk;
 *  - a spin (detector flag or |β| ≥ spinAngleDeg) discards every un-banked point
 *    ("CHAIN LOST −N"), resets the multiplier to 1 and ends the drift.
 */
import type { DriftEvent, DriftPhase, Lap, SlipState, StyleCallout } from '../types';
import { DriftAccumulator } from './accumulator';
import { buildDriftScore, scoreDrift, type ScoredDrift } from './drift';
import { calloutLabel, resolveOptions, type ScoreOptions } from './rules';

export interface LiveDriftInfo {
  phase: DriftPhase;
  /** Current |β| (rad) as the detector sees it (informational; the scorer uses the SlipState). */
  angle: number;
  peakAngle: number;
  transitions: number;
  durationS: number;
  spin?: boolean;
  id: number;
}

export interface LiveTick {
  /** Banked points + at-risk chain points: the big number on the HUD. */
  total: number;
  /** Change of `total` since the previous tick (negative on CHAIN LOST). */
  delta: number;
  multiplier: number;
  /** Un-banked points currently at risk. */
  chainPoints: number;
  /** Callouts fired this tick. */
  callouts: StyleCallout[];
  /** The chain just banked. */
  banked: boolean;
  /** The chain was just lost to a spin. */
  lost: boolean;
  bankedPoints: number;
  lostPoints: number;
  /** "BANKED +1,234" / "CHAIN LOST −2,345" or null. */
  banner: string | null;
  /** Points of the drift in progress (0 when idle). */
  driftPoints: number;
  /** Points per second right now (0 when idle) — drives a rate needle. */
  rate: number;
  /** Id of the drift in progress, or null. */
  driftId: number | null;
  /** Drifts in the current chain. */
  chainDrifts: number;
}

interface CompletedDrift {
  id: number;
  startT: number;
  endT: number;
  spun: boolean;
}

export class LiveScorer {
  private o: ScoreOptions;
  private acc: DriftAccumulator | null = null;
  private bankedTotal = 0;
  private chainPoints = 0;
  private chainDrifts = 0;
  private chainMult: number;
  private chainActive = false;
  private lastExitT = -Infinity;
  private lastExitClean = false;
  private prevTotal = 0;
  private completed = new Map<number, ScoredDrift>();
  private completedOrder: number[] = [];
  private log: CompletedDrift[] = [];
  private ring: SlipState[] = [];
  private pending: { callouts: StyleCallout[]; lost: boolean; lostPoints: number } | null = null;
  private lastT = -Infinity;
  /** Ids of completed drifts whose points are still at risk. */
  private unbankedIds: number[] = [];
  /** Id of the last drift that ended (by spin or by onDriftCompleted): later samples with it are ignored. */
  private deadId: number | null = null;

  constructor(opts?: Partial<ScoreOptions>) {
    this.o = resolveOptions(opts);
    this.chainMult = this.o.multiplierStart;
  }

  get options(): ScoreOptions {
    return this.o;
  }

  /** Banked + at-risk points. */
  get total(): number {
    return this.bankedTotal + this.chainPoints;
  }

  get multiplier(): number {
    return this.acc ? this.acc.multiplier : this.chainActive ? this.chainMult : this.o.multiplierStart;
  }

  get chain(): { points: number; drifts: number; active: boolean } {
    return { points: this.chainPoints, drifts: this.chainDrifts, active: this.chainActive };
  }

  /** The drift in progress, if any. */
  get current(): { id: number; points: number; multiplier: number; transitions: number; elapsedS: number } | null {
    if (!this.acc) return null;
    return { id: this.acc.id, points: this.acc.driftTotal, multiplier: this.acc.multiplier, transitions: this.acc.transitions, elapsedS: this.acc.elapsedS };
  }

  reset(): void {
    this.acc = null;
    this.bankedTotal = 0;
    this.chainPoints = 0;
    this.chainDrifts = 0;
    this.chainMult = this.o.multiplierStart;
    this.chainActive = false;
    this.lastExitT = -Infinity;
    this.lastExitClean = false;
    this.prevTotal = 0;
    this.completed.clear();
    this.completedOrder = [];
    this.log = [];
    this.ring = [];
    this.pending = null;
    this.lastT = -Infinity;
    this.unbankedIds = [];
    this.deadId = null;
  }

  push(s: SlipState, live: LiveDriftInfo | null): LiveTick {
    const o = this.o;
    const tick: LiveTick = {
      total: 0,
      delta: 0,
      multiplier: 1,
      chainPoints: 0,
      callouts: [],
      banked: false,
      lost: false,
      bankedPoints: 0,
      lostPoints: 0,
      banner: null,
      driftPoints: 0,
      rate: 0,
      driftId: null,
      chainDrifts: 0,
    };
    this.remember(s);
    if (this.pending) {
      tick.callouts.push(...this.pending.callouts);
      if (this.pending.lost) {
        tick.lost = true;
        tick.lostPoints = this.pending.lostPoints;
      }
      this.pending = null;
    }
    const active = live !== null && live.phase !== 'idle' && live.id !== this.deadId;

    // a drift ended (feed went idle or switched id)
    if (this.acc && (!active || (live as LiveDriftInfo).id !== this.acc.id)) this.endDrift(s.t, false, tick);
    // a drift started
    if (active && !this.acc) this.startDrift((live as LiveDriftInfo).id, s.t);

    if (this.acc) {
      const res = this.acc.step(s);
      this.chainPoints += res.points + res.bonus;
      tick.callouts.push(...res.callouts);
      tick.rate = res.rate;
      const spin = (live as LiveDriftInfo).spin === true || this.acc.spun;
      if (spin) this.endDrift(s.t, true, tick);
      else {
        tick.driftPoints = this.acc.driftTotal;
        tick.driftId = this.acc.id;
      }
    } else {
      this.idleHousekeeping(s.t, tick);
    }

    tick.multiplier = this.multiplier;
    tick.chainPoints = this.chainPoints;
    tick.chainDrifts = this.chainDrifts;
    tick.total = this.total;
    tick.delta = tick.total - this.prevTotal;
    this.prevTotal = tick.total;
    if (tick.lost) tick.banner = `CHAIN LOST −${fmt(tick.lostPoints)}`;
    else if (tick.banked) tick.banner = `BANKED +${fmt(tick.bankedPoints)}`;
    this.lastT = s.t;
    return tick;
  }

  /**
   * The detector finished a drift. Returns the DriftScore as accumulated live (identical
   * to what the HUD showed). If the drift is still open on this side it is closed here and
   * its end-of-drift callouts are reported on the next tick.
   */
  onDriftCompleted(e: DriftEvent): ScoredDrift {
    if (this.acc && this.acc.id === e.id) {
      const spin = (e as { spin?: boolean }).spin === true || this.acc.spun;
      const tick = { callouts: [] as StyleCallout[], lost: false, lostPoints: 0 };
      const endT = Math.min(e.endT, Math.max(this.lastT, this.acc.startT));
      this.endDrift(endT, spin, tick);
      this.pending = tick; // callouts / CHAIN LOST are reported on the next tick; its delta shows the drop
    }
    const known = this.completed.get(e.id);
    if (known) return known;
    // never seen live (scorer started mid-run?): replay from the ring buffer
    const sd = scoreDrift(e, this.ring, this.o, { multiplier: this.o.multiplierStart, chainDrifts: 0 });
    this.completed.set(e.id, sd);
    this.completedOrder.push(e.id);
    return sd;
  }

  /**
   * Optional: tell the scorer a lap closed (from the track model) so CLEAN LAP can fire
   * live: ≥ cleanLapMinDrifts drifts ENDED inside the lap and none spun. Points bank
   * immediately (a clean lap cannot be lost). Returns the callout or null.
   */
  onLapCompleted(lap: Lap): StyleCallout | null {
    const o = this.o;
    const inLap = this.log.filter((d) => d.endT >= lap.startT && d.endT < lap.endT);
    if (inLap.length < o.cleanLapMinDrifts || inLap.some((d) => d.spun)) return null;
    const pts = o.calloutPoints['clean-lap'];
    const c: StyleCallout = { t: lap.endT, kind: 'clean-lap', label: calloutLabel('clean-lap'), points: pts };
    this.bankedTotal += pts;
    const last = inLap[inLap.length - 1];
    const sd = this.completed.get(last.id);
    if (sd) {
      sd.callouts.push(c);
      sd.bonus += pts;
      sd.total += pts;
    }
    if (!this.pending) this.pending = { callouts: [], lost: false, lostPoints: 0 };
    this.pending.callouts.push(c);
    return c;
  }

  /** Drift scores accumulated so far, in completion order. */
  get completedDrifts(): ScoredDrift[] {
    return this.completedOrder.map((id) => this.completed.get(id) as ScoredDrift);
  }

  // ---------------------------------------------------------------------------------------

  private startDrift(id: number, t: number): void {
    const o = this.o;
    if (!this.chainActive) {
      this.chainMult = o.multiplierStart;
      this.chainDrifts = 0;
    }
    this.acc = new DriftAccumulator(o, id, t, { multiplier: this.chainMult, chainDrifts: this.chainDrifts });
    this.chainDrifts++;
    this.chainActive = true;
    this.lastExitClean = false;
  }

  private endDrift(endT: number, spin: boolean, tick: { callouts: StyleCallout[]; lost: boolean; lostPoints: number }): void {
    const acc = this.acc as DriftAccumulator;
    const o = this.o;
    const { callouts, stats } = acc.finish(endT, spin);
    for (const c of callouts) this.chainPoints += c.points;
    tick.callouts.push(...callouts);
    const sd = buildDriftScore(acc, stats, o);
    if (stats.spun) {
      const lost = this.chainPoints;
      tick.lost = true;
      tick.lostPoints = lost;
      this.chainPoints = 0;
      this.chainActive = false;
      this.chainMult = o.multiplierStart;
      this.chainDrifts = 0;
      this.lastExitClean = false;
      sd.lost = true;
      for (const id of this.unbankedIds) {
        const d = this.completed.get(id);
        if (d) d.lost = true;
      }
      this.unbankedIds = [];
    } else {
      this.chainMult = acc.multiplier;
      this.lastExitClean = true;
      this.unbankedIds.push(acc.id);
    }
    this.lastExitT = endT;
    this.deadId = acc.id;
    this.completed.set(acc.id, sd);
    this.completedOrder.push(acc.id);
    this.log.push({ id: acc.id, startT: acc.startT, endT, spun: stats.spun });
    this.acc = null;
  }

  private idleHousekeeping(t: number, tick: LiveTick): void {
    const o = this.o;
    if (this.chainPoints > 0 && this.lastExitClean && t - this.lastExitT >= o.bankDelayS) {
      tick.banked = true;
      tick.bankedPoints = this.chainPoints;
      this.bankedTotal += this.chainPoints;
      this.chainPoints = 0;
      this.unbankedIds = [];
    }
    if (this.chainActive && t - this.lastExitT >= o.chainGapS) {
      this.chainActive = false;
      this.chainMult = o.multiplierStart;
      this.chainDrifts = 0;
    }
  }

  private remember(s: SlipState): void {
    this.ring.push(s);
    const keepS = 120;
    if (this.ring.length > 2048 && this.ring[0].t < s.t - keepS) {
      let cut = 0;
      while (cut < this.ring.length && this.ring[cut].t < s.t - keepS) cut++;
      this.ring = this.ring.slice(cut);
    }
  }
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
