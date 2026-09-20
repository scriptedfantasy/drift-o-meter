/**
 * Replay scene model — DATA, not pixels.
 *
 * `buildReplay(session)` turns a Session into a compact, renderer-agnostic scene description:
 * a 20 Hz trail, glow segments, smoke particles, markers, a ghost of the best lap and a 10 Hz
 * telemetry strip. The Skia renderer in the app and the SVG renderer in the harness both draw
 * exactly this data, so what the critic sees on Linux is what the phone shows.
 *
 * TIME CONVENTION: every time in a Replay is REPLAY-RELATIVE seconds (0 = first trail sample).
 * `Replay.t0` is the session-clock time of replay time 0, so `sessionT = t0 + replayT`.
 * Angles follow src/engine/types.ts (math convention, radians, β = course − heading).
 */

export interface ReplayOptions {
  /** Trail sample rate, Hz. */
  trailHz: number;
  /** Telemetry strip sample rate, Hz. */
  telemetryHz: number;
  /** Bounds padding, metres (at least this; also ≥ 5 % of the extent). */
  paddingM: number;
  /** Car geometry used for the smoke emitter and marker placement. */
  carLengthM: number;
  carWidthM: number;
  /** Smoke emitter: interval between puffs, |β| threshold (rad), particle life (s). */
  smokeIntervalS: number;
  smokeBetaThreshold: number;
  smokeLifeS: number;
  /** |β| (rad) that maps to glow intensity 0 and 1. */
  intensityLo: number;
  intensityHi: number;
  /** Build the best-lap ghost when the session is a closed circuit with ≥ 2 laps. */
  ghost: boolean;
  /** Fallback points rate (pts/s at intensity 1) when the session has no per-drift score. */
  fallbackPointsPerS: number;
}

export interface ReplayBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The car's path resampled at `hz`, as typed arrays (all length `n`). */
export interface ReplayTrail {
  n: number;
  hz: number;
  /** Replay-relative seconds. */
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
  /** Math-convention radians, wrapped to (-π, π]. */
  heading: Float64Array;
  course: Float64Array;
  /** Signed slip angle, radians. */
  beta: Float64Array;
  /** m/s. */
  speed: Float64Array;
  /** Cumulative points at this sample. */
  score: Float64Array;
  /** Distance travelled since replay start, metres. */
  dist: Float64Array;
  /** Glow intensity 0..1 from |β| (intensityLo → 0, intensityHi → 1). */
  intensity: Float32Array;
  /** Index of the segment containing this sample, or -1. */
  segmentOf: Int16Array;
  /** Lap index containing this sample, or -1 when the session has no laps / outside laps. */
  lapOf: Int16Array;
}

/** One contiguous drifting run (from a DriftEvent) mapped onto trail samples. */
export interface ReplaySegment {
  driftId: number;
  /** Inclusive trail index range. */
  startIndex: number;
  endIndex: number;
  /** Replay-relative seconds. */
  startT: number;
  endT: number;
  durationS: number;
  /** Per-sample intensity 0..1 for the samples startIndex..endIndex (length endIndex-startIndex+1). */
  intensity: Float32Array;
  /** Peak |β| (rad), when (replay s) and which trail index. */
  peakAngle: number;
  peakT: number;
  peakIndex: number;
  /** +1 right-hand drift (β>0) at initiation, −1 left. */
  initialDirection: 1 | -1;
  transitions: number;
  /** Points awarded for this drift (score total, or the fallback estimate). */
  points: number;
}

/** A tyre-smoke puff. Position/size/opacity at a later time come from `smokeAt()`. */
export interface SmokeParticle {
  /** Replay-relative birth time, s. */
  birthT: number;
  /** Emission point (rear axle, one tyre), metres. */
  x: number;
  y: number;
  /** Initial velocity, m/s (opposite to the travel direction plus a little lateral spread). */
  vx: number;
  vy: number;
  /** Initial radius, metres. */
  size: number;
  /** Lifetime, s. */
  life: number;
  /** Emission strength 0..1 (from drift intensity) — scales opacity. */
  strength: number;
  /** +1 left rear tyre, −1 right rear tyre. */
  side: 1 | -1;
}

