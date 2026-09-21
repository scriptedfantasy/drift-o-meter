/**
 * scoreSession — replays the chain rules over a whole run and aggregates the
 * 0–100 components + grade. See index.ts for the rule set.
 */
import type { DriftEvent, Lap, SessionIntegrity, SessionScore, SlipState, StyleCalloutKind, TrackCorner, TrackModel } from '../types';
import { clamp, radToDeg } from '../types';
import { countsForPoints } from './accumulator';
import { scoreDrift, type ScoredDrift } from './drift';
import {
  angleScore,
  calloutLabel,
  curve,
  gradeFor,
  resolveOptions,
  speedScore,
  steadinessScore,
  trackFactorFor,
  NEUTRAL_TRACK,
  type ScoreOptions,
  type TrackFactor,
} from './rules';

/** Per-sample side channel `scoreSession` needs to reproduce what the live run scored. */
export interface SessionContext {
  /**
   * 1 where the integrity monitor believed the slide, 0 where it did not, indexed exactly like
   * `states`. Absent = believe everything (a replay of a session recorded before the monitor
   * was wired in).
   */
  plausible?: Uint8Array | null;
  /** End-of-run verdicts from the integrity monitor. */
  integrity?: { mount: 'rigid' | 'suspect' | 'loose'; physics: 'ok' | 'implausible'; gps: 'good' | 'poor' | 'none'; message: string } | null;
}

export interface SessionBreakdown extends SessionScore {
  perDrift: Record<number, ScoredDrift>;
  /** 0..100 combined score before grading. */
  combined: number;
  /** Cross-lap corner consistency (0..100) or null when the track has < 2 laps / no corners. */
  crossLapConsistency: number | null;
  steadiness: number;
  /** Quality ingredients, 0..100 / factors 0..1. */
  qualityParts: { steadiness: number; timeAtAngle: number; cleanExitFraction: number; exitFactor: number; spinFactor: number };
  /** Style ingredients, 0..100. */
  styleParts: { variety: number; transitions: number; chain: number; flair: number };
  drifts: number;
  spins: number;
  transitions: number;
  cleanLaps: number;
  /** Total drifting seconds. */
  driftTimeS: number;
  /**
   * Drifts the ANGLE component was measured over: the ones that did not end in a spin. Lower
   * than `drifts` means a screen should say so ("8 of 11 slides — the three you spun do not
   * count") rather than leaving the number unexplained.
   */
  angleDrifts: number;
  /** What the integrity monitor made of the run, and whether the score may be published. */
  integrity: SessionIntegrity;
  /** How the track's own geometry scaled the angle and speed expectations. */
  trackFactor: TrackFactor;
  /** Points of the biggest single drift ÷ points of all kept drifts (1.0 = one corner was the run). */
  bestShare: number;
  /** Median kept-drift points, so a results screen can say "best vs typical" instead of only "best". */
  medianDriftPoints: number;
  /** Total ÷ drifting seconds: the rate a driver kept up, independent of how long they drove. */
  pointsPerDriftSecond: number;
}

export interface ChainSummary {
  drifts: number[];
  /** Points that made it to the bank. */
  banked: number;
  /** Points lost to a spin. */
  lost: number;
}

/**
 * Replay the chain rules over the drifts (sorted by start time):
 *  - a drift that starts ≤ chainGapS after a clean exit inherits the multiplier and the chain count;
 *  - a drift that starts ≥ bankDelayS after the previous exit finds those points already banked;
 *  - a spin loses every un-banked drift of the chain (marked `lost`).
 */
