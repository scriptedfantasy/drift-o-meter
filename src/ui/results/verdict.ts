/**
 * The words on the results screen: the one-sentence verdict and the one line of explanation
 * under each component bar.
 *
 * Every sentence has to be earned. Praise only fires above a threshold the scorer actually
 * reached, criticism cites the corner, the drift or the number it came from, and a session
 * that was sloppy is told so — a review pull quote, not a participation ribbon.
 */
import { DEFAULT_SCORE_OPTIONS, medianCornerRadiusM, trackFactorFor, type Curve } from '../../engine/score';
import type { StyleCalloutKind, TrackCorner } from '../../engine/types';
import { colors } from '../theme';
import { cornerLabel, cornerTag } from './corners';
import type { ComponentRow, DriftRow, ResultsBase } from './model';
import { KIND_NAMES, scoreColor } from './palette';

const O = DEFAULT_SCORE_OPTIONS;

/**
 * The scales are quoted from `DEFAULT_SCORE_OPTIONS`, never typed out by hand: when the scorer
 * is retuned the explanation retunes with it, instead of quietly lying about the curve.
 */
function curveText(c: Curve, unit: string, scale = 1, digits = 0): string {
  if (!c.length) return '';
  const knots = c.length <= 3 ? c : [c[0], c[Math.round((c.length - 1) / 2)], c[c.length - 1]];
  return knots.map(([x, y]) => `${Math.round(y)} at ${(x * scale).toFixed(digits)}${unit}`).join(', ');
}

function wmean(items: Array<{ w: number; v: number }>): number {
  let sw = 0;
  let sv = 0;
  for (const it of items) {
    sw += it.w;
    sv += it.w * it.v;
  }
  return sw > 0 ? sv / sw : 0;
}

/** The duration-weighted held peak the angle component is built on, degrees. */
export function weightedHeldPeak(rows: DriftRow[]): number {
  return wmean(rows.map((r) => ({ w: Math.max(O.minWeightS, r.durationS), v: r.heldPeakDeg })));
}

/** The plateau-weighted jitter the steadiness score is built on, degrees RMS. */
export function weightedJitter(rows: DriftRow[]): number {
  const judged = rows.filter((r) => r.scored?.stats.plateauS > 0);
  const src = judged.length ? judged : rows;
  return wmean(src.map((r) => ({ w: judged.length ? r.scored.stats.plateauS : Math.max(O.minWeightS, r.durationS), v: r.scored?.stats.jitterDeg ?? 0 })));
}

export interface WorstCorner {
  corner: TrackCorner;
  /** Peak |β| per lap at that corner (deg); NaN where the corner was not drifted. */
  perLap: number[];
  spreadM: number;
  /** 0..1 corner score from `lapConsistency`. */
  score: number;
}

/** The corner the driver repeated worst across laps (the most useful thing on the screen). */
export function worstCorner(model: ResultsBase): WorstCorner | null {
  const laps = model.laps;
  if (!laps || !laps.available) return null;
  let worst: WorstCorner | null = null;
  for (const c of laps.perCorner) {
    const corner = model.corners.find((k) => k.id === c.cornerId);
    if (!corner) continue;
    const hits = c.laps.filter((l) => l !== null).length;
    if (hits === 0) continue;
    const perLap = c.laps.map((l) => (l ? l.peakAngleDeg : NaN));
    const cand: WorstCorner = { corner, perLap, spreadM: c.entrySpreadM, score: c.score };
    if (!worst || cand.score < worst.score) worst = cand;
  }
  return worst;
}

/** The corner the driver repeated best. */
export function bestCorner(model: ResultsBase): WorstCorner | null {
  const laps = model.laps;
  if (!laps || !laps.available) return null;
  let best: WorstCorner | null = null;
  for (const c of laps.perCorner) {
    const corner = model.corners.find((k) => k.id === c.cornerId);
    if (!corner) continue;
    if (c.laps.filter((l) => l !== null).length < 2) continue;
    const cand: WorstCorner = { corner, perLap: c.laps.map((l) => (l ? l.peakAngleDeg : NaN)), spreadM: c.entrySpreadM, score: c.score };
    if (!best || cand.score > best.score) best = cand;
  }
  return best;
}

