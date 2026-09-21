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

/**
 * Why a source would not start.
 *
 * The two permissions are separate codes because they send the driver to two different
 * switches: `permission-denied` is Motion & Fitness, `location-permission-denied` is Location.
 * One code for both meant a denied LOCATION permission surfaced on the calibration screen as
 * "Motion access is off / Turn on Motion & Fitness" — the driver told to fix the thing that
 * already works. `unavailable` is a device with no usable motion sensors, which is not
 * retryable and must not be reported as one.
 */
export type SensorErrorCode = 'unsupported' | 'permission-denied' | 'location-permission-denied' | 'unavailable' | 'services-disabled' | 'failed';

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