export type ReplayMarkerKind = 'drift-start' | 'drift-peak' | 'drift-end' | 'transition' | 'lap';

export interface ReplayMarker {
  kind: ReplayMarkerKind;
  /** Replay-relative seconds. */
  t: number;
  x: number;
  y: number;
  heading: number;
  course: number;
  /** Short HUD label, e.g. "42°", "+1 250", "LAP 2", "TRANSITION". */
  label: string;
  driftId?: number;
  lapIndex?: number;
  /** Peak |β| in radians for drift-peak markers. */
  peakAngle?: number;
  /** Points for drift-end markers. */
  points?: number;
}

export interface ReplayLap {
  index: number;
  /** Replay-relative seconds. */
  startT: number;
  endT: number;
  durationS: number;
  /** Inclusive trail index range. */
  startIndex: number;
  endIndex: number;
  /** Points scored inside this lap (cumulative score at end − at start). */
  points: number;
  /** True for the lap the ghost replays. */
  best: boolean;
}

/** The best lap re-sampled on lap-relative time τ ∈ [0, durationS] at the trail rate. */
export interface ReplayGhost {
  lapIndex: number;
  /** Replay-relative start/end of the best lap. */
  startT: number;
  endT: number;
  durationS: number;
  points: number;
  n: number;
  hz: number;
  /** Lap-relative time τ. */
  tau: Float64Array;
  x: Float64Array;
  y: Float64Array;
  heading: Float64Array;
  course: Float64Array;
  beta: Float64Array;
  speed: Float64Array;
  /** Distance since lap start, metres. */
  dist: Float64Array;
}

export interface ReplayTelemetry {
  n: number;
  hz: number;
  t: Float64Array;
  speed: Float32Array;
  /** |β| in radians. */
  angle: Float32Array;
  /** Signed β in radians. */
  beta: Float32Array;
  /** Cumulative points. */
  points: Float32Array;
  /** 1 while inside a drift segment. */
  drifting: Uint8Array;
  /** Max values, handy for scaling the strip. */
  maxSpeed: number;
  maxAngle: number;
  maxPoints: number;
}

export interface Replay {
  /** Session-clock seconds corresponding to replay time 0. */
  t0: number;
  durationS: number;
  bounds: ReplayBounds;
  trail: ReplayTrail;
  segments: ReplaySegment[];
  smoke: SmokeParticle[];
  markers: ReplayMarker[];
  laps: ReplayLap[];
  ghost: ReplayGhost | null;
  telemetry: ReplayTelemetry;
  /** Track centre-line (metres) when the session has a track model, for drawing the road. */
  track: { path: Array<{ x: number; y: number }>; closed: boolean; gate?: { ax: number; ay: number; bx: number; by: number } } | null;
  /** Session summary for HUD chrome. */
  info: { name: string; totalPoints: number; grade: string; driftCount: number; peakAngle: number; maxSpeed: number };
  options: ReplayOptions;
}

export interface ReplayPose {
  t: number;
  x: number;
  y: number;
  heading: number;
  course: number;
  beta: number;
  speed: number;
  points: number;
  phase: 'idle' | 'drifting';
  /** 0..1 glow intensity from |β|. */
  intensity: number;
  /** Segment index or -1. */
  segment: number;
  /** Lap index or -1. */
  lap: number;
  /** Distance travelled since replay start, metres. */
  dist: number;
}

export interface GhostPose {
  x: number;
  y: number;
  heading: number;
  course: number;
  beta: number;
  speed: number;
  /** Lap-relative time, s. */
  tau: number;
  /** Metres the CAR is ahead (+) or behind (−) the ghost along the lap. */
  gapM: number;
  /** True while the ghost is still inside its best lap (false once it has crossed the line). */
  inLap: boolean;
}

export interface SmokeState {
  x: number;
  y: number;
  /** Radius, metres. */
  radius: number;
  /** 0..1 */
  opacity: number;
  /** 0..1 */
  age: number;
}
