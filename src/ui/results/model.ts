/**
 * Results model: everything the results screen draws, derived once from a `Session`.
 *
 * The numbers come from the engine's own scorer (`scoreSession` → `SessionBreakdown`) and its
 * cross-lap analysis (`lapConsistency`); this module only arranges them, names the corners and
 * counts what the screen has to show. Nothing here invents a score.
 */
import { driftSamples, scoreSession, type ScoredDrift, type SessionBreakdown, type SessionContext } from '../../engine/score';
import { lapConsistency, type LapConsistency } from '../../engine/track';
import type { DriftEvent, Grade, Session, SessionIntegrity, StyleCalloutKind, TrackCorner } from '../../engine/types';
import { radToDeg } from '../../engine/types';
import { colors, gradeColors } from '../theme';
import { cornerAt, cornerLabel } from './corners';
import { KIND_NAMES } from './palette';
import { componentRows, verdictFor } from './verdict';

export interface DriftRow {
  id: number;
  /** 1-based position in the session. */
  index: number;
  event: DriftEvent;
  scored: ScoredDrift;
  startT: number;
  endT: number;
  durationS: number;
  /** Instantaneous peak |β| in degrees. */
  peakDeg: number;
  /** Peak |β| HELD for 1.5 s — what the angle component counts. */
  heldPeakDeg: number;
  entryKmh: number;
  meanKmh: number;
  transitions: number;
  points: number;
  multiplier: number;
  spun: boolean;
  lost: boolean;
  cleanExit: boolean;
  /** +1 right-hand drift, −1 left. */
  direction: 1 | -1;
  /** |β| in degrees, resampled for the sparkline. */
  trace: number[];
  /** Where in the trace the peak sits, 0..1. */
  peakAt: number;
  /** Corner this slide happened on, when the track has one. */
  corner: TrackCorner | null;
  cornerLabel: string | null;
  callouts: Array<{ kind: StyleCalloutKind; label: string; points: number }>;
}

export interface ComponentRow {
  key: 'angle' | 'consistency' | 'quality' | 'speed' | 'style';
  label: string;
  /** 0..100 as the scorer computed it. */
  score: number;
  /** Weight in the combined score. */
  weight: number;
  color: string;
  /** One specific sentence about this session — the judgement, not the rubric. */
  explain: string;
  /** How the scorer arrives at it. Kept behind a disclosure, and absent on an unpublished run. */
  scale?: string;
}

export type NoteLevel = 'ok' | 'warn' | 'bad';

export interface IntegrityNote {
  level: NoteLevel;
  title: string;
  body: string;
}

export interface CalloutTally {
  kind: StyleCalloutKind;
  label: string;
  count: number;
  points: number;
}

export interface GpsQuality {
  fixes: number;
  medianHAcc: number;
  p90HAcc: number;
  /** Longest gap between fixes, seconds. */
  maxGapS: number;
  /** Fraction of fixes worse than 15 m. */
  poorFraction: number;
}

/** Everything except the prose; `verdict.ts` turns this into sentences. */
export interface ResultsBase {
  session: Session;
  breakdown: SessionBreakdown;
  /**
   * What the integrity monitor made of the run — the authoritative copy, taken from the session
   * when the pipeline recorded one and from the re-score otherwise.
   */
  judged: SessionIntegrity;
  /**
   * False when the engine refuses to publish this run's total and grade (see the contract on
   * `SessionIntegrity.scoreTrusted`). The screen must then show NO grade letter and must not
   * present the total as an achievement — it offers the recording instead.
   */
  trusted: boolean;
  grade: Grade;
  gradeColor: string;
  /** 0..100 rating behind the grade. */
  rating: number;
  total: number;
  drifts: DriftRow[];
  best: DriftRow | null;
  callouts: CalloutTally[];
  calloutPoints: number;
  lostPoints: number;
  laps: LapConsistency | null;
  lapCount: number;
  corners: TrackCorner[];
  integrity: IntegrityNote[];
  gps: GpsQuality;
  stats: {
    /** Peak |β| anywhere in the run, drifting or not, degrees. */
    sessionPeakDeg: number;
    peakDeg: number;
    heldPeakDeg: number;
    driftTimeS: number;
    driftFraction: number;
    transitions: number;
    spins: number;
    topDriftKmh: number;
    longestChainPoints: number;
    cleanLaps: number;
  };
  /** True when the session came from the simulator rather than a drive. */
  simulated: boolean;
}

