/**
 * Run review model: everything the review screen draws, derived once from a `Session`.
 *
 * The figures are the run's OWN measurements, read out of `Session.driftStats` — the engine
 * writes one `DriftSummary` per slide at the end of a run and this module arranges them. It no
 * longer re-analyses anything: it used to call `scoreSession` on arrival, which cost a few
 * hundred milliseconds on a big session and reached per-slide measurements through
 * `score.perDrift[id].stats`, inside a structure whose reason for existing was points.
 *
 * WHAT IS DELIBERATELY NOT HERE any more: points, multipliers, the 0-100 rating, the five
 * component sub-scores, the callout tally and the grade's colour. The review states what the car
 * did — speed, angle, how long, how many — and the only judgement left on the page is the
 * integrity monitor's, which is a judgement of the DATA and not of the driving.
 *
 * `total`, `grade` and `stats.longestChainPoints` are still carried because `src/ui/garage/
 * demo.ts` writes them back into `Session.score` when it seeds the demo garage. They are the
 * engine's published figures passed straight through; nothing in this kit renders them.
 */
import { calibrationBand, sessionIntegrity, type MonitorVerdict } from '../../engine/integrity';
import { DEFAULT_SCORE_OPTIONS, driftSamples } from '../../engine/score';
import type { DriftEvent, DriftSummary, Grade, Session, SessionIntegrity, SessionScore, TrackCorner } from '../../engine/types';
import { radToDeg } from '../../engine/types';
import { cornerAt, cornerLabel } from './corners';

export interface DriftRow {
  id: number;
  /** 1-based position in the session. */
  index: number;
  event: DriftEvent;
  /** The run's own measurements of this slide, or null for a session that kept none. */
  stats: DriftSummary | null;
  startT: number;
  endT: number;
  durationS: number;
  /** Instantaneous peak |β| in degrees. This is what the review prints as PEAK. */
  peakDeg: number;
  /** Peak |β| HELD for 1.5 s. Always the smaller, honest figure; see `DriftStats.heldPeakDeg`. */
  heldPeakDeg: number;
  /**
   * Seconds the slide was actually SIDEWAYS — `DriftSummary.sustainedS`, which counts only the
   * samples past the angle that qualifies as sliding, not the ramp in and the gather at the end.
   *
   * This is what the review prints as HELD, and it is deliberately not `durationS`: on the
   * shipped fixtures the two differ by 0.8 to 1.4 s on a five-second slide, which is a fifth of
   * it. `heldPeakDeg` exists for exactly the same reason one column over — a figure captioned
   * "held" that prints the unqualified one is overstating the driver.
   */
  heldS: number;
  /** Entry speed in km/h. The review converts at render; see `formatSpeed`. */
  entryKmh: number;
  meanKmh: number;
  transitions: number;
  /**
   * Whether the slide ended in a spin, AS PUBLISHED. `src/engine/types.ts` states the contract:
   * the scorer's spin rule is broader than `DriftEvent.spin`, and re-deriving it made the replay
   * and this screen disagree about the same slide. Read, never computed.
   */
  spun: boolean;
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
}

export type NoteLevel = 'ok' | 'warn' | 'bad';

