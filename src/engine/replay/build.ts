import { clamp, degToRad, radToDeg, wrapAngle, type DriftEvent, type DriftSummary, type Session, type SlipState } from '../types';
import type {
  DriftSeverity,
  Replay,
  ReplayBounds,
  ReplayEvent,
  ReplayGhost,
  ReplayHighlight,
  ReplayLap,
  ReplayMarker,
  ReplayOptions,
  ReplaySegment,
  ReplayTelemetry,
  ReplayTrail,
  SmokeParticle,
} from './types';

export const DEFAULT_REPLAY_OPTIONS: ReplayOptions = {
  trailHz: 20,
  telemetryHz: 10,
  paddingM: 15,
  carLengthM: 4.4,
  carWidthM: 1.8,
  smokeIntervalS: 0.15,
  smokeBetaThreshold: degToRad(15),
  smokeLifeS: 1.6,
  intensityLo: degToRad(8),
  // 60°, NOT the simulator's ~49° ceiling: a 70° near-spin must look different from a 45° slide.
  intensityHi: degToRad(60),
  ghost: true,
  ghostSync: 'distance',
  deadAirS: 1.5,
  gpsGapS: 2.5,
  gpsMaxHAccM: 50,
  highlightLeadS: 3.5,
};

/** Severity band edges in radians (see DriftSeverity). */
export const SEVERITY_EDGES = {
  hold: degToRad(8),
  big: degToRad(25),
  extreme: degToRad(40),
  spin: degToRad(65),
} as const;

/**
 * The callout for a drift's peak.
 *
 * `spun` is the ENGINE's published verdict (`ReplaySegment.spin`, from `DriftSummary.spun`),
 * never an angle band. The band used to stand in for it, which put "SAVED IT 118°" on a drift
 * the engine had marked as a spin, and "BIG ANGLE" on one that genuinely spun. An angle is what
 * the car reached; whether the driver held it is a different fact, and only the engine knows it.
 *
 * SAVED IT is therefore reserved for an angle past the spin edge that the driver DID hold, which
 * is the one moment in a run that deserves the phrase.
 */
export function peakCallout(spun: boolean, peakAngle: number): string {
  const deg = Math.round(Math.abs(peakAngle) * (180 / Math.PI));
  if (spun) return `LOST IT ${deg}°`;
  if (Math.abs(peakAngle) >= SEVERITY_EDGES.spin) return `SAVED IT ${deg}°`;
  return 'BIG ANGLE';
}

/**
 * What the run MEASURED about one slide, or null when it measured nothing.
 *
 * `Session.driftStats` is where the engine publishes it now. A session stored before that field
 * existed still has the same figures in the old place — inside the scorer's per-drift record —
 * so this is the accessor pattern `src/platform/sessionStore.ts:statsOf` established, and it is
 * a pattern rather than a one-liner because the fallback is the whole point: every run already
 * on a phone is read through it.
 */
function statsOf(session: Session, id: number): DriftSummary | null {
  const own = session.driftStats?.[id];
  if (own && typeof own === 'object') return own;
  const legacy = (session.score?.perDrift as Record<number, { stats?: DriftSummary }> | undefined)?.[id];
  return legacy && typeof legacy.stats === 'object' && legacy.stats !== null ? legacy.stats : null;
}

/**
 * Did this slide end in a spin? The published answer, never a re-derivation.
 *
 * `DriftSummary.spun` is the BROAD rule — any sample inside the slide past the spin angle — and
 * `DriftEvent.spin` is the detector's narrower flag, raised off the slide's peak, which can miss
 * exactly that sample. The replay read the narrow one and drew a clean exit over a slide the
 * review had already called a spin. Either saying yes is a yes, which is also what makes a
 * session with no `driftStats` at all still honest about the spins its detector did catch.
 */
function spunOf(session: Session, d: DriftEvent): boolean {
  return d.spin === true || statsOf(session, d.id)?.spun === true;
}

/** |β| → drama band. Absolute, so it means the same in every session. */
export function severityOf(beta: number): DriftSeverity {
  const a = Math.abs(beta);
  if (!(a >= SEVERITY_EDGES.hold)) return 'none';
  if (a < SEVERITY_EDGES.big) return 'hold';
  if (a < SEVERITY_EDGES.extreme) return 'big';
  if (a < SEVERITY_EDGES.spin) return 'extreme';
  return 'spin';
}

/** Interpolate an angle along the shortest arc. */
export function lerpAngle(a: number, b: number, f: number): number {
  return wrapAngle(a + wrapAngle(b - a) * f);
}

/** |β| → glow intensity 0..1 (intensityLo → 0, intensityHi → 1). */
export function intensityOf(beta: number, opts: ReplayOptions): number {
  return clamp((Math.abs(beta) - opts.intensityLo) / (opts.intensityHi - opts.intensityLo), 0, 1);
}

/**
 * How far β may drift from `course − heading` before the trail is rebuilt from the identity.
 * Half a degree: far above the noise of interpolating three angles, far below anything a driver
 * or a critic could see on screen.
 */
export const IDENTITY_TOLERANCE = degToRad(0.5);

interface SourceSample {
  t: number;
  x: number;
  y: number;
  heading: number;
  course: number;
  beta: number;
  speed: number;
}

/** Prefer estimator states; fall back to simulator truth when the session has no states. */
function sourceSamples(session: Session): SourceSample[] {
  if (session.states && session.states.length >= 2) {
    return session.states.map((s: SlipState) => ({ t: s.t, x: s.x, y: s.y, heading: s.heading, course: s.course, beta: s.beta, speed: s.speed }));
  }
  if (session.truth && session.truth.length >= 2) {
    return session.truth.map((s) => ({ t: s.t, x: s.x, y: s.y, heading: s.heading, course: s.course, beta: s.beta, speed: s.speed }));
  }
  return [];
}

/**
 * Sort by time, drop samples with a non-finite timestamp, and report both. A single
 * out-of-order timestamp must not collapse the replay to nothing (it used to).
 */
