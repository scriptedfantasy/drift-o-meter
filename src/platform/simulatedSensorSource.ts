/**
 * Plays a recorded / simulated `{ motion, gps }` pair back in real time (or faster/slower via
 * `rate`), delivering samples through the same `SensorListeners` the device source uses.
 *
 * Timestamps: every emitted sample is re-based onto the live clock, `t' = base + (t − t0)`,
 * where `base` is `clock.now()` at `start()`. The ORIGINAL spacing between samples is kept
 * even when `rate ≠ 1`, so the engine integrates the same physics whether the run is played at
 * 1× or fast-forwarded at 8× (at rate 1 the emitted `t'` also matches the wall clock, which is
 * what the HUD and the harness rely on).
 */
import type { GpsSample, MotionSample } from '../engine/types';
import { now } from './clock';
import { type SensorListeners, type SensorSource } from './sensorSource';

export interface SimulatedStreams {
  motion: MotionSample[];
  gps: GpsSample[];
}

export interface SimulatedSourceOptions {
  /** Playback speed multiplier (1 = real time). */
  rate?: number;
  /** Restart from the beginning when the data runs out. */
  loop?: boolean;
  /** Called once when playback reaches the end (not called when looping). */
  onEnd?: () => void;
}

export class SimulatedSensorSource implements SensorSource {
  readonly kind = 'simulated' as const;
  /** Length of the recording in seconds. */
  readonly durationS: number;

  private readonly t0: number;
  private readonly tEnd: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners: SensorListeners | null = null;
  private running = false;
  private im = 0;
  private ig = 0;
  private base = 0;

  constructor(
    private readonly data: SimulatedStreams,
    private readonly opts: SimulatedSourceOptions = {},
  ) {
    const firsts = [data.motion[0]?.t, data.gps[0]?.t].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const lasts = [data.motion[data.motion.length - 1]?.t, data.gps[data.gps.length - 1]?.t].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    this.t0 = firsts.length ? Math.min(...firsts) : 0;
    this.tEnd = lasts.length ? Math.max(...lasts) : 0;
    this.durationS = Math.max(0, this.tEnd - this.t0);
    if (!(this.rate > 0)) throw new Error(`SimulatedSensorSource: rate must be > 0 (got ${String(this.opts.rate)})`);
  }

  get rate(): number {
    return this.opts.rate ?? 1;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Fraction of the recording delivered so far, 0..1. */
  get progress(): number {
    const total = this.data.motion.length + this.data.gps.length;
    return total === 0 ? 1 : (this.im + this.ig) / total;
  }

  /** Recording time (seconds from the start of the data) that playback has reached. */
  get elapsedS(): number {
    if (!this.running) return this.progress >= 1 ? this.durationS : 0;
    return Math.min(this.durationS, (now() - this.base) * this.rate);
  }

  async start(listeners: SensorListeners): Promise<void> {
    this.stop();
    this.listeners = listeners;
    this.running = true;
    this.im = 0;
    this.ig = 0;
    this.base = now();
    this.schedule(0);
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.listeners = null;
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(this.tick, Math.max(0, delayMs));
  }

  private readonly tick = (): void => {
    this.timer = null;
    const listeners = this.listeners;
    if (!this.running || !listeners) return;
    const { motion, gps } = this.data;
    const simElapsed = (now() - this.base) * this.rate;

    for (;;) {
      const tm = this.im < motion.length ? motion[this.im].t - this.t0 : Infinity;
      const tg = this.ig < gps.length ? gps[this.ig].t - this.t0 : Infinity;
      const next = Math.min(tm, tg);
      if (next === Infinity) {
        this.finish();
        return;
      }
      if (next > simElapsed) {
        this.schedule(((next - simElapsed) / this.rate) * 1000);
        return;
      }
      if (tm <= tg) {
        const s = motion[this.im++];
        listeners.onMotion({ ...s, t: this.base + tm });
      } else {
        const s = gps[this.ig++];
        listeners.onGps({ ...s, t: this.base + tg });
      }
      if (!this.running) return; // a listener called stop()
    }
  };

  private finish(): void {
    if (this.opts.loop) {
      this.im = 0;
      this.ig = 0;
      this.base = now();
      this.schedule(0);
      return;
    }
    this.running = false;
    this.listeners = null;
    this.opts.onEnd?.();
  }
}
