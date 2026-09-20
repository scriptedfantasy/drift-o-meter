import { clamp, degToRad, wrapAngle, type DriftEvent, type Session, type SlipState, type StyleCallout } from '../types';
import type {
  Replay,
  ReplayBounds,
  ReplayGhost,
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
  intensityHi: degToRad(45),
  ghost: true,
  fallbackPointsPerS: 100,
};

/** Interpolate an angle along the shortest arc. */
export function lerpAngle(a: number, b: number, f: number): number {
  return wrapAngle(a + wrapAngle(b - a) * f);
}

/** |β| → glow intensity 0..1 (intensityLo → 0, intensityHi → 1). */
export function intensityOf(beta: number, opts: ReplayOptions): number {
  return clamp((Math.abs(beta) - opts.intensityLo) / (opts.intensityHi - opts.intensityLo), 0, 1);
}

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
  if (session.states.length >= 2) {
    return session.states.map((s: SlipState) => ({ t: s.t, x: s.x, y: s.y, heading: s.heading, course: s.course, beta: s.beta, speed: s.speed }));
  }
  if (session.truth && session.truth.length >= 2) {
    return session.truth.map((s) => ({ t: s.t, x: s.x, y: s.y, heading: s.heading, course: s.course, beta: s.beta, speed: s.speed }));
  }
  return [];
}

function buildTrail(src: SourceSample[], t0: number, durationS: number, opts: ReplayOptions): ReplayTrail {
  const hz = opts.trailHz;
  const n = Math.max(1, Math.round(durationS * hz) + 1);
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
  // first finite position, so a leading run of invalid samples holds a real point
  for (const s of src) {
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      lastX = s.x;
      lastY = s.y;
      havePos = true;
      break;
    }
  }
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
    }
    x[k] = havePos ? lastX : 0;
    y[k] = havePos ? lastY : 0;
    heading[k] = lerpAngle(a.heading, b.heading, f);
    course[k] = lerpAngle(a.course, b.course, f);
    beta[k] = a.beta + (b.beta - a.beta) * f;
    speed[k] = Math.max(0, a.speed + (b.speed - a.speed) * f);
    intensity[k] = intensityOf(beta[k], opts);
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
    score: new Float64Array(n),
    dist,
    intensity,
    segmentOf: new Int16Array(n).fill(-1),
    lapOf: new Int16Array(n).fill(-1),
  };
}

/** Trail index of replay time t (fractional). */
export function trailIndexOf(trail: ReplayTrail, t: number): number {
  return clamp(t * trail.hz, 0, trail.n - 1);
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
    const startT = clamp(lap.startT - t0, 0, durationS);
    const endT = clamp(lap.endT - t0, 0, durationS);
    if (endT - startT < 1) continue;
    const startIndex = Math.ceil(startT * trail.hz - 1e-6);
    const endIndex = Math.min(trail.n - 1, Math.floor(endT * trail.hz + 1e-6));
    laps.push({ index: lap.index, startT, endT, durationS: endT - startT, startIndex, endIndex, points: 0, best: false });
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
  // fallback: pts/s × angle factor (|β| / 30°, capped at 1.5)
  let pts = 0;
  for (let k = startIndex; k <= endIndex; k++) {
    pts += (opts.fallbackPointsPerS * clamp(Math.abs(trail.beta[k]) / degToRad(30), 0, 1.5)) / trail.hz;
  }
  return { total: Math.round(pts), callouts: [] };
}

function buildSegments(session: Session, t0: number, trail: ReplayTrail, durationS: number, opts: ReplayOptions): ReplaySegment[] {
  const drifts = [...session.drifts].sort((a, b) => a.startT - b.startT);
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
      // samples may be claimed by an earlier overlapping drift; the first one wins
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
    segments.push({
      driftId: d.id,
      startIndex,
      endIndex,
      startT,
      endT,
      durationS: endT - startT,
      intensity,
      peakAngle: Math.max(peak, Number.isFinite(d.peakAngle) ? d.peakAngle : 0),
      peakT,
      peakIndex,
      initialDirection: firstSign !== 0 ? firstSign : d.initialDirection === -1 ? -1 : 1,
      transitions: Math.max(transitions, d.transitions | 0),
      points: total,
    });
  }
  return segments;
}

/** Cumulative score on the trail: each drift's points accrue with weight (0.15 + intensity); callout bonuses step in at their time. */
function fillScore(session: Session, t0: number, trail: ReplayTrail, segments: ReplaySegment[]): void {
  const inc = new Float64Array(trail.n);
  for (const seg of segments) {
    const ds = session.score?.perDrift?.[seg.driftId];
    const callouts = ds?.callouts ?? [];
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
      const tc = clamp(c.t - t0, seg.startT, seg.endT);
      const k = clamp(Math.round(tc * trail.hz), seg.startIndex, seg.endIndex);
      inc[k] += c.points;
    }
    // any bonus we could not place (scores whose total < sum of callouts) still lands at the end
    if (seg.points < bonus) inc[seg.endIndex] += 0;
  }
  let acc = 0;
  for (let k = 0; k < trail.n; k++) {
    acc += inc[k];
    trail.score[k] = acc;
  }
}

