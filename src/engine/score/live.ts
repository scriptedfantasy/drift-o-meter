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
 *
 * ── ONE DRIFT, ONE WINDOW, ONE SCORE ──────────────────────────────────────────────────────
 * A drift's score is `scoreDrift` over the window the DETECTOR published for it — the same
 * call, over the same samples, with the same chain context, that `replayChains` makes offline.
 * The running per-sample accumulation is a PROVISIONAL estimate for the HUD only: it is
 * replaced by that authoritative score the instant the drift closes, and again if the detector
 * later finalises an event that spans it.
 *
 * It was not always. The live scorer used to keep whatever its accumulator had integrated
 * between the sample the detector's live feed appeared on and the sample it went idle on —
 * a window that starts `entryHoldS` LATE and ends `exitHoldS` (0.6 s) after the car has already
 * straightened, because that is when a real-time state machine can be sure. The detector's own
 * event is placed where a human judge would put it: back-dated to the last upward crossing of
 * `exitAngle`, and ended where |β| dropped below it for good. Two windows, two answers, and
 * the difference is not the handful of base points inside the ramps (measured: 4 points in
 * 5 250 on harbor seed 3) but every DECISION that hangs off the boundaries:
 *
 *   the chain gap   `startT(next) − endT(prev)` on the event clock against the same difference
 *                   on the detection clock. On harbor seed 3 the two slides at 46.996 → 50.018
 *                   are 3.022 s apart — past `chainGapS`, so the session starts a fresh chain —
 *                   while live they were 47.609 → 50.541, i.e. 2.93 s, and the chain continued
 *                   at ×4.75. Everything the multiplier touches then doubles down: LINK ×3
 *                   (1 710 points the verdict screen never paid), CLEAN LAP at ×4.75 instead of
 *                   ×1, HIGH SPEED, INITIATION, and the drift's own base points.
 *   PERFECT EXIT    |dβ/dt| over "the drift's last 0.5 s" — which, on the live window, is the
 *                   half second AFTER the car straightened, inside the exit hold, where the
 *                   trace is flat by construction. It is not the exit at all.
 *   CLEAN LAP       which drift is the lap's LAST one, decided on `endT`.
 *
 * Measured over 2 tracks × 6 seeds × 6 looseness × 4 lap counts, 238 of 288 runs published a
 * different number on the drive display from the one the verdict screen printed for the same
 * run: +32.1 % at harbor/3/0 (28 401 against 21 505) and −11.7 % at touge/6/0.2.
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
  /**
   * The detector's own start for this drift — back-dated to where the slide began, which is the
   * `startT` the `DriftEvent` will carry. The scorer scores the drift over THAT window, not over
   * the window in which the detector happened to be sure.
   */
  startT: number;
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
   * How much of `delta` is the engine FINALISING a past slide rather than this instant earning.
   *
   * A drift is scored over the window the DETECTOR published for it — the same call, over the
   * same samples, that `scoreSession` makes — and the scorer only has that window once the drift
   * is over, `exitHoldS` after the car straightened. So the moment a drift closes (and again if
   * the detector re-opens it to link it, which turns two slides into one event) the running total
   * is corrected to the score the verdict screen will publish, and THAT correction lands here.
   *
   * It is what makes the counting guarantee checkable rather than approximate: on a frame stamped
   * `counting: false`, `delta - settled` is never positive, because nothing was earned FOR that
   * instant. `delta` alone cannot say it, since a slide that ended while the monitor still
   * believed the car can be finalised on a frame it no longer does.
   */
  settled: number;
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
  lost: boolean;
  lostPoints: number;
}

/**
 * One drift on the scorer's books.
 *
 * `settled` means a `DriftEvent` has claimed it, so its score is the one `scoreSession` will
 * publish. Until then it is the scorer's own reading of the same window — right in every case
 * the detector does not revise, and superseded when it does (a linked drift the detector
 * re-opens becomes ONE event; a slide shorter than `minDriftDurationS` becomes none).
 */
interface Recorded {
  sd: ScoredDrift;
  startT: number;
  endT: number;
  settled: boolean;
  /**
   * The event's own sample range, when one has claimed this drift. `DriftEvent.sampleStart` is
   * the onset crossing rounded to the nearer sample and it is NOT always the nearest one to
   * `startT`, so reproducing `scoreSession` bit for bit means using the index rather than
   * re-deriving it from the time: 16 ms of one drift moved a CLEAN LAP by 0.32 points, which is
   * a whole point on a run's published total.
   */
  sampleStart?: number;
  sampleEnd?: number;
  /** Its points have moved to `bankedTotal`; a spin can no longer take them. */
  banked: boolean;
  /** CLEAN LAP points attached to this drift — carried across a re-score, which cannot see laps. */
  lapBonus: number;
}