export function replayChains(
  drifts: DriftEvent[],
  states: SlipState[],
  o: ScoreOptions,
  ctx?: SessionContext,
  tf: TrackFactor = NEUTRAL_TRACK,
): { scored: ScoredDrift[]; chains: ChainSummary[] } {
  const sorted = drifts.slice().sort((a, b) => a.startT - b.startT || a.id - b.id);
  const scored: ScoredDrift[] = [];
  const chains: ChainSummary[] = [];
  let mult = o.multiplierStart;
  let chainDrifts = 0;
  let lastEndT = -Infinity;
  let lastSpun = false;
  let unbanked: ScoredDrift[] = [];
  let chain: ChainSummary | null = null;
  for (const e of sorted) {
    const gap = e.startT - lastEndT;
    const chained = chain !== null && !lastSpun && gap <= o.chainGapS;
    if (!chained) {
      if (chain) for (const d of unbanked) chain.banked += d.total; // the previous chain banked on its own
      mult = o.multiplierStart;
      chainDrifts = 0;
      unbanked = [];
      chain = { drifts: [], banked: 0, lost: 0 };
      chains.push(chain);
    } else if (gap >= o.bankDelayS) {
      for (const d of unbanked) chain!.banked += d.total;
      unbanked = [];
    }
    // `e.spin` is the detector's verdict and it is REQUIRED on a DriftEvent: a spin that the
    // HUD announced as CHAIN LOST must not reach the results screen as a clean exit.
    const sd = scoreDrift(e, states, o, { multiplier: mult, chainDrifts, spin: e.spin, plausible: ctx?.plausible ?? null }, tf);
    scored.push(sd);
    chain!.drifts.push(sd.id);
    chainDrifts++;
    unbanked.push(sd);
    if (sd.spun) {
      for (const d of unbanked) {
        d.lost = true;
        chain!.lost += d.total;
      }
      unbanked = [];
      mult = o.multiplierStart;
      chainDrifts = 0;
      lastSpun = true;
      chain = null;
    } else {
      mult = sd.multiplierEnd;
      lastSpun = false;
    }
    lastEndT = e.endT;
  }
  if (chain) for (const d of unbanked) chain.banked += d.total;
  return { scored, chains };
}

/** Callouts a driver has to go and EARN: the ones style's flair term counts. */
const RARE_KINDS = new Set<StyleCalloutKind>(['extreme-angle', 'manji', 'high-speed', 'link', 'clean-lap']);

/** Duration-weighted mean (weights floored at minWeightS so a blip still counts a little). */
function wmean(items: Array<{ w: number; v: number }>): number {
  let sw = 0;
  let sv = 0;
  for (const it of items) {
    sw += it.w;
    sv += it.w * it.v;
  }
  return sw > 0 ? sv / sw : 0;
}

// ---------------------------------------------------------------------------------------
// Track projection for cross-lap consistency

function nearestS(ref: TrackModel['refPath'], x: number, y: number, hint: number, closed: boolean): { s: number; idx: number; d2: number } {
  const n = ref.length;
  const win = 60;
  let best = -1;
  let bestD2 = Infinity;
  const consider = (i: number) => {
    const p = ref[i];
    const dx = p.x - x;
    const dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  };
  for (let k = -win; k <= win; k++) {
    let i = hint + k;
    if (closed) i = ((i % n) + n) % n;
    else if (i < 0 || i >= n) continue;
    consider(i);
  }
  if (bestD2 > 15 * 15) {
    bestD2 = Infinity;
    for (let i = 0; i < n; i++) consider(i);
  }
  return { s: ref[best].s, idx: best, d2: bestD2 };
}

export interface LapCornerStats {
  /** Peak |β| (deg, smoothed) per corner; NaN where the lap never visited the corner window. */
  peaks: number[];
  /** Arc-length (m, along the reference lap) where |β| first rose through angleFloorDeg on the way into each corner; NaN if no initiation was seen. */
  initiationS: number[];
}

