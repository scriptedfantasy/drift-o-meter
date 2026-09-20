import { clamp, degToRad, wrapAngle, type DriftEvent, type Session, type SlipState, type StyleCallout } from '../types';
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
  fallbackPointsPerS: 100,
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
 * The callout for a drift's peak. The spin band gets its own word AND its magnitude, so a 70°
 * save and a 93° one never read the same. One rule, used by the builder and by any tool that
 * rewrites a peak.
 */
export function peakCallout(severity: DriftSeverity, peakAngle: number): string {
  if (severity !== 'spin') return 'BIG ANGLE';
  return `SAVED IT ${Math.round((Math.abs(peakAngle) * 180) / Math.PI)}\u00b0`;
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

const fin = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

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
    x[k] = havePos ? lastX : 0;
    y[k] = havePos ? lastY : 0;
    // angles interpolate on the shortest arc — β too: a slide through ±π must not read as 0°
    lastHeading = heading[k] = pickAngle(a.heading, b.heading, f, lastHeading);
    lastCourse = course[k] = pickAngle(a.course, b.course, f, lastCourse);
    lastBeta = beta[k] = pickAngle(a.beta, b.beta, f, lastBeta);
    lastSpeed = speed[k] = Math.max(0, pick(a.speed, b.speed, f, lastSpeed));
    intensity[k] = intensityOf(beta[k], opts);
  }
  if (badPos > 0) warnings.push(badPos === n ? 'no usable positions in this session (SIGNAL LOST)' : `${badPos} trail samples had no usable position`);
  if (badScalar > 0) warnings.push(`${badScalar} trail samples were affected by a non-finite speed/angle input and were held steady`);
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
    score: new Float64Array(n),
    multiplier: new Float32Array(n).fill(1),
    chain: new Float32Array(n),
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
    warnings.push(`${windows.length} GPS dropout${windows.length === 1 ? '' : 's'} totalling ${lost.toFixed(1)} s were dead-reckoned`);
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
    laps.push({ index: lap.index, startT, endT, durationS: endT - startT, startIndex, endIndex, points: 0, best: false, fastest: false, ghostRef: -1 });
  }
  laps.sort((a, b) => a.startT - b.startT);
  for (let li = 0; li < laps.length; li++) {
    const lap = laps[li];
    for (let k = lap.startIndex; k <= lap.endIndex; k++) if (trail.lapOf[k] < 0) trail.lapOf[k] = li;
  }
  return laps;
}

function driftPoints(session: Session, d: DriftEvent, trail: ReplayTrail, startIndex: number, endIndex: number, opts: ReplayOptions): { total: number; callouts: StyleCallout[] } {
  const ds = session.score?.perDrift?.[d.id];
  if (ds && Number.isFinite(ds.total) && ds.total > 0) return { total: ds.total, callouts: ds.callouts ?? [] };
  let pts = 0;
  for (let k = startIndex; k <= endIndex; k++) {
    pts += (opts.fallbackPointsPerS * clamp(Math.abs(trail.beta[k]) / degToRad(30), 0, 1.5)) / trail.hz;
  }
  return { total: Math.round(pts), callouts: [] };
}

function buildSegments(session: Session, t0: number, trail: ReplayTrail, durationS: number, opts: ReplayOptions): ReplaySegment[] {
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
    const { total } = driftPoints(session, d, trail, startIndex, endIndex, opts);
    const peakT = Number.isFinite(d.peakAngleT) && d.peakAngleT >= d.startT && d.peakAngleT <= d.endT ? d.peakAngleT - t0 : trail.t[peakIndex];
    const peakAngle = Math.max(peak, Number.isFinite(d.peakAngle) ? d.peakAngle : 0);
    segments.push({
      driftId: d.id,
      startIndex,
      endIndex,
      startT,
      endT,
      durationS: endT - startT,
      intensity,
      peakAngle,
      peakT,
      peakIndex,
      severity: severityOf(peakAngle),
      initialDirection: firstSign !== 0 ? firstSign : d.initialDirection === -1 ? -1 : 1,
      transitions: Math.max(transitions, d.transitions | 0),
      points: total,
      lapIndex: trail.lapOf[startIndex],
    });
  }
  return segments;
}

/**
 * Cumulative score, multiplier and chain along the trail. Each drift's points accrue with
 * weight (0.15 + intensity); callout bonuses step in at their time.
 */