function cleanSamples(src: SourceSample[], warnings: string[]): SourceSample[] {
  const finite = src.filter((s) => Number.isFinite(s.t));
  if (finite.length !== src.length) warnings.push(`${src.length - finite.length} samples had a non-finite timestamp and were dropped`);
  let ooo = 0;
  for (let i = 1; i < finite.length; i++) if (finite[i].t < finite[i - 1].t) ooo++;
  if (ooo > 0) {
    warnings.push(`${ooo} out-of-order timestamps were re-sorted`);
    finite.sort((a, b) => a.t - b.t);
  }
  return finite;
}

function buildTrail(src: SourceSample[], t0: number, durationS: number, opts: ReplayOptions, warnings: string[]): ReplayTrail {
  const hz = opts.trailHz;
  const n = Math.max(2, Math.round(durationS * hz) + 1);
  const t = new Float64Array(n);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const heading = new Float64Array(n);
  const course = new Float64Array(n);
  const beta = new Float64Array(n);
  const speed = new Float64Array(n);
  const intensity = new Float32Array(n);
  let j = 0;
  let lastX = 0;
  let lastY = 0;
  let havePos = false;
  let badPos = 0;
  let badScalar = 0;
  /** The same two holes in the units a driver reads them in: metres of road, seconds of run. */
  let badPosM = 0;
  let badScalarS = 0;
  // last known-good scalars, so one NaN sample holds the previous value instead of poisoning
  // every later sample (dist is a running sum: a single NaN used to destroy the whole run).
  let lastHeading = 0;
  let lastCourse = 0;
  let lastBeta = 0;
  let lastSpeed = 0;
  for (const s of src) {
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      lastX = s.x;
      lastY = s.y;
      havePos = true;
      break;
    }
  }
  for (const s of src) {
    if (Number.isFinite(s.heading)) {
      lastHeading = s.heading;
      break;
    }
  }
  const pick = (a: number, b: number, f: number, last: number): number => {
    const af = Number.isFinite(a);
    const bf = Number.isFinite(b);
    if (af && bf) return a + (b - a) * f;
    badScalar++;
    if (af) return a;
    if (bf) return b;
    return last;
  };
  const pickAngle = (a: number, b: number, f: number, last: number): number => {
    const af = Number.isFinite(a);
    const bf = Number.isFinite(b);
    if (af && bf) return lerpAngle(a, b, f);
    badScalar++;
    if (af) return wrapAngle(a);
    if (bf) return wrapAngle(b);
    return last;
  };
  for (let k = 0; k < n; k++) {
    const tk = t0 + k / hz;
    t[k] = k / hz;
    while (j < src.length - 2 && src[j + 1].t <= tk) j++;
    const a = src[j];
    const b = src[Math.min(j + 1, src.length - 1)];
    const span = b.t - a.t;
    const f = span > 1e-9 ? clamp((tk - a.t) / span, 0, 1) : 0;
    const ax = Number.isFinite(a.x) && Number.isFinite(a.y);
    const bx = Number.isFinite(b.x) && Number.isFinite(b.y);
    if (ax && bx) {
      lastX = a.x + (b.x - a.x) * f;
      lastY = a.y + (b.y - a.y) * f;
    } else if (ax) {
      lastX = a.x;
      lastY = a.y;
    } else if (bx) {
      lastX = b.x;
      lastY = b.y;
    } else badPos++;
    const posBad = !(ax || bx);
    const scalarBefore = badScalar;
    x[k] = havePos ? lastX : 0;
    y[k] = havePos ? lastY : 0;
    // angles interpolate on the shortest arc — β too: a slide through ±π must not read as 0°
    lastHeading = heading[k] = pickAngle(a.heading, b.heading, f, lastHeading);
    lastCourse = course[k] = pickAngle(a.course, b.course, f, lastCourse);
    lastBeta = beta[k] = pickAngle(a.beta, b.beta, f, lastBeta);
    lastSpeed = speed[k] = Math.max(0, pick(a.speed, b.speed, f, lastSpeed));
    // the same hole said in road units: how far the car travelled while nothing was known
    if (posBad) badPosM += speed[k] / hz;
    if (badScalar > scalarBefore) badScalarS += 1 / hz;
    intensity[k] = intensityOf(beta[k], opts);
  }
  // A DRIVER HAS NO IDEA WHAT A TRAIL SAMPLE IS. This plate is read at arm's length by someone
  // who wants to know what is wrong with their recording, so it is stated in the units the road
  // is in — seconds of the run and metres of it — not in the renderer's own 20 Hz grid.
  if (badPos > 0) {
    warnings.push(
      badPos === n
        ? 'no usable positions in this session (SIGNAL LOST)'
        : `${(badPos / hz).toFixed(1)} s of the run had no usable position — about ${Math.round(badPosM)} m of road`,
    );
  }
  if (badScalar > 0) warnings.push(`${badScalarS.toFixed(1)} s of speed or angle was missing and was held steady`);
  // β = course − heading is the engine's DEFINITION of a slip angle (src/engine/types.ts), and
  // three arrays copied independently can quietly stop obeying it — a fixture that rewrote β
  // without touching heading drew a car pointing straight down the road under a 118° numeral,
  // and nothing downstream noticed for a whole round. The nose is what gets redrawn, because
  // the position (and therefore the course) is measured and β is the estimator's output.
  let worst = 0;
  for (let k = 0; k < n; k++) {
    const e = Math.abs(wrapAngle(beta[k] - (course[k] - heading[k])));
    if (e > worst) worst = e;
  }
  if (worst > IDENTITY_TOLERANCE) {
    warnings.push(`the slip angle disagrees with the heading by up to ${radToDeg(worst).toFixed(1)}° — the car is drawn from course − β`);
    for (let k = 0; k < n; k++) heading[k] = wrapAngle(course[k] - beta[k]);
  }
  const dist = new Float64Array(n);
  for (let k = 1; k < n; k++) dist[k] = dist[k - 1] + (0.5 * (speed[k - 1] + speed[k])) / hz;
  return {
    n,
    hz,
    t,
    x,
    y,
    heading,
    course,
    beta,
    speed,
    dist,
    intensity,
    segmentOf: new Int16Array(n).fill(-1),
    lapOf: new Int16Array(n).fill(-1),
    measured: new Uint8Array(n).fill(1),
  };
}

