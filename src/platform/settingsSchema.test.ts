import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, sanitizeSettings } from './settingsSchema';

describe('sanitizeSettings', () => {
  it('returns defaults for junk', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ sensorMode: 'telepathy', simTrack: 'moon', simRate: 'fast', units: 5, haptics: 'yes' })).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values and clamps numbers', () => {
    expect(sanitizeSettings({ sensorMode: 'simulated', simTrack: 'touge', simRate: 500, simSeed: 3.6, simLaps: 0, units: 'mph', haptics: false, sound: false })).toEqual({
      sensorMode: 'simulated',
      simTrack: 'touge',
      simRate: 32,
      simSeed: 4,
      simLaps: 1,
      units: 'mph',
      haptics: false,
      sound: false,
    });
  });
});
