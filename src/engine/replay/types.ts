/**
 * Replay scene model — DATA, not pixels.
 *
 * `buildReplay(session)` turns a Session into a compact, renderer-agnostic scene description:
 * a 20 Hz trail, glow segments, smoke particles, markers, events, a ghost of the best lap and a
 * 10 Hz telemetry strip. The Skia renderer in the app and the SVG renderer in the harness both
 * draw exactly this data, so what the critic sees on Linux is what the phone shows.
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
  /**
   * How the ghost is placed. `distance` (default) puts it where the reference lap was at the
   * same distance into the lap: it stays beside you showing the line through this corner.
   * `time` puts it where that lap was at the same elapsed time: a car to chase, which is more
   * dramatic but is off screen whenever the laps differ by more than a second or two.
   * Either way `gapS` / `gapPoints` report the same delta.
   */
  ghostSync: 'distance' | 'time';
  /** Fallback points rate (pts/s at intensity 1) when the session has no per-drift score. */
  fallbackPointsPerS: number;
  /** Trim leading/trailing dead air (parked car) to this many seconds. */
  deadAirS: number;
  /**
   * A gap between usable GPS fixes longer than this is a DROPOUT: positions through it were
   * dead-reckoned, not measured. Both renderers dash those stretches from `trail.measured` /
   * `gapWindows` instead of each inventing a rule from `session.gps`.
   */
  gpsGapS: number;
  /** A fix with worse horizontal accuracy than this does not count as a measurement, metres. */
  gpsMaxHAccM: number;
  /** How long before a highlight's peak to cue playback, seconds (see `ReplayHighlight.cueT`). */
  highlightLeadS: number;
}

export interface ReplayBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * How dramatic the current slide is. Bands are absolute so the renderer's colour ramp,
 * shake and smoke rate mean the same thing in every session:
 *   none    |β| < 8°     not sliding
 *   hold    8–25°        a controlled drift
 *   big     25–40°       committed
 *   extreme 40–65°       ember → gold territory, the money shot
 *   spin    ≥ 65°        about to be a spin; red
 */
export type DriftSeverity = 'none' | 'hold' | 'big' | 'extreme' | 'spin';

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
  /** Signed slip angle, radians, wrapped to (-π, π]. */
  beta: Float64Array;
  /** m/s. */
  speed: Float64Array;
  /** Cumulative points at this sample. */
  score: Float64Array;
  /** Score multiplier in force at this sample (1 when not drifting). */
  multiplier: Float32Array;
  /** Points banked in the CURRENT chain at this sample (0 when not drifting). */
  chain: Float32Array;
  /** Distance travelled since replay start, metres. */
  dist: Float64Array;
  /** Glow intensity 0..1 from |β| (intensityLo → 0, intensityHi → 1). */
  intensity: Float32Array;
  /** Index of the segment containing this sample, or -1. */
  segmentOf: Int16Array;
  /** Lap index containing this sample, or -1 when the session has no laps / outside laps. */
  lapOf: Int16Array;
  /**
   * 1 where the position was MEASURED (a usable GPS fix brackets this sample), 0 where it was
   * dead-reckoned through a dropout. The trail is continuous either way — the estimator fills
   * the gap — so without this mask a renderer cannot tell a real corner from a guessed one, and
   * two renderers inventing their own heuristics will disagree about where the data was real.
   */
  measured: Uint8Array;
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
  /**
   * Peak |β| (rad) as the DETECTOR measured it (`DriftEvent.peakAngle`) — the number the results
   * screen prints, so the two screens cannot disagree about the same slide. On a noisy mount the
   * raw trail runs a few degrees above it; that maximum is `samplePeakAngle`, for the colour ramp
   * only, because it is a rendering detail rather than a claim about the drive.
   */
  peakAngle: number;
  /** Largest |β| on the trail inside this drift. Colour/width ramp only — never printed. */
  samplePeakAngle: number;
  peakT: number;
  peakIndex: number;
  /** Severity band of `peakAngle`. */
  severity: DriftSeverity;
  /**
   * The detector's verdict: this drift ended in a spin (`DriftEvent.spin`), not a controlled
   * exit. Carried through rather than re-derived from an angle band, because the band is a
   * rendering threshold and the flag is the engine's assertion — see the doc on `DriftEvent.spin`
   * in src/engine/types.ts for what happens when a renderer guesses instead.
   */
  spin: boolean;
  /**
   * True when this drift's points never reached the bank because a spin took the chain
   * (the scorer's chain rule, replayed here from `DriftEvent.spin` and the drift times).
   * `points` is then 0 and `grossPoints` is what the slide would have been worth.
   */
  lost: boolean;
  /** +1 right-hand drift (β>0) at initiation, −1 left. */
  initialDirection: 1 | -1;
  transitions: number;
  /** Points this drift actually BANKED (0 when `lost`), which is what the running total adds. */
  points: number;
  /** Points the drift earned before the chain rule was applied (equals `points` when kept). */
  grossPoints: number;
  /** Lap index this drift starts in, or -1. */
  lapIndex: number;
}