function hash01(i: number): number {
  // tiny deterministic hash → [0,1)
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
  const rear = 0.5 * opts.carLengthM;
  const half = 0.5 * opts.carWidthM;
  for (let k = 0; k < trail.n; k++) {
    const t = trail.t[k];
    if (Math.abs(trail.beta[k]) <= opts.smokeBetaThreshold || trail.speed[k] < 1) {
      continue;
    }
    if (t < nextEmit) continue;
    nextEmit = t + opts.smokeIntervalS;
    const h = trail.heading[k];
    const c = trail.course[k];
    const ch = Math.cos(h);
    const sh = Math.sin(h);
    const speed = trail.speed[k];
    const inten = trail.intensity[k];
    // one puff per rear tyre (left = +side along (−sin h, cos h)); the outside tyre of the slide
    // works hardest, so it gets the bigger puff: β>0 means the car travels left of its nose,
    // i.e. the rear is sliding right → the RIGHT rear (side −1) is the outside tyre.
    const outside: 1 | -1 = trail.beta[k] > 0 ? -1 : 1;
    for (const side of [1, -1] as const) {
      const ox = trail.x[k] - rear * ch - side * half * sh;
      const oy = trail.y[k] - rear * sh + side * half * ch;
      const j1 = hash01(emitted * 2) - 0.5;
      const j2 = hash01(emitted * 2 + 1) - 0.5;
      const big = side === outside ? 1 : 0.8;
      // opposite to the travel direction (the tyre leaves the puff behind), plus lateral spread outward from the tyre
      const back = 0.22 * speed * (1 + 0.3 * j1);
      const lateral = side * (0.8 + 0.6 * inten) + 0.6 * j2;
      smoke.push({
        birthT: t,
        x: ox,
        y: oy,
        vx: -back * Math.cos(c) - lateral * sh,
        vy: -back * Math.sin(c) + lateral * ch,
        size: (1.0 + 0.8 * inten) * big,
        life: opts.smokeLifeS,
        strength: (0.45 + 0.55 * inten) * big,
        side,
      });
      emitted++;
    }
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

function fmtPoints(p: number): string {
  return Math.round(p).toLocaleString('en-US').replace(/,/g, ' ');
}

function buildMarkers(trail: ReplayTrail, segments: ReplaySegment[], laps: ReplayLap[], opts: ReplayOptions): ReplayMarker[] {
  const markers: ReplayMarker[] = [];
  for (const seg of segments) {
    markers.push({ kind: 'drift-start', t: seg.startT, ...poseFields(trail, seg.startT), label: 'DRIFT', driftId: seg.driftId });
    const peakDeg = Math.round((seg.peakAngle * 180) / Math.PI);
    markers.push({ kind: 'drift-peak', t: seg.peakT, ...poseFields(trail, seg.peakT), label: `${peakDeg}°`, driftId: seg.driftId, peakAngle: seg.peakAngle });
    // transitions: β sign flips between two strong lobes; marker at the zero crossing
    let lastStrong: 1 | -1 | 0 = 0;
    let lastStrongIdx = seg.startIndex;
    let n = 0;
    for (let k = seg.startIndex; k <= seg.endIndex; k++) {
      const b = trail.beta[k];
      if (Math.abs(b) <= opts.intensityLo) continue;
      const sg: 1 | -1 = b > 0 ? 1 : -1;
      if (lastStrong !== 0 && sg !== lastStrong) {
        // zero crossing between lastStrongIdx and k, interpolated to sub-sample time
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
        markers.push({ kind: 'transition', t: tz, ...poseFields(trail, tz), label: n > 1 ? `TRANSITION x${n}` : 'TRANSITION', driftId: seg.driftId });
      }
      lastStrong = sg;
      lastStrongIdx = k;
    }
    markers.push({ kind: 'drift-end', t: seg.endT, ...poseFields(trail, seg.endT), label: `+${fmtPoints(seg.points)}`, driftId: seg.driftId, points: seg.points });
  }
  for (const lap of laps) {
    markers.push({ kind: 'lap', t: lap.startT, ...poseFields(trail, lap.startT), label: `LAP ${lap.index + 1}`, lapIndex: lap.index });
  }
  const last = laps[laps.length - 1];
  if (last) {
    markers.push({ kind: 'lap', t: last.endT, ...poseFields(trail, last.endT), label: 'FINISH', lapIndex: last.index + 1 });
  }
  markers.sort((a, b) => a.t - b.t);
  return markers;
}

function buildGhost(trail: ReplayTrail, laps: ReplayLap[], closed: boolean, durationS: number, opts: ReplayOptions): ReplayGhost | null {
  if (!opts.ghost || !closed) return null;
  const complete = laps.filter((l) => l.endT <= durationS + 1e-6 && l.durationS > 5);
  if (complete.length < 2) return null;
  for (const lap of laps) lap.points = trailValueAt(trail, trail.score, lap.endT) - trailValueAt(trail, trail.score, lap.startT);
  let best = complete[0];
  for (const lap of complete) {
    if (lap.points > best.points + 1e-9) best = lap;
    else if (Math.abs(lap.points - best.points) <= 1e-9 && lap.durationS < best.durationS) best = lap;
  }
  best.best = true;
  const hz = trail.hz;
  const n = Math.round(best.durationS * hz) + 1;
  const tau = new Float64Array(n);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const heading = new Float64Array(n);
  const course = new Float64Array(n);
  const beta = new Float64Array(n);
  const speed = new Float64Array(n);
  const dist = new Float64Array(n);
  const d0 = trailValueAt(trail, trail.dist, best.startT);
  for (let k = 0; k < n; k++) {
    const tk = k / hz;
    const t = Math.min(best.startT + tk, best.endT);
    tau[k] = tk;
    x[k] = trailValueAt(trail, trail.x, t);
    y[k] = trailValueAt(trail, trail.y, t);
    heading[k] = trailAngleAt(trail, trail.heading, t);
    course[k] = trailAngleAt(trail, trail.course, t);
    beta[k] = trailValueAt(trail, trail.beta, t);
    speed[k] = trailValueAt(trail, trail.speed, t);
    dist[k] = trailValueAt(trail, trail.dist, t) - d0;
  }
  return { lapIndex: best.index, startT: best.startT, endT: best.endT, durationS: best.durationS, points: best.points, n, hz, tau, x, y, heading, course, beta, speed, dist };
}

function buildTelemetry(trail: ReplayTrail, durationS: number, opts: ReplayOptions): ReplayTelemetry {
  const hz = opts.telemetryHz;
  const n = Math.max(1, Math.round(durationS * hz) + 1);
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
    const b = trailValueAt(trail, trail.beta, tk);
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
  for (let k = 0; k < trail.n; k++) {
    if (trail.x[k] < minX) minX = trail.x[k];
    if (trail.x[k] > maxX) maxX = trail.x[k];
    if (trail.y[k] < minY) minY = trail.y[k];
    if (trail.y[k] > maxY) maxY = trail.y[k];
  }
  if (track) {
    for (const p of track.path) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) {
    minX = maxX = minY = maxY = 0;
  }
  const pad = Math.max(opts.paddingM, 0.05 * Math.max(maxX - minX, maxY - minY));
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

/**
 * Build the replay scene for a session. Pure; O(n) in the number of samples.
 * Works from `session.states`, or from `session.truth` when a (simulated) session has no states.
 */
export function buildReplay(session: Session, partial: Partial<ReplayOptions> = {}): Replay {
  const opts: ReplayOptions = { ...DEFAULT_REPLAY_OPTIONS, ...partial };
  const src = sourceSamples(session);
  if (src.length < 2) {
    // an empty session still yields a valid, drawable replay
    const trail = buildTrail([{ t: 0, x: 0, y: 0, heading: 0, course: 0, beta: 0, speed: 0 }, { t: 0.05, x: 0, y: 0, heading: 0, course: 0, beta: 0, speed: 0 }], 0, 0.05, opts);
    const telemetry = buildTelemetry(trail, 0.05, opts);
    return {
      t0: 0,
      durationS: 0.05,
      bounds: buildBounds(trail, null, opts),
      trail,
      segments: [],
      smoke: [],
      markers: [],
      laps: [],
      ghost: null,
      telemetry,
      track: null,
      info: { name: session.name, totalPoints: 0, grade: session.score?.grade ?? 'D', driftCount: 0, peakAngle: 0, maxSpeed: 0 },
      options: opts,
    };
  }
  const t0 = src[0].t;
  const durationS = Math.max(1 / opts.trailHz, src[src.length - 1].t - t0);
  const trail = buildTrail(src, t0, durationS, opts);
  const laps = buildLaps(session, t0, trail, durationS);
  const segments = buildSegments(session, t0, trail, durationS, opts);
  fillScore(session, t0, trail, segments);
  const smoke = buildSmoke(trail, opts);
  const markers = buildMarkers(trail, segments, laps, opts);
  const closed = !!session.track?.closed;
  const ghost = buildGhost(trail, laps, closed, durationS, opts);
  if (!ghost) for (const lap of laps) lap.points = trailValueAt(trail, trail.score, lap.endT) - trailValueAt(trail, trail.score, lap.startT);
  const telemetry = buildTelemetry(trail, durationS, opts);
  const track = session.track && session.track.refPath.length > 1 ? { path: session.track.refPath.map((p) => ({ x: p.x, y: p.y })), closed, gate: session.track.gate } : null;
  const bounds = buildBounds(trail, track, opts);
  let peakAngle = 0;
  for (const s of segments) if (s.peakAngle > peakAngle) peakAngle = s.peakAngle;
  const totalPoints = session.score && Number.isFinite(session.score.total) && session.score.total > 0 ? session.score.total : trail.score[trail.n - 1];
  return {
    t0,
    durationS,
    bounds,
    trail,
    segments,
    smoke,
    markers,
    laps,
    ghost,
    telemetry,
    track,
    info: { name: session.name, totalPoints, grade: session.score?.grade ?? 'D', driftCount: segments.length, peakAngle, maxSpeed: telemetry.maxSpeed },
    options: opts,
  };
}
