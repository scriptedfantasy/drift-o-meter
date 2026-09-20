/**
 * Plays a simulated recording into the HUD's pipeline, with a seek and a freeze.
 *
 * `SimulatedSensorSource` (src/platform) re-bases every timestamp onto the live clock, which is
 * exactly right for a run that starts at the beginning and never jumps. The HUD needs two more
 * things — warp to an arbitrary instant (`?at=`) and hold there (`?hold=1`) so a critic can
 * capture the same frame twice — and both break a re-based clock: after a warp the live stream
 * would hand the engine timestamps ~100 s in the past.
 *
 * So this player keeps the RECORDING's own timestamps and only schedules WHEN it delivers them.
 * The engine integrates the same physics either way (it only ever looks at sample `t`), the HUD
 * clock reads `frame.t − t0` instead of wall time, and a warp is just "deliver the next N
 * samples right now". Playback speed comes from `rate` (the `?rate=` query parameter).
 */
import type { GpsSample, MotionSample } from '../../engine/types';
import { now } from '../../platform/clock';

export interface SimPlayerListeners {
  onMotion(m: MotionSample): void;
  onGps(g: GpsSample): void;
  onEnd?(): void;
}

export interface SimPlayerOptions extends SimPlayerListeners {
  /** Playback speed multiplier (1 = real time). */
  rate?: number;
}

export interface SimRecording {
  motion: MotionSample[];
  gps: GpsSample[];
}

export class SimPlayer {
  /** Recording time of the first sample. */
  readonly t0: number;
  readonly durationS: number;

  private im = 0;
  private ig = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ended = false;
  /** Recording position (seconds from `t0`) reached so far. */
  private pos = 0;
  private wallBase = 0;
  private posBase = 0;

  constructor(
    private readonly data: SimRecording,
    private readonly opts: SimPlayerOptions,
  ) {
    const firstM = data.motion[0]?.t;
    const firstG = data.gps[0]?.t;
    const lastM = data.motion[data.motion.length - 1]?.t;
    const lastG = data.gps[data.gps.length - 1]?.t;
    const firsts = [firstM, firstG].filter(isFinite);
    const lasts = [lastM, lastG].filter(isFinite);
    this.t0 = firsts.length ? Math.min(...firsts) : 0;
    this.durationS = lasts.length ? Math.max(0, Math.max(...lasts) - this.t0) : 0;
  }

  get rate(): number {
    const r = this.opts.rate ?? 1;
    return r > 0 && Number.isFinite(r) ? r : 1;
  }

  /** Recording seconds delivered so far. */
  get positionS(): number {
    return this.pos;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** Deliver everything up to `seconds` AT ONCE (no waiting). Used by `?at=`. */
  warpTo(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= this.pos) return;
    this.drainTo(Math.min(seconds, this.durationS));
  }

  /** Begin (or resume) real-time delivery from the current position. */
  start(): void {
    if (this.running || this.ended) return;
    this.running = true;
    this.wallBase = now();
    this.posBase = this.pos;
    this.tick();
  }

  /** Stop delivering but keep the position, so `start()` resumes. Used by `?hold=1`. */
  pause(): void {
    this.running = false;
    this.clearTimer();
  }

  stop(): void {
    this.pause();
    this.ended = true;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private readonly tick = (): void => {
    this.timer = null;
    if (!this.running) return;
    const target = this.posBase + (now() - this.wallBase) * this.rate;
    this.drainTo(target);
    if (this.im >= this.data.motion.length && this.ig >= this.data.gps.length) {
      this.running = false;
      this.ended = true;
      this.opts.onEnd?.();
      return;
    }
    const next = this.nextDue();
    const waitMs = Math.max(0, ((next - target) / this.rate) * 1000);
    this.timer = setTimeout(this.tick, waitMs);
  };

  /** Next sample's recording offset, or Infinity when the recording is exhausted. */
  private nextDue(): number {
    const { motion, gps } = this.data;
    const tm = this.im < motion.length ? motion[this.im].t - this.t0 : Infinity;
    const tg = this.ig < gps.length ? gps[this.ig].t - this.t0 : Infinity;
    return Math.min(tm, tg);
  }

  /** Emit every sample whose offset is <= `target`, GPS first when they tie. */
  private drainTo(target: number): void {
    const { motion, gps } = this.data;
    for (;;) {
      const tm = this.im < motion.length ? motion[this.im].t - this.t0 : Infinity;
      const tg = this.ig < gps.length ? gps[this.ig].t - this.t0 : Infinity;
      const next = Math.min(tm, tg);
      if (next === Infinity || next > target) break;
      if (tg <= tm) this.opts.onGps(gps[this.ig++]);
      else this.opts.onMotion(motion[this.im++]);
      this.pos = next;
    }
    if (target > this.pos) this.pos = Math.min(target, this.durationS);
  }
}

function isFinite(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
