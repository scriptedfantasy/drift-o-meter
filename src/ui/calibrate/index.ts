/**
 * Calibration screen kit.
 *
 * `MountDialView` is the platform-split wrapper on purpose: the Skia component behind it
 * (`MountDial`) must not be evaluated on web until CanvasKit is loaded, so nothing here
 * re-exports it directly.
 */
export {
  arrivalOf,
  attitudeWords,
  cautionsOf,
  faultForError,
  headlineOf,
  IDLE_READING,
  isFlat,
  isSettled,
  leaveOf,
  lightsOf,
  mountIsRigid,
  mountVerdict,
  orientationOf,
  phaseOf,
  qualityBand,
  stepsOf,
  FAULTS,
  FLAT_DEG,
  SHARP_QUALITY,
  TRUST_QUALITY,
} from './model';
export type {
  Arrival,
  CalibrationFault,
  CalibrationFaultKind,
  CalibrationPhase,
  CalibrationReading,
  Caution,
  FaultDestination,
  Headline,
  Leave,
  Light,
  QualityBand,
  Step,
} from './model';
export { parseCalibrateParams, DEFAULT_CALIBRATE_PARAMS } from './params';
export type { CalibrateParams, CalibrateReason } from './params';
export { useCalibration } from './useCalibration';
export type { Calibration } from './useCalibration';
export { Banner, Cautions, EngineStrip, Lights, Steps } from './parts';