export class LiveScorer {
  private o: ScoreOptions;
  private acc: DriftAccumulator | null = null;
  /** Back-dated start of the drift in progress — the boundary its DriftEvent will carry. */
  private accStartT = 0;
  /** Where the detector currently says the drift in progress ENDS (`startT + durationS`). */
  private accEndT = 0;
  /** What `acc` has contributed to `chainPoints` so far (points + bonus already handed over). */
  private accPaid = 0;
  private bankedTotal = 0;
  private chainPoints = 0;
  private prevTotal = 0;
  /** Net change from finalising drifts since the last tick reported one (see `LiveTick.settled`). */
  private settledSince = 0;
  private settlingDepth = 0;

  // ── the chain replay, advanced one drift at a time exactly as `replayChains` advances it ──
  /** Multiplier a chained follower inherits. */
  private chainMult: number;
  /** Drifts already ON THE BOOKS in the current chain (the one in progress is not counted). */
  private chainDrifts = 0;
  /** End of the newest drift on the books, ON THE DETECTOR'S CLOCK (what `replayChains` uses). */
  private lastEndT = -Infinity;
  private lastSpun = false;
  private hasPrev = false;
  /** `lastEndT` value the chain has already banked through, so banking happens once per chain. */
  private bankedThroughT = NaN;
  private completed = new Map<number, Recorded>();
  private completedOrder: number[] = [];
  /**
   * Trailing `ringKeepS` of states and the integrity verdict each was scored under. A HEAD
   * INDEX with amortised compaction, not `slice()` on every push: re-slicing a full 12 000-
   * element window at 100 Hz cost 70 µs and ~100 KB of garbage PER SAMPLE — ten times the rest
   * of the engine put together — and only after the run passed two minutes, which is why no
   * test ever saw it.
   *
   * The mask rides along because a re-score has to refuse the same instants the live pass did,
   * bit for bit: `scoreDrift` with a per-sample mask reproduces the refusal exactly, while the
   * `suppressedS` fallback only pays its expected value.
   */
  private ring: SlipState[] = [];
  private ringOk: number[] = [];
  private ringHead = 0;
  /** Samples pushed so far: `ring[k]` is sample `samples - ring.length + k` of the run. */
  private samples = 0;
  /** What the NEXT tick has to report, because it happened between two samples. */
  private pending: EndDriftSink | null = null;
  /** Callouts waiting for a frame the scorer pays on (see the drain at the end of `push`). */
  private held: StyleCallout[] = [];
  private lastT = -Infinity;
  /** Ids of drifts on the books whose points are still at risk. */
  private unbankedIds: number[] = [];
  /** Id of the last drift that ended (by spin or by onDriftCompleted): later samples with it are ignored. */
  private deadId: number | null = null;
  /**
   * Every lap the track model has reported, with what the scorer has PAID for it against what it
   * is currently WORTH. A lap is judged the moment the line goes past — the drifts inside it may
   * still be revised, so the judgement is revised with them, exactly as a drift's own score is.
   */
  private laps: LapEntry[] = [];
  /** A lap's worth changed, or one is owed: re-judge on the next sample. */
  private lapsDirty = false;

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
    return this.acc ? this.acc.multiplier : this.chainOpenAt(this.lastT) ? this.chainMult : this.o.multiplierStart;
  }

  get chain(): { points: number; drifts: number; active: boolean } {
    const drifts = this.chainDriftsAt(this.lastT);
    return { points: this.chainPoints, drifts, active: drifts > 0 };
  }

  /** Is the chain still alive at `t` — i.e. would a drift starting now inherit the multiplier? */
  private chainOpenAt(t: number): boolean {
    return this.hasPrev && !this.lastSpun && t - this.lastEndT <= this.o.chainGapS;
  }

  /** Drifts in the chain as a HUD counts them: the ones on the books plus the one in progress. */
  private chainDriftsAt(t: number): number {
    if (this.acc) return this.chainDrifts + 1;
    return this.chainOpenAt(t) ? this.chainDrifts : 0;
  }

  /** The drift in progress, if any. */
  get current(): { id: number; points: number; multiplier: number; transitions: number; elapsedS: number } | null {
    if (!this.acc) return null;
    return { id: this.acc.id, points: this.acc.driftTotal, multiplier: this.acc.multiplier, transitions: this.acc.transitions, elapsedS: this.acc.elapsedS };
  }

  reset(): void {
    this.acc = null;
    this.accStartT = 0;
    this.accEndT = 0;
    this.accPaid = 0;
    this.bankedTotal = 0;
    this.chainPoints = 0;
    this.chainDrifts = 0;
    this.chainMult = this.o.multiplierStart;
    this.lastEndT = -Infinity;
    this.lastSpun = false;
    this.hasPrev = false;
    this.bankedThroughT = NaN;
    this.prevTotal = 0;
    this.settledSince = 0;
    this.settlingDepth = 0;
    this.completed.clear();
    this.completedOrder = [];
    this.ring = [];
    this.ringOk = [];
    this.ringHead = 0;
    this.samples = 0;
    this.pending = null;
    this.held = [];
    this.lastT = -Infinity;
    this.unbankedIds = [];
    this.deadId = null;
    this.laps = [];
    this.lapsDirty = false;
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
      settled: 0,
      counting: countsForPoints(s, plausible),
    };
    this.remember(s, plausible);
    // A CLEAN LAP earned while the monitor was doubting the car waits here for a sample the
    // scorer pays on, and lands on that one — never on a frame stamped `counting: false`.
    if (this.lapsDirty) this.refreshLaps(s, plausible);
    if (this.pending) {
      tick.callouts.push(...this.pending.callouts);
      if (this.pending.lost) {
        tick.lost = true;
        tick.lostPoints = this.pending.lostPoints;
      }
      this.pending = null;
    }
    // A CONFIRMED drift only. Phase 'entry' is the detector still deciding, and an entry it
    // abandons never becomes a `DriftEvent` — scoring one put points on the HUD that the verdict
    // screen had no drift to hang them on.
    const active = live !== null && CONFIRMED.has(live.phase) && live.id !== this.deadId;

    // a drift ended (feed went idle or switched id). It is closed at THIS sample, so this
    // sample's gate prices whatever it fires — the same rule `fire()` applies inside a drift.
    if (this.acc && (!active || (live as LiveDriftInfo).id !== this.acc.id)) this.endDrift(this.accEndT, false, tick);
    // a drift started
    if (active && !this.acc) this.startDrift(live as LiveDriftInfo, s.t, tick);

    if (this.acc) {
      const info = live as LiveDriftInfo;
      // The detector publishes where the drift ENDS on every frame — and on the frame its exit
      // hold expires it publishes the back-dated crossing rather than `t`, which is the `endT`
      // the DriftEvent will carry. Keeping it here is how the scorer closes the drift where the
      // engine says it ended instead of where it found out.
      if (Number.isFinite(info.startT) && Number.isFinite(info.durationS)) this.accEndT = Math.max(this.accStartT, info.startT + info.durationS);
      else this.accEndT = s.t;
      const res = this.acc.step(s, plausible);
      this.chainPoints += res.points + res.bonus;
      this.accPaid += res.points + res.bonus;
      tick.callouts.push(...res.callouts);
      tick.rate = res.rate;
      const spin = info.spin === true || this.acc.spun;
      if (spin) {
        this.accEndT = s.t;
        this.endDrift(s.t, true, tick);
      } else {
        tick.driftPoints = this.acc.driftTotal;
        tick.driftId = this.acc.id;
      }
    } else {
      this.idleHousekeeping(s.t, tick);
    }
    if (this.lapsDirty) this.refreshLaps(s, plausible);

    // A CALLOUT IS REPORTED BY A FRAME THE SCORER PAYS ON, never by one it refused. The exit
    // callouts are the case: they belong to the drift's last instant, and the scorer only finds
    // out the drift is over `exitHoldS` later — on a frame that may be one the monitor doubts.
    if (this.held.length && tick.counting) tick.callouts.push(...this.held.splice(0, this.held.length));

    tick.multiplier = this.multiplier;
    tick.chainPoints = this.chainPoints;
    tick.chainDrifts = this.chainDriftsAt(s.t);
    // NOTHING IS EARNED ON A FRAME THE SCORER WOULD NOT PAY ON, and the frame says so itself:
    // `delta - settled` is what this instant earned, and it is never positive while
    // `counting` is false. The total CAN still move on such a frame, by `settled` — a drift is
    // scored over the window the DETECTOR published for it, which the scorer only has once the
    // drift is over, `exitHoldS` after the car straightened and on whatever frame that lands on.
    // Recognising what a past slide was worth is not earning something now, so it is reported
    // rather than hidden; a display that hid it would owe the difference for the rest of the run
    // and end up publishing a number the verdict screen does not, which is the whole defect.
    tick.total = this.total;
    tick.delta = tick.total - this.prevTotal;
    tick.settled = this.settledSince;
    this.settledSince = 0;
    this.prevTotal = tick.total;
    if (tick.lost) tick.banner = `CHAIN LOST −${fmt(tick.lostPoints)}`;
    else if (tick.banked) tick.banner = `BANKED +${fmt(tick.bankedPoints)}`;
    this.lastT = s.t;
    return tick;
  }

  /**
   * The detector finished a drift. Returns the DriftScore for it — `scoreDrift` over the event's
   * own window, which is the score `scoreSession` publishes for the same event.
   *
   * The event arrives up to `mergeGapS` after the exit precisely because the detector may still
   * revise it: a slide confirmed inside that window RE-OPENS the pending drift, so two slides the
   * HUD counted separately become ONE event. This method therefore supersedes every unsettled
   * drift on the books — a merged pair, and any slide the detector's twitch rule dropped — with
   * the single authoritative score.
   */
  onDriftCompleted(e: DriftEvent): ScoredDrift {
    if (this.acc && this.acc.id === e.id) {
      const spin = e.spin === true || this.acc.spun;
      // the drift is closed here, between two samples: CHAIN LOST is reported on the next tick
      const out: EndDriftSink = { callouts: [], lost: false, lostPoints: 0 };
      this.accEndT = Math.min(e.endT, Math.max(this.lastT, this.accStartT));
      this.endDrift(this.accEndT, spin, out);
      this.pending = out; // CHAIN LOST is reported on the next tick; its delta shows the drop
    }
    return this.settle(e);
  }

  /**
   * Optional: tell the scorer a lap closed (from the track model) so CLEAN LAP can fire
   * live: ≥ cleanLapMinDrifts drifts ENDED inside the lap and none spun. Points bank
   * immediately (a clean lap cannot be lost). Returns the callout when it is paid on this
   * sample, or null — which includes the case where it is queued for the next believed sample,
   * or held because a slide that began before the line has not ended yet.
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
   *   WHICH DRIFT IS THE LAP'S LAST is the detector's boundary, because that is the boundary
   *   `scoreSession` uses, and the bonus is worth THAT drift's end multiplier. On harbor seed 3
   *   the live scorer read the second lap's last drift as #7 — it closed at 111.861 on the
   *   detection clock and #8 closed at 123.188, past the 122.64 line — while the session read it
   *   as #8, whose event ends at 122.558, inside. 1,408 points against 445, for one lap.
   *
   * `s` and `plausible` are REQUIRED for the same reason `DriftEvent.spin` is: a caller that can
   * omit the gate is a caller that will, and this is the third paying path that was missed.
   */
  onLapCompleted(lap: Lap, s: SlipState, plausible = true): StyleCallout | null {
    this.laps.push({ lap, points: 0, driftId: -1, paid: 0, paidTo: -1, announced: false });
    this.lapsDirty = true;
    return this.refreshLaps(s, plausible);
  }

  /**
   * Re-judge every lap against the books as they stand, and settle the difference.
   *
   * A lap is judged the moment its line goes past, on the drifts the scorer has then — and those
   * drifts are still provisional: one may be re-opened and linked into its neighbour, so a lap
   * that held three slides comes to hold two (harbor seed 5 at looseness 0.1 paid 845 points for
   * a lap that was never clean), and a slide still in its exit hold at the line turns out to have
   * ENDED before it, which decides whose end multiplier the bonus is worth (harbor seed 4 at
   * looseness 0.2: 366 points against 1,385). So the judgement is revised exactly as a drift's
   * own score is, and the difference lands like any other payment: a REDUCTION at once, an
   * INCREASE only on a sample `countsForPoints` accepts.
   */
  private refreshLaps(s: SlipState, plausible: boolean): StyleCallout | null {
    const counting = countsForPoints(s, plausible);
    let fired: StyleCallout | null = null;
    let owed = false;
    for (const e of this.laps) {
      const want = this.judgeLap(e.lap);
      e.points = want.points;
      e.driftId = want.driftId;
      // What this frame may settle to. A lap's FIRST payment is a payment and waits for a sample
      // the scorer pays on; once it is on the books, every later move of it — a reduction, a
      // transfer onto the drift that now carries it, a revision as those drifts settle — is a
      // correction to an award already made, and lands at once (reported as `settled`, like a
      // drift's own re-score). Holding revisions back instead left a lap paid 297 and worth 372
      // on a run whose monitor stopped believing it in between (harbor seed 9, looseness 0.15).
      const allow = counting || e.paid > 0 ? e.points : Math.min(e.points, e.paid);
      // THE CHIP SAYS WHAT THE LAP IS WORTH, so it waits until that is settled — the detector
      // may still re-open a drift inside the lap and link it to its neighbour, which changes how
      // many slides the lap held and whose end multiplier the bonus is worth. The MONEY does not
      // wait: it is judged at the line and revised with the drifts, so the running total is the
      // one the verdict screen publishes either way. Announcing at the line instead drew
      // `CLEAN LAP +1,385` for a lap that ended up worth 366.
      const announce = counting && this.lapIsFinal(e.lap);
      if (allow !== e.paid || e.driftId !== e.paidTo) {
        this.settling(() => {
          if (e.paid > 0) this.unpayLap(e);
          if (allow > 0) fired = this.payLap(e, allow, announce) ?? fired;
        });
      } else if (announce && !e.announced && e.paid > 0) {
        fired = this.announceLap(e) ?? fired;
      }
      if (e.points > e.paid) owed = true;
    }
    this.lapsDirty = owed;
    return fired;
  }

  /** Has the engine finished deciding which drifts the lap held? */
  private lapIsFinal(lap: Lap): boolean {
    if (this.acc && this.accStartT < lap.endT) return false;
    return !this.records().some((r) => !r.settled && r.startT < lap.endT);
  }

  /** Put the chip on screen for a lap whose bonus is already on the books. */
  private announceLap(e: LapEntry): StyleCallout | null {
    const rec = this.completed.get(e.paidTo);
    const c = rec?.sd.callouts.find((x) => x.kind === 'clean-lap');
    if (!c) return null;
    e.announced = true;
    if (!this.pending) this.pending = { callouts: [], lost: false, lostPoints: 0 };
    this.pending.callouts.push(c);
    return c;
  }

  /** What a lap is worth right now, and which drift carries it — `scoreSession`'s own test. */
  private judgeLap(lap: Lap): { points: number; driftId: number } {
    const o = this.o;
    const none = { points: 0, driftId: -1 };
    const inLap = this.records().filter((d) => d.sd.stats.endT >= lap.startT && d.sd.stats.endT < lap.endT);
    if (inLap.length < o.cleanLapMinDrifts || inLap.some((d) => d.sd.spun)) return none;
    const last = inLap[inLap.length - 1];
    // tidiness does not pay where sliding did not, and a drift a later spin took off the books
    // takes its lap bonus with it (`scoreSession` attaches it and then keeps only `!lost` drifts)
    if (last.sd.lost || !(last.sd.total - last.lapBonus > 0)) return none;
    const believed = lapBelief(inLap.map((d) => d.sd));
    if (!(believed > 0)) return none;
    // the same multiplier rule as every other callout, and the same one `scoreSession` applies
    // offline (the lap's last drift's end multiplier), so live and replay agree to the point
    return { points: o.calloutPoints['clean-lap'] * (o.calloutsUseMultiplier ? Math.max(1, last.sd.stats.multiplierEnd) : 1) * believed, driftId: last.sd.id };
  }

  /**
   * Put `amount` of CLEAN LAP on the books, against the drift that carries the lap. The chip is
   * announced once — on the frame that first pays the lap, which is always one the scorer pays on
   * — and every later revision of the amount is silent, because a frame may not show a `+N` for
   * an instant the scorer refused.
   */
  private payLap(e: LapEntry, amount: number, announce: boolean): StyleCallout | null {
    const c: StyleCallout = { t: e.lap.endT, kind: 'clean-lap', label: calloutLabel('clean-lap'), points: amount };
    this.bankedTotal += amount;
    const rec = this.completed.get(e.driftId);
    if (rec) {
      rec.sd.callouts.push(c);
      rec.sd.bonus += amount;
      rec.sd.total += amount;
      rec.lapBonus += amount;
    }
    e.paid = amount;
    e.paidTo = e.driftId;
    if (e.announced || !announce) return null;
    e.announced = true;
    if (!this.pending) this.pending = { callouts: [], lost: false, lostPoints: 0 };
    this.pending.callouts.push(c);
    return c;
  }

  /** Take a lap bonus back off the books — the lap turned out not to be worth what it was paid. */
  private unpayLap(e: LapEntry): void {
    const rec = this.completed.get(e.paidTo);
    if (rec) {
      const i = rec.sd.callouts.findIndex((c) => c.kind === 'clean-lap');
      if (i >= 0) rec.sd.callouts.splice(i, 1);
      rec.sd.bonus -= e.paid;
      rec.sd.total -= e.paid;
      rec.lapBonus -= e.paid;
    }
    this.bankedTotal -= e.paid;
    e.paid = 0;
    e.paidTo = -1;
  }

  /** Drift scores accumulated so far, in completion order. */
  get completedDrifts(): ScoredDrift[] {
    return this.records().map((r) => r.sd);
  }

  // ---------------------------------------------------------------------------------------

  /**
   * Run a finalisation and remember what it moved, so the frame that reports it can say how much
   * of its `delta` was the engine finishing its accounting rather than this instant earning.
   */
  private settling<T>(fn: () => T): T {
    if (this.settlingDepth++ > 0) {
      try {
        return fn();
      } finally {
        this.settlingDepth--;
      }
    }
    const before = this.total;
    try {
      return fn();
    } finally {
      this.settlingDepth--;
      this.settledSince += this.total - before;
    }
  }

  private records(): Recorded[] {
    return this.completedOrder.map((id) => this.completed.get(id) as Recorded);
  }

  /**
   * The chain context a drift starting at `startT` inherits — `replayChains`' own test, on the
   * detector's clock. Idempotent, so the provisional accumulator and the authoritative re-score
   * of the same drift are handed the same context.
   */
  private beginChain(startT: number, tick: LiveTick | null = null): { multiplier: number; chainDrifts: number } {
    const chained = this.chainOpenAt(startT);
    // `replayChains`' own bank point, and the one that decides what a later spin can still take:
    // a chain that ended more than `bankDelayS` before this drift began is already in the bank.
    if (!chained || startT - this.lastEndT >= this.o.bankDelayS) this.bank(tick);
    if (!chained) {
      this.chainMult = this.o.multiplierStart;
      this.chainDrifts = 0;
    }
    return { multiplier: this.chainMult, chainDrifts: this.chainDrifts };
  }

  /** Move what is at risk into the bank, once — `tick` gets the BANKED banner when it is a frame. */
  private bank(tick: LiveTick | null): void {
    if (this.bankedThroughT === this.lastEndT || !this.hasPrev) return;
    this.bankedThroughT = this.lastEndT;
    if (this.chainPoints > 0) {
      if (tick) {
        tick.banked = true;
        tick.bankedPoints = this.chainPoints;
      }
      this.bankedTotal += this.chainPoints;
      this.chainPoints = 0;
    }
    // A drift worth nothing still LEAVES the chain when the chain banks. It used to stay on the
    // at-risk list whenever the chain had no points to bank — which is every drift of a run the
    // monitor refused — so a spin three drifts later marked all of them `lost` while the session
    // marked none. Same total (they were worth nothing), different story on the results screen.
    for (const id of this.unbankedIds) {
      const d = this.completed.get(id);
      if (d) d.banked = true;
    }
    this.unbankedIds = [];
  }

  private startDrift(live: LiveDriftInfo, t: number, tick: LiveTick): void {
    const startT = Number.isFinite(live.startT) ? Math.min(live.startT, t) : t;
    this.accStartT = startT;
    this.accEndT = t;
    this.accPaid = 0;
    // the new slide is itself the proof that the previous chain's points are safe, so the BANKED
    // beat lands here when the driver goes again more than `bankDelayS` after the last exit
    this.acc = new DriftAccumulator(this.o, live.id, t, this.beginChain(startT, tick));
  }

  /**
   * Close the drift at `endT` — the DETECTOR's boundary, not the sample the scorer found out on,
   * which is `exitHoldS` later with the car already straight. The exit callouts the record ends
   * up with are held for a frame the scorer pays on, because a chip may not show a `+N` on a
   * frame stamped `counting: false`; their points are inside the record either way.
   */
  private endDrift(endT: number, spin: boolean, tick: EndDriftSink): void {
    const acc = this.acc as DriftAccumulator;
    const o = this.o;
    // the accumulator's own exit callouts are provisional like the rest of it; the record's are
    // the ones that get reported, and their points are already inside its total
    const { stats } = acc.finish(Math.max(this.accStartT, endT), spin);
    const provisional = buildDriftScore(acc, stats, o);
    const paid = this.accPaid;
    this.acc = null;
    this.accPaid = 0;
    const rec: Recorded = { sd: provisional, startT: this.accStartT, endT: Math.max(this.accStartT, endT), settled: false, banked: false, lapBonus: 0 };
    this.record(rec, paid, tick);
    if (this.completed.has(rec.sd.id)) for (const c of rec.sd.callouts) if (c.kind === 'perfect-exit') this.held.push(c);
  }

  /**
   * Put a drift on the books: replace what it has already paid into the chain with its score over
   * the detector's own window, and advance the chain replay exactly as `replayChains` advances it.
   */
  private record(rec: Recorded, alreadyPaid: number, tick: EndDriftSink | null): void {
    this.settling(() => this.recordNow(rec, alreadyPaid, tick));
  }

  private recordNow(rec: Recorded, alreadyPaid: number, tick: EndDriftSink | null): void {
    const o = this.o;
    const ctx = this.beginChain(rec.startT);
    rec.sd = this.rescore(rec, ctx) ?? rec.sd;
    // A slide shorter than the detector's own twitch rule never becomes a DriftEvent, so it never
    // reaches the verdict screen: the HUD must not keep it either.
    if (!rec.sd.spun && rec.endT - rec.startT < o.minDriftDurationS) {
      this.chainPoints -= alreadyPaid;
      return;
    }
    this.chainPoints += rec.sd.total - alreadyPaid;
    this.chainDrifts++;
    if (rec.sd.spun) {
      const lost = this.chainPoints;
      if (tick) {
        tick.lost = true;
        tick.lostPoints = lost;
      }
      this.chainPoints = 0;
      this.chainMult = o.multiplierStart;
      this.chainDrifts = 0;
      rec.sd.lost = true;
      for (const id of this.unbankedIds) {
        const d = this.completed.get(id);
        if (d) d.sd.lost = true;
      }
      this.unbankedIds = [];
    } else {
      this.chainMult = rec.sd.stats.multiplierEnd;
      this.unbankedIds.push(rec.sd.id);
    }
    this.lastEndT = rec.endT;
    this.lastSpun = rec.sd.spun;
    this.hasPrev = true;
    this.lapsDirty = this.lapsDirty || this.laps.length > 0;
    this.deadId = rec.sd.id;
    this.completed.set(rec.sd.id, rec);
    this.completedOrder.push(rec.sd.id);
  }

  /**
   * Score a drift the way the session will: `scoreDrift` over the detector's window, from the
   * ring, with the per-sample verdicts the live pass ran under. Null when the ring no longer
   * reaches back to the start of the drift — `ringKeepS` (120 s) against a detector cap of
   * `maxDurationS + chainBonusS × transitions`, so it takes one drift with nine direction changes
   * in it before the window can fall short; the provisional score stands in that case.
   */
  private rescore(rec: Recorded, ctx: { multiplier: number; chainDrifts: number }): ScoredDrift | null {
    const n = this.ring.length;
    const base = this.samples - n; // run-sample index of ring[0]
    let a: number;
    let b: number;
    if (rec.sampleStart !== undefined && rec.sampleEnd !== undefined) {
      // THE EVENT'S OWN INDICES, so this is `driftSampleRange` over the same samples.
      a = rec.sampleStart - base;
      b = rec.sampleEnd - base;
      if (a < this.ringHead || b >= n) return null; // the ring no longer holds the whole drift
      while (b >= a && this.ring[b].t > rec.endT + 1e-6) b--;
    } else {
      a = this.ringHead;
      while (a < n && this.ring[a].t < rec.startT) a++;
      if (a >= n) return null;
      if (a === this.ringHead && this.ring[a].t > rec.startT + this.o.maxDtS) return null; // the ring forgot the start
      // THE NEAREST SAMPLE TO THE BOUNDARY, not the first one past it. A drift's start is an
      // interpolated crossing between two samples, and `DriftEvent.sampleStart` is that crossing
      // rounded to the nearer of the two — so `driftSampleRange` can begin one sample BEFORE
      // `startT`. One 10 ms sample is enough to change the answer: the transition counter is
      // seeded at the first sample it sees, and a swing only counts once the side being left has
      // been held `minDwellS`, so harbor seed 6 lost a whole TRANSITION (135 points, and the
      // multiplier step behind it) to a window that began 0.9 ms late.
      if (a > this.ringHead && rec.startT - this.ring[a - 1].t < this.ring[a].t - rec.startT) a--;
      b = a;
      while (b + 1 < n && this.ring[b + 1].t <= rec.endT) b++;
    }
    if (b < a) return null;
    const states = this.ring.slice(a, b + 1);
    if (!states.length) return null;
    const mask = new Uint8Array(states.length);
    for (let i = 0; i < states.length; i++) mask[i] = this.ringOk[a + i];
    const e: DriftEvent = {
      id: rec.sd.id,
      startT: rec.startT,
      endT: rec.endT,
      durationS: rec.endT - rec.startT,
      peakAngle: 0,
      peakAngleT: rec.startT,
      meanAngle: 0,
      angleStdDev: 0,
      transitions: 0,
      entrySpeed: 0,
      meanSpeed: 0,
      minSpeed: 0,
      distanceM: 0,
      peakYawRate: 0,
      peakLateralAccel: 0,
      initialDirection: 1,
      spin: rec.sd.spun,
      suppressedS: 0,
      sampleStart: 0,
      sampleEnd: states.length - 1,
    };
    return scoreDrift(e, states, this.o, { ...ctx, spin: rec.sd.spun, plausible: mask });
  }

  /**
   * A DriftEvent is the engine's own account of a drift, and it wins over the scorer's reading of
   * the same stretch of road. It supersedes every unsettled drift on the books, because the
   * detector may have merged two of them into this one, or dropped one as a twitch.
   */
  private settle(e: DriftEvent): ScoredDrift {
    return this.settling(() => this.settleNow(e));
  }

  private settleNow(e: DriftEvent): ScoredDrift {
    const known = this.completed.get(e.id);
    if (known && known.settled) return known.sd;
    let supersededSpin = false;
    // unwind every unsettled record, newest first, back out of the books
    while (this.completedOrder.length) {
      const id = this.completedOrder[this.completedOrder.length - 1];
      const rec = this.completed.get(id) as Recorded;
      if (rec.settled) break;
      this.completedOrder.pop();
      this.completed.delete(id);
      const i = this.unbankedIds.indexOf(id);
      if (i >= 0) this.unbankedIds.splice(i, 1);
      supersededSpin = supersededSpin || rec.sd.spun;
      // a CLEAN LAP rides on a drift's score for the results screen but banks on its own, so it
      // comes off separately — and the lap goes back to unpaid, to be re-judged against the event
      const drift = rec.sd.total - rec.lapBonus;
      if (rec.banked) this.bankedTotal -= drift;
      else if (!rec.sd.lost) this.chainPoints -= drift;
      // The lap bonus stays on the books and keeps looking for a home: the event replaces the
      // drift, it does not undo the lap. Re-homing it is a move, not a payment, so it needs no
      // believed sample — without that, a lap paid at the line went unpaid for the rest of a run
      // whose mount the monitor had stopped believing (harbor seed 4, looseness 0.2: 366 points).
      for (const le of this.laps) if (le.paidTo === id) le.paidTo = ORPHANED;
    }
    const prev = this.completedOrder.length ? (this.completed.get(this.completedOrder[this.completedOrder.length - 1]) as Recorded) : null;
    this.hasPrev = prev !== null;
    this.lastEndT = prev ? prev.endT : -Infinity;
    this.lastSpun = prev ? prev.sd.spun : false;
    this.chainMult = prev && !prev.sd.spun ? prev.sd.stats.multiplierEnd : this.o.multiplierStart;
    this.chainDrifts = prev ? this.chainDriftsBefore(prev) : 0;
    this.bankedThroughT = NaN;
    this.deadId = prev ? prev.sd.id : this.deadId;
    // A SPIN THE HUD ANNOUNCED MUST NOT REACH THE RESULTS SCREEN AS A CLEAN EXIT. The event is
    // the authority on the drift, but a `spin: false` event over a stretch the live feed called
    // a spin is a producer that disagrees with itself, and the harsher verdict is the safe one.
    const spun = e.spin || supersededSpin;
    const rec: Recorded = {
      sd: this.emptyScore({ ...e, spin: spun }),
      startT: e.startT,
      endT: e.endT,
      sampleStart: e.sampleStart,
      sampleEnd: e.sampleEnd,
      settled: true,
      banked: false,
      lapBonus: 0,
    };
    this.record(rec, 0, null);
    if (!this.completed.has(e.id)) {
      // the twitch rule dropped it: nothing on the books, nothing on the screen
      rec.sd.lost = true;
    }
    this.lapsDirty = true;
    return rec.sd;
  }

  /** How many settled drifts are in the chain that `prev` ends. */
  private chainDriftsBefore(prev: Recorded): number {
    const recs = this.records();
    let n = 0;
    for (let i = recs.length - 1; i >= 0; i--) {
      n++;
      if (recs[i].sd.spun) break;
      const before = recs[i - 1];
      if (!before || recs[i].startT - before.endT > this.o.chainGapS) break;
    }
    return n;
  }

  /** A zero score for an event the ring can no longer reach (the score `record` will replace). */
  private emptyScore(e: DriftEvent): ScoredDrift {
    const acc = new DriftAccumulator(this.o, e.id, e.startT, { multiplier: this.chainMult, chainDrifts: this.chainDrifts });
    const { stats } = acc.finish(e.endT, e.spin);
    return buildDriftScore(acc, stats, this.o);
  }

  /**
   * Nobody started another slide, so the chain's points are safe — but only once the detector can
   * no longer DISCOVER one that began inside the bank delay. A drift's start is back-dated by up
   * to `chainLookbackS` behind the sample that confirms it, so "BANKED" is claimed that much
   * after `bankDelayS` rather than on the stroke of it. The claim is the reason: the HUD says
   * those points can no longer be lost, and a slide the scorer had not met yet used to take them.
   */
  private idleHousekeeping(t: number, tick: LiveTick): void {
    const o = this.o;
    if (this.hasPrev && !this.lastSpun && t - this.lastEndT >= o.bankDelayS + o.chainLookbackS) this.bank(tick);
  }

  private remember(s: SlipState, plausible: boolean): void {
    this.samples++;
    this.ring.push(s);
    this.ringOk.push(countsForPoints(s, plausible) ? 1 : 0);
    const cutoff = s.t - this.o.ringKeepS;
    // O(1) amortised: drop expired samples by moving a head index, and only compact the array
    // when the dead prefix is at least half of it (so the O(n) copy happens once per n pushes)
    while (this.ringHead < this.ring.length && this.ring[this.ringHead].t < cutoff) this.ringHead++;
    if (this.ringHead > 4096 && this.ringHead * 2 >= this.ring.length) {
      this.ring = this.ring.slice(this.ringHead);
      this.ringOk = this.ringOk.slice(this.ringHead);
      this.ringHead = 0;
    }
  }
}

/** `paidTo` when the drift a lap bonus was attached to has been superseded by its event. */
const ORPHANED = -2;

/** A lap, what it is currently worth, and what the scorer has actually put on the books for it. */
interface LapEntry {
  lap: Lap;
  /** What it is worth now, and the drift that carries it. */
  points: number;
  driftId: number;
  /** What is on the books, and against which drift. */
  paid: number;
  paidTo: number;
  /** The chip has been on screen: later revisions of the amount are silent. */
  announced: boolean;
}

/** The detector has confirmed a drift in these phases; 'entry' is it still deciding. */
const CONFIRMED = new Set<DriftPhase>(['drifting', 'transition', 'exit']);

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