export interface ResultsModel extends ResultsBase {
  /** One sentence of plain-language judgement, earned from the data. */
  verdict: string;
  components: ComponentRow[];
}

const TRACE_POINTS = 56;

/** |β| in degrees over a drift, resampled to `n` buckets by peak (so a spike survives). */
function traceOf(event: DriftEvent, session: Session, n = TRACE_POINTS): { trace: number[]; peakAt: number } {
  const samples = driftSamples(event, session.states);
  if (samples.length === 0) return { trace: [0, 0], peakAt: 0 };
  const out = new Array<number>(n).fill(0);
  const t0 = samples[0].t;
  const span = Math.max(1e-6, samples[samples.length - 1].t - t0);
  const seen = new Array<boolean>(n).fill(false);
  for (const s of samples) {
    const k = Math.min(n - 1, Math.max(0, Math.floor(((s.t - t0) / span) * n)));
    const v = Math.abs(radToDeg(s.beta));
    if (!seen[k] || v > out[k]) out[k] = v;
    seen[k] = true;
  }
  // fill buckets a slow sample rate left empty
  let last = 0;
  for (let i = 0; i < n; i++) {
    if (!seen[i]) out[i] = last;
    else last = out[i];
  }
  let peakIdx = 0;
  for (let i = 1; i < n; i++) if (out[i] > out[peakIdx]) peakIdx = i;
  return { trace: out, peakAt: n > 1 ? peakIdx / (n - 1) : 0 };
}

function median(v: number[]): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function quantile(v: number[], q: number): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export function gpsQuality(session: Session): GpsQuality {
  const fixes = session.gps.filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lon));
  const acc = fixes.map((g) => (Number.isFinite(g.hAcc) ? g.hAcc : 999));
  let maxGap = 0;
  for (let i = 1; i < fixes.length; i++) maxGap = Math.max(maxGap, fixes[i].t - fixes[i - 1].t);
  const poor = acc.filter((a) => a > 15).length;
  return {
    fixes: fixes.length,
    medianHAcc: median(acc),
    p90HAcc: quantile(acc, 0.9),
    maxGapS: maxGap,
    poorFraction: fixes.length ? poor / fixes.length : 0,
  };
}

/**
 * Plain-language honesty about the data behind the score. Everything here is read out of the
 * session: calibration quality, GPS accuracy and gaps, how long the estimator held a lock, and
 * whether anything in the trace is physically impossible.
 */
