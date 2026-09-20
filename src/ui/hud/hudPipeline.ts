/**
 * The HUD's frame source: one place where the screen meets `src/engine/pipeline.ts`.
 *
 *   sensor source ──MotionSample──▶ DriftPipeline ──LiveFrame──▶ HUD
 *
 * The HUD never touches the engine modules directly; it only ever sees `LiveFrame`s, so the
 * engine can be re-wired without the HUD noticing. Nothing here imports React or React Native
 * (this module also runs in node, under `tools/`).
 */
import { DriftPipeline, type DriftPipelineApi, type DriftPipelineOptions, type LiveFrame } from '../../engine/pipeline';
import type { MountCalibration } from '../../engine/types';

const IDENTITY_CALIBRATION: MountCalibration = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], quality: 0, forwardResolved: false, t: 0 };

export function createHudPipeline(opts: DriftPipelineOptions = {}): DriftPipelineApi {
  return new DriftPipeline(opts);
}

/** What the HUD renders before the first sample arrives: everything zeroed, nothing claimed. */
export function idleFrame(t = 0): LiveFrame {
  return {
    t,
    state: { t, beta: 0, betaSigma: 0, heading: 0, course: 0, speed: 0, yawRate: 0, ay: 0, ax: 0, x: 0, y: 0, valid: false },
    phase: 'idle',
    live: null,
    completed: null,
    score: { total: 0, delta: 0, multiplier: 1, chainPoints: 0, chainActive: false, banked: false, lost: false, callouts: [] },
    calibration: IDENTITY_CALIBRATION,
    integrity: { mount: 'rigid', physics: 'ok', gps: 'none', message: 'Waiting for GPS' },
    lap: { count: 0, progress: NaN, completed: null },
  };
}

export type { LiveFrame, DriftPipelineApi, DriftPipelineOptions };
