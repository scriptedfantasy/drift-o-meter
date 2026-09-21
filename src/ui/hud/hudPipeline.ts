/**
 * The HUD's frame source: one place where the screen meets `src/engine/pipeline.ts`.
 *
 *   sensor source ──MotionSample──▶ DriftPipeline ──LiveFrame──▶ HUD
 *
 * The HUD never touches the engine modules directly; it only ever sees `LiveFrame`s, so the
 * engine can be re-wired without the HUD noticing. Nothing here imports React or React Native
 * (this module also runs in node, under `tools/`).
 */
import { DriftPipeline, idleLiveFrame, type DriftPipelineApi, type DriftPipelineOptions, type LiveFrame } from '../../engine/pipeline';

export function createHudPipeline(opts: DriftPipelineOptions = {}): DriftPipelineApi {
  return new DriftPipeline(opts);
}

/**
 * What the HUD renders before the first sample arrives: everything zeroed, nothing claimed.
 *
 * It is the ENGINE's own idle frame, not a copy of one. The copy that used to live here drifted
 * the moment a field was added to `LiveFrame` — which is exactly the failure `idleLiveFrame`
 * exists to prevent, since a stale literal keeps compiling while the HUD quietly reads a value
 * the engine never wrote.
 */
export function idleFrame(t = 0): LiveFrame {
  return idleLiveFrame(t);
}

export type { LiveFrame, DriftPipelineApi, DriftPipelineOptions };