/** The monitor's messages are written for a HUD pill and carry no full stop. */
function endSentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function integrityNotes(session: Session, gps: GpsQuality, judged?: SessionBreakdown['integrity']): IntegrityNote[] {
  const notes: IntegrityNote[] = [];

  // The scorer's own verdict comes first: it is the one that decided whether the total counts.
  if (judged && !judged.scoreTrusted) {
    notes.push({
      level: 'bad',
      title: 'The engine will not vouch for this score',
      body: `${endSentence(judged.message || 'Too much of the run could not be believed')} ${Math.round(judged.implausibleDriftFraction * 100)}% of your drifting time earned nothing (${judged.suppressedS.toFixed(1)} s), so the number above is a floor, not a measurement.`,
    });
  } else if (judged && judged.implausibleDriftFraction > 0.02) {
    notes.push({
      level: 'warn',
      title: 'Some of the run was not believed',
      body: `${judged.suppressedS.toFixed(1)} s of drifting (${Math.round(judged.implausibleDriftFraction * 100)}%) scored nothing because the monitor could not square it with the physics.${judged.message ? ` ${endSentence(judged.message)}` : ''}`,
    });
  }
  const meta = session.meta ?? {};
  const cal = session.calibration;
  const q = Math.round((cal?.quality ?? 0) * 100);

  // The pipeline's own integrity monitor, when it left its verdict in the session.
  const mount = typeof meta.mount === 'string' ? meta.mount : null;
  if (mount === 'loose' || mount === 'handheld') {
    notes.push({
      level: 'bad',
      title: 'The phone was moving',
      body: 'The integrity monitor saw the phone shifting against the car, not just the car moving. Movement in the cradle shows up as slip angle the car never made, so every angle below is worth less than it looks.',
    });
  } else if (mount === 'suspect') {
    notes.push({
      level: 'warn',
      title: 'Mount looked unsteady',
      body: 'The monitor could not tell whether some of the motion was the phone rather than the car. Nothing here is invalid, but a couple of degrees of angle may be cradle rattle.',
    });
  }

  if (!cal || cal.quality < 0.4 || (cal && !cal.forwardResolved)) {
    notes.push({
      level: 'bad',
      title: 'Mount never calibrated',
      body: `Calibration confidence ${q}%${cal && !cal.forwardResolved ? ' and the forward axis was never resolved' : ''}. Without a resolved forward axis the app cannot tell a slide from a lane change, so treat the angles as indicative only.`,
    });
  } else if (cal.quality < 0.75) {
    notes.push({
      level: 'warn',
      title: 'Calibration only half confident',
      body: `The mount calibration settled at ${q}%. Drive a straight, accelerate once and the forward axis sharpens up; until then a few degrees of every angle here belong to the mount.`,
    });
  }

  if (meta.physics === 'implausible') {
    notes.push({ level: 'bad', title: 'Motion the car cannot make', body: 'The monitor latched an impossible yaw rate or lateral g during the run. Something shook the phone; the affected moments are not driving.' });
  }

  if (gps.fixes === 0) {
    notes.push({ level: 'bad', title: 'No GPS', body: 'Not one usable fix. Without a direction of travel there is no slip angle, so this score is guesswork.' });
  } else if (gps.poorFraction > 0.12 || gps.medianHAcc > 12) {
    notes.push({
      level: 'bad',
      title: 'GPS was poor',
      body: `Median accuracy ${gps.medianHAcc.toFixed(1)} m, ${Math.round(gps.poorFraction * 100)}% of fixes worse than 15 m${gps.maxGapS > 3 ? `, longest gap ${gps.maxGapS.toFixed(1)} s` : ''}. Course noise leaks straight into slip angle: these angles are softer than they look.`,
    });
  } else if (gps.maxGapS > 3) {
    notes.push({
      level: 'warn',
      title: 'GPS dropped out',
      body: `${gps.maxGapS.toFixed(1)} s without a fix (median accuracy ${gps.medianHAcc.toFixed(1)} m otherwise). Through the gap the angle is dead-reckoned from the gyro alone and drifts a little.`,
    });
  }

  const dropped = typeof meta.droppedSamples === 'number' ? meta.droppedSamples : 0;
  const nanGuards = typeof meta.nanGuards === 'number' ? meta.nanGuards : 0;
  if (dropped + nanGuards > 0) {
    notes.push({
      level: 'warn',
      title: 'Sensor stream had holes',
      body: `${dropped} samples arrived out of order or too late and ${nanGuards} had to be repaired. Small gaps are normal on a phone; large ones bend the angle trace.`,
    });
  }

  const states = session.states;
  if (states.length) {
    let moving = 0;
    let invalid = 0;
    let impossible = 0;
    for (const s of states) {
      if (s.speed > 5) {
        moving++;
        if (!s.valid) invalid++;
      }
      if (Math.abs(s.yawRate) > 4 || Math.abs(s.ay) > 2 * 9.80665) impossible++;
    }
    const lostFrac = moving ? invalid / moving : 0;
    if (lostFrac > 0.08) {
      notes.push({
        level: 'warn',
        title: 'Filter lost its lock',
        body: `${Math.round(lostFrac * 100)}% of the moving time had no usable course lock. Those stretches were scored on the gyro's word alone.`,
      });
    }
    if (impossible > states.length * 0.002) {
      notes.push({
        level: 'bad',
        title: 'Impossible motion in the trace',
        body: `${impossible} samples exceed what a car can do (4 rad/s yaw or 2 g lateral). Something shook the phone; those moments are not driving.`,
      });
    }
  }

  if (notes.length === 0) {
    notes.push({
      level: 'ok',
      title: 'Nothing qualifies this score',
      body: `Mount calibrated to ${q}% with the forward axis resolved, ${gps.fixes} GPS fixes at ${gps.medianHAcc.toFixed(1)} m median accuracy, no dropouts over 3 s. The numbers above are the driving.`,
    });
  }
  return notes;
}

