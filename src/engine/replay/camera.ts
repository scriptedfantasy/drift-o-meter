import { clamp, wrapAngle } from '../types';
import { poseAt } from './pose';
import type { Replay } from './types';

export type CameraMode = 'overview' | 'chase' | 'cinematic';

export interface Viewport {
  w: number;
  h: number;
}

/**
 * Camera state. Screen mapping (see `worldToScreen`): world → subtract (cx, cy) → rotate by
 * `rotation` → scale by `zoom` (px per metre) → flip y (screen y grows downwards) → offset to the
 * viewport centre. `rotation = π/2 − course` puts the travel direction at the top of the screen.
 */
export interface CameraState {
  cx: number;
  cy: number;
  /** Pixels per metre. */
  zoom: number;
  /** Radians, CCW. */
  rotation: number;
  w: number;
  h: number;
}

/**
 * Hard per-second bounds on camera motion, enforced after smoothing. At 60 fps this means
 * pan ≤ 1.0 m, rotation ≤ 0.05 rad (2.9°) and zoom ratio ≤ 2.0 % per frame, in every mode,
 * including mode switches and the first frames after a scrub.
 */
export const CAMERA_LIMITS = {
  /** m/s */
  maxPan: 60,
  /** rad/s */
  maxRotation: 3.0,
  /** ln(zoom) units per second */
  maxZoomLog: 1.2,
} as const;

export const CAMERA_TUNING = {
  /** Critically-damped time constants, s. */
  positionTau: 0.35,
  zoomTau: 0.8,
  rotationTau: 0.5,
  /** Chase/cinematic: metres of track across the shorter viewport side. */
  chaseSpanM: 60,
  /** Look-ahead along the course, metres (fades to 0 below `lookAheadFullSpeed`). */
  lookAheadM: 12,
  lookAheadFullSpeed: 6,
  /** Overview padding fraction on each side of the bounds. */
  overviewPad: 0.08,
  /** Cinematic zoom factor: 0.85 on straights → 1.6 at full drift intensity. */
  cinematicZoomIdle: 0.85,
  cinematicZoomFull: 1.6,
  /** Cinematic sway: 0.3 Hz, ±1.4° rotation and ±1.2 m lateral. */
  swayHz: 0.3,
  swayRotation: 0.025,
  swayOffsetM: 1.2,
} as const;

/**
 * Critically damped second-order smoother with an exact (closed-form) step, so it is stable for
 * any dt. τ is the response scale: ω = 2/τ, the step response reaches 63 % at ≈ τ and 95 % at ≈ 2.4 τ.
 */
class Spring {
  x = 0;
  v = 0;
  constructor(private wrap: boolean) {}
  snap(target: number): void {
    this.x = this.wrap ? wrapAngle(target) : target;
    this.v = 0;
  }
  /** Advance towards `target`; `feedforward` is added to the velocity outside the spring loop. */
  step(target: number, dt: number, tau: number, feedforward = 0): number {
    const w = 2 / tau;
    const x0 = this.x + feedforward * dt;
    const e0 = this.wrap ? wrapAngle(x0 - target) : x0 - target;
    const v0 = this.v;
    const c = v0 + w * e0;
    const ex = Math.exp(-w * dt);
    const e1 = (e0 + c * dt) * ex;
    const v1 = (v0 - c * w * dt) * ex;
    this.x = this.wrap ? wrapAngle(target + e1) : target + e1;
    this.v = v1;
    return this.x;
  }
}

interface CameraTarget {
  cx: number;
  cy: number;
  zoom: number;
  rotation: number;
  /** Feedforward velocity of the target, m/s. */
  vx: number;
  vy: number;
}

/**
 * Replay camera. `update(replay, t, dt)` returns the smoothed state for replay time `t`, where
 * `dt` is the frame interval. The first update snaps to the target (no start-up jump); afterwards
 * every parameter is critically-damped and hard-limited per frame (see CAMERA_LIMITS).
 * `jumpTo()` snaps for scrubbing.
 */
export class ReplayCamera {
  private mode: CameraMode;
  private viewport: Viewport;
  private px = new Spring(false);
  private py = new Spring(false);
  private pz = new Spring(false); // ln(zoom)
  private pr = new Spring(true);
  private state: CameraState | null = null;
  private lastRotationTarget = 0;
  private lastT = NaN;

  constructor(mode: CameraMode, viewport: Viewport) {
    this.mode = mode;
    this.viewport = { w: Math.max(1, viewport.w), h: Math.max(1, viewport.h) };
  }

  getMode(): CameraMode {
    return this.mode;
  }

  /** Switch mode; the springs carry the current state over so the switch is a smooth move. */
  setMode(mode: CameraMode): void {
    this.mode = mode;
  }

  setViewport(viewport: Viewport): void {
    this.viewport = { w: Math.max(1, viewport.w), h: Math.max(1, viewport.h) };
    if (this.state) {
      this.state.w = this.viewport.w;
      this.state.h = this.viewport.h;
    }
  }

  /** Forget the smoothed state; the next update snaps to its target. */
  reset(): void {
    this.state = null;
    this.lastT = NaN;
  }

  getState(): CameraState | null {
    return this.state ? { ...this.state } : null;
  }

  /** Snap to the target for time t (use when the user scrubs). */
  jumpTo(replay: Replay, t: number): CameraState {
    const target = this.targetFor(replay, t);
    this.px.snap(target.cx);
    this.py.snap(target.cy);
    this.pz.snap(Math.log(target.zoom));
    this.pr.snap(target.rotation);
    this.state = { cx: target.cx, cy: target.cy, zoom: target.zoom, rotation: wrapAngle(target.rotation), w: this.viewport.w, h: this.viewport.h };
    this.lastT = t;
    return { ...this.state };
  }

