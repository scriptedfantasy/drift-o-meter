/**
 * Pure helpers for choosing a sensor source: URL query parsing (web) and the decision table
 * that combines platform, query and saved settings. No React Native imports (runs in vitest).
 */
import type { TrackId } from '../sim';
import type { AppSettings } from './settingsSchema';

export interface SimParams {
  track: TrackId;
  /** Playback speed multiplier. */
  rate: number;
  seed: number;
  laps: number;
}

export const SIM_TRACKS: readonly TrackId[] = ['harbor', 'touge'];

export const DEFAULT_SIM_PARAMS: SimParams = { track: 'harbor', rate: 1, seed: 1, laps: 2 };

const OFF_WORDS = new Set(['0', 'false', 'off', 'none', 'no', 'device']);
const ON_WORDS = new Set(['1', 'true', 'on', 'yes', 'sim']);

function toParams(input: string | URLSearchParams | Record<string, string | undefined> | null | undefined): URLSearchParams {
  if (!input) return new URLSearchParams();
  if (input instanceof URLSearchParams) return input;
  if (typeof input === 'string') return new URLSearchParams(input.startsWith('?') ? input.slice(1) : input);
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) if (typeof v === 'string') p.set(k, v);
  return p;
}

function num(v: string | null, fallback: number, lo: number, hi: number, integer = false): number {
  if (v === null || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const c = Math.min(hi, Math.max(lo, n));
  return integer ? Math.round(c) : c;
}

export function isTrackId(v: string): v is TrackId {
  return (SIM_TRACKS as readonly string[]).includes(v);
}

/**
 * Parse `?sim=harbor&rate=2&seed=7&laps=3`. Returns `null` when the query does not ask for the
 * simulator (`sim` absent or one of 0/false/off/none/device). `sim=1|true|on` picks the default
 * track; an unknown track name also falls back to the default.
 */
export function parseSimParams(
  input: string | URLSearchParams | Record<string, string | undefined> | null | undefined,
  defaults: SimParams = DEFAULT_SIM_PARAMS,
): SimParams | null {
  const p = toParams(input);
  const sim = p.get('sim')?.trim().toLowerCase() ?? null;
  if (sim === null || OFF_WORDS.has(sim)) return null;
  const track: TrackId = isTrackId(sim) ? sim : ON_WORDS.has(sim) ? defaults.track : defaults.track;
  return {
    track,
    rate: num(p.get('rate'), defaults.rate, 0.1, 32),
    seed: num(p.get('seed'), defaults.seed, 0, 2 ** 31 - 1, true),
    laps: num(p.get('laps'), defaults.laps, 1, 10, true),
  };
}

/** Inverse of `parseSimParams`, without the leading `?`. */
export function simParamsToQuery(p: SimParams): string {
  const q = new URLSearchParams();
  q.set('sim', p.track);
  if (p.rate !== 1) q.set('rate', String(p.rate));
  if (p.seed !== DEFAULT_SIM_PARAMS.seed) q.set('seed', String(p.seed));
  if (p.laps !== DEFAULT_SIM_PARAMS.laps) q.set('laps', String(p.laps));
  return q.toString();
}

export function describeSimParams(p: SimParams): string {
  const rate = p.rate === 1 ? '' : ` · ${Number(p.rate.toFixed(2))}×`;
  return `SIM · ${p.track.toUpperCase()}${rate}`;
}

export type SourcePlan = { kind: 'device' } | { kind: 'simulated'; params: SimParams; reason: 'query' | 'settings' | 'no-sensors' };

/**
 * Decide which source to use. Web always ends up simulated (there are no usable sensors in a
 * browser): the query string wins, otherwise the saved sim settings. Native follows the
 * settings flag unless a query explicitly asks for the simulator.
 */
export function planSource(platform: string, search: string | null | undefined, settings: AppSettings): SourcePlan {
  const fromSettings: SimParams = { track: settings.simTrack, rate: settings.simRate, seed: settings.simSeed, laps: settings.simLaps };
  const fromQuery = parseSimParams(search, fromSettings);
  if (fromQuery) return { kind: 'simulated', params: fromQuery, reason: 'query' };
  if (platform === 'web') return { kind: 'simulated', params: fromSettings, reason: 'no-sensors' };
  if (settings.sensorMode === 'simulated') return { kind: 'simulated', params: fromSettings, reason: 'settings' };
  return { kind: 'device' };
}