/** Build the rows for every drift, in the order they happened. */
function driftRows(session: Session, breakdown: SessionBreakdown): DriftRow[] {
  const sorted = [...session.drifts].sort((a, b) => a.startT - b.startT || a.id - b.id);
  return sorted.map((event, i) => {
    const scored = breakdown.perDrift[event.id];
    const stats = scored?.stats;
    const { trace, peakAt } = traceOf(event, session);
    const mid = session.states[Math.min(session.states.length - 1, Math.max(0, Math.round((event.sampleStart + event.sampleEnd) / 2)))];
    const corner = mid ? cornerAt(session.track, mid.x, mid.y) : null;
    return {
      id: event.id,
      index: i + 1,
      event,
      scored,
      startT: event.startT,
      endT: event.endT,
      durationS: event.durationS,
      // The accumulator stops on the sample that tripped the spin, so its running peak is
      // truncated (or 0). The trace kept going: for a spin, report what the car actually did.
      peakDeg: stats && stats.peakDeg > 0 && !stats.spun ? stats.peakDeg : Math.max(stats?.peakDeg ?? 0, radToDeg(event.peakAngle)),
      heldPeakDeg: stats && stats.heldPeakDeg > 0 ? stats.heldPeakDeg : radToDeg(event.peakAngle),
      entryKmh: stats ? stats.entrySpeedKmh : event.entrySpeed * 3.6,
      meanKmh: stats ? stats.meanSpeedKmh : event.meanSpeed * 3.6,
      transitions: stats ? stats.transitions : event.transitions,
      points: scored ? Math.round(scored.total) : 0,
      multiplier: scored ? scored.multiplier : 1,
      spun: stats ? stats.spun : false,
      lost: scored ? scored.lost : false,
      cleanExit: stats ? stats.cleanExit : true,
      direction: event.initialDirection,
      trace,
      peakAt,
      corner,
      cornerLabel: corner ? cornerLabel(corner) : null,
      callouts: (scored?.callouts ?? []).map((c) => ({ kind: c.kind, label: c.label, points: c.points })),
    };
  });
}

function tallyCallouts(rows: DriftRow[]): { callouts: CalloutTally[]; points: number } {
  const byKind = new Map<StyleCalloutKind, CalloutTally>();
  let points = 0;
  for (const r of rows) {
    if (r.lost) continue;
    for (const c of r.callouts) {
      const prev = byKind.get(c.kind);
      points += c.points;
      if (prev) {
        prev.count++;
        prev.points += c.points;
      } else {
        byKind.set(c.kind, { kind: c.kind, label: KIND_NAMES[c.kind], count: 1, points: c.points });
      }
    }
  }
  const callouts = [...byKind.values()].sort((a, b) => b.points - a.points || b.count - a.count);
  return { callouts, points };
}

