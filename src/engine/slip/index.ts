/**
 * Slip-angle estimator — public surface.
 *
 *   const est = new SlipEstimator({ gpsLatencyS: 0.45 });
 *   est.pushGps(fix);            // whenever a fix is delivered (GpsSample.t = receive time)
 *   const s = est.pushMotion(v); // at motion rate, vehicle-frame sample from the mount calibrator
 *   s.beta, s.betaSigma, s.speed, s.x, s.y, s.valid …
 *
 * See estimator.ts for the physics and filter design.
 */
export { SlipEstimator, DEFAULT_SLIP_OPTIONS } from './estimator';
export type { SlipOptions, SlipMotionInput } from './estimator';
export { History } from './history';
export type { HistoryPoint } from './history';
