/**
 * scoreSession — replays the chain rules over a whole run and aggregates the
 * 0–100 components + grade. See index.ts for the rule set.
 */
import type { DriftEvent, SessionScore, SlipState, StyleCalloutKind, TrackModel } from '../types';
import { clamp, radToDeg } from '../types';
import { scoreDrift, type ScoredDrift } from './drift';
import { angleScore, calloutLabel, curve, gradeFor, resolveOptions, speedScore, steadinessScore, type ScoreOptions } from './rules';

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
  styleParts: { variety: number; transitions: number; flair: number };
  drifts: number;
  spins: number;
  transitions: number;
  cleanLaps: number;
  /** Total drifting seconds. */
  driftTimeS: number;
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
export function replayChains(drifts: DriftEvent[], states: SlipState[], o: ScoreOptions): { scored: ScoredDrift[]; chains: ChainSummary[] } {
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
    const sd = scoreDrift(e, states, o, { multiplier: mult, chainDrifts });
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

// ---------------------------------------------------------------------------------------

export function scoreSession(drifts: DriftEvent[], states: SlipState[], track: TrackModel | null, opts?: Partial<ScoreOptions>): SessionBreakdown {
  const o = resolveOptions(opts);
  const { scored, chains } = replayChains(drifts, states, o);
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
        const pts = o.calloutPoints['clean-lap'];
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
  const peakDeg = wmean(scored.map((d) => ({ w: w(d), v: d.stats.heldPeakDeg })));
  const angle = n ? angleScore(peakDeg, o) : 0;

  // steadiness is weighted by the plateau seconds it was measured on; drifts too short to judge do not count
  const judged = scored.filter((d) => d.stats.plateauS > 0);
  const jitter = judged.length ? wmean(judged.map((d) => ({ w: d.stats.plateauS, v: d.stats.jitterDeg }))) : wmean(scored.map((d) => ({ w: w(d), v: d.stats.jitterDeg })));
  const steadiness = n ? steadinessScore(jitter, o) : 0;
  const cross = n ? crossLapConsistency(states, track, o) : null;
  const consistency = cross === null ? steadiness : o.crossLapWeight * cross + (1 - o.crossLapWeight) * steadiness;

  const spins = scored.filter((d) => d.spun).length;
  const driftTimeS = scored.reduce((a, d) => a + d.stats.durationS, 0);
  const timeAtAngleFrac = driftTimeS > 0 ? scored.reduce((a, d) => a + d.stats.timeAtAngleS, 0) / driftTimeS : 0;
  const cleanExitFraction = n ? scored.filter((d) => d.cleanExit).length / n : 0;
  const qw = o.qualityWeights;
  const qualityParts = {
    steadiness,
    timeAtAngle: clamp(curve(o.timeAtAngleCurve, timeAtAngleFrac), 0, 100),
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
  const speed = n ? speedScore(meanSpeed, o) : 0;

  const kinds = new Set<StyleCalloutKind>();
  let transitions = 0;
  let flairCallouts = 0;
  for (const d of scored) {
    transitions += d.transitions;
    for (const c of d.callouts)
      if (c.kind !== 'initiation') {
        kinds.add(c.kind);
        flairCallouts++;
      }
  }
  const sw = o.styleWeights;
  const styleParts = {
    variety: 100 * Math.min(1, kinds.size / o.styleVarietyTarget),
    transitions: n ? 100 * Math.min(1, transitions / n / o.styleTransitionsPerDrift) : 0,
    flair: n ? 100 * Math.min(1, flairCallouts / n / o.styleCalloutsPerDrift) : 0,
  };
  const style = n ? (sw.variety * styleParts.variety + sw.transitions * styleParts.transitions + sw.flair * styleParts.flair) / (sw.variety + sw.transitions + sw.flair) : 0;

  const W = o.weights;
  const combined = n ? W.angle * angle + W.consistency * consistency + W.quality * quality + W.speed * speed + W.style * style : 0;
  const grade = n ? gradeFor(combined, o) : 'D';

  let best: ScoredDrift | null = null;
  for (const d of kept) if (!best || d.total > best.total) best = d;
  const longestChainPoints = chains.reduce((a, c) => Math.max(a, c.banked), 0);

  return {
    total: Math.round(total),
    grade,
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
    spins,
    transitions,
    cleanLaps,
    driftTimeS,
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