/**
 * What the integrity monitor concluded during the run, if the pipeline left its verdict in the
 * session. The per-sample plausibility mask is not part of a stored `Session`, so a replay can
 * only repeat the monitor's end-of-run judgement — it cannot re-derive which samples it doubted.
 */
function sessionContext(session: Session): SessionContext | undefined {
  const i = session.integrity;
  if (i) return { integrity: { mount: i.mount, physics: i.physics, gps: i.gps, message: i.message } };
  // sessions written before `Session.integrity` existed left the monitor's verdict in `meta`
  const m = session.meta ?? {};
  const mount = m.mount === 'loose' || m.mount === 'suspect' || m.mount === 'rigid' ? m.mount : null;
  const physics = m.physics === 'implausible' || m.physics === 'ok' ? m.physics : null;
  const gps = m.gps === 'poor' || m.gps === 'none' || m.gps === 'good' ? m.gps : null;
  const message = typeof m.integrity === 'string' ? m.integrity : '';
  if (!mount && !physics && !gps && !message) return undefined;
  return { integrity: { mount: mount ?? 'rigid', physics: physics ?? 'ok', gps: gps ?? 'good', message } };
}

/**
 * Derive the whole screen from a session. Runs the real scorer, so it costs a few hundred
 * milliseconds on a big session — call it once, memoised.
 */
export function buildResultsModel(session: Session): ResultsModel {
  const breakdown = scoreSession(session.drifts, session.states, session.track, undefined, sessionContext(session));
  const rows = driftRows(session, breakdown);
  const best = breakdown.bestDriftId !== null ? (rows.find((r) => r.id === breakdown.bestDriftId) ?? null) : null;
  const { callouts, points: calloutPoints } = tallyCallouts(rows);
  const lostPoints = rows.filter((r) => r.lost).reduce((a, r) => a + r.points, 0);
  const laps = session.track && session.track.laps.length >= 2 ? lapConsistency(session.track, session.drifts, session.states) : null;
  const gps = gpsQuality(session);
  const driftTimeS = breakdown.driftTimeS;
  let sessionPeak = 0;
  for (const s of session.states) {
    const v = Math.abs(radToDeg(s.beta));
    if (v > sessionPeak) sessionPeak = v;
  }

  // The run's own verdict wins where it exists; a re-score may only take trust away, never add it.
  const judged: SessionIntegrity = session.integrity ?? breakdown.integrity;
  const trusted = judged.scoreTrusted && breakdown.integrity.scoreTrusted && (session.score?.trusted ?? true);

  const base: ResultsBase = {
    session,
    breakdown,
    judged,
    trusted,
    grade: breakdown.grade,
    gradeColor: gradeColors[breakdown.grade] ?? colors.muted,
    rating: breakdown.combined,
    total: breakdown.total,
    drifts: rows,
    best,
    callouts,
    calloutPoints,
    lostPoints,
    laps: laps && laps.available ? laps : null,
    lapCount: session.track?.laps.length ?? 0,
    corners: session.track?.corners ?? [],
    integrity: integrityNotes(session, gps, judged),
    gps,
    stats: {
      sessionPeakDeg: sessionPeak,
      peakDeg: rows.reduce((m, r) => Math.max(m, r.peakDeg), 0),
      heldPeakDeg: rows.reduce((m, r) => Math.max(m, r.heldPeakDeg), 0),
      driftTimeS,
      driftFraction: session.durationS > 0 ? driftTimeS / session.durationS : 0,
      transitions: breakdown.transitions,
      spins: breakdown.spins,
      topDriftKmh: rows.reduce((m, r) => Math.max(m, r.entryKmh, r.meanKmh), 0),
      longestChainPoints: breakdown.longestChainPoints,
      cleanLaps: breakdown.cleanLaps,
    },
    simulated: session.meta?.source === 'simulation' || typeof session.meta?.fixture === 'string',
  };

  return { ...base, verdict: verdictFor(base), components: componentRows(base) };
}