/**
 * Which trail samples rest on a real fix, and where the run was dead-reckoned.
 *
 * The estimator propagates position through a GPS dropout, so the trail is continuous and a
 * renderer cannot otherwise tell a measured corner from a reckoned one. Computing this here,
 * once, is the difference between two renderers agreeing about where the data was real and each
 * inventing its own threshold.
 */
function markMeasured(session: Session, t0: number, trail: ReplayTrail, durationS: number, opts: ReplayOptions, warnings: string[]): Array<{ startT: number; endT: number }> {
  const usable = (g: { t: number; lat: number; lon: number; hAcc: number }) =>
    Number.isFinite(g.t) && Number.isFinite(g.lat) && Number.isFinite(g.lon) && Number.isFinite(g.hAcc) && g.hAcc > 0 && g.hAcc <= opts.gpsMaxHAccM;
  const fixes = (session.gps ?? []).filter(usable).map((g) => g.t - t0).sort((a, b) => a - b);
  const windows: Array<{ startT: number; endT: number }> = [];
  if (fixes.length === 0) {
    // no usable fixes at all: nothing here was measured
    trail.measured.fill(0);
    if (trail.n > 1) windows.push({ startT: 0, endT: durationS });
    warnings.push('no usable GPS fixes: every position was dead-reckoned');
    return windows;
  }
  // a gap longer than gpsGapS (including the run-in before the first fix and the run-out after
  // the last) is a dropout
  const edges = [-Infinity, ...fixes, Infinity];
  for (let i = 1; i < edges.length; i++) {
    const a = edges[i - 1];
    const b = edges[i];
    const from = Math.max(0, a === -Infinity ? 0 : a);
    const to = Math.min(durationS, b === Infinity ? durationS : b);
    const span = (b === Infinity ? durationS : b) - (a === -Infinity ? 0 : a);
    if (span <= opts.gpsGapS || to <= from) continue;
    windows.push({ startT: from, endT: to });
  }
  trail.measured.fill(1);
  for (const w of windows) {
    const i0 = Math.max(0, Math.ceil(w.startT * trail.hz));
    const i1 = Math.min(trail.n - 1, Math.floor(w.endT * trail.hz));
    for (let k = i0; k <= i1; k++) trail.measured[k] = 0;
  }
  if (windows.length) {
    const lost = windows.reduce((acc, w) => acc + (w.endT - w.startT), 0);
    warnings.push(`${windows.length} GPS dropout${windows.length === 1 ? ' totalling' : 's totalling'} ${lost.toFixed(1)} s ${windows.length === 1 ? 'was' : 'were'} dead-reckoned`);
  }
  return windows;
}

/** Trail index of replay time t (fractional). */
export function trailIndexOf(trail: ReplayTrail, t: number): number {
  return clamp(Number.isFinite(t) ? t * trail.hz : 0, 0, trail.n - 1);
}

/** Linear interpolation of a trail-aligned array at replay time t. */
export function trailValueAt(trail: ReplayTrail, arr: ArrayLike<number>, t: number): number {
  const fi = trailIndexOf(trail, t);
  const i0 = Math.floor(fi);
  const i1 = Math.min(i0 + 1, trail.n - 1);
  const f = fi - i0;
  return arr[i0] + (arr[i1] - arr[i0]) * f;
}

function trailAngleAt(trail: ReplayTrail, arr: Float64Array, t: number): number {
  const fi = trailIndexOf(trail, t);
  const i0 = Math.floor(fi);
  const i1 = Math.min(i0 + 1, trail.n - 1);
  return lerpAngle(arr[i0], arr[i1], fi - i0);
}

function buildLaps(session: Session, t0: number, trail: ReplayTrail, durationS: number): ReplayLap[] {
  const laps: ReplayLap[] = [];
  const src = session.track?.laps ?? [];
  for (const lap of src) {
    if (!Number.isFinite(lap.startT) || !Number.isFinite(lap.endT)) continue;
    const startT = clamp(lap.startT - t0, 0, durationS);
    const endT = clamp(lap.endT - t0, 0, durationS);
    if (endT - startT < 1) continue;
    const startIndex = Math.ceil(startT * trail.hz - 1e-6);
    const endIndex = Math.min(trail.n - 1, Math.floor(endT * trail.hz + 1e-6));
    laps.push({ index: lap.index, startT, endT, durationS: endT - startT, startIndex, endIndex, fastest: false, ghostRef: -1 });
  }
  laps.sort((a, b) => a.startT - b.startT);
  for (let li = 0; li < laps.length; li++) {
    const lap = laps[li];
    for (let k = lap.startIndex; k <= lap.endIndex; k++) if (trail.lapOf[k] < 0) trail.lapOf[k] = li;
  }
  return laps;
}