/** Per lap: peak angle and initiation point per corner. */
export function cornerStatsPerLap(states: SlipState[], track: TrackModel, o: ScoreOptions): LapCornerStats[] {
  const laps = track.laps;
  const corners = track.corners;
  const ref = track.refPath;
  const out: LapCornerStats[] = [];
  if (!laps.length || !corners.length || ref.length < 2) return out;
  const L = track.lengthM || ref[ref.length - 1].s;
  const wrapS = (x: number) => (track.closed ? ((x % L) + L) % L : x);
  const inRange = (s: number, a0: number, b0: number): boolean => {
    if (!track.closed) return s >= a0 && s <= b0;
    const a = wrapS(a0);
    const b = wrapS(b0);
    return a <= b ? s >= a && s <= b : s >= a || s <= b;
  };
  /** signed distance from a (m) forward to s along the lap */
  const forward = (a: number, s: number): number => {
    if (!track.closed) return s - a;
    let d = s - wrapS(a);
    if (d < -L / 2) d += L;
    if (d > L / 2) d -= L;
    return d;
  };
  for (const lap of laps) {
    const peaks = new Array<number>(corners.length).fill(NaN);
    const initiationS = new Array<number>(corners.length).fill(NaN);
    const below = new Array<boolean>(corners.length).fill(false); // seen |β| < floor inside the lookback zone
    const i0 = clamp(lap.sampleStart | 0, 0, states.length - 1);
    const i1 = clamp(lap.sampleEnd | 0, 0, states.length - 1);
    let hint = 0;
    const win: Array<{ t: number; v: number }> = [];
    let sum = 0;
    for (let i = i0; i <= i1; i++) {
      const st = states[i];
      const v = Math.abs(radToDeg(st.beta));
      win.push({ t: st.t, v });
      sum += v;
      while (win.length && win[0].t < st.t - o.smoothingS) sum -= win.shift()!.v;
      const sm = sum / win.length;
      const p = nearestS(ref, st.x, st.y, hint, track.closed);
      hint = p.idx;
      for (let c = 0; c < corners.length; c++) {
        const cc = corners[c];
        if (inRange(p.s, cc.startS - o.cornerLeadMarginM, cc.endS + o.cornerTrailMarginM)) {
          if (!(peaks[c] >= sm)) peaks[c] = Number.isNaN(peaks[c]) ? sm : Math.max(peaks[c], sm);
        }
        if (Number.isNaN(initiationS[c]) && inRange(p.s, cc.startS - o.initiationLookbackM, cc.endS)) {
          if (sm < o.angleFloorDeg) below[c] = true;
          else if (below[c]) initiationS[c] = forward(cc.startS, p.s); // metres relative to the corner start
        }
      }
    }
    out.push({ peaks, initiationS });
  }
  return out;
}

/** Backwards-compatible view: peak |β| per [lap][corner]. */
export function cornerPeaksPerLap(states: SlipState[], track: TrackModel, o: ScoreOptions): number[][] {
  return cornerStatsPerLap(states, track, o).map((l) => l.peaks);
}

function sampleSd(vals: number[]): number {
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1));
}

/**
 * Cross-lap consistency (null if < 2 laps or no corners), angle-weighted over the corners
 * drifted in at least one lap:
 *  - angle:      100 × (1 − cvScale × CV of the peak angle across laps)
 *  - initiation: 100 × (1 − sd of the initiation point across laps / initiationSdFullM)
 * blended with crossLapAngleWeight. A corner drifted in one lap and skipped in another
 * counts as inconsistent (its peak that lap is 0).
 */
export function crossLapConsistency(states: SlipState[], track: TrackModel | null, o: ScoreOptions): number | null {
  if (!track || track.laps.length < 2 || !track.corners.length) return null;
  const per = cornerStatsPerLap(states, track, o);
  if (per.length < 2) return null;
  let sw = 0;
  let sv = 0;
  for (let c = 0; c < track.corners.length; c++) {
    // a corner the path does not actually fit is a corner whose window sits on the wrong piece
    // of road: comparing laps through it measures the model's error, not the driver's
    if (cornerFitResidualM(track, track.corners[c]) > o.cornerFitMaxResidualM) continue;
    const vals = per.map((row) => (Number.isNaN(row.peaks[c]) ? 0 : row.peaks[c]));
    if (!vals.some((v) => v >= o.angleFloorDeg)) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const cv = mean > 0 ? sampleSd(vals) / mean : 1;
    const angleScore = 100 * clamp(1 - o.cvScale * cv, 0, 1);
    const inits = per.map((row) => row.initiationS[c]).filter((x) => !Number.isNaN(x));
    let score = angleScore;
    if (inits.length >= 2) {
      const initScore = 100 * clamp(1 - sampleSd(inits) / o.initiationSdFullM, 0, 1);
      score = o.crossLapAngleWeight * angleScore + (1 - o.crossLapAngleWeight) * initScore;
    }
    sw += mean;
    sv += mean * score;
  }
  if (sw <= 0) return null;
  return sv / sw;
}