/** A tyre-smoke puff. Position/size/opacity at a later time come from `smokeAt()`. */
export interface SmokeParticle {
  /** Replay-relative birth time, s. */
  birthT: number;
  /** Emission point (rear axle, one tyre), metres. */
  x: number;
  y: number;
  /** Initial velocity, m/s (opposite to the travel direction plus lateral spread). */
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
  /** Deterministic 0..1 per-particle randomness: turbulence phase, rotation, size variance. */
  seed: number;
  /** 0..1 how hot the rubber was: 1 = white-hot fresh smoke, 0 = cold grey dust. */
  heat: number;
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
  /** Lap this marker belongs to, or -1. Renderers use it to retire previous laps' markers. */
  lapIndex: number;
  /** Draw priority for screen-space label de-confliction (higher wins). */
  priority: number;
  driftId?: number;
  /** Peak |β| in radians for drift-peak markers. */
  peakAngle?: number;
  /** Severity band for drift-peak markers. */
  severity?: DriftSeverity;
  /** Points for drift-end markers. */
  points?: number;
}

/**
 * A timed dramatic beat the renderer animates: the SAME data drives the Skia app and the SVG
 * harness, so their motion cannot diverge. `magnitude` 0..1 scales the effect (shake, slam).
 */
export type ReplayEventKind = 'entry' | 'transition' | 'peak' | 'exit' | 'lap' | 'finish' | 'spin';

export interface ReplayEvent {
  kind: ReplayEventKind;
  /** Replay-relative seconds at which the beat fires. */
  t: number;
  /** How long the callout holds before it fades, s. */
  holdS: number;
  /** 0..1 dramatic weight: drives shake amplitude, slam scale and glow bloom. */
  magnitude: number;
  /** Higher wins when two beats overlap. */
  priority: number;
  /** Uppercase callout text, or '' for beats with no callout. */
  label: string;
  /** Points this beat awards, if any (for the odometer). */
  points?: number;
  driftId?: number;
  lapIndex: number;
}

/** An event with its animation phase resolved at a given time (see `activeEvents`). */
export interface ActiveEvent extends ReplayEvent {
  /** Seconds since the beat fired. */
  age: number;
  /** 0..1 through hold+fade. */
  progress: number;
  /** Callout scale: slams 1.8 → 1.0 with overshoot (DESIGN.md motion language). */
  scale: number;
  /** 0..1 callout opacity. */
  opacity: number;
  /** 0..1 screen-shake envelope (decays over 100–200 ms). */
  shake: number;
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
  /** True for the lap the ghost replays (best points). */
  best: boolean;
  /** True for the quickest lap. */
  fastest: boolean;
  /** Which lap the ghost shows while THIS lap is being watched (never itself), or -1. */
  ghostRef: number;
}