function buildSegments(session: Session, t0: number, trail: ReplayTrail, durationS: number, opts: ReplayOptions, warnings: string[]): ReplaySegment[] {
  const drifts = [...(session.drifts ?? [])].filter((d) => Number.isFinite(d.startT) && Number.isFinite(d.endT)).sort((a, b) => a.startT - b.startT);
  const segments: ReplaySegment[] = [];
  for (const d of drifts) {
    const startT = clamp(d.startT - t0, 0, durationS);
    const endT = clamp(d.endT - t0, 0, durationS);
    const startIndex = Math.ceil(startT * trail.hz - 1e-6);
    const endIndex = Math.min(trail.n - 1, Math.floor(endT * trail.hz + 1e-6));
    if (endIndex < startIndex) continue;
    const intensity = new Float32Array(endIndex - startIndex + 1);
    let peak = 0;
    let peakIndex = startIndex;
    let firstSign: 1 | -1 | 0 = 0;
    let transitions = 0;
    let lastStrong: 1 | -1 | 0 = 0;
    for (let k = startIndex; k <= endIndex; k++) {
      if (trail.segmentOf[k] < 0) trail.segmentOf[k] = segments.length;
      intensity[k - startIndex] = trail.intensity[k];
      const ab = Math.abs(trail.beta[k]);
      if (ab > peak) {
        peak = ab;
        peakIndex = k;
      }
      if (ab > opts.intensityLo) {
        const sg: 1 | -1 = trail.beta[k] > 0 ? 1 : -1;
        if (firstSign === 0) firstSign = sg;
        if (lastStrong !== 0 && sg !== lastStrong) transitions++;
        lastStrong = sg;
      }
    }
    const stats = statsOf(session, d.id);
    const peakT = Number.isFinite(d.peakAngleT) && d.peakAngleT >= d.startT && d.peakAngleT <= d.endT ? d.peakAngleT - t0 : trail.t[peakIndex];
    // The DETECTOR's peak is the one that gets printed, because it is the one the results screen
    // prints; the trail maximum runs up to a few degrees higher on a noisy mount and is kept only
    // for the colour ramp. They used to be maxed together, which put "BEST 80°" on the replay
    // against "PEAK ANGLE 75.9°" on the results screen for the same slide.
    const peakAngle = Number.isFinite(d.peakAngle) && d.peakAngle > 0 ? d.peakAngle : peak;
    segments.push({
      driftId: d.id,
      startIndex,
      endIndex,
      startT,
      endT,
      durationS: endT - startT,
      intensity,
      peakAngle,
      samplePeakAngle: Math.max(peak, peakAngle),
      peakT,
      peakIndex,
      severity: severityOf(peakAngle),
      spin: spunOf(session, d),
      initialDirection: firstSign !== 0 ? firstSign : d.initialDirection === -1 ? -1 : 1,
      transitions: Math.max(transitions, d.transitions | 0),
      // The seconds the results screen prints under HELD, when the run kept measurements; the
      // whole slide when it did not, which is the most a recording that old knows about itself.
      heldS: stats && Number.isFinite(stats.sustainedS) && stats.sustainedS > 0 ? Math.min(stats.sustainedS, Math.max(0, endT - startT)) : endT - startT,
      suppressedS: Number.isFinite(d.suppressedS) && d.suppressedS > 0 ? Math.min(d.suppressedS, Math.max(0, d.durationS)) : 0,
      lapIndex: trail.lapOf[startIndex],
    });
  }
  // Every slide has to exist on both screens. A drift clipped away by the active window
  // used to leave the replay saying "8 DRIFTS" where the results screen listed 9.
  const kept = new Set(segments.map((g) => g.driftId));
  const dropped = drifts.filter((d) => !kept.has(d.id));
  if (dropped.length > 0) warnings.push(`${dropped.length} drift${dropped.length === 1 ? '' : 's'} fell outside the replay window and are not drawn`);
  return segments;
}

