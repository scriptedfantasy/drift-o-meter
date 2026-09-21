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
import { countsForPoints, DriftAccumulator } from './accumulator';
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
  /**
   * THE GATE THIS TICK RAN UNDER (`countsForPoints`): true when an instant of drifting would
   * earn something right now, false while the integrity monitor does not believe the slide or
   * the estimator's state is invalid. It is not an inference about the scorer — it is the flag
   * the scorer itself used, so `counting === false` guarantees this tick paid nothing.
   *
   * It is false on a perfectly healthy run whenever nothing is being paid for anyway (parked,
   * crawling, between slides): "not counting" means "would not pay", not "something is wrong".
   */
  counting: boolean;
}

/** Where `endDrift` puts what it fires: a live tick, or the record the next tick will drain. */
interface EndDriftSink {
  callouts: StyleCallout[];
  unpriced?: StyleCallout[];
  lost: boolean;
  lostPoints: number;
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
  /**
   * Trailing `ringKeepS` of states, for replaying a drift the scorer never saw live. A HEAD
   * INDEX with amortised compaction, not `slice()` on every push: re-slicing a full 12 000-
   * element window at 100 Hz cost 70 µs and ~100 KB of garbage PER SAMPLE — ten times the rest
   * of the engine put together — and only after the run passed two minutes, which is why no
   * test ever saw it.
   */
  private ring: SlipState[] = [];
  private ringHead = 0;
  /**
   * What the NEXT tick has to report, because it happened between two samples.
   *
   * `callouts` are already paid for; `unpriced` are end-of-drift callouts that have NOT been
   * paid yet, because the frame that reports them is the frame that decides whether they are
   * worth anything (see `push`). `drift` is the ScoredDrift they belong to, so a refusal can
   * take them back off its bonus as well as off the chain.
   */
  private pending: { callouts: StyleCallout[]; unpriced: StyleCallout[]; drift: ScoredDrift | null; lost: boolean; lostPoints: number } | null = null;
  private lastT = -Infinity;
  /** Ids of completed drifts whose points are still at risk. */
  private unbankedIds: number[] = [];
  /** Id of the last drift that ended (by spin or by onDriftCompleted): later samples with it are ignored. */
  private deadId: number | null = null;
  /** A CLEAN LAP that has been earned and is waiting for a sample the scorer pays on. */
  private pendingLap: { t: number; points: number; driftId: number } | null = null;

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
    this.ringHead = 0;
    this.pending = null;
    this.lastT = -Infinity;
    this.unbankedIds = [];
    this.deadId = null;
    this.pendingLap = null;
  }

  /**
   * One sample. `plausible` is the integrity monitor's verdict for this instant (default true):
   * while it is false the slide earns nothing, exactly as a `valid:false` sample does in the
   * detector. Without it a phone rattling in a cradle scored 40 % MORE than the same drive with
   * the phone bolted down, because the rattle inflates the angle it is fed.
   */
  push(s: SlipState, live: LiveDriftInfo | null, plausible = true): LiveTick {
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
      counting: countsForPoints(s, plausible),
    };
    this.remember(s);
    // A CLEAN LAP earned while the monitor was doubting the car waits here for a sample the
    // scorer pays on, and lands on that one — never on a frame stamped `counting: false`.
    if (this.pendingLap) this.releaseLap(s, plausible);
    if (this.pending) {
      // END-OF-DRIFT CALLOUTS ARE PRICED BY THE FRAME THAT REPORTS THEM, not by the one that
      // earned them. `onDriftCompleted` runs BETWEEN two samples — the pipeline calls it after
      // the scorer's own `push` — so a PERFECT EXIT earned on a believed sample used to be
      // added to the chain there and then, and surfaced on the next frame. When that next frame
      // was one the monitor refused, the HUD drew `PERFECT EXIT +45` with the total rising, on a
      // frame stamped `counting: false` (measured: harbor, seed 2, looseness 0.1, t = 5.18 s).
      // That is the same class as the CLEAN LAP leak one level down, and the fix is the same
      // sentence: nothing is paid on a frame the scorer would not pay on.
      for (const c of this.pending.unpriced) {
        if (tick.counting) {
          this.chainPoints += c.points;
        } else if (c.points !== 0) {
          const sd = this.pending.drift;
          if (sd) {
            sd.bonus -= c.points;
            sd.total -= c.points;
          }
          c.points = 0;
        }
      }
      tick.callouts.push(...this.pending.callouts, ...this.pending.unpriced);
      if (this.pending.lost) {
        tick.lost = true;
        tick.lostPoints = this.pending.lostPoints;
      }
      this.pending = null;
    }
    const active = live !== null && live.phase !== 'idle' && live.id !== this.deadId;

    // a drift ended (feed went idle or switched id). It is closed at THIS sample, so this
    // sample's gate prices whatever it fires — the same rule `fire()` applies inside a drift.
    if (this.acc && (!active || (live as LiveDriftInfo).id !== this.acc.id)) this.endDrift(s.t, false, tick, tick.counting ? 'pay' : 'refuse');
    // a drift started
    if (active && !this.acc) this.startDrift((live as LiveDriftInfo).id, s.t);

    if (this.acc) {
      const res = this.acc.step(s, plausible);
      this.chainPoints += res.points + res.bonus;
      tick.callouts.push(...res.callouts);
      tick.rate = res.rate;
      const spin = (live as LiveDriftInfo).spin === true || this.acc.spun;
      if (spin) this.endDrift(s.t, true, tick, tick.counting ? 'pay' : 'refuse');
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
      const spin = e.spin === true || this.acc.spun;
      const id = this.acc.id;
      // `unpriced`: these callouts are reported on the NEXT tick, so that tick decides whether
      // they are worth anything. `endDrift` therefore does not bank them here.
      const out = { callouts: [] as StyleCallout[], unpriced: [] as StyleCallout[], drift: null as ScoredDrift | null, lost: false, lostPoints: 0 };
      const endT = Math.min(e.endT, Math.max(this.lastT, this.acc.startT));
      this.endDrift(endT, spin, out, 'defer');
      out.drift = this.completed.get(id) ?? null;
      this.pending = out; // callouts / CHAIN LOST are reported on the next tick; its delta shows the drop
    }
    const known = this.completed.get(e.id);
    if (known) return known;
    // never seen live (scorer started mid-run?): replay from the ring buffer
    const sd = scoreDrift(e, this.ringStates(), this.o, { multiplier: this.o.multiplierStart, chainDrifts: 0, spin: e.spin });
    this.completed.set(e.id, sd);
    this.completedOrder.push(e.id);
    return sd;
  }

  /**
   * Optional: tell the scorer a lap closed (from the track model) so CLEAN LAP can fire
   * live: ≥ cleanLapMinDrifts drifts ENDED inside the lap and none spun. Points bank
   * immediately (a clean lap cannot be lost). Returns the callout when it is paid on this
   * sample, or null — which includes the case where it is queued for the next believed one.
   *
   * ── THE ONE PAYING PATH THAT IS NOT PER-SAMPLE ────────────────────────────────────────────
   * so it has to answer the gate for itself, and it used to answer a different question
   * entirely: `sd.total > 0`, "did the lap's last slide earn anything at any point in its life".
   * Measured on the app's own sim parameters (harbor, seed 1, 2 laps), the HUD drew
   * `CLEAN LAP +1,425` with the odometer stepping 9,624 → 10,974 four lines above the words
   * `MOUNT SHAKING — NOT SCORING`: 1,725 points at looseness 0, 300 at 0.05, 1,725 at 0.1 and
   * 0.15, 1,650 at 0.2, every one of those runs published with `trusted: true` and grade A or B.
   * 5–10 % of a PUBLISHED total, paid at instants the monitor had refused.
   *
   * ── WHAT REPLACED IT, AND WHY IT IS NOT SIMPLY `countsForPoints` ──────────────────────────
   * Two things, because the bonus has two honest questions to answer and they are not the same
   * question:
   *
   *   HOW MUCH is it worth — `lapBelief`, the believed share of the sliding inside the lap. A
   *   lap the monitor refused outright is worth nothing for being tidy; a lap it believed
   *   entirely is worth the full bonus; in between it is worth the share. This is the same
   *   arithmetic `scoreSession` runs offline, off the same two fields, so the live total and a
   *   re-scored one agree without either needing the per-sample mask.
   *
   *   WHEN is it paid — never on a sample the scorer would not pay on. Not as a forfeit: the
   *   crossing instant is an arbitrary tick of a lap-long award, and on harbor seed 1 the start
   *   line happens to sit inside a 0.23 s stretch the monitor doubts on EVERY lap, so forfeiting
   *   cost a clean, trusted, looseness-0 run 1,725 points and opened a 3.3 % live-versus-stored
   *   gap on the cleanest run the simulator can produce — which is the defect class
   *   `docs/CRITIC.md` rule 9 is about, moved rather than killed. So the payment WAITS
   *   (`pendingLap`) for the next sample `countsForPoints` accepts, and if the run never offers
   *   one — a hand-held run, every frame of which says `counting: false` — it is never paid at
   *   all. No frame can ever show `score.total` rising while it is stamped `counting: false`,
   *   which is the guarantee `pipeline.ts` publishes and the one a HUD reads it for.
   *
   * `s` and `plausible` are REQUIRED for the same reason `DriftEvent.spin` is: a caller that can
   * omit the gate is a caller that will, and this is the third paying path that was missed.
   */
  onLapCompleted(lap: Lap, s: SlipState, plausible = true): StyleCallout | null {
    const o = this.o;
    const inLap = this.log.filter((d) => d.endT >= lap.startT && d.endT < lap.endT);
    if (inLap.length < o.cleanLapMinDrifts || inLap.some((d) => d.spun)) return null;
    const last = inLap[inLap.length - 1];
    const sd = this.completed.get(last.id);
    if (!sd || !(sd.total > 0)) return null;
    const believed = lapBelief(inLap.map((d) => this.completed.get(d.id)));
    if (!(believed > 0)) return null;
    // the same multiplier rule as every other callout, and the same one `scoreSession` applies
    // offline (the lap's last drift's end multiplier), so live and replay agree to the point
    const pts = o.calloutPoints['clean-lap'] * (o.calloutsUseMultiplier ? Math.max(1, sd.multiplierEnd) : 1) * believed;
    this.pendingLap = { t: lap.endT, points: pts, driftId: sd.id };
    return this.releaseLap(s, plausible);
  }

  /**
   * Pay a queued CLEAN LAP, if this sample is one the scorer pays on. Called at the top of every
   * `push` and once from `onLapCompleted` itself, so a clean crossing pays on its own frame.
   */
  private releaseLap(s: SlipState, plausible: boolean): StyleCallout | null {
    const q = this.pendingLap;
    if (!q || !countsForPoints(s, plausible)) return null;
    this.pendingLap = null;
    const c: StyleCallout = { t: q.t, kind: 'clean-lap', label: calloutLabel('clean-lap'), points: q.points };
    this.bankedTotal += q.points;
    const sd = this.completed.get(q.driftId);
    if (sd) {
      sd.callouts.push(c);
      sd.bonus += q.points;
      sd.total += q.points;
    }
    if (!this.pending) this.pending = { callouts: [], unpriced: [], drift: null, lost: false, lostPoints: 0 };
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

  /**
   * Close the drift. `pay` is false when the caller is `onDriftCompleted`, i.e. when the
   * end-of-drift callouts will be REPORTED on a later frame: their points are then held on the
   * callouts and banked (or written off) by the frame that reports them, so the running total
   * can never rise on a frame stamped `counting: false`.
   */
  private endDrift(endT: number, spin: boolean, tick: EndDriftSink, mode: 'pay' | 'refuse' | 'defer'): void {
    const acc = this.acc as DriftAccumulator;
    const o = this.o;
    const { callouts, stats } = acc.finish(endT, spin);
    if (mode === 'defer') {
      (tick.unpriced as StyleCallout[]).push(...callouts);
    } else {
      if (mode === 'refuse') {
        // this sample is one the scorer will not pay on, so the exit callout is worth exactly
        // nothing — the same rule `fire()` applies to every callout inside the drift
        for (const c of callouts) {
          acc.bonus -= c.points;
          c.points = 0;
        }
      }
      for (const c of callouts) this.chainPoints += c.points;
      tick.callouts.push(...callouts);
    }
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
    const cutoff = s.t - this.o.ringKeepS;
    // O(1) amortised: drop expired samples by moving a head index, and only compact the array
    // when the dead prefix is at least half of it (so the O(n) copy happens once per n pushes)
    while (this.ringHead < this.ring.length && this.ring[this.ringHead].t < cutoff) this.ringHead++;
    if (this.ringHead > 4096 && this.ringHead * 2 >= this.ring.length) {
      this.ring = this.ring.slice(this.ringHead);
      this.ringHead = 0;
    }
  }

  /** The live states still in the window, as a dense array (only built when something replays). */
  private ringStates(): SlipState[] {
    return this.ringHead === 0 ? this.ring : this.ring.slice(this.ringHead);
  }
}

/**
 * How much of a lap's sliding the integrity monitor believed, 0..1 — what a CLEAN LAP is worth.
 *
 * `stats.durationS` is the drifting time that COUNTED and `stats.implausibleS` is the drifting
 * time it refused, and both are produced the same way by the live accumulator and by a re-score
 * (where `scoreDrift` fills them from `DriftEvent.suppressedS`). So this one expression gives
 * the same answer live, in `finish()`, and on a session loaded from disk with no per-sample mask
 * at all — which is why the bonus needs no second rule for the durable path.
 */
export function lapBelief(drifts: Array<{ stats: { durationS: number; implausibleS: number } } | undefined>): number {
  let counted = 0;
  let refused = 0;
  for (const d of drifts) {
    if (!d) continue;
    counted += Math.max(0, d.stats.durationS);
    refused += Math.max(0, d.stats.implausibleS);
  }
  const total = counted + refused;
  return total > 0 ? counted / total : 1;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
