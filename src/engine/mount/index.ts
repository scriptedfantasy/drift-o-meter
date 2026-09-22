/**
 * Mount calibration: phone-frame samples → vehicle-frame samples, whatever the mount.
 * See ./calibrator.ts for the algorithm.
 */
export { MountCalibrator, DEFAULT_MOUNT_OPTIONS, forwardProgress } from './calibrator';
export type { MountOptions, MountDiagnostics, ForwardProgress } from './calibrator';
export { angleBetweenDeg, rowOf, applyRotation } from './math';
