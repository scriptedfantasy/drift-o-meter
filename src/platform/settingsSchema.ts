/** App settings shape, defaults and sanitiser (pure; the IO lives in `settings.ts`). */
import type { TrackId } from '../sim';

export type SensorMode = 'device' | 'simulated';
export type SpeedUnits = 'kmh' | 'mph';

export interface AppSettings {
  /** Which sensor source `/drive` uses on native. Web is always simulated. */
  sensorMode: SensorMode;
  simTrack: TrackId;
  simRate: number;
  simSeed: number;
  simLaps: number;
  units: SpeedUnits;
  haptics: boolean;
  sound: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  sensorMode: 'device',
  simTrack: 'harbor',
  simRate: 1,
  simSeed: 1,
  simLaps: 2,
  units: 'kmh',
  haptics: true,
  sound: true,
};

const TRACKS: readonly string[] = ['harbor', 'touge'];

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function numIn(v: unknown, lo: number, hi: number, fallback: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const c = Math.min(hi, Math.max(lo, v));
  return integer ? Math.round(c) : c;
}

/** Coerce anything (old versions, hand-edited JSON) into a valid `AppSettings`. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    sensorMode: pick(r.sensorMode, ['device', 'simulated'] as const, DEFAULT_SETTINGS.sensorMode),
    simTrack: pick(r.simTrack, TRACKS as readonly TrackId[], DEFAULT_SETTINGS.simTrack),
    simRate: numIn(r.simRate, 0.1, 32, DEFAULT_SETTINGS.simRate),
    simSeed: numIn(r.simSeed, 0, 2 ** 31 - 1, DEFAULT_SETTINGS.simSeed, true),
    simLaps: numIn(r.simLaps, 1, 10, DEFAULT_SETTINGS.simLaps, true),
    units: pick(r.units, ['kmh', 'mph'] as const, DEFAULT_SETTINGS.units),
    haptics: typeof r.haptics === 'boolean' ? r.haptics : DEFAULT_SETTINGS.haptics,
    sound: typeof r.sound === 'boolean' ? r.sound : DEFAULT_SETTINGS.sound,
  };
}