/** The best lap re-sampled on lap-relative time τ ∈ [0, durationS] at the trail rate. */
export interface ReplayGhost {
  lapIndex: number;
  /** Replay-relative start/end of the best lap. */
  startT: number;
  endT: number;
  durationS: number;
  points: number;
  /** What made this lap the reference. The renderer labels the gap accordingly. */
  criterion: 'points' | 'time';
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
  /** Points scored since lap start. */
  points_: Float64Array;
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

/** A moment worth jumping to (results screen / share). Sorted by score, best first. */
export interface ReplayHighlight {
  /** The moment itself: the peak of the drift. */
  t: number;
  /**
   * Where playback should START to see this moment. `inT` is the beginning of the whole drift,
   * which on a long chain is half a minute of run-up before anything happens; `cueT` is the
   * run-in to the peak, so "jump to the best moment" lands on the moment.
   */
  cueT: number;
  /** Seconds before/after `t` worth playing. */
  inT: number;
  outT: number;
  label: string;
  kind: 'peak' | 'chain' | 'transition';
  driftId?: number;
  points: number;
  peakAngle: number;
}

export interface Replay {
  /** Session-clock seconds corresponding to replay time 0. */
  t0: number;
  durationS: number;
  /** Padded extent of everything drawable — what the minimap and the culler use. */
  bounds: ReplayBounds;
  /**
   * The extent of the ACTION: the driven line plus the track, with no padding. The overview
   * camera frames this, so a circuit fills the shot instead of floating inside a margin.
   */
  content: ReplayBounds;
  trail: ReplayTrail;
  segments: ReplaySegment[];
  smoke: SmokeParticle[];
  markers: ReplayMarker[];
  events: ReplayEvent[];
  laps: ReplayLap[];
  ghost: ReplayGhost | null;
  telemetry: ReplayTelemetry;
  highlights: ReplayHighlight[];
  /** Track centre-line (metres) when the session has a track model, for drawing the road. */
  track: {
    path: Array<{ x: number; y: number }>;
    closed: boolean;
    gate?: { ax: number; ay: number; bx: number; by: number };
    corners: Array<{ x: number; y: number; direction: 1 | -1; radiusM: number; apexS: number }>;
  } | null;
  /** Session summary for HUD chrome. */
  info: {
    name: string;
    /**
     * Whether the run's score may be presented as an achievement (mirrors
     * `SessionIntegrity.scoreTrusted`). When false the engine refused to publish the run.
     */
    trusted: boolean;
    /**
     * Headline score and grade — NULL when `trusted` is false, so a renderer cannot print an
     * untrusted total by forgetting to check. Show `untrustedMessage` instead. (The raw
     * timeline in `trail.score` is still present: it is the shape of the run, not a claim
     * about it, and the scrubber needs it.)
     */
    totalPoints: number | null;
    grade: string | null;
    /** Driver-facing reason the score is withheld. Empty when trusted. */
    untrustedMessage: string;
    driftCount: number;
    /** The single biggest |β| of the session, radians. */
    peakAngle: number;
    /** 90th percentile of |β| while drifting — what the run actually looked like. */
    typicalAngle: number;
    maxSpeed: number;
    /** Band of `typicalAngle`, so one spike does not relabel a whole session. */
    severity: DriftSeverity;
  };
  /**
   * Stretches where the position was dead-reckoned through a GPS dropout, replay-relative
   * seconds. Derived once, here, from `session.gps` — renderers draw these dashed rather than
   * each deriving their own windows with their own threshold.
   */
  gapWindows: Array<{ startT: number; endT: number }>;
  /** Non-fatal data problems found while building (bad timestamps, missing positions…). */
  warnings: string[];
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
  /** Score multiplier in force. */
  multiplier: number;
  /** Points banked in the current chain. */
  chain: number;
  phase: 'idle' | 'drifting';
  /** 0..1 glow intensity from |β|. */
  intensity: number;
  /** Absolute drama band from |β| — drives colour, shake and smoke rate. */
  severity: DriftSeverity;
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
  /** The reference lap's own elapsed time at this point of the lap, s. */
  tau: number;
  /** Which lap the ghost is replaying. Never the lap being watched. */
  lapIndex: number;
  /** How far the car is off the reference line here, metres (the ghost is distance-synced). */
  gapM: number;
  /**
   * TRUE time gap in seconds: how much earlier (+, car ahead) or later (−) the car reached
   * this point than the reference lap did. Computed by inverting that lap's distance→time
   * curve, so it does not flicker with instantaneous speed.
   */
  gapS: number;
  /** Points the car is ahead (+) / behind (−) the ghost at the same point of the lap. */
  gapPoints: number;
  /** True while the car is still within the reference lap's distance. */
  inLap: boolean;
  /** How this pose was placed (see `ReplayOptions.ghostSync`). */
  sync: 'distance' | 'time';
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
  /** 0..1 white-hot → grey. */
  heat: number;
  /** Rotation for a non-circular sprite, radians. */
  rotation: number;
  /** 0..1 per-particle randomness, carried through from the particle. */
  seed: number;
}
