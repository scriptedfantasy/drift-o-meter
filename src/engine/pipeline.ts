/**
 * DriftPipeline — wires the engine modules into one object the app talks to.
 *
 *   sensor adapter ──MotionSample──▶ MountCalibrator ──VehicleMotionSample──▶ SlipEstimator ──SlipState──▶
 *   DriftDetector ──DriftEvent/live──▶ LiveScorer ──points/callouts──▶ HUD
 *   GPS ──GpsSample──▶ (calibrator, estimator, integrity)      TrackBuilder / IntegrityMonitor observe.
 *
 * The app only ever sees `LiveFrame`s (at motion rate, ~100 Hz) and the final `Session`.
 * This file holds the public frame types; the implementation lands once the modules do.
 */
import type {
  DriftEvent,
  DriftPhase,
  GpsSample,
  Lap,
  MotionSample,
  MountCalibration,
  Session,
  SlipState,
  StyleCallout,
  TrackModel,
} from './types';

export interface LiveFrame {
  t: number;
  state: SlipState;
  phase: DriftPhase;
  /** The in-progress drift, if any. */
  live: {
    id: number;
    durationS: number;
    /** Signed β in radians. */
    angle: number;
    peakAngle: number;
    direction: 1 | -1;
    transitions: number;
  } | null;
  /** Drift that just completed on this frame, if any. */
  completed: DriftEvent | null;
  score: {
    total: number;
    delta: number;
    multiplier: number;
    chainPoints: number;
    chainActive: boolean;
    banked: boolean;
    lost: boolean;
    /** Callouts fired on this frame. */
    callouts: StyleCallout[];
  };
  calibration: MountCalibration;
  integrity: {
    mount: 'rigid' | 'suspect' | 'loose';
    physics: 'ok' | 'implausible';
    gps: 'good' | 'poor' | 'none';
    message: string;
  };
  lap: { count: number; progress: number; completed: Lap | null };
}

export interface DriftPipelineOptions {
  gpsLatencyS?: number;
}

export interface DriftPipelineApi {
  pushMotion(m: MotionSample): LiveFrame;
  pushGps(g: GpsSample): void;
  /** Mark the phone as stationary for calibration (user tapped "calibrate"). */
  markStationary(): void;
  /** Finish the run: closes open drifts, builds the track model, scores the session. */
  finish(meta?: Record<string, string | number | boolean>): Session;
  readonly frame: LiveFrame | null;
  readonly states: SlipState[];
  readonly drifts: DriftEvent[];
  readonly track: TrackModel | null;
  reset(): void;
}