  update(replay: Replay, t: number, dt: number): CameraState {
    if (!this.state || !(dt > 0)) return this.jumpTo(replay, t);
    const target = this.targetFor(replay, t);
    const prev = this.state;
    const step = Math.min(dt, 1); // a stalled frame must not become a teleport
    let cx = this.px.step(target.cx, step, CAMERA_TUNING.positionTau, target.vx);
    let cy = this.py.step(target.cy, step, CAMERA_TUNING.positionTau, target.vy);
    let lz = this.pz.step(Math.log(target.zoom), step, CAMERA_TUNING.zoomTau);
    let rot = this.pr.step(target.rotation, step, CAMERA_TUNING.rotationTau);
    // hard per-frame limits
    const maxPan = CAMERA_LIMITS.maxPan * step;
    const dx = cx - prev.cx;
    const dy = cy - prev.cy;
    const d = Math.hypot(dx, dy);
    if (d > maxPan) {
      cx = prev.cx + (dx / d) * maxPan;
      cy = prev.cy + (dy / d) * maxPan;
      this.px.x = cx;
      this.py.x = cy;
    }
    const maxZ = CAMERA_LIMITS.maxZoomLog * step;
    const prevLz = Math.log(prev.zoom);
    if (Math.abs(lz - prevLz) > maxZ) {
      lz = prevLz + Math.sign(lz - prevLz) * maxZ;
      this.pz.x = lz;
    }
    const maxR = CAMERA_LIMITS.maxRotation * step;
    const dr = wrapAngle(rot - prev.rotation);
    if (Math.abs(dr) > maxR) {
      rot = wrapAngle(prev.rotation + Math.sign(dr) * maxR);
      this.pr.x = rot;
    }
    this.state = { cx, cy, zoom: Math.exp(lz), rotation: rot, w: this.viewport.w, h: this.viewport.h };
    this.lastT = t;
    return { ...this.state };
  }

  private targetFor(replay: Replay, t: number): CameraTarget {
    const { w, h } = this.viewport;
    if (this.mode === 'overview') {
      const b = replay.bounds;
      const ex = Math.max(1, (b.maxX - b.minX) * (1 + 2 * CAMERA_TUNING.overviewPad));
      const ey = Math.max(1, (b.maxY - b.minY) * (1 + 2 * CAMERA_TUNING.overviewPad));
      return { cx: 0.5 * (b.minX + b.maxX), cy: 0.5 * (b.minY + b.maxY), zoom: Math.min(w / ex, h / ey), rotation: 0, vx: 0, vy: 0 };
    }
    const pose = poseAt(replay, t);
    const speedF = clamp(pose.speed / CAMERA_TUNING.lookAheadFullSpeed, 0, 1);
    const look = CAMERA_TUNING.lookAheadM * speedF;
    const cc = Math.cos(pose.course);
    const sc = Math.sin(pose.course);
    let cx = pose.x + look * cc;
    let cy = pose.y + look * sc;
    let zoom = Math.min(w, h) / CAMERA_TUNING.chaseSpanM;
    // hold the last rotation while (nearly) stopped: a parked car has no travel direction
    if (pose.speed > 1) this.lastRotationTarget = Math.PI / 2 - pose.course;
    else if (!Number.isFinite(this.lastRotationTarget) || Number.isNaN(this.lastT)) this.lastRotationTarget = Math.PI / 2 - pose.heading;
    let rotation = this.lastRotationTarget;
    if (this.mode === 'cinematic') {
      zoom *= CAMERA_TUNING.cinematicZoomIdle + (CAMERA_TUNING.cinematicZoomFull - CAMERA_TUNING.cinematicZoomIdle) * pose.intensity;
      const ph = 2 * Math.PI * CAMERA_TUNING.swayHz * t;
      rotation += CAMERA_TUNING.swayRotation * Math.sin(ph);
      const lat = CAMERA_TUNING.swayOffsetM * Math.sin(ph + 1.3) * speedF;
      cx += -sc * lat;
      cy += cc * lat;
    }
    return { cx, cy, zoom, rotation, vx: pose.speed * cc, vy: pose.speed * sc };
  }
}

/** World metres → screen pixels (y down). */
export function worldToScreen(cam: CameraState, x: number, y: number): { x: number; y: number } {
  const dx = x - cam.cx;
  const dy = y - cam.cy;
  const c = Math.cos(cam.rotation);
  const s = Math.sin(cam.rotation);
  return { x: cam.w / 2 + cam.zoom * (c * dx - s * dy), y: cam.h / 2 - cam.zoom * (s * dx + c * dy) };
}

/** Screen pixels → world metres. */
export function screenToWorld(cam: CameraState, sx: number, sy: number): { x: number; y: number } {
  const u = (sx - cam.w / 2) / cam.zoom;
  const v = -(sy - cam.h / 2) / cam.zoom;
  const c = Math.cos(cam.rotation);
  const s = Math.sin(cam.rotation);
  return { x: cam.cx + c * u + s * v, y: cam.cy - s * u + c * v };
}

/**
 * A world direction (math radians, CCW from +x east) as a screen angle: radians, CLOCKWISE
 * positive from screen +x, i.e. what `rotate()` in a y-down canvas / SVG expects (after ×180/π).
 */
export function worldAngleToScreen(cam: CameraState, angle: number): number {
  return -(angle + cam.rotation);
}
