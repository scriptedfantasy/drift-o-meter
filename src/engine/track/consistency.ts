/**
 * Cross-lap consistency: for every corner of a closed track, how repeatable were the
 * driver's drifts from lap to lap (peak angle, entry point, whether the corner was drifted).
 */
import type { DriftEvent, SlipState, TrackModel } from '../types';
import { modS, wrapS } from './geometry';
import { PathIndex } from './projector';

export interface CornerLapStat {
  lap: number;
  peakAngleDeg: number;
  /** Arc length (0..lengthM) where the drift into this corner began. */
  entryS: number;
  entrySpeed: number;
}

export interface CornerConsistency {
  cornerId: number;
  /** One entry per lap; null when the corner was not drifted in that lap. */
  laps: Array<CornerLapStat | null>;
  /** Coefficient of variation of peakAngleDeg across the laps that drifted the corner. */
  angleCV: number;
  /** Standard deviation of the entry point across those laps, metres. */
  entrySpreadM: number;
  /** Fraction of laps in which the corner was drifted. */
  hitRate: number;
  /** 0..1 per-corner score = hitRate × (0.6·angle term + 0.4·entry term). */
  score: number;
}

export interface LapConsistency {
  perCorner: CornerConsistency[];
  /** 0..1, mean of the per-corner scores over corners drifted at least once (0 when none). */
  overall: number;
  lapsCompared: number;
  /** False when fewer than two laps or no drift touched any corner: `overall` is not meaningful then. */
  available: boolean;
}

export interface ConsistencyOptions {
  /** Corner window extends this far before startS (drift initiation happens before turn-in), metres. */
  leadM: number;
  /** ...and this far after endS, metres. */
  tailM: number;
  /** |β| must exceed this to count as an entry, radians. */
  minAngleRad: number;
  /** angle term = 1 − angleCV / angleCVScale, clamped. */
  angleCVScale: number;
  /** entry term = 1 − entrySpreadM / entrySpreadScaleM, clamped. */
  entrySpreadScaleM: number;
}

export const DEFAULT_CONSISTENCY_OPTIONS: ConsistencyOptions = {
  leadM: 35,
  tailM: 15,
  minAngleRad: (5 * Math.PI) / 180,
  angleCVScale: 0.4,
  entrySpreadScaleM: 25,
};

function meanStd(v: number[]): { mean: number; std: number } {
  const n = v.length;
  if (n === 0) return { mean: 0, std: 0 };
  let m = 0;
  for (const a of v) m += a;
  m /= n;
  let ss = 0;
  for (const a of v) ss += (a - m) * (a - m);
  return { mean: m, std: Math.sqrt(ss / n) };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lapConsistency(
  model: TrackModel,
  drifts: DriftEvent[],
  states: SlipState[],
  opts: Partial<ConsistencyOptions> = {},
): LapConsistency {
  const o = { ...DEFAULT_CONSISTENCY_OPTIONS, ...opts };
  const nLaps = model.laps.length;
  const L = model.lengthM;
  const empty = (): LapConsistency => ({
    perCorner: model.corners.map((c) => ({ cornerId: c.id, laps: [], angleCV: 0, entrySpreadM: 0, hitRate: 0, score: 0 })),
    overall: 0,
    lapsCompared: nLaps,
    available: false,
  });
  if (!model.closed || nLaps === 0 || model.refPath.length < 3 || !(L > 0) || states.length === 0) return empty();

  const index = new PathIndex(model.refPath, true, L);
  const anchor = Math.max(0, Math.min(states.length - 1, model.laps[0].sampleStart));
  const N = states.length;

  // unwrapped arc length u for every state from the first lap's start onwards
  const u = new Float64Array(N).fill(NaN);
  let prevS = NaN;
  let acc = 0;
  for (let i = anchor; i < N; i++) {
    const st = states[i];
    if (!Number.isFinite(st.x) || !Number.isFinite(st.y)) continue;
    const p = index.project(st.x, st.y);
    if (!p) continue;
    if (Number.isNaN(prevS)) acc = p.s > L / 2 ? p.s - L : p.s; // the start sits on the line; noise may put it just behind
    else acc += wrapS(p.s - prevS, L);
    prevS = p.s;
    u[i] = acc;
  }

  // which states belong to a drift
  const inDrift = new Uint8Array(N);
  for (const d of drifts) {
    const a = Math.max(0, Math.min(N - 1, d.sampleStart));
    const b = Math.max(a, Math.min(N - 1, d.sampleEnd));
    for (let i = a; i <= b; i++) inDrift[i] = 1;
  }

  const perCorner: CornerConsistency[] = [];
  let scoreSum = 0;
  let scored = 0;
  for (const c of model.corners) {
    const laps: Array<CornerLapStat | null> = [];
    const peaks: number[] = [];
    const entries: number[] = [];
    for (let k = 0; k < nLaps; k++) {
      const u0 = k * L + c.startS - o.leadM;
      const u1 = k * L + c.endS + o.tailM;
      let peak = 0;
      let entryU = NaN;
      let entrySpeed = 0;
      for (let i = anchor; i < N; i++) {
        const ui = u[i];
        if (!(ui >= u0 && ui <= u1) || !inDrift[i]) continue;
        const b = states[i].beta;
        if (!Number.isFinite(b)) continue;
        // in a right-hander (direction −1) the nose points right and β > 0; sign(β) = −direction
        if (Math.sign(b) !== -c.direction || Math.abs(b) <= o.minAngleRad) continue;
        if (Number.isNaN(entryU)) {
          entryU = ui;
          entrySpeed = states[i].speed;
        }
        if (Math.abs(b) > peak) peak = Math.abs(b);
      }
      if (Number.isNaN(entryU)) {
        laps.push(null);
        continue;
      }
      const peakDeg = (peak * 180) / Math.PI;
      peaks.push(peakDeg);
      entries.push(entryU - (k * L + c.startS));
      laps.push({ lap: k, peakAngleDeg: peakDeg, entryS: modS(entryU, L), entrySpeed });
    }
    const hits = peaks.length;
    const hitRate = nLaps > 0 ? hits / nLaps : 0;
    let angleCV = 0;
    let entrySpreadM = 0;
    if (hits >= 2) {
      const a = meanStd(peaks);
      angleCV = a.mean > 1e-9 ? a.std / a.mean : 0;
      entrySpreadM = meanStd(entries).std;
    }
    const score = hits > 0 ? hitRate * (0.6 * clamp01(1 - angleCV / o.angleCVScale) + 0.4 * clamp01(1 - entrySpreadM / o.entrySpreadScaleM)) : 0;
    if (hits > 0) {
      scoreSum += score;
      scored++;
    }
    perCorner.push({ cornerId: c.id, laps, angleCV, entrySpreadM, hitRate, score });
  }
  const overall = scored > 0 ? scoreSum / scored : 0;
  return { perCorner, overall, lapsCompared: nLaps, available: nLaps >= 2 && scored > 0 };
}