function fillScore(session: Session, t0: number, trail: ReplayTrail, segments: ReplaySegment[]): void {
  const inc = new Float64Array(trail.n);
  for (const seg of segments) {
    const ds = session.score?.perDrift?.[seg.driftId];
    const callouts = ds?.callouts ?? [];
    const mult = ds && Number.isFinite(ds.multiplier) && ds.multiplier > 0 ? ds.multiplier : 1 + 0.5 * seg.transitions;
    let bonus = 0;
    for (const c of callouts) if (Number.isFinite(c.points) && c.points > 0) bonus += c.points;
    const base = Math.max(0, seg.points - bonus);
    let wsum = 0;
    for (let k = seg.startIndex; k <= seg.endIndex; k++) wsum += 0.15 + trail.intensity[k];
    if (wsum > 0) {
      for (let k = seg.startIndex; k <= seg.endIndex; k++) inc[k] += (base * (0.15 + trail.intensity[k])) / wsum;
    }
    for (const c of callouts) {
      if (!(Number.isFinite(c.points) && c.points > 0)) continue;
      const tc = clamp(Number.isFinite(c.t) ? c.t - t0 : seg.startT, seg.startT, seg.endT);
      const k = clamp(Math.round(tc * trail.hz), seg.startIndex, seg.endIndex);
      inc[k] += c.points;
    }
    // multiplier ramps with the transitions banked so far inside this drift
    let done = 0;
    let lastStrong: 1 | -1 | 0 = 0;
    for (let k = seg.startIndex; k <= seg.endIndex; k++) {
      const ab = Math.abs(trail.beta[k]);
      if (ab > degToRad(8)) {
        const sg: 1 | -1 = trail.beta[k] > 0 ? 1 : -1;
        if (lastStrong !== 0 && sg !== lastStrong) done++;
        lastStrong = sg;
      }
      trail.multiplier[k] = Math.max(1, Math.min(mult, 1 + (mult - 1) * (seg.transitions > 0 ? done / seg.transitions : 1)));
    }
  }
  let acc = 0;
  for (let k = 0; k < trail.n; k++) {
    acc += inc[k];
    trail.score[k] = acc;
  }
  for (const seg of segments) {
    const at0 = trail.score[seg.startIndex];
    for (let k = seg.startIndex; k <= seg.endIndex; k++) trail.chain[k] = trail.score[k] - at0;
  }
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

/**
 * Score text, one rule for every renderer. No thousands separator below six digits: a space is
 * ~74 % of a digit width, so "7 273" parses as two numbers at arm's length — and Barlow has no
 * thin-space glyph, so a renderer that substitutes one gets a full-width gap.
 */
export function formatPoints(p: number): string {
  const v = Math.round(Number.isFinite(p) ? p : 0);
  const a = Math.abs(v);
  return (v < 0 ? '-' : '') + (a < 100000 ? String(a) : a.toLocaleString('en-US'));
}

const MARKER_PRIORITY: Record<string, number> = { 'drift-peak': 40, transition: 30, 'drift-end': 20, lap: 15, 'drift-start': 10 };

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
        push({ kind: 'transition', t: tz, ...poseFields(trail, tz), label: n > 1 ? `TRANSITION x${n}` : 'TRANSITION', driftId: seg.driftId });
      }
      lastStrong = sg;
      lastStrongIdx = k;
    }
    push({ kind: 'drift-end', t: seg.endT, ...poseFields(trail, seg.endT), label: `+${formatPoints(seg.points)}`, driftId: seg.driftId, points: seg.points });
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
 * The dramatic beats, in time order. Both renderers animate from this so the app and the
 * harness cannot diverge (DESIGN.md motion language: slam 1.8 → 1.0, shake on transitions).
 */
