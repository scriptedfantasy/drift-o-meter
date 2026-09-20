import type { GpsSample, MotionSample } from '../engine/types';

export interface SensorListeners {
  onMotion(s: MotionSample): void;
  onGps(s: GpsSample): void;
}

export type SensorSourceKind = 'device' | 'simulated';

/**
 * Something that produces phone-frame motion samples (~100 Hz) and GPS fixes (~1 Hz) on the
 * monotonic clock from `clock.ts`. The engine does not care whether they come from CoreMotion
 * or from the simulator.
 */
export interface SensorSource {
  readonly kind: SensorSourceKind;
  /** Resolves once streaming has begun. Rejects with a `SensorSourceError` when it cannot. */
  start(listeners: SensorListeners): Promise<void>;
  /** Idempotent. */
  stop(): void;
}

export type SensorErrorCode = 'unsupported' | 'permission-denied' | 'unavailable' | 'services-disabled' | 'failed';

export class SensorSourceError extends Error {
  readonly code: SensorErrorCode;
  override readonly cause?: unknown;

  constructor(code: SensorErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'SensorSourceError';
    this.code = code;
    this.cause = cause;
  }
}

/** Human-readable, user-facing explanation for an error thrown by `SensorSource.start`. */
export function describeSensorError(err: unknown): string {
  if (err instanceof SensorSourceError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