export interface IntegrityNote {
  level: NoteLevel;
  title: string;
  body: string;
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

export interface ResultsModel {
  session: Session;
  /**
   * What the run itself published, because the pipeline saw it with a per-sample plausibility
   * mask that a stored session does not carry. `trusted` is read from here rather than
   * re-derived, so the garage row, this screen and the replay cannot disagree about one run.
   */
  score: SessionScore;
  /**
   * What the integrity monitor made of the run — the authoritative copy, taken from the session
   * when the pipeline recorded one and from the re-score otherwise.
   */
  judged: SessionIntegrity;
  /**
   * False when the engine refuses to publish this run's total and grade (see the contract on
   * `SessionIntegrity.scoreTrusted`). A phone waved about in a parked car produces large angles
   * and a plausible-looking run; when this is false the review says so at the top and presents
   * every figure below it as a recording, not as something achieved.
   */
  trusted: boolean;
  /** The engine's published grade. Passed through for `src/ui/garage/demo.ts`; never rendered. */
  grade: Grade;
  /** The engine's published total. Passed through for `src/ui/garage/demo.ts`; never rendered. */
  total: number;
  drifts: DriftRow[];
  /**
   * The slide the review leads with: biggest peak angle, longest held breaking the tie. NOT the
   * scorer's `bestDriftId`, which ranked by points — a driver asked what their best drift was
   * means the biggest one they held, and a points ranking answered a different question with a
   * multiplier in it.
   */
  best: DriftRow | null;
  integrity: IntegrityNote[];
  gps: GpsQuality;
  stats: {
    /** Peak |β| anywhere in the run, drifting or not, degrees. */
    sessionPeakDeg: number;
    /**
     * Fastest the car went at any point of the run, km/h — read off the estimator's own fused
     * speed, not off the drifts. The cell is labelled TOP SPEED, and a top speed that only
     * counts the moments the car was sideways is not one.
     */
    topSpeedKmh: number;
    /**
     * Seconds of sliding in the RECORDING, summed from the slides themselves. This is what TIME
     * SIDEWAYS prints, on a trusted run and a refused one alike: a refused run's recording still
     * contains the sliding it contains, and the thing the engine withholds is the verdict on it,
     * not the stopwatch.
     */
    driftTimeS: number;
    driftFraction: number;
    /** The biggest instantaneous |β| inside a slide, degrees. */
    peakDeg: number;
    /** The biggest |β| actually HELD inside a slide — always the smaller, honest figure. */
    heldPeakDeg: number;
    transitions: number;
    spins: number;
    /** Fastest entry or mean speed across the slides, km/h. */
    topDriftKmh: number;
    /** Published, and passed through for `src/ui/garage/demo.ts` alone. Never rendered here. */
    longestChainPoints: number;
  };
  /** True when the session came from the simulator rather than a drive. */
  simulated: boolean;
}

/**
 * What `model.score` reads as for a session that never stored one.
 *
 * Only reachable through a hand-built or truncated session; every run the pipeline writes
 * carries a score. `trusted: true` because an absent score is not evidence of dishonesty —
 * the refusal path is driven by `judged.scoreTrusted`, which is assembled from the monitor.
 */
const EMPTY_SCORE: SessionScore = {
  total: 0,
  grade: 'D',
  angle: 0,
  consistency: 0,
  quality: 0,
  speed: 0,
  style: 0,
  bestDriftId: null,
  longestChainPoints: 0,
  perDrift: {},
  trusted: true,
};

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
 * Plain-language honesty about the data behind the numbers. Everything here is read out of the
 * session: calibration quality, GPS accuracy and gaps, how long the estimator held a lock, and
 * whether anything in the trace is physically impossible.
 */
/** The monitor's messages are written for a HUD pill and carry no full stop. */
function endSentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function integrityNotes(session: Session, gps: GpsQuality, judged?: SessionIntegrity): IntegrityNote[] {
  const notes: IntegrityNote[] = [];

  // The monitor's own verdict comes first: it is the one that decided whether these figures
  // describe a car at all.
  if (judged && !judged.scoreTrusted) {
    notes.push({
      level: 'bad',
      title: 'The engine will not vouch for these numbers',
      body: `${endSentence(judged.message || 'Too much of the run could not be believed')} ${Math.round(judged.implausibleDriftFraction * 100)}% of the sliding time (${judged.suppressedS.toFixed(1)} s) could not be squared with the physics of a car, and that is too much of the run for the rest to stand on.`,
    });
  } else if (judged && judged.implausibleDriftFraction > 0.02) {
    notes.push({
      level: 'warn',
      title: 'Some of the run was not believed',
      body: `${judged.suppressedS.toFixed(1)} s of drifting (${Math.round(judged.implausibleDriftFraction * 100)}%) could not be squared with the physics, so the angles across those moments are softer than they read.${judged.message ? ` ${endSentence(judged.message)}` : ''}`,
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

  // The ENGINE decides what its own quality number means (`src/engine/integrity/band.ts`). This
  // screen used to compare against 0.4 and 0.75 of its own, the garage against a different 0.4
  // and the calibration screen against its own 0.75 — so a run at 0.33 was "ready to measure"
  // there and "never calibrated" here, on the same number. The lower edge is now the monitor's
  // own veto, which means this screen can no longer disown a run the engine went on to publish.
  const calBand = calibrationBand(cal?.quality ?? NaN, cal?.forwardResolved ?? false);
  if (!cal || calBand === 'unresolved' || calBand === 'unusable') {
    notes.push({
      level: 'bad',
      title: 'Mount never calibrated',
      body: `Calibration confidence ${q}%${cal && !cal.forwardResolved ? ' and the forward axis was never resolved' : ''}. Without a resolved forward axis the app cannot tell a slide from a lane change, so treat the angles as indicative only.`,
    });
  } else if (calBand === 'trusted') {
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
    notes.push({ level: 'bad', title: 'No GPS', body: 'Not one usable fix. Without a direction of travel there is no slip angle, so every angle on this page is guesswork.' });
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
        body: `${Math.round(lostFrac * 100)}% of the moving time had no usable course lock. Through those stretches the angle is the gyro's word alone.`,
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
      title: 'Nothing qualifies these numbers',
      body: `Mount calibrated to ${q}% with the forward axis resolved, ${gps.fixes} GPS fixes at ${gps.medianHAcc.toFixed(1)} m median accuracy, no dropouts over 3 s. The numbers above are the driving.`,
    });
  }
  return notes;
}

/**
 * The run's own measurements of one slide, from whichever place this session keeps them.
 *
 * `Session.driftStats` is the home. Before it existed they were only reachable inside the
 * scorer's per-drift record, as `score.perDrift[id].stats`. The fallback is not tidiness: every
 * run already on a phone was stored that way, and dropping it would empty the review of every
 * held angle, entry speed and spin verdict for a season of somebody's driving. Copied from
 * `src/platform/sessionStore.ts:statsOf`, which is the same read for the garage's index.
 */
function statsOf(session: Session, id: number): DriftSummary | null {
  const own = session.driftStats?.[id];
  if (own && typeof own === 'object') return own;
  // The old home is not on `DriftScore` any more, so the cast is the read rather than a wish:
  // what is being asked is whether THIS session, stored under the old shape, still has one.
  const legacy = (session.score?.perDrift as Record<number, { stats?: DriftSummary }> | undefined)?.[id]?.stats;
  return legacy && typeof legacy === 'object' ? legacy : null;
}

/** Build the rows for every drift, in the order they happened. */
function driftRows(session: Session): DriftRow[] {
  const sorted = [...session.drifts].sort((a, b) => a.startT - b.startT || a.id - b.id);
  return sorted.map((event, i) => {
    const stats = statsOf(session, event.id);
    const { trace, peakAt } = traceOf(event, session);
    const mid = session.states[Math.min(session.states.length - 1, Math.max(0, Math.round((event.sampleStart + event.sampleEnd) / 2)))];
    const corner = mid ? cornerAt(session.track, mid.x, mid.y) : null;
    return {
      id: event.id,
      index: i + 1,
      event,
      stats,
      startT: event.startT,
      endT: event.endT,
      durationS: event.durationS,
      // The accumulator stops on the sample that tripped the spin, so its running peak is
      // truncated (or 0). The trace kept going: for a spin, report what the car actually did.
      peakDeg: stats && stats.peakDeg > 0 && !stats.spun ? stats.peakDeg : Math.max(stats?.peakDeg ?? 0, radToDeg(event.peakAngle)),
      heldPeakDeg: stats && stats.heldPeakDeg > 0 ? stats.heldPeakDeg : radToDeg(event.peakAngle),
      heldS: stats && stats.sustainedS > 0 ? stats.sustainedS : event.durationS,
      entryKmh: stats ? stats.entrySpeedKmh : event.entrySpeed * 3.6,
      meanKmh: stats ? stats.meanSpeedKmh : event.meanSpeed * 3.6,
      transitions: stats ? stats.transitions : event.transitions,
      // `spun` is the run's PUBLISHED verdict, for the reason `types.ts` states in capitals: the
      // broad spin rule is wider than the detector's own `DriftEvent.spin`, and when this screen
      // re-derived it the replay and the review disagreed about the same slide. Read, never
      // computed — `DriftEvent.spin` is the fallback only when the run kept no measurements.
      spun: stats?.spun ?? event.spin === true,
      cleanExit: stats ? stats.cleanExit : true,
      direction: event.initialDirection,
      trace,
      peakAt,
      corner,
      cornerLabel: corner ? cornerLabel(corner) : null,
    };
  });
}

/**
 * The slide the review leads with: biggest peak angle, longest held breaking the tie.
 *
 * This is the rule a driver means by "my best drift", and it is deliberately NOT the scorer's
 * `bestDriftId`, which ranked by points — angle times duration times speed times a chain
 * multiplier — so the slide it named could be a smaller one taken faster in a longer chain.
 * A spin can win this, because a spin really is the biggest angle of the run; the panel says
 * SPUN when it does rather than quietly picking the runner-up and calling it the biggest.
 *
 * The tie-break is `heldS`, the same seconds the panel prints under HELD, so a driver comparing
 * two equal angles is comparing the figure they can see.
 *
 * Exported for the test that pins the tie-break, which would otherwise have to restate the rule
 * to check it — and a test that restates the rule cannot catch the rule changing.
 */
type AngleRanked = Pick<DriftRow, 'peakDeg' | 'heldS'>;

export function bestByAngle(rows: readonly AngleRanked[]): AngleRanked | null {
  return rows.reduce<AngleRanked | null>((best, r) => {
    if (!best) return r;
    if (r.peakDeg !== best.peakDeg) return r.peakDeg > best.peakDeg ? r : best;
    return r.heldS > best.heldS ? r : best;
  }, null);
}

/**
 * What the integrity monitor concluded during the run, for a session stored before
 * `Session.integrity` existed: those runs left the monitor's verdict loose in `meta`.
 */
function monitorFromMeta(session: Session): MonitorVerdict | null {
  const m = session.meta ?? {};
  const mount = m.mount === 'loose' || m.mount === 'suspect' || m.mount === 'rigid' ? m.mount : null;
  const physics = m.physics === 'implausible' || m.physics === 'ok' ? m.physics : null;
  const gps = m.gps === 'poor' || m.gps === 'none' || m.gps === 'good' ? m.gps : null;
  const message = typeof m.integrity === 'string' ? m.integrity : '';
  if (!mount && !physics && !gps && !message) return null;
  return { mount: mount ?? 'rigid', physics: physics ?? 'ok', gps: gps ?? 'good', message };
}

/**
 * The run's trust verdict, for a session that did not store one.
 *
 * `Session.integrity` is where this lives and every run the pipeline writes carries it. A run
 * stored before the field existed does not, and its verdict has to be rebuilt from the same
 * inputs the engine uses — the unbelieved seconds inside each slide against the believed ones —
 * through `sessionIntegrity`, so an old run is judged by exactly the rule a new one is rather
 * than by a second copy of it that will drift.
 *
 * The threshold still lives in the scorer's option bag. When that bag goes it needs a home of
 * its own; this is the only line in the review that still reaches into it.
 */
function integrityFor(session: Session, rows: DriftRow[]): SessionIntegrity {
  if (session.integrity) return session.integrity;
  const implausiblePerDrift = rows.map((r) => r.stats?.implausibleS ?? 0);
  const observedS = rows.reduce((a, r) => a + r.durationS, 0);
  const suppressedS = implausiblePerDrift.reduce((a, v) => a + v, 0);
  return sessionIntegrity({
    implausiblePerDrift,
    believedDriftS: Math.max(0, observedS - suppressedS),
    monitor: monitorFromMeta(session),
    maxImplausibleFraction: DEFAULT_SCORE_OPTIONS.integrityMaxImplausibleFraction,
  });
}

/**
 * Derive the whole review from a session.
 *
 * Reading rather than re-deriving: the only loop over the raw states is the one that finds the
 * run's peak angle and top speed, plus one resample per slide for its sparkline. Everything else
 * is already in the session. Still worth memoising on a long run — the traces are 56 buckets
 * each, resampled from every estimator sample inside the slide.
 */
export function buildResultsModel(session: Session): ResultsModel {
  const published: SessionScore | undefined = session.score;
  const rows = driftRows(session);
  const best = (bestByAngle(rows) as DriftRow | null) ?? null;
  const gps = gpsQuality(session);
  let sessionPeak = 0;
  let topSpeedKmh = 0;
  for (const s of session.states) {
    const v = Math.abs(radToDeg(s.beta));
    if (v > sessionPeak) sessionPeak = v;
    // `EstimatorState.speed` is the fused ground speed in m/s and goes NaN before the filter has
    // a lock, so it is guarded rather than maxed blind.
    if (Number.isFinite(s.speed) && s.speed * 3.6 > topSpeedKmh) topSpeedKmh = s.speed * 3.6;
  }

  // The run's own verdict is the verdict. Nothing downstream has more information than the run
  // did, so nothing downstream may add trust — and, by the same argument, none may remove it.
  const judged = integrityFor(session, rows);
  const trusted = (published ? published.trusted : true) && judged.scoreTrusted;
  // Recorded sliding, summed from the slides themselves. NOT the scorer's own drifting seconds,
  // which were zero on a run it would not believe — printing "5 slides, 0:00 sideways" from the
  // two together was a page contradicting itself about the recording it was describing.
  const driftTimeS = rows.reduce((a, r) => a + r.durationS, 0);

  return {
    session,
    score: published ?? EMPTY_SCORE,
    judged,
    trusted,
    grade: published?.grade ?? 'D',
    total: published?.total ?? 0,
    drifts: rows,
    best,
    integrity: integrityNotes(session, gps, judged),
    gps,
    stats: {
      sessionPeakDeg: sessionPeak,
      topSpeedKmh,
      driftTimeS,
      driftFraction: session.durationS > 0 ? driftTimeS / session.durationS : 0,
      peakDeg: rows.reduce((m, r) => Math.max(m, r.peakDeg), 0),
      heldPeakDeg: rows.reduce((m, r) => Math.max(m, r.heldPeakDeg), 0),
      transitions: rows.reduce((a, r) => a + r.transitions, 0),
      spins: rows.filter((r) => r.spun).length,
      topDriftKmh: rows.reduce((m, r) => Math.max(m, r.entryKmh, r.meanKmh), 0),
      longestChainPoints: published?.longestChainPoints ?? 0,
    },
    simulated: session.meta?.source === 'simulation' || typeof session.meta?.fixture === 'string',
  };
}
