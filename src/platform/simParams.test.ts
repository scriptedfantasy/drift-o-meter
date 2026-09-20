import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from './settingsSchema';
import { DEFAULT_SIM_PARAMS, describeSimParams, parseSimParams, planSource, simParamsToQuery } from './simParams';

describe('parseSimParams', () => {
  it('returns null when the simulator is not requested', () => {
    expect(parseSimParams('')).toBeNull();
    expect(parseSimParams(null)).toBeNull();
    expect(parseSimParams('?rate=2')).toBeNull();
    expect(parseSimParams('?sim=0')).toBeNull();
    expect(parseSimParams('?sim=off')).toBeNull();
    expect(parseSimParams('?sim=device')).toBeNull();
  });

  it('parses track, rate, seed and laps with clamping', () => {
    expect(parseSimParams('?sim=harbor&rate=1')).toEqual({ track: 'harbor', rate: 1, seed: 1, laps: 2 });
    expect(parseSimParams('sim=touge&rate=4&seed=42&laps=3')).toEqual({ track: 'touge', rate: 4, seed: 42, laps: 3 });
    expect(parseSimParams(new URLSearchParams('sim=1'))).toEqual(DEFAULT_SIM_PARAMS);
    expect(parseSimParams({ sim: 'true', rate: '100' })?.rate).toBe(32);
    expect(parseSimParams('?sim=harbor&rate=0')?.rate).toBe(0.1);
    expect(parseSimParams('?sim=harbor&laps=99')?.laps).toBe(10);
    expect(parseSimParams('?sim=harbor&seed=2.7')?.seed).toBe(3);
    expect(parseSimParams('?sim=harbor&rate=abc')?.rate).toBe(1);
  });

  it('falls back to the default track for unknown names', () => {
    expect(parseSimParams('?sim=nurburgring')?.track).toBe('harbor');
    expect(parseSimParams('?sim=HARBOR')?.track).toBe('harbor');
  });

  it('round-trips through simParamsToQuery', () => {
    const p = { track: 'touge' as const, rate: 2, seed: 9, laps: 4 };
    expect(parseSimParams(simParamsToQuery(p))).toEqual(p);
    expect(simParamsToQuery(DEFAULT_SIM_PARAMS)).toBe('sim=harbor');
  });

  it('describes params for the HUD', () => {
    expect(describeSimParams({ track: 'harbor', rate: 1, seed: 1, laps: 2 })).toBe('SIM · HARBOR');
    expect(describeSimParams({ track: 'touge', rate: 2, seed: 1, laps: 2 })).toBe('SIM · TOUGE · 2×');
  });
});

describe('planSource', () => {
  const settings = { ...DEFAULT_SETTINGS, simTrack: 'touge' as const, simRate: 2 };

  it('always simulates on web, preferring the query string', () => {
    expect(planSource('web', null, settings)).toMatchObject({ kind: 'simulated', reason: 'no-sensors', params: { track: 'touge', rate: 2 } });
    expect(planSource('web', '?sim=harbor&rate=1', settings)).toMatchObject({ kind: 'simulated', reason: 'query', params: { track: 'harbor', rate: 1 } });
  });

  it('uses device sensors on native unless settings or query say otherwise', () => {
    expect(planSource('ios', null, settings)).toEqual({ kind: 'device' });
    expect(planSource('ios', null, { ...settings, sensorMode: 'simulated' })).toMatchObject({ kind: 'simulated', reason: 'settings' });
    expect(planSource('ios', '?sim=harbor', settings)).toMatchObject({ kind: 'simulated', reason: 'query' });
    expect(planSource('ios', '?sim=device', { ...settings, sensorMode: 'simulated' })).toMatchObject({ kind: 'simulated', reason: 'settings' });
  });
});
