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
  /** True on the single frame where the camera CUT (mode switch / scrub). */
  cut: boolean;
  /** 0..1 cross-fade after a cut (1 on the cut frame, 0 once the 120 ms fade is over). */
  cutFade: number;
}

/**
 * Hard per-second bounds on camera motion, enforced after smoothing during CONTINUOUS
 * playback. At 60 fps: pan ≤ 1.0 m, rotation ≤ 0.05 rad (2.9°) and zoom ratio ≤ 2.0 % per frame.
 *
 * A mode switch is deliberately NOT smoothed: it is a CUT with a 120 ms cross-fade (film
 * language), because a rate-limited 180° rotation takes >1 s of nauseating spin on a phone.
 * The cut frame is flagged `cut: true`; every other frame obeys the bounds.
 */
export const CAMERA_LIMITS = {
  /** m/s */
  maxPan: 60,
  /** rad/s */
  maxRotation: 3.0,
  /** ln(zoom) units per second */
  maxZoomLog: 1.2,
  /** Cross-fade length after a cut, in REAL seconds (it must decay while paused). */
  cutFadeS: 0.12,
} as const;

export const CAMERA_TUNING = {
  /** Critically-damped time constants, s. */
  positionTau: 0.35,
  zoomTau: 0.8,
  rotationTau: 0.5,
  /**
   * Chase/cinematic framing: metres of track across the SHORTER viewport side, adapted to speed
   * so a slow hairpin fills the frame and a 100 km/h straight still shows what is coming.
   * 28 m at ≤ 30 km/h → 55 m at ≥ 100 km/h.
   */
  spanSlowM: 28,
  spanFastM: 55,
  spanSlowSpeed: 8.3,
  spanFastSpeed: 27.8,
  /** Full drift intensity pulls in by up to 30 % on top of that. */
  spanDriftPull: 0.3,
  /** Look-ahead along the course, metres (fades to 0 below `lookAheadFullSpeed`). */
  lookAheadM: 12,
  lookAheadFullSpeed: 6,
  /** Extra look-ahead as a fraction of the span while sliding, so the car leads into frame. */
  lookAheadDrift: 0.12,
  /**
   * Hard cap on look-ahead as a fraction of the VISIBLE shorter side, applied after the zoom
   * (including the cinematic multiplier) is known. 12 m is a comfortable lead at a 55 m span
   * and shoves the car off the bottom of a tall portrait stage at a 17 m one.
   */
  maxLookFrac: 0.22,
  /** Overview padding fraction on each side of the bounds. */
  overviewPad: 0.04,
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
 * Self-heals: if its state ever goes non-finite (bad sample upstream) it snaps to the target
 * instead of staying NaN forever.
 */
class Spring {
  x = 0;
  v = 0;
  constructor(private wrap: boolean) {}
  snap(target: number): void {
    const t = Number.isFinite(target) ? target : 0;
    this.x = this.wrap ? wrapAngle(t) : t;
    this.v = 0;
  }
  /** Advance towards `target`; `feedforward` is added to the velocity outside the spring loop. */
  step(target: number, dt: number, tau: number, feedforward = 0): number {
    const tgt = Number.isFinite(target) ? target : this.x;
    if (!Number.isFinite(this.x) || !Number.isFinite(this.v)) {
      this.snap(tgt);
      return this.x;
    }
    const ff = Number.isFinite(feedforward) ? feedforward : 0;
    const w = 2 / tau;
    const x0 = this.x + ff * dt;
    const e0 = this.wrap ? wrapAngle(x0 - tgt) : x0 - tgt;
    const v0 = this.v;
    const c = v0 + w * e0;
    const ex = Math.exp(-w * dt);
    const e1 = (e0 + c * dt) * ex;
    const v1 = (v0 - c * w * dt) * ex;
    const nx = this.wrap ? wrapAngle(tgt + e1) : tgt + e1;
    if (!Number.isFinite(nx) || !Number.isFinite(v1)) {
      this.snap(tgt);
      return this.x;
    }
    this.x = nx;
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
 * `dt` is the REAL frame interval in seconds (not a replay-time delta): while paused, keep
 * calling it with the same `t` and a real `dt` so smoothing settles and a cut's cross-fade clears. The first update snaps to the target (no start-up jump); afterwards
 * every parameter is critically-damped and hard-limited per frame (see CAMERA_LIMITS), except on
 * a deliberate cut. `jumpTo()` snaps for scrubbing; `setMode()` cuts by default.
 */
export class ReplayCamera {
  private mode: CameraMode;
  private viewport: Viewport;
  private px = new Spring(false);
  private py = new Spring(false);
  private pz = new Spring(false); // ln(zoom)
  private pr = new Spring(true);
  private state: CameraState | null = null;
  /**
   * The rotation the chase/cinematic camera is heading for. NaN until the first target is
   * computed, so a parked car on the very first frame seeds it from its HEADING instead of
   * silently keeping 0 rad and whipping a quarter turn as soon as it moves.
   */
  private lastRotationTarget = NaN;
  private pendingCut = false;
  /** REAL seconds since the last cut, accumulated from `dt` — not replay time, which does not
   *  advance while paused: a cut on a paused frame used to leave the screen 55 % black forever. */
  private sinceCut = Infinity;
  private lastT = 0;

  constructor(mode: CameraMode, viewport: Viewport) {
    this.mode = mode;
    this.viewport = { w: Math.max(1, viewport.w), h: Math.max(1, viewport.h) };
  }

  getMode(): CameraMode {
    return this.mode;
  }

  /**
   * Switch mode. By default this is a CUT on the next update (with a 120 ms cross-fade the
   * renderer can use); pass `{ smooth: true }` to ride the springs instead, which is rate-limited
   * and therefore slow for large rotations.
   */
  setMode(mode: CameraMode, opts: { smooth?: boolean } = {}): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (!opts.smooth) this.pendingCut = true;
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
    this.sinceCut = Infinity;
    this.pendingCut = false;
    this.lastRotationTarget = NaN;
  }

  getState(): CameraState | null {
    return this.state ? { ...this.state } : null;
  }

  /** Snap to the target for time t (use when the user scrubs, or on a mode cut). */
  jumpTo(replay: Replay, t: number): CameraState {
    return this.snapTo(replay, t, true);
  }

  /**
   * `isCut` distinguishes a deliberate camera change (mode switch / scrub — the renderer
   * cross-fades) from merely initialising on the first frame, which must NOT flash: the opening
   * frame of a replay is not a cut.
   */
  private snapTo(replay: Replay, t: number, isCut: boolean): CameraState {
    const target = this.targetFor(replay, t);
    this.px.snap(target.cx);
    this.py.snap(target.cy);
    this.pz.snap(Math.log(target.zoom));
    this.pr.snap(target.rotation);
    if (isCut) this.sinceCut = 0;
    this.pendingCut = false;
    this.lastT = t;
    this.state = {
      cx: this.px.x,
      cy: this.py.x,
      zoom: Math.exp(this.pz.x),
      rotation: wrapAngle(this.pr.x),
      w: this.viewport.w,
      h: this.viewport.h,
      cut: isCut,
      cutFade: isCut ? 1 : 0,
    };
    return { ...this.state };
  }

  update(replay: Replay, t: number, dt: number): CameraState {
    if (!this.state) return this.snapTo(replay, t, false);
    if (!(dt > 0) || this.pendingCut) return this.snapTo(replay, t, this.pendingCut);
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
    const zoom = Math.exp(lz);
    this.lastT = t;
    this.sinceCut += step; // REAL elapsed time, so the fade clears even when t is frozen
    if (![cx, cy, zoom, rot].every(Number.isFinite)) return this.snapTo(replay, t, false);
    this.state = {
      cx,
      cy,
      zoom,
      rotation: rot,
      w: this.viewport.w,
      h: this.viewport.h,
      cut: false,
      cutFade: clamp(1 - this.sinceCut / CAMERA_LIMITS.cutFadeS, 0, 1),
    };
    return { ...this.state };
  }

  /** Metres across the shorter viewport side for this pose (speed- and drift-adaptive). */
  private spanFor(speed: number, intensity: number): number {
    const T = CAMERA_TUNING;
    const f = clamp((speed - T.spanSlowSpeed) / (T.spanFastSpeed - T.spanSlowSpeed), 0, 1);
    const base = T.spanSlowM + (T.spanFastM - T.spanSlowM) * f;
    return base * (1 - T.spanDriftPull * clamp(intensity, 0, 1));
  }

  private targetFor(replay: Replay, t: number): CameraTarget {
    const { w, h } = this.viewport;
    if (this.mode === 'overview') {
      const b = replay.bounds;
      const ex = Math.max(1, (b.maxX - b.minX) * (1 + 2 * CAMERA_TUNING.overviewPad));
      const ey = Math.max(1, (b.maxY - b.minY) * (1 + 2 * CAMERA_TUNING.overviewPad));
      const cx = 0.5 * (b.minX + b.maxX);
      const cy = 0.5 * (b.minY + b.maxY);
      return { cx: Number.isFinite(cx) ? cx : 0, cy: Number.isFinite(cy) ? cy : 0, zoom: Math.min(w / ex, h / ey), rotation: 0, vx: 0, vy: 0 };
    }
    const pose = poseAt(replay, t);
    const speed = Number.isFinite(pose.speed) ? pose.speed : 0;
    const intensity = Number.isFinite(pose.intensity) ? pose.intensity : 0;
    const course = Number.isFinite(pose.course) ? pose.course : 0;
    const span = this.spanFor(speed, intensity);
    const speedF = clamp(speed / CAMERA_TUNING.lookAheadFullSpeed, 0, 1);
    let zoom = Math.min(w, h) / span;
    if (this.mode === 'cinematic') {
      zoom *= CAMERA_TUNING.cinematicZoomIdle + (CAMERA_TUNING.cinematicZoomFull - CAMERA_TUNING.cinematicZoomIdle) * intensity;
    }
    // lead the car further into frame while it is sliding, so the shot has motion of its own —
    // but never by more than a fixed fraction of what is actually visible, or a zoomed-in
    // cinematic frame on a tall stage pushes the car out of the bottom of the band
    const visibleSpan = Math.min(w, h) / zoom;
    const look = Math.min((CAMERA_TUNING.lookAheadM + CAMERA_TUNING.lookAheadDrift * span * intensity) * speedF, CAMERA_TUNING.maxLookFrac * visibleSpan);
    const cc = Math.cos(course);
    const sc = Math.sin(course);
    let cx = (Number.isFinite(pose.x) ? pose.x : 0) + look * cc;
    let cy = (Number.isFinite(pose.y) ? pose.y : 0) + look * sc;
    // While moving, point the travel direction up. While stopped, hold the last target — but on
    // the FIRST frame there is no last target, so seed it from the car's heading: a replay that
    // opens on a stationary car must still open pointing the right way.
    if (speed > 1) this.lastRotationTarget = Math.PI / 2 - course;
    else if (!Number.isFinite(this.lastRotationTarget)) this.lastRotationTarget = Math.PI / 2 - (Number.isFinite(pose.heading) ? pose.heading : 0);
    let rotation = this.lastRotationTarget;
    if (this.mode === 'cinematic') {
      const ph = 2 * Math.PI * CAMERA_TUNING.swayHz * t;
      rotation += CAMERA_TUNING.swayRotation * Math.sin(ph);
      const lat = CAMERA_TUNING.swayOffsetM * Math.sin(ph + 1.3) * speedF;
      cx += -sc * lat;
      cy += cc * lat;
    }
    if (![cx, cy, zoom, rotation].every(Number.isFinite)) {
      const b = replay.bounds;
      return { cx: 0.5 * (b.minX + b.maxX) || 0, cy: 0.5 * (b.minY + b.maxY) || 0, zoom: Math.min(w, h) / CAMERA_TUNING.spanFastM, rotation: 0, vx: 0, vy: 0 };
    }
    return { cx, cy, zoom, rotation, vx: speed * cc, vy: speed * sc };
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