/**
 * RMS distance (m) from the reference path over a corner's span to the best-fit circle through
 * it — how much the corner in the model IS a corner. An algebraic (Kåsa) fit: exact for a clean
 * arc, and large for a span that wandered onto a straight or swallowed two separate bends.
 */
export function cornerFitResidualM(track: TrackModel, corner: TrackCorner): number {
  const ref = track.refPath;
  const n = ref.length;
  if (n < 8) return Infinity;
  const L = track.lengthM || ref[n - 1].s;
  const span = corner.endS - corner.startS;
  if (!(span > 0) || !(L > 0)) return Infinity;
  const step = L / n;
  const i0 = Math.round(corner.startS / step);
  const count = Math.max(4, Math.round(span / step));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k <= count; k++) {
    const i = track.closed ? ((i0 + k) % n + n) % n : i0 + k;
    if (i < 0 || i >= n) continue;
    xs.push(ref[i].x);
    ys.push(ref[i].y);
  }
  const m = xs.length;
  if (m < 4) return Infinity;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < m; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= m;
  my /= m;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  for (let i = 0; i < m; i++) {
    const x = xs[i] - mx;
    const y = ys[i] - my;
    const z = x * x + y * y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxz += x * z;
    syz += y * z;
  }
  const det = 2 * (sxx * syy - sxy * sxy);
  if (Math.abs(det) < 1e-9) return Infinity;
  const cx = (syy * sxz - sxy * syz) / det;
  const cy = (sxx * syz - sxy * sxz) / det;
  let r = 0;
  for (let i = 0; i < m; i++) r += Math.hypot(xs[i] - mx - cx, ys[i] - my - cy);
  r /= m;
  let sq = 0;
  for (let i = 0; i < m; i++) {
    const d = Math.hypot(xs[i] - mx - cx, ys[i] - my - cy) - r;
    sq += d * d;
  }
  return Math.sqrt(sq / m);
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const a = v.slice().sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
}

/** Median corner radius of the model (m), 0 when the model has no usable corners. */
export function medianCornerRadiusM(track: TrackModel | null): number {
  if (!track) return 0;
  return median(track.corners.map((c) => c.radiusM).filter((r) => Number.isFinite(r) && r > 0));
}

/**
 * Median straight between consecutive corners (m): how LINKED the road is. A road whose corners
 * are 19 m apart can be drifted as one continuous slide; one whose corners are 47 m apart cannot,
 * however well it is driven. 0 when there are fewer than two corners.
 */
export function medianCornerGapM(track: TrackModel | null): number {
  if (!track || track.corners.length < 2) return 0;
  const cs = track.corners.slice().sort((a, b) => a.startS - b.startS);
  const gaps: number[] = [];
  for (let i = 1; i < cs.length; i++) gaps.push(Math.max(0, cs[i].startS - cs[i - 1].endS));
  if (track.closed && track.lengthM > 0) gaps.push(Math.max(0, track.lengthM - cs[cs.length - 1].endS + cs[0].startS));
  return median(gaps);
}

/**
 * What a lap's CLEAN LAP bonus is worth, 0..1 — the offline form of the gate
 * `LiveScorer.onLapCompleted` asks at the instant it pays.
 *
 * TWO PATHS, the same two `scoreDrift` already has, and for the same reason.
 *
 *  - WITH the per-sample mask (the live pipeline's own `finish()`, and any replay handed it):
 *    the answer is the gate itself, at the sample the lap closed on — `countsForPoints`, the
 *    identical expression, so `finish()` reproduces the live decision exactly. 1 or 0.
 *
 *  - WITHOUT it (a session re-scored from storage, where a sample-indexed mask could not
 *    survive decimation without silently misaligning): the durable fallback is
 *    `DriftEvent.suppressedS`, and a per-drift duration cannot say WHERE inside a slide the
 *    monitor stopped believing — only how much of it it refused. So this pays the EXPECTED
 *    value, the believed fraction of the lap's drifting time, exactly as `scoreDrift` pays the
 *    expected value of a suppressed drift's callouts. A lap whose believed remainder is shorter
 *    than one sample gap was not partly believed, it was refused, and pays 0.
 */