function hash01(i: number): number {
  let h = (i * 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function buildSmoke(trail: ReplayTrail, opts: ReplayOptions): SmokeParticle[] {
  const smoke: SmokeParticle[] = [];
  let nextEmit = -Infinity;
  let emitted = 0;
  let side: 1 | -1 = 1;
  const rear = 0.5 * opts.carLengthM;
  const half = 0.5 * opts.carWidthM;
  for (let k = 0; k < trail.n; k++) {
    const t = trail.t[k];
    const b = trail.beta[k];
    const v = trail.speed[k];
    // every guard is a POSITIVE finite test: `Math.abs(NaN) <= thr` is false, so a NaN β
    // used to sail straight through and emit particles at NaN coordinates.
    if (!Number.isFinite(b) || !Number.isFinite(v) || !Number.isFinite(trail.x[k]) || !Number.isFinite(trail.y[k])) continue;
    if (!(Math.abs(b) > opts.smokeBetaThreshold) || !(v >= 1)) continue;
    const inten = trail.intensity[k];
    // a bigger slide smokes more often: 0.15 s at full intensity, 0.26 s at the threshold
    const interval = opts.smokeIntervalS * (1.7 - 0.7 * inten);
    if (t < nextEmit) continue;
    nextEmit = t + interval;
    const h = trail.heading[k];
    const c = trail.course[k];
    const ch = Math.cos(h);
    const sh = Math.sin(h);
    // spread is perpendicular to the DIRECTION OF TRAVEL, so the puff always leaves the tyre
    // backwards however far the nose is turned
    const cc = Math.cos(c);
    const scc = Math.sin(c);
    // the outside rear tyre works hardest: β>0 (travelling left of the nose) → right rear
    const outside: 1 | -1 = b > 0 ? -1 : 1;
    // one puff per emission, biased to the outside tyre (halves the count vs both tyres and
    // lets each puff be bigger and more varied — 22 identical discs read as one tube)
    side = emitted % 3 === 2 ? (outside === 1 ? -1 : 1) : outside;
    const ox = trail.x[k] - rear * ch - side * half * sh;
    const oy = trail.y[k] - rear * sh + side * half * ch;
    const s0 = hash01(emitted * 3);
    const s1 = hash01(emitted * 3 + 1);
    const s2 = hash01(emitted * 3 + 2);
    const back = 0.22 * v * (1 + 0.35 * (s0 - 0.5));
    // real tyre smoke is thrown wide, not trailed in a tube: 2.5–4 m/s outward
    const lateral = side * (2.5 + 1.5 * inten) * (0.75 + 0.5 * s1);
    smoke.push({
      birthT: t,
      x: ox,
      y: oy,
      vx: -back * cc - lateral * scc,
      vy: -back * scc + lateral * cc,
      // double the size variance
      size: (0.9 + 1.1 * inten) * (0.6 + 0.9 * s2),
      life: opts.smokeLifeS * (0.8 + 0.5 * s0),
      strength: 0.45 + 0.55 * inten,
      side,
      seed: s1,
      heat: clamp(0.35 + 0.75 * inten, 0, 1),
    });
    emitted++;
  }
  return smoke;
}

function poseFields(trail: ReplayTrail, t: number): { x: number; y: number; heading: number; course: number } {
  return {
    x: trailValueAt(trail, trail.x, t),
    y: trailValueAt(trail, trail.y, t),
    heading: trailAngleAt(trail, trail.heading, t),
    course: trailAngleAt(trail, trail.course, t),
  };
}

const MARKER_PRIORITY: Record<string, number> = { 'drift-peak': 40, transition: 30, 'drift-end': 20, lap: 15, 'drift-start': 10 };

/**
 * WHAT THE EXIT OF A SLIDE SAYS. One rule, exported, so both renderers say the same thing and a
 * test can run it.
 *
 * The exit used to announce an award — "+1250", "CHAIN LOST −8981", "AT RISK +1380" — and those
 * are gone with the points behind them. What is left at the end of a slide is what the driver
 * actually did with it: how many seconds they held the car sideways. That is
 * `ReplaySegment.heldS`, the same figure the review prints under HELD, so the two screens cannot
 * describe the same slide with two different durations.
 *
 * THE MONITOR OUTRANKS IT WHEN NOTHING BELIEVABLE IS LEFT, and only then. A slide the monitor
 * refused outright has no hold to report — saying "HELD 2.9 S" over it would be the replay
 * vouching for a measurement the engine has already disowned — so it says what it does know:
 * `src/engine/types.ts` calls this duration "the only form a driver can be shown: '6.1 s of this
 * slide did not count, because the phone was moving in its mount'". Before this existed, `hero`
 * seed 13's drift 3 (2.93 s long, all 2.93 s of it refused) drew a full ribbon with a halo and
 * two ticks and said nothing at all, while the results screen printed the session's 9.36 s /
 * 11.4 % one screen away.
 *
 * A PARTLY refused slide still reports its hold, because it is still a slide: `good`'s drift 2
 * is 23.9 s of sideways with 2.2 s of it refused, and an exit reading "2.2 S DID NOT COUNT" over
 * it would describe a twenty-four-second drift by the one second of it the monitor blinked at,
 * and would disagree with the row the review prints for the same slide. The refusal is not
 * dropped — the review itemises it, and the frame's own plate carries the session's verdict —
 * it is simply not what the exit of that slide is about.
 *
 * A slide too short to have a tenth of a second in it says nothing rather than "HELD 0.0 S".
 */
export function exitLabel(seg: Pick<ReplaySegment, 'heldS' | 'suppressedS'>): string {
  const believed = seg.heldS - seg.suppressedS;
  if (seg.suppressedS > 0 && believed < 0.05) return `${seg.suppressedS.toFixed(1)} S DID NOT COUNT`;
  return seg.heldS >= 0.05 ? `HELD ${seg.heldS.toFixed(1)} S` : '';
}

function buildMarkers(trail: ReplayTrail, segments: ReplaySegment[], laps: ReplayLap[], opts: ReplayOptions): ReplayMarker[] {
  const markers: ReplayMarker[] = [];
  const lapOfT = (t: number) => trail.lapOf[clamp(Math.round(t * trail.hz), 0, trail.n - 1)];
  const push = (m: Omit<ReplayMarker, 'lapIndex' | 'priority'> & { lapIndex?: number }) => {
    markers.push({ ...m, lapIndex: m.lapIndex ?? lapOfT(m.t), priority: MARKER_PRIORITY[m.kind] ?? 0 });
  };
  for (const seg of segments) {
    push({ kind: 'drift-start', t: seg.startT, ...poseFields(trail, seg.startT), label: 'DRIFT', driftId: seg.driftId });
    const peakDeg = Math.round((seg.peakAngle * 180) / Math.PI);
    push({ kind: 'drift-peak', t: seg.peakT, ...poseFields(trail, seg.peakT), label: `${peakDeg}°`, driftId: seg.driftId, peakAngle: seg.peakAngle, severity: seg.severity });
    let lastStrong: 1 | -1 | 0 = 0;
    let lastStrongIdx = seg.startIndex;
    let n = 0;
    for (let k = seg.startIndex; k <= seg.endIndex; k++) {
      const b = trail.beta[k];
      if (!(Math.abs(b) > opts.intensityLo)) continue;
      const sg: 1 | -1 = b > 0 ? 1 : -1;
      if (lastStrong !== 0 && sg !== lastStrong) {
        let tz = trail.t[k];
        for (let m = lastStrongIdx + 1; m <= k; m++) {
          const b0 = trail.beta[m - 1];
          const b1 = trail.beta[m];
          if (Math.sign(b1) === sg || b1 === 0) {
            const f = b1 === b0 ? 0 : clamp(-b0 / (b1 - b0), 0, 1);
            tz = trail.t[m - 1] + f / trail.hz;
            break;
          }
        }
        n++;
        // U+00D7, and a COUNT of direction changes rather than anything that was ever multiplied
        // by it: the chip that spelled a score multiplier this way is gone, the transitions are
        // what the driver did and stay
        push({ kind: 'transition', t: tz, ...poseFields(trail, tz), label: n > 1 ? `TRANSITION \u00d7${n}` : 'TRANSITION', driftId: seg.driftId });
      }
      lastStrong = sg;
      lastStrongIdx = k;
    }
    push({
      kind: 'drift-end',
      t: seg.endT,
      ...poseFields(trail, seg.endT),
      // The seconds the car was sideways, or the seconds the monitor refused when there were any
      // \u2014 `exitLabel` owns that choice for both renderers. The dot marks the exit either way.
      label: exitLabel(seg),
      driftId: seg.driftId,
      heldS: seg.heldS,
      // present only when the refusal is what the marker is SAYING, so a renderer never has to
      // work out which of two durations the label in front of it is
      suppressedS: exitLabel(seg).includes('DID NOT COUNT') ? seg.suppressedS : undefined,
    });
  }
  for (const lap of laps) {
    push({ kind: 'lap', t: lap.startT, ...poseFields(trail, lap.startT), label: `LAP ${lap.index + 1}`, lapIndex: lap.index });
  }
  const last = laps[laps.length - 1];
  if (last) push({ kind: 'lap', t: last.endT, ...poseFields(trail, last.endT), label: 'FINISH', lapIndex: last.index });
  markers.sort((a, b) => a.t - b.t);
  return markers;
}

/**
 * How loud a beat is, 0..1 — the shake it puts through the frame, the scale the callout slams
 * to, and how far the glow blooms.
 *
 * IT WAS A RATIO OF POINTS: `seg.grossPoints / maxPoints`, clamped to 0.25..1, with a lost chain
 * forced to 1 and a lost-but-not-spun drift to 0.35. So the loudest moment of a run was the one
 * the scorer paid most for, which on a chained lap is a long, shallow, fast slide rather than
 * the one the driver remembers — and a slide the integrity monitor refused shook the screen at
 * 0.35 for reasons no frame could show.
 *
 * The replacement is the slide itself, and both halves of it are things a driver can see:
 *
 *   ANGLE, against the run's own biggest. The peak is the headline of any slide and is what the
 *   review leads with, so a 64° moment on a run whose best is 64° is at the top of the scale and
 *   a 30° one on the same run is a little under half of it. It is relative to the RUN and not to
 *   a fixed ceiling because the beat is a moment inside this run, not a comparison with another:
 *   on a 20° touge lap the biggest slide of the lap still has to feel like the biggest slide of
 *   the lap. `SEVERITY_EDGES.hold` floors the denominator so a lap with nothing in it cannot
 *   scale 4° up into a peak.
 *
 *   DURATION, as a lift rather than a second axis. Two slides that reach the same angle are not
 *   the same moment if one was held four times as long, but duration cannot be allowed to
 *   outrank angle either — a 12 s shallow slide is not the loudest thing in a run with a 70°
 *   save in it. So it is a 0..0.3 bonus that saturates at 6 s, measured on `heldS`, the seconds
 *   the car was actually sideways, which is the figure the review prints.
 *
 * Floored at 0.25 so every slide registers, capped at 1. A spin stays at 1 whatever its angle:
 * losing the car is the loudest thing that can happen in a run, and the engine has already said
 * so (`ReplaySegment.spin`).
 */
export function beatMagnitude(seg: Pick<ReplaySegment, 'peakAngle' | 'heldS' | 'spin'>, runPeakAngle: number): number {
  if (seg.spin) return 1;
  const scale = Math.max(runPeakAngle, SEVERITY_EDGES.hold);
  const angle = clamp(Math.abs(seg.peakAngle) / scale, 0, 1);
  const held = clamp(seg.heldS / 6, 0, 1);
  return clamp(0.75 * angle + 0.3 * held, 0.25, 1);
}

/**
 * The dramatic beats, in time order. Both renderers animate from this so the app and the
 * harness cannot diverge (DESIGN.md motion language: slam 1.8 → 1.0, shake on transitions).
 */
function buildEvents(trail: ReplayTrail, segments: ReplaySegment[], laps: ReplayLap[], markers: ReplayMarker[]): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  const runPeak = Math.max(0, ...segments.map((g) => Math.abs(g.peakAngle)));
  for (const seg of segments) {
    const mag = beatMagnitude(seg, runPeak);
    events.push({ kind: 'entry', t: seg.startT, holdS: 0.6, magnitude: 0.45 * mag, priority: 20, label: '', driftId: seg.driftId, lapIndex: seg.lapIndex });
    // The kind comes from the engine's own verdict. A spun drift ALWAYS gets its beat, whatever
    // band its angle landed in, and a held angle never borrows the spin's word or its colour.
    if (seg.spin || seg.severity === 'extreme' || seg.severity === 'spin') {
      events.push({
        kind: seg.spin ? 'spin' : 'peak',
        t: seg.peakT,
        holdS: 1.1,
        magnitude: mag,
        priority: seg.spin ? 90 : 60,
        label: peakCallout(seg.spin, seg.peakAngle),
        driftId: seg.driftId,
        lapIndex: seg.lapIndex,
      });
    }
    // The exit says how long the car was sideways, or — when the monitor refused the slide
    // outright — that it did not believe it, which is a beat of its own (`refused`, so both
    // renderers can colour it without reading the string). It used to be an award, and a spun
    // drift's exit was pushed 0.35 s past the spin beat so "CHAIN LOST −8981" would not land on
    // top of "LOST IT 118°"; with no number to announce there is nothing to get out of the way
    // of, and the exit sits where the slide actually ended. Priority still keeps the spin's word
    // on the frame while it is up.
    const exit = exitLabel(seg);
    events.push({
      kind: exit.includes('DID NOT COUNT') ? 'refused' : 'exit',
      t: seg.endT,
      holdS: 1.3,
      magnitude: 0.6 * mag,
      priority: 50,
      label: exit,
      driftId: seg.driftId,
      lapIndex: seg.lapIndex,
    });
  }
  for (const m of markers) {
    if (m.kind !== 'transition') continue;
    events.push({ kind: 'transition', t: m.t, holdS: 1.0, magnitude: 0.7, priority: 70, label: m.label, driftId: m.driftId, lapIndex: m.lapIndex });
  }
  for (const lap of laps) {
    if (lap.index > 0) events.push({ kind: 'lap', t: lap.startT, holdS: 1.2, magnitude: 0.5, priority: 65, label: `LAP ${lap.index + 1}`, lapIndex: lap.index });
  }
  const last = laps[laps.length - 1];
  if (last) events.push({ kind: 'finish', t: last.endT, holdS: 2.5, magnitude: 1, priority: 95, label: 'FINISH', lapIndex: last.index });
  events.sort((a, b) => a.t - b.t);
  return events;
}

/**
 * THE BEST BITS, best first — and "best" is the app's one rule for it: the biggest peak angle,
 * with the longest held breaking a tie.
 *
 * IT WAS RANKED BY POINTS: `b.points + b.peakAngle * 1000` against the same for `a`, where
 * `points` was the slide's gross score. The angle term dominated that sum on almost every run
 * (1000 × radians is 0–2 000 against a few hundred to a few thousand points), which is why the
 * order barely moves — but "barely" is not a rule, and the runs where the points DID decide were
 * exactly the ones where the driver disagreed: a long fast shallow slide inside a chain, ranked
 * over the save of the run. The review screen already picks its BEST DRIFT this way
 * (`bestByAngle` in src/ui/results/model.ts), and "best bits" and "best drift" have to be the
 * same words about the same run.
 *
 * The tie-break is `heldS`, the seconds the car was actually sideways — the same figure the chip
 * prints and the same one the review prints under HELD — so a driver comparing two equal angles
 * is comparing the number they can see.
 *
 * A SPIN CAN WIN, because a spin really is the biggest angle of a run. The chip says SPUN when
 * it does, rather than quietly handing the title to the runner-up and calling it the biggest.
 */
function buildHighlights(trail: ReplayTrail, segments: ReplaySegment[], lead: number): ReplayHighlight[] {
  const out: ReplayHighlight[] = [];
  for (const seg of segments) {
    const kind: ReplayHighlight['kind'] = seg.spin ? 'spin' : seg.transitions >= 2 ? 'link' : 'angle';
    const inT = Math.max(0, seg.startT - 1);
    const deg = Math.round((seg.peakAngle * 180) / Math.PI);
    out.push({
      t: seg.peakT,
      // land on the moment, not on the run-up: a three-link chain starts 25 s before its peak
      cueT: Math.max(inT, seg.peakT - lead),
      inT,
      outT: Math.min(trail.t[trail.n - 1], seg.endT + 1.2),
      // The angle, then what happened to it: how long it was held, or that it was lost. Both are
      // measurements of the slide. The chip used to read "23° · 0 PTS" on a slide the engine had
      // paid nothing for, which is a score printed over a refusal.
      label: seg.spin ? `${deg}° · SPUN` : kind === 'link' ? `${deg}° · ${seg.transitions}-LINK` : `${deg}° · ${seg.heldS.toFixed(1)}S`,
      kind,
      driftId: seg.driftId,
      peakAngle: seg.peakAngle,
      heldS: seg.heldS,
    });
  }
  out.sort((a, b) => (b.peakAngle !== a.peakAngle ? b.peakAngle - a.peakAngle : b.heldS - a.heldS));
  return out;
}

/**
 * Re-parameterise one lap on lap-relative time τ. Used for the ghost: `ghostPoseAt` compares
 * the lap being watched against a DIFFERENT lap (never itself — a ghost that is the car is a
 * rendering glitch, not a ghost).
 */
function sampleLap(trail: ReplayTrail, lap: ReplayLap): ReplayGhost {
  const hz = trail.hz;
  const n = Math.max(2, Math.round(lap.durationS * hz) + 1);
  const tau = new Float64Array(n);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const heading = new Float64Array(n);
  const course = new Float64Array(n);
  const beta = new Float64Array(n);
  const speed = new Float64Array(n);
  const dist = new Float64Array(n);
  const d0 = trailValueAt(trail, trail.dist, lap.startT);
  for (let k = 0; k < n; k++) {
    const tk = k / hz;
    const t = Math.min(lap.startT + tk, lap.endT);
    tau[k] = tk;
    x[k] = trailValueAt(trail, trail.x, t);
    y[k] = trailValueAt(trail, trail.y, t);
    heading[k] = trailAngleAt(trail, trail.heading, t);
    course[k] = trailAngleAt(trail, trail.course, t);
    beta[k] = trailAngleAt(trail, trail.beta, t);
    speed[k] = trailValueAt(trail, trail.speed, t);
    dist[k] = trailValueAt(trail, trail.dist, t) - d0;
  }
  return { lapIndex: lap.index, startT: lap.startT, endT: lap.endT, durationS: lap.durationS, n, hz, tau, x, y, heading, course, beta, speed, dist };
}

/**
 * Choose the reference lap and, for every lap, which OTHER lap its ghost shows.
 * Returns the primary ghost (the fastest lap) or null.
 *
 * THE REFERENCE IS THE QUICKEST LAP. It used to be the lap that SCORED most — `lap.points`, the
 * cumulative score delta across it, with lap time only breaking a tie — so a ghost car existed
 * because of a number that no longer does. Time is the racing answer and the only one left that
 * is a fact about the driving: the gap the screen reports is already a time gap (`GhostPose.gapS`,
 * from the reference lap's own distance→time curve), so the ghost and its readout now agree about
 * what is being compared. `ReplayLap.fastest` was already computed here, one line apart from the
 * old `best`, for the same laps.
 *
 * Every lap's ghost is the fastest of the OTHER laps, so the ghost is never the car being
 * watched — a cyan outline sitting exactly on the white car reads as a rendering glitch.
 */
function buildGhost(trail: ReplayTrail, laps: ReplayLap[], closed: boolean, durationS: number, opts: ReplayOptions): ReplayGhost | null {
  if (!opts.ghost || !closed) return null;
  const complete = laps.filter((l) => l.endT <= durationS + 1e-6 && l.durationS > 5);
  if (complete.length < 2) return null;
  const quicker = (a: ReplayLap, b: ReplayLap) => a.durationS < b.durationS;
  let fastest = complete[0];
  for (const lap of complete) if (quicker(lap, fastest)) fastest = lap;
  fastest.fastest = true;
  for (const lap of laps) {
    let ref: ReplayLap | null = null;
    for (const other of complete) {
      if (other.index === lap.index) continue;
      if (!ref || quicker(other, ref)) ref = other;
    }
    lap.ghostRef = ref ? ref.index : -1;
  }
  return sampleLap(trail, fastest);
}

function buildTelemetry(trail: ReplayTrail, durationS: number, opts: ReplayOptions): ReplayTelemetry {
  const hz = opts.telemetryHz;
  const n = Math.max(2, Math.round(durationS * hz) + 1);
  const t = new Float64Array(n);
  const speed = new Float32Array(n);
  const angle = new Float32Array(n);
  const beta = new Float32Array(n);
  const drifting = new Uint8Array(n);
  let maxSpeed = 0;
  let maxAngle = 0;
  for (let k = 0; k < n; k++) {
    const tk = k / hz;
    t[k] = tk;
    speed[k] = trailValueAt(trail, trail.speed, tk);
    const b = trailAngleAt(trail, trail.beta, tk);
    beta[k] = b;
    angle[k] = Math.abs(b);
    drifting[k] = trail.segmentOf[Math.round(trailIndexOf(trail, tk))] >= 0 ? 1 : 0;
    if (speed[k] > maxSpeed) maxSpeed = speed[k];
    if (angle[k] > maxAngle) maxAngle = angle[k];
  }
  return { n, hz, t, speed, angle, beta, drifting, maxSpeed, maxAngle };
}

function buildBounds(trail: ReplayTrail, track: Replay['track'], opts: ReplayOptions, pad = true): ReplayBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (let k = 0; k < trail.n; k++) add(trail.x[k], trail.y[k]);
  if (track) for (const p of track.path) add(p.x, p.y);
  if (!Number.isFinite(minX)) {
    minX = maxX = minY = maxY = 0;
  }
  const m = pad ? Math.max(opts.paddingM, 0.05 * Math.max(maxX - minX, maxY - minY)) : 0;
  return { minX: minX - m, maxX: maxX + m, minY: minY - m, maxY: maxY + m };
}

