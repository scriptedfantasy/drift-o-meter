/**
 * Calibration screen kit.
 *
 * `MountDialView` is the platform-split wrapper on purpose: the Skia component behind it
 * (`MountDial`) must not be evaluated on web until CanvasKit is loaded, so nothing here
 * re-exports it directly.
 */
export {
  attitudeWords,
  cautionsOf,
  headlineOf,
  IDLE_READING,
  isFlat,
  isSettled,
  lightsOf,
  orientationOf,
  phaseOf,
  qualityBand,
  stepsOf,
  FLAT_DEG,
  SETTLED_UP,
  SHARP_QUALITY,
  TRUST_QUALITY,
} from './model';
export type { CalibrationFault, CalibrationFaultKind, CalibrationPhase, CalibrationReading, Caution, Headline, Light, QualityBand, Step } from './model';
export { parseCalibrateParams, DEFAULT_CALIBRATE_PARAMS } from './params';
export type { CalibrateParams } from './params';
export { useCalibration } from './useCalibration';
export type { Calibration } from './useCalibration';
export { Banner, Cautions, EngineStrip, Lights, Steps } from './parts';
