/**
 * Picks the sensor source for a run.
 *
 *  - Web: always simulated (browsers have no usable motion/GPS for this). `?sim=harbor&rate=1`
 *    (see `parseSimParams`) selects track/speed/seed/laps; without a query the saved sim
 *    settings are used. This is what the verification harness relies on.
 *  - Native: the settings flag (`sensorMode`) unless a query explicitly asks for the simulator.
 */
import { Platform } from 'react-native';

import { simulateRun, type SimulatedRun } from '../sim';
import { DeviceSensorSource } from './deviceSensorSource';
import type { SensorSource } from './sensorSource';
import { loadSettings } from './settings';
import { describeSimParams, planSource, type SimParams, type SourcePlan } from './simParams';
import { SimulatedSensorSource } from './simulatedSensorSource';

export interface SourceSelection {
  kind: 'device' | 'simulated';
  source: SensorSource;
  /** Short uppercase description for the HUD, e.g. `SIM · HARBOR · 2×`. */
  label: string;
  plan: SourcePlan;
  sim: { params: SimParams; run: SimulatedRun } | null;
}

export interface SelectSourceOptions {
  /** Query string to parse instead of `window.location.search` (pass `null` to ignore the URL). */
  search?: string | null;
  loop?: boolean;
  onEnd?: () => void;
}

/** The page query string on web, `null` elsewhere. */
export function currentSearch(): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  return window.location.search || null;
}

const runCache = new Map<string, SimulatedRun>();

/** Generate (or reuse) the simulated run for these params. Synchronous and CPU-bound (~tens of ms). */
export function getSimulatedRun(params: SimParams): SimulatedRun {
  const key = `${params.track}|${params.seed}|${params.laps}`;
  const cached = runCache.get(key);
  if (cached) return cached;
  const run = simulateRun(params.track, { seed: params.seed, laps: params.laps });
  if (runCache.size >= 3) {
    const oldest = runCache.keys().next();
    if (!oldest.done) runCache.delete(oldest.value);
  }
  runCache.set(key, run);
  return run;
}

export async function selectSensorSource(opts: SelectSourceOptions = {}): Promise<SourceSelection> {
  const settings = await loadSettings();
  const search = opts.search === undefined ? currentSearch() : opts.search;
  const plan = planSource(Platform.OS, search, settings);

  if (plan.kind === 'device') {
    return { kind: 'device', source: new DeviceSensorSource(), label: 'DEVICE · LIVE SENSORS', plan, sim: null };
  }

  // Yield once so the screen can paint before the synchronous simulation runs.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const run = getSimulatedRun(plan.params);
  const source = new SimulatedSensorSource({ motion: run.motion, gps: run.gps }, { rate: plan.params.rate, loop: opts.loop, onEnd: opts.onEnd });
  return { kind: 'simulated', source, label: describeSimParams(plan.params), plan, sim: { params: plan.params, run } };
}