/**
 * First/last times worth watching: the replay must not open on a parked car, nor keep rolling
 * for twenty seconds after the chequered flag. On a closed circuit it ends just after the last
 * lap's finish so the FINISH beat lands on the final frame.
 */
function activeWindow(session: Session, src: SourceSample[], opts: ReplayOptions): { start: number; end: number } {
  const moving = (s: SourceSample) => Number.isFinite(s.speed) && s.speed > 1.5;
  let i = 0;
  while (i < src.length && !moving(src[i])) i++;
  let j = src.length - 1;
  while (j > i && !moving(src[j])) j--;
  if (i >= j) return { start: src[0].t, end: src[src.length - 1].t };
  let start = Math.max(src[0].t, src[i].t - opts.deadAirS);
  let end = Math.min(src[src.length - 1].t, src[j].t + opts.deadAirS);
  const laps = session.track?.laps ?? [];
  if (session.track?.closed && laps.length > 0) {
    const finish = Math.max(...laps.map((l) => (Number.isFinite(l.endT) ? l.endT : -Infinity)));
    if (Number.isFinite(finish) && finish > start + 5) end = Math.min(end, finish + 2.5);
  }
  // ...but never at the cost of a slide. The chequered flag is not the end of the
  // recording: a drift that runs past it (or begins before the car was judged to be moving) is
  // still on the results screen, and a window that cuts it makes the two screens count
  // different runs. The FINISH beat stays at the flag; the replay simply keeps rolling.
  const drifts = (session.drifts ?? []).filter((d) => Number.isFinite(d.startT) && Number.isFinite(d.endT));
  for (const d of drifts) {
    if (d.startT < start) start = Math.max(src[0].t, d.startT - 0.5);
    if (d.endT > end) end = Math.min(src[src.length - 1].t, d.endT + opts.deadAirS);
  }
  return { start, end };
}