function lapPayFactor(lap: Lap, states: SlipState[], mask: Uint8Array | null, lapDrifts: DriftEvent[], maxDtS: number): number {
  if (mask) {
    const i = firstSampleAtOrAfter(states, lap.endT);
    if (i < 0) return 0;
    return countsForPoints(states[i], mask[i] !== 0) ? 1 : 0;
  }
  let dur = 0;
  let supp = 0;
  for (const e of lapDrifts) {
    if (!(e.durationS > 0)) continue;
    dur += e.durationS;
    supp += Math.min(Math.max(0, e.suppressedS), e.durationS);
  }
  if (!(dur > 0)) return 1; // nothing to doubt: a lap with no measured drifting time
  const remainderS = dur - supp;
  return remainderS <= maxDtS ? 0 : clamp(remainderS / dur, 0, 1);
}

/** Index of the first state at or after `t`, or the last one; −1 when there are none. */
function firstSampleAtOrAfter(states: SlipState[], t: number): number {
  const n = states.length;
  if (n === 0) return -1;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (states[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, n - 1);
}

// ---------------------------------------------------------------------------------------

export function scoreSession(
  drifts: DriftEvent[],
  states: SlipState[],
  track: TrackModel | null,
  opts?: Partial<ScoreOptions>,
  ctx?: SessionContext,
): SessionBreakdown {
  const o = resolveOptions(opts);
  const tf = trackFactorFor(medianCornerRadiusM(track), medianCornerGapM(track), o);
  const { scored, chains } = replayChains(drifts, states, o, ctx, tf);
  const perDrift: Record<number, ScoredDrift> = {};
  for (const d of scored) perDrift[d.id] = d;

  // ---- clean laps: a lap in which ≥ 3 drifts ENDED and none spun (attached to the lap's last drift) --
  let cleanLaps = 0;
  if (track && track.laps.length) {
    for (const lap of track.laps) {
      const inLap = scored.filter((d) => d.stats.endT >= lap.startT && d.stats.endT < lap.endT);
      if (inLap.length >= o.cleanLapMinDrifts && !inLap.some((d) => d.spun)) {
        cleanLaps++;
        const last = inLap[inLap.length - 1];
        // The same test `LiveScorer.onLapCompleted` applies: a lap whose slides the integrity
        // monitor refused to believe earned nothing, and tidiness does not pay where sliding
        // did not. (`cleanLaps` still counts the lap — it is a statement about spins.)
        if (!(last.total > 0)) continue;
        // AND the same gate every other payment asks, about the instant the bonus is paid at.
        // `last.total > 0` is a question about the lap's HISTORY; it was the only question here,
        // and a harbor run at looseness 0 paid 1,725 points across two crossings the monitor
        // refused — on frames the HUD was simultaneously stamping NOT SCORING.
        const idsInLap = new Set(inLap.map((d) => d.id));
        const factor = lapPayFactor(lap, states, ctx?.plausible ?? null, drifts.filter((e) => idsInLap.has(e.id)), o.maxDtS);
        if (!(factor > 0)) continue;
        const pts = o.calloutPoints['clean-lap'] * (o.calloutsUseMultiplier ? Math.max(1, last.stats.multiplierEnd) : 1) * factor;
        last.callouts.push({ t: lap.endT, kind: 'clean-lap', label: calloutLabel('clean-lap'), points: pts });
        last.bonus += pts;
        last.total += pts;
      }
    }
  }

  const kept = scored.filter((d) => !d.lost);
  const total = kept.reduce((a, d) => a + d.total, 0);
  const n = scored.length;

  // ---- components ---------------------------------------------------------------------
  const w = (d: ScoredDrift) => Math.max(o.minWeightS, d.stats.durationS);
  // ANGLE counts only the angle the driver CONTROLLED. A spin is angle the car took, not angle
  // the driver held, and crediting it paid for the spin twice over: the sloppy fixture scored
  // 100/100 on the heaviest component — more than the showcase run's 96 — off three slides it
  // had lost, while the eight it actually drove averaged 17°, which is worth nothing. A run
  // whose every drift ended in a spin held no angle it controlled, so it scores 0 here.
  const controlled = scored.filter((d) => !d.spun);
  const peakDeg = wmean(controlled.map((d) => ({ w: w(d), v: d.stats.heldPeakDeg })));
  const angle = controlled.length ? angleScore(peakDeg, o, tf) : 0;

  // Steadiness is the DURATION-weighted mean of the per-drift steadiness, over EVERY drift.
  // Nothing is dropped: a drift whose angle never settled has no plateau, and "never settled"
  // is exactly what unsteady means — `steadinessScore` caps what an unmeasurable plateau may
  // claim (plateauCapCurve) instead of the average quietly excluding it. Dropping those drifts
  // used to leave a 57 s slide with 4 transitions out of the average and judge the whole run on
  // one 0.62 s window of a 7 s drift, which graded the sloppier driver S and the tidier one C.
  const steadiness = n ? wmean(scored.map((d) => ({ w: w(d), v: steadinessScore(d.stats.jitterDeg / (tf.jitter || 1), o, d.stats.plateauS) }))) : 0;
  const cross = n ? crossLapConsistency(states, track, o) : null;
  // Unproven cross-lap consistency is NEUTRAL, not absent: removing the term meant one lap
  // (nothing to compare) scored the same driver higher than two laps. A road that is not a
  // circuit has nothing to prove, so it keeps steadiness alone unless told otherwise.
  const lappable = !!track && (track.closed || track.laps.length >= 2);
  const crossTerm = cross === null ? (lappable || o.crossLapNeutralOnOpenTrack ? o.crossLapNeutral : null) : cross;
  const consistency = n ? (crossTerm === null ? steadiness : o.crossLapWeight * crossTerm + (1 - o.crossLapWeight) * steadiness) : 0;

  const spins = scored.filter((d) => d.spun).length;
  const driftTimeS = scored.reduce((a, d) => a + d.stats.durationS, 0);
  const timeAtAngleFrac = driftTimeS > 0 ? scored.reduce((a, d) => a + d.stats.timeAtAngleS, 0) / driftTimeS : 0;
  const cleanExitFraction = n ? scored.filter((d) => d.cleanExit).length / n : 0;
  const qw = o.qualityWeights;
  const qualityParts = {
    steadiness,
    timeAtAngle: clamp(curve(o.timeAtAngleCurve, timeAtAngleFrac / (tf.timeAtAngle || 1)), 0, 100),
    cleanExitFraction,
    exitFactor: clamp(1 - o.exitPenalty * (1 - cleanExitFraction), 0, 1),
    spinFactor: n ? clamp(1 - (o.spinPenalty * spins) / n, 0, 1) : 0,
  };
  const quality = n
    ? ((qw.steadiness * qualityParts.steadiness + qw.timeAtAngle * qualityParts.timeAtAngle) / (qw.steadiness + qw.timeAtAngle)) *
      qualityParts.exitFactor *
      qualityParts.spinFactor
    : 0;

  const meanSpeed = wmean(scored.map((d) => ({ w: w(d), v: d.stats.meanSpeedKmh })));
  const speed = n ? speedScore(meanSpeed, o, tf) : 0;

  // Style is built on things that VARY with the driving: how many kinds of callout the run
  // earned, direction changes per drift, how deep the chains ran, and how much of the run was
  // actually spent sideways. The old "flair" term counted callouts per drift, and since
  // INITIATION, PERFECT EXIT and SMOOTH fired on nearly every drift it scored 74–100 for
  // everyone — 20 % of the weight carrying 2 % of the discrimination.
  const kinds = new Set<StyleCalloutKind>();
  let transitions = 0;
  let rare = 0;
  for (const d of scored) {
    transitions += d.transitions;
    for (const c of d.callouts) {
      if (c.kind !== 'initiation') kinds.add(c.kind);
      if (RARE_KINDS.has(c.kind)) rare++;
    }
  }
  const longestChain = chains.reduce((a, c) => Math.max(a, c.drifts.length), 0);
  const sw = o.styleWeights;
  const styleParts = {
    variety: 100 * Math.min(1, kinds.size / o.styleVarietyTarget),
    transitions: n ? 100 * Math.min(1, transitions / n / (o.styleTransitionsPerDrift * (tf.transitions || 1))) : 0,
    chain: n ? 100 * Math.min(1, longestChain / o.styleChainTarget) : 0,
    flair: n ? 100 * Math.min(1, rare / n / o.styleRarePerDrift) : 0,
  };
  const swSum = sw.variety + sw.transitions + sw.chain + sw.flair;
  const style = n
    ? (sw.variety * styleParts.variety + sw.transitions * styleParts.transitions + sw.chain * styleParts.chain + sw.flair * styleParts.flair) / swSum
    : 0;

  const W = o.weights;
  const combined = n ? W.angle * angle + W.consistency * consistency + W.quality * quality + W.speed * speed + W.style * style : 0;
  const grade = n ? gradeFor(combined, o) : 'D';

  let best: ScoredDrift | null = null;
  for (const d of kept) if (!best || d.total > best.total) best = d;
  const longestChainPoints = chains.reduce((a, c) => Math.max(a, c.banked), 0);

  // ---- how much of the run was ONE corner, and what the driver kept up per second ----------
  const keptTotals = kept.map((d) => d.total).sort((a, b) => a - b);
  const bestShare = total > 0 && keptTotals.length ? keptTotals[keptTotals.length - 1] / total : 0;
  const medianDriftPoints = keptTotals.length
    ? keptTotals.length % 2
      ? keptTotals[keptTotals.length >> 1]
      : 0.5 * (keptTotals[(keptTotals.length >> 1) - 1] + keptTotals[keptTotals.length >> 1])
    : 0;
  const pointsPerDriftSecond = driftTimeS > 0 ? total / driftTimeS : 0;

  // ---- integrity: may this run publish a score at all? -------------------------------------
  const suppressedS = scored.reduce((a, d) => a + d.stats.implausibleS, 0);
  const observedDriftS = driftTimeS + suppressedS;
  const implausibleDriftFraction = observedDriftS > 0 ? suppressedS / observedDriftS : 0;
  const iv = ctx?.integrity ?? null;
  const trusted = implausibleDriftFraction <= o.integrityMaxImplausibleFraction;
  const integrity: SessionIntegrity = {
    mount: iv?.mount ?? 'rigid',
    physics: iv?.physics ?? 'ok',
    gps: iv?.gps ?? 'good',
    implausibleDriftFraction: round1(implausibleDriftFraction * 100) / 100,
    suppressedS: Math.round(suppressedS * 100) / 100,
    scoreTrusted: n === 0 || trusted,
    message: trusted
      ? ''
      : `${Math.round(implausibleDriftFraction * 100)}% of this run's sliding could not be trusted` +
        `${iv?.message ? ` — ${iv.message}` : ' — check the phone is rigidly mounted'}`,
  };

  return {
    total: Math.round(total),
    grade,
    trusted: integrity.scoreTrusted,
    angle: round1(angle),
    consistency: round1(consistency),
    quality: round1(quality),
    speed: round1(speed),
    style: round1(style),
    bestDriftId: best ? best.id : null,
    longestChainPoints: Math.round(longestChainPoints),
    perDrift,
    combined: round1(combined),
    crossLapConsistency: cross === null ? null : round1(cross),
    steadiness: round1(steadiness),
    qualityParts,
    styleParts,
    drifts: n,
    angleDrifts: controlled.length,
    spins,
    transitions,
    cleanLaps,
    driftTimeS,
    integrity,
    trackFactor: tf,
    bestShare: round1(bestShare * 100) / 100,
    medianDriftPoints: Math.round(medianDriftPoints),
    pointsPerDriftSecond: Math.round(pointsPerDriftSecond),
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
