/**
 * Replay scene model: Session → data for the Skia renderer (app) and the SVG renderer (harness).
 * See ./types.ts for the scene description and its time convention (replay-relative seconds).
 */
export type {
  GhostPose,
  Replay,
  ReplayBounds,
  ReplayGhost,
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
export { buildReplay, DEFAULT_REPLAY_OPTIONS, intensityOf, lerpAngle, trailIndexOf, trailValueAt } from './build';
export { poseAt, ghostPoseAt, lapAt, scrubTelemetry, type TelemetrySample } from './pose';
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
export { sessionFromSimulation, type FixtureOptions } from './fixtures';