function buildEvents(trail: ReplayTrail, segments: ReplaySegment[], laps: ReplayLap[], markers: ReplayMarker[]): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  const maxPoints = Math.max(1, ...segments.map((s) => s.points));
  for (const seg of segments) {
    const mag = clamp(seg.peakAngle / SEVERITY_EDGES.spin, 0.2, 1);
    events.push({ kind: 'entry', t: seg.startT, holdS: 0.6, magnitude: 0.45 * mag, priority: 20, label: '', driftId: seg.driftId, lapIndex: seg.lapIndex });
    if (seg.severity === 'extreme' || seg.severity === 'spin') {
      events.push({
        kind: seg.severity === 'spin' ? 'spin' : 'peak',
        t: seg.peakT,
        holdS: 1.1,
        magnitude: mag,
        priority: seg.severity === 'spin' ? 90 : 60,
        label: peakCallout(seg.severity, seg.peakAngle),
        driftId: seg.driftId,
        lapIndex: seg.lapIndex,
      });
    }
    events.push({
      kind: 'exit',
      t: seg.endT,
      holdS: 1.3,
      magnitude: clamp(seg.points / maxPoints, 0.25, 1),
      priority: 50,
      label: `+${formatPoints(seg.points)}`,
      points: seg.points,
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

function buildHighlights(trail: ReplayTrail, segments: ReplaySegment[], lead: number): ReplayHighlight[] {
  const out: ReplayHighlight[] = [];
  for (const seg of segments) {
    const kind: ReplayHighlight['kind'] = seg.transitions >= 2 ? 'chain' : seg.severity === 'extreme' || seg.severity === 'spin' ? 'peak' : 'transition';
    const inT = Math.max(0, seg.startT - 1);
    out.push({
      t: seg.peakT,
      // land on the moment, not on the run-up: a three-link chain starts 25 s before its peak
      cueT: Math.max(inT, seg.peakT - lead),
      inT,
      outT: Math.min(trail.t[trail.n - 1], seg.endT + 1.2),
      label: seg.transitions >= 2 ? `${seg.transitions}-LINK CHAIN` : `${Math.round((seg.peakAngle * 180) / Math.PI)}° · ${formatPoints(seg.points)} PTS`,
      kind,
      driftId: seg.driftId,
      points: seg.points,
      peakAngle: seg.peakAngle,
    });
  }
  out.sort((a, b) => b.points + b.peakAngle * 1000 - (a.points + a.peakAngle * 1000));
  return out;
}

/**
 * Re-parameterise one lap on lap-relative time τ. Used for the ghost: `ghostPoseAt` compares
 * the lap being watched against a DIFFERENT lap (never itself — a ghost that is the car is a
 * rendering glitch, not a ghost).
 */
function sampleLap(trail: ReplayTrail, lap: ReplayLap, criterion: 'points' | 'time'): ReplayGhost {
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
  const points_ = new Float64Array(n);
  const d0 = trailValueAt(trail, trail.dist, lap.startT);
  const p0 = trailValueAt(trail, trail.score, lap.startT);
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
    points_[k] = trailValueAt(trail, trail.score, t) - p0;
  }
  return { lapIndex: lap.index, startT: lap.startT, endT: lap.endT, durationS: lap.durationS, points: lap.points, criterion, n, hz, tau, x, y, heading, course, beta, speed, dist, points_ };
}

/**
 * Choose the reference lap and, for every lap, which OTHER lap its ghost shows.
 * Returns the primary ghost (the best lap) or null.
 */
function buildGhost(trail: ReplayTrail, laps: ReplayLap[], closed: boolean, durationS: number, opts: ReplayOptions): ReplayGhost | null {
  for (const lap of laps) lap.points = trailValueAt(trail, trail.score, lap.endT) - trailValueAt(trail, trail.score, lap.startT);
  if (!opts.ghost || !closed) return null;
  const complete = laps.filter((l) => l.endT <= durationS + 1e-6 && l.durationS > 5);
  if (complete.length < 2) return null;
  const better = (a: ReplayLap, b: ReplayLap) => a.points > b.points + 1e-9 || (Math.abs(a.points - b.points) <= 1e-9 && a.durationS < b.durationS);
  let best = complete[0];
  let fastest = complete[0];
  for (const lap of complete) {
    if (better(lap, best)) best = lap;
    if (lap.durationS < fastest.durationS) fastest = lap;
  }
  best.best = true;
  fastest.fastest = true;
  // every lap's ghost is the best of the OTHER laps, so the ghost is never the car itself
  for (const lap of laps) {
    let ref: ReplayLap | null = null;
    for (const other of complete) {
      if (other.index === lap.index) continue;
      if (!ref || better(other, ref)) ref = other;
    }
    lap.ghostRef = ref ? ref.index : -1;
  }
  return sampleLap(trail, best, 'points');
}

function buildTelemetry(trail: ReplayTrail, durationS: number, opts: ReplayOptions): ReplayTelemetry {
  const hz = opts.telemetryHz;
  const n = Math.max(2, Math.round(durationS * hz) + 1);
  const t = new Float64Array(n);
  const speed = new Float32Array(n);
  const angle = new Float32Array(n);
  const beta = new Float32Array(n);
  const points = new Float32Array(n);
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
    points[k] = trailValueAt(trail, trail.score, tk);
    drifting[k] = trail.segmentOf[Math.round(trailIndexOf(trail, tk))] >= 0 ? 1 : 0;
    if (speed[k] > maxSpeed) maxSpeed = speed[k];
    if (angle[k] > maxAngle) maxAngle = angle[k];
  }
  return { n, hz, t, speed, angle, beta, points, drifting, maxSpeed, maxAngle, maxPoints: points[n - 1] };
}

function buildBounds(trail: ReplayTrail, track: Replay['track'], opts: ReplayOptions): ReplayBounds {
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
  const pad = Math.max(opts.paddingM, 0.05 * Math.max(maxX - minX, maxY - minY));
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

/**
 * First/last times worth watching: the replay must not open on a parked car, nor keep rolling
 * for twenty seconds after the chequered flag. On a closed circuit it ends just after the last
 * lap's finish so the FINISH beat and the grade land on the final frame.
 */
function activeWindow(session: Session, src: SourceSample[], opts: ReplayOptions): { start: number; end: number } {
  const moving = (s: SourceSample) => Number.isFinite(s.speed) && s.speed > 1.5;
  let i = 0;
  while (i < src.length && !moving(src[i])) i++;
  let j = src.length - 1;
  while (j > i && !moving(src[j])) j--;
  if (i >= j) return { start: src[0].t, end: src[src.length - 1].t };
  const start = Math.max(src[0].t, src[i].t - opts.deadAirS);
  let end = Math.min(src[src.length - 1].t, src[j].t + opts.deadAirS);
  const laps = session.track?.laps ?? [];
  if (session.track?.closed && laps.length > 0) {
    const finish = Math.max(...laps.map((l) => (Number.isFinite(l.endT) ? l.endT : -Infinity)));
    if (Number.isFinite(finish) && finish > start + 5) end = Math.min(end, finish + 2.5);
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
      info: { name: session.name ?? '', trusted: false, totalPoints: null, grade: null, untrustedMessage: 'No usable data in this session', driftCount: 0, peakAngle: 0, typicalAngle: 0, maxSpeed: 0, severity: 'none' },
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
  const segments = buildSegments(session, t0, trail, durationS, opts);
  fillScore(session, t0, trail, segments);
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
  let peakAngle = 0;
  for (const s of segments) if (s.peakAngle > peakAngle) peakAngle = s.peakAngle;
  // The session headline describes the RUN, not its single biggest spike: one 71° save used to
  // make a whole session read "spin". Use the 90th percentile of |β| while drifting, which is
  // what the driving actually looked like.
  const driftAngles: number[] = [];
  for (let k = 0; k < trail.n; k++) if (trail.segmentOf[k] >= 0) driftAngles.push(Math.abs(trail.beta[k]));
  driftAngles.sort((a, b) => a - b);
  const typicalAngle = driftAngles.length ? driftAngles[Math.min(driftAngles.length - 1, Math.floor(driftAngles.length * 0.9))] : 0;
  const rawTotal = session.score && Number.isFinite(session.score.total) && session.score.total > 0 ? session.score.total : trail.score[trail.n - 1];
  // `SessionScore.trusted` mirrors `SessionIntegrity.scoreTrusted`; either saying no means the
  // run may not be presented as an achievement, so the headline is null rather than merely
  // flagged — a renderer cannot print it by forgetting to look.
  const trusted = session.score?.trusted !== false && session.integrity?.scoreTrusted !== false;
  const untrustedMessage = trusted ? '' : (session.integrity?.message ?? '').trim() || 'This run was not believed well enough to score';
  return {
    t0,
    durationS,
    bounds,
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
      totalPoints: trusted ? fin(rawTotal) : null,
      grade: trusted ? (session.score?.grade ?? 'D') : null,
      untrustedMessage,
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
