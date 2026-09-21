/**
 * Replay scene model: Session → data for the Skia renderer (app) and the SVG renderer (harness).
 * See ./types.ts for the scene description and its time convention (replay-relative seconds).
 *
 * The simulator-backed fixture lives in ./fixtures and is NOT exported here, so it never ships
 * in the app bundle: tests and tools import `src/engine/replay/fixtures` directly.
 */
export type {
  ActiveEvent,
  DriftSeverity,
  GhostPose,
  Replay,
  ReplayBounds,
  ReplayEvent,
  ReplayEventKind,
  ReplayGhost,
  ReplayHighlight,
  ReplayLap,
  ReplayMarker,
  ReplayMarkerKind,
  ReplayOptions,
  ReplayPose,
  ReplaySegment,
  ReplayTelemetry,
  ReplayTrail,
  SmokeParticle,
  SmokeState,
} from './types';
export { buildReplay, DEFAULT_REPLAY_OPTIONS, SEVERITY_EDGES, formatPoints, intensityOf, lerpAngle, peakCallout, refusedLabel, severityOf, trailIndexOf, trailValueAt } from './build';
export { poseAt, ghostPoseAt, ghostPointsAt, lapAt, activeEvents, shakeAt, scrubTelemetry, type TelemetrySample } from './pose';
export { smokeAt, liveSmoke } from './smoke';
export {
  ReplayCamera,
  worldToScreen,
  screenToWorld,
  worldAngleToScreen,
  CAMERA_LIMITS,
  CAMERA_TUNING,
  type CameraMode,
  type CameraState,
  type Viewport,
} from './camera';