/**
 * Build the replay scene for a session. Pure; O(n) in the number of samples.
 * Works from `session.states`, or from `session.truth` when a (simulated) session has no states.
 */
export function buildReplay(session: Session, partial: Partial<ReplayOptions> = {}): Replay {
  const opts: ReplayOptions = { ...DEFAULT_REPLAY_OPTIONS, ...partial };
  const warnings: string[] = [];
  const src = cleanSamples(sourceSamples(session), warnings);
  if (src.length < 2) {
    warnings.push('session has no usable samples');
    const stub: SourceSample[] = [
      { t: 0, x: 0, y: 0, heading: 0, course: 0, beta: 0, speed: 0 },
      { t: 0.05, x: 0, y: 0, heading: 0, course: 0, beta: 0, speed: 0 },
    ];
    const trail = buildTrail(stub, 0, 0.05, opts, []);
    const telemetry = buildTelemetry(trail, 0.05, opts);
    return {
      t0: 0,
      durationS: 0.05,
      bounds: buildBounds(trail, null, opts),
      content: buildBounds(trail, null, opts, false),
      trail,
      segments: [],
      smoke: [],
      markers: [],
      events: [],
      laps: [],
      ghost: null,
      telemetry,
      highlights: [],
      track: null,
      info: { name: session.name ?? '', trusted: false, driftCount: 0, peakAngle: 0, typicalAngle: 0, maxSpeed: 0, severity: 'none' },
      gapWindows: [],
      warnings,
      options: opts,
    };
  }
  const window = activeWindow(session, src, opts);
  const t0 = window.start;
  const durationS = Math.max(1 / opts.trailHz, window.end - t0);
  const trail = buildTrail(src, t0, durationS, opts, warnings);
  const gapWindows = markMeasured(session, t0, trail, durationS, opts, warnings);
  const laps = buildLaps(session, t0, trail, durationS);
  const segments = buildSegments(session, t0, trail, durationS, opts, warnings);
  const smoke = buildSmoke(trail, opts);
  const markers = buildMarkers(trail, segments, laps, opts);
  const events = buildEvents(trail, segments, laps, markers);
  const closed = !!session.track?.closed;
  const ghost = buildGhost(trail, laps, closed, durationS, opts);
  const telemetry = buildTelemetry(trail, durationS, opts);
  const highlights = buildHighlights(trail, segments, opts.highlightLeadS);
  const track =
    session.track && session.track.refPath?.length > 1
      ? {
          path: session.track.refPath.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => ({ x: p.x, y: p.y })),
          closed,
          gate: session.track.gate,
          corners: (session.track.corners ?? []).map((c) => ({ x: c.x, y: c.y, direction: c.direction, radiusM: c.radiusM, apexS: c.apexS })),
        }
      : null;
  const bounds = buildBounds(trail, track, opts);
  const content = buildBounds(trail, track, opts, false);
  let peakAngle = 0;
  for (const s of segments) if (s.peakAngle > peakAngle) peakAngle = s.peakAngle;
  // The session headline describes the RUN, not its single biggest spike: one 71° save used to
  // make a whole session read "spin". Use the 90th percentile of |β| while drifting, which is
  // what the driving actually looked like.
  const driftAngles: number[] = [];
  for (let k = 0; k < trail.n; k++) if (trail.segmentOf[k] >= 0) driftAngles.push(Math.abs(trail.beta[k]));
  driftAngles.sort((a, b) => a - b);
  const typicalAngle = driftAngles.length ? driftAngles[Math.min(driftAngles.length - 1, Math.floor(driftAngles.length * 0.9))] : 0;
  // THE ONE VERDICT LEFT, and it is the integrity monitor's. It used to be read from two places
  // at once — `SessionScore.trusted` and `SessionIntegrity.scoreTrusted`, either saying no being
  // enough — because a scored object must never be separated from the verdict on whether it may
  // be shown. The score is gone; the monitor is not, and its answer is the same answer it always
  // was: whether a phone waved in a parked car is about to be presented as a drive.
  const trusted = session.integrity?.scoreTrusted !== false;
  return {
    t0,
    durationS,
    bounds,
    content,
    trail,
    segments,
    smoke,
    markers,
    events,
    laps,
    ghost,
    telemetry,
    highlights,
    track,
    gapWindows,
    info: {
      name: session.name ?? '',
      trusted,
      driftCount: segments.length,
      peakAngle,
      typicalAngle,
      maxSpeed: telemetry.maxSpeed,
      severity: severityOf(typicalAngle),
    },
    warnings,
    options: opts,
  };
}
