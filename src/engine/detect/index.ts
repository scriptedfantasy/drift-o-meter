/**
 * Drift detector: SlipState stream (100 Hz) → DriftEvent[] + live phase for the HUD.
 *
 *   const det = new DriftDetector();
 *   for (const s of states) { const out = det.push(s); hud.show(out.phase, out.live); if (out.completed) score(out.completed); }
 *   det.finish();            // closes an open drift at the end of the run
 *   det.events, det.spins    // finalised events and which of them ended in a spin
 */
export { DriftDetector } from './detector';
export type { LiveDrift, DetectorOutput } from './detector';
export { DEFAULT_DETECT_OPTIONS, resolveOptions } from './options';
export type { DetectOptions } from './options';