function round(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return '--';
  return v.toFixed(digits);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function times(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/**
 * The integrity monitor writes for a HUD pill: "reason — advice", no full stop, capitals mid-line.
 * Spliced into a verdict that reads as machine output, so the first dash becomes a sentence break
 * and the whole thing gets terminated.
 */
export function sentencesFromPill(message: string): string {
  const text = message.trim();
  if (!text) return '';
  const i = text.indexOf('—');
  const out = i > 0 ? `${text.slice(0, i).trim()}. ${text.slice(i + 1).trim()}` : text;
  return /[.!?]$/.test(out) ? out : `${out}.`;
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Where the spins happened, in words. */
function spinWhere(model: ResultsBase): string {
  const spun = model.drifts.filter((d) => d.spun);
  const labels = [...new Set(spun.map((d) => (d.corner ? cornerLabel(d.corner) : null)).filter((x): x is string => x !== null))];
  if (labels.length === 1) return ` on ${labels[0]}`;
  if (labels.length === 2) return ` on ${labels[0]} and ${labels[1]}`;
  return '';
}

function praiseFor(model: ResultsBase): string | null {
  const b = model.breakdown;
  const best = model.best;
  const held = model.stats.heldPeakDeg;
  // the corner that produced the biggest HELD angle, which is not always the biggest scorer
  const holder = model.drifts.reduce<DriftRow | null>((m, r) => (!m || r.heldPeakDeg > m.heldPeakDeg ? r : m), null);
  const perDrift = b.drifts > 0 ? b.transitions / b.drifts : 0;
  if (b.angle >= 85 && best) {
    return `Huge angles — ${round(held)}° held${holder?.corner ? ` through ${cornerLabel(holder.corner)}` : ''}`;
  }
  if (b.spins === 0 && b.consistency >= 85 && model.lapCount >= 2) {
    return `You put the car in the same place lap after lap`;
  }
  if (perDrift >= 0.9 && b.style >= 80) {
    return `${b.transitions} linked ${plural(b.transitions, 'transition')} and most of the callout book`;
  }
  if (b.quality >= 85) {
    return `Committed slides — ${Math.round(timeAtAngleFraction(model) * 100)}% of the sideways time was past ${O.qualityAngleDeg}°`;
  }
  if (b.angle >= 70) {
    return `Real angle on the board (${round(held)}° held)`;
  }
  if (b.speed >= 70) {
    return `You carried ${round(meanDriftKmh(model))} km/h while sideways`;
  }
  if (b.consistency >= 70) {
    return `Steady hands: only ±${round(weightedJitter(model.drifts), 1)}° of wobble at full lock`;
  }
  if (b.drifts >= 5 && b.spins === 0) {
    return `${b.drifts} slides on the board and not one spin`;
  }
  return null;
}

function timeAtAngleFraction(model: ResultsBase): number {
  const total = model.stats.driftTimeS;
  if (total <= 0) return 0;
  let at = 0;
  for (const d of model.drifts) at += d.scored?.stats.timeAtAngleS ?? 0;
  return at / total;
}

function meanDriftKmh(model: ResultsBase): number {
  return wmean(model.drifts.map((d) => ({ w: Math.max(O.minWeightS, d.durationS), v: d.meanKmh })));
}

function flawsFor(model: ResultsBase): string[] {
  const b = model.breakdown;
  const out: string[] = [];
  if (b.spins > 0) {
    out.push(`you lost the rear ${times(b.spins)}${spinWhere(model)}${model.lostPoints > 0 ? `, and ${model.lostPoints.toLocaleString('en-US')} points went with it` : ''}`);
  }
  const worst = worstCorner(model);
  if (b.consistency < 60 && worst) {
    const vals = worst.perLap.map((v) => (Number.isFinite(v) ? `${round(v)}°` : 'nothing'));
    out.push(`${cornerLabel(worst.corner)} was a different corner every lap (${vals.join(' then ')})`);
  } else if (b.consistency < 60) {
    out.push(`the angle wandered ±${round(weightedJitter(model.drifts), 1)}° once you were committed`);
  }
  if (b.quality < 60) {
    const frac = timeAtAngleFraction(model);
    if (b.qualityParts.cleanExitFraction < 0.7) {
      const scrappy = Math.round((1 - b.qualityParts.cleanExitFraction) * b.drifts);
      out.push(`${scrappy} of ${b.drifts} exits were snatched back rather than driven out`);
    } else {
      out.push(`only ${Math.round(frac * 100)}% of the sideways time was past ${O.qualityAngleDeg}°`);
    }
  }
  if (b.angle < 50) {
    out.push(`nothing you held went past ${round(model.stats.heldPeakDeg)}°`);
  }
  if (b.speed < 40) {
    out.push(`it all happened at ${round(meanDriftKmh(model))} km/h`);
  }
  if (b.style < 45) {
    out.push(`it was the same move at every corner`);
  }
  if (b.drifts > 0 && b.drifts <= 2) {
    out.push(`${b.drifts} ${plural(b.drifts, 'slide')} in ${mmss(model.session.durationS)} is not a session, it is a sample`);
  }
  return out;
}

/** One sentence of judgement, earned from the numbers. */
export function verdictFor(model: ResultsBase): string {
  const b = model.breakdown;
  if (b.drifts === 0) {
    const peak = model.stats.sessionPeakDeg;
    return `No slides detected — ${mmss(model.session.durationS)} of driving and the rear never came past ${round(Math.max(peak, 0))}°, so there is nothing to judge but the lap itself.`;
  }

  const flaws = flawsFor(model);
  const praise = praiseFor(model);
  const sloppy = b.grade === 'D' || b.spins >= 2 || (b.consistency < 45 && b.quality < 50);

  // When the engine refuses to publish the score, its own words ARE the verdict: the screen has
  // nothing to judge but the recording.
  if (!model.trusted) {
    return sentencesFromPill(model.judged.message) || 'Too much of this run could not be believed for its score to mean anything.';
  }

  // Short of a refusal, a mount that never calibrated still comes first: praising or blaming the
  // driving on top of it would be a verdict on the cradle, not the driver.
  const cal = model.session.calibration;
  const calPct = Math.round((cal?.quality ?? 0) * 100);
  if (!cal || cal.quality < 0.4) {
    const rest = flaws[0] ?? `${b.drifts} ${plural(b.drifts, 'slide')} were logged for ${model.total.toLocaleString('en-US')} points`;
    return `Judge the data before the driving — the mount calibration never got past ${calPct}%, and on that footing ${rest}.`;
  }

  if (sloppy) {
    // the first clause often already carries an "and"; a second one turns the sentence to mush
    if (flaws.length >= 2) return `${capitalize(flaws[0])}${flaws[0].includes(' and ') ? '; ' : ', and '}${flaws[1]}.`;
    if (flaws.length === 1) return `${capitalize(flaws[0])}.`;
    return `${b.drifts} slides, ${model.total.toLocaleString('en-US')} points, and nothing in them the scorer could reward.`;
  }

  if (praise && flaws.length) return `${capitalize(praise)}, but ${flaws[0]}.`;
  if (praise) {
    const best = model.best;
    const named = best?.corner ? praise.includes(cornerLabel(best.corner)) : false;
    const closer = best
      ? `${best.points.toLocaleString('en-US')} of the ${model.total.toLocaleString('en-US')} came from one ${round(best.durationS, 1)} s slide${best.corner && !named ? ` through ${cornerLabel(best.corner)}` : ''}`
      : `${model.total.toLocaleString('en-US')} points with nothing thrown away`;
    return `${capitalize(praise)}, and ${closer}.`;
  }
  if (flaws.length) return `${capitalize(flaws[0])}.`;
  return `${b.drifts} slides, ${model.total.toLocaleString('en-US')} points: nothing went wrong, and nothing went spectacular either.`;
}

const FLAIR_KINDS: StyleCalloutKind[] = ['transition', 'extreme-angle', 'long-drift', 'smooth', 'high-speed', 'manji', 'link', 'perfect-exit', 'clean-lap'];

/** The five component bars, each with one specific line about this session. */
export function componentRows(model: ResultsBase): ComponentRow[] {
  const b = model.breakdown;
  const w = O.weights;
  const rows = model.drifts;
  const empty = rows.length === 0;

  // ---- angle
  const bestHold = rows.reduce<DriftRow | null>((m, r) => (!m || r.heldPeakDeg > m.heldPeakDeg ? r : m), null);
  const tf = trackFactorFor(medianCornerRadiusM(model.session.track), O);
  const stretched = tf.angle !== 1 || tf.speed !== 1 ? ` This track's corners (median radius ${Math.round(tf.medianRadiusM)} m) stretch the scale ×${tf.angle.toFixed(2)}.` : '';
  const angleText = empty
    ? 'No drift, no angle: the component starts at zero and stays there.'
    : `Duration-weighted held peak ${round(weightedHeldPeak(rows))}°; the best hold was ${round(bestHold?.heldPeakDeg ?? 0)}° on drift #${bestHold?.index ?? 1}${bestHold?.corner ? ` at ${cornerLabel(bestHold.corner)}` : ''}.`;
  const angleScaleText = `The scale pays ${curveText(O.angleCurve, '°', tf.angle)}.${stretched}`;

  // ---- consistency
  const worst = worstCorner(model);
  const jitter = weightedJitter(rows);
  let consText: string;
  if (empty) {
    consText = 'Nothing to compare: consistency needs at least one held slide.';
  } else if (b.crossLapConsistency !== null && worst) {
    const vals = worst.perLap.map((v, i) => `lap ${i + 1} ${Number.isFinite(v) ? `${round(v)}°` : 'skipped'}`);
    consText = `${Math.round(O.crossLapWeight * 100)}% cross-lap, ${Math.round((1 - O.crossLapWeight) * 100)}% steadiness. Your least repeatable corner was ${cornerTag(worst.corner)} — ${vals.join(', ')}, entry moving ${round(worst.spreadM, 1)} m. Cross-lap ${round(b.crossLapConsistency, 0)} · steadiness ${round(b.steadiness, 0)}.`;
  } else {
    consText = `One lap, so cross-lap consistency could not be measured and counts as neutral; the rest is steadiness: ±${round(jitter, 2)}° RMS of wobble around the angle you were aiming for.`;
  }
  const jitterBest = O.jitterCurve[0];
  const jitterZero = O.jitterCurve[O.jitterCurve.length - 1];
  const consScaleText = `${Math.round(O.crossLapWeight * 100)}% cross-lap, ${Math.round((1 - O.crossLapWeight) * 100)}% steadiness; ±${jitterBest[0]}° of wobble scores ${jitterBest[1]}, ±${jitterZero[0]}° scores ${jitterZero[1]}.`;

  // ---- quality
  const frac = timeAtAngleFraction(model);
  const cleanExits = Math.round(b.qualityParts.cleanExitFraction * b.drifts);
  const qualText = empty
    ? 'Quality judges slides. There were none.'
    : `${Math.round(frac * 100)}% of your ${mmss(model.stats.driftTimeS)} sideways was past ${O.qualityAngleDeg}°, ${cleanExits} of ${b.drifts} exits driven out clean${b.spins ? `, and ${b.spins} ${plural(b.spins, 'spin')} cut the whole component by ${Math.round((1 - b.qualityParts.spinFactor) * 100)}%` : ''}.`;

  // ---- speed
  const fastest = rows.reduce<DriftRow | null>((m, r) => (!m || r.entryKmh > m.entryKmh ? r : m), null);
  const speedText = empty
    ? 'Speed is measured while sideways, and you never were.'
    : `Mean ${round(meanDriftKmh(model))} km/h while sideways, fastest entry ${round(fastest?.entryKmh ?? 0)} km/h on drift #${fastest?.index ?? 1}.`;
  const speedScaleText = `The scale pays ${curveText(O.speedScoreCurve, ' km/h', tf.speed)}.`;

  // ---- style
  const kinds = new Set<StyleCalloutKind>();
  for (const r of rows) for (const c of r.callouts) if (c.kind !== 'initiation') kinds.add(c.kind);
  const missing = FLAIR_KINDS.filter((k) => !kinds.has(k)).slice(0, 2).map((k) => KIND_NAMES[k]);
  const perDrift = b.drifts > 0 ? b.transitions / b.drifts : 0;
  const styleText = empty
    ? 'No callouts fired, so there is no style score to give.'
    : `${kinds.size} different callouts fired (6 kinds is full marks), ${round(perDrift, 1)} transitions per slide, ${Math.round(model.calloutPoints).toLocaleString('en-US')} bonus points.${missing.length ? ` Never earned: ${missing.join(', ')}.` : ''}`;

  // On a run the engine would not publish, the rubric is not the point and quoting it under a
  // "NOT PUBLISHED" heading is noise: the scale sentences are dropped entirely, and so is every
  // sentence that judges rather than describes — a 0–100 sub-score, a clean-exit count or a spin
  // tally is a verdict drawn from the very angles the monitor refused to believe.
  const scaleOf = (text: string) => (model.trusted ? text : undefined);
  if (!model.trusted) {
    const worstUn = worst ? `${cornerTag(worst.corner)} came out ${worst.perLap.map((v) => (Number.isFinite(v) ? `${round(v)}°` : 'not at all')).join(' then ')}` : 'the corners came out differently lap to lap';
    return [
      { key: 'angle', label: 'Angle', score: NaN, weight: w.angle, color: colors.muted, explain: angleText },
      {
        key: 'consistency',
        label: 'Consistency',
        score: NaN,
        weight: w.consistency,
        color: colors.muted,
        explain: `${capitalize(worstUn)} — though with the mount unbelieved, that difference may be the phone rather than the driving.`,
      },
      {
        key: 'quality',
        label: 'Quality',
        score: NaN,
        weight: w.quality,
        color: colors.muted,
        explain: `${Math.round(frac * 100)}% of the ${mmss(model.stats.driftTimeS)} of recorded sliding was past ${O.qualityAngleDeg}°. Exits and spins are not counted here.`,
      },
      { key: 'speed', label: 'Speed', score: NaN, weight: w.speed, color: colors.muted, explain: speedText },
      { key: 'style', label: 'Style', score: NaN, weight: w.style, color: colors.muted, explain: 'Callouts are awards. A run the engine would not publish does not earn any.' },
    ];
  }
  return [
    { key: 'angle', label: 'Angle', score: b.angle, weight: w.angle, color: scoreColor(b.angle), explain: angleText, scale: scaleOf(angleScaleText) },
    { key: 'consistency', label: 'Consistency', score: b.consistency, weight: w.consistency, color: scoreColor(b.consistency), explain: consText, scale: scaleOf(consScaleText) },
    { key: 'quality', label: 'Quality', score: b.quality, weight: w.quality, color: scoreColor(b.quality), explain: qualText, scale: scaleOf(`Quality is ${Math.round((O.qualityWeights.steadiness / (O.qualityWeights.steadiness + O.qualityWeights.timeAtAngle)) * 100)}% steadiness and the rest time past ${O.qualityAngleDeg}°, then cut by scrappy exits and spins.`) },
    { key: 'speed', label: 'Speed', score: b.speed, weight: w.speed, color: scoreColor(b.speed), explain: speedText, scale: scaleOf(speedScaleText) },
    { key: 'style', label: 'Style', score: b.style, weight: w.style, color: scoreColor(b.style), explain: styleText, scale: scaleOf(`Variety of callout kinds, transitions per slide, the longest chain and total time sideways.`) },
  ];
}
