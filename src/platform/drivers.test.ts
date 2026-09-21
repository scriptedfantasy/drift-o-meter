import { describe, expect, it } from 'vitest';

import {
  activeDriver,
  addDriver,
  driverById,
  EMPTY_ROSTER,
  MAX_DRIVERS,
  MAX_NAME,
  newDriverId,
  normalizeName,
  removeDriver,
  renameDriver,
  sameName,
  sanitizeRoster,
  setActiveDriver,
  type Roster,
} from './driversSchema';

function withDrivers(...names: string[]): Roster {
  let r: Roster = EMPTY_ROSTER;
  let t = 1_700_000_000_000;
  for (const n of names) r = addDriver(r, n, (t += 1000)).roster;
  return r;
}

describe('normalizeName', () => {
  it('trims and collapses inner whitespace', () => {
    expect(normalizeName('  Lukas   Amacher ')).toBe('Lukas Amacher');
  });

  it('cuts to MAX_NAME rather than rejecting a long name', () => {
    const long = 'Bartholomew Wolfeschlegelstein';
    expect(normalizeName(long)).toHaveLength(MAX_NAME);
    expect(long.startsWith(normalizeName(long))).toBe(true);
  });

  it('keeps the case the driver typed', () => {
    expect(normalizeName('mArCo')).toBe('mArCo');
  });

  it('answers empty for anything that is not a string', () => {
    for (const v of [null, undefined, 42, {}, []]) expect(normalizeName(v)).toBe('');
  });
});

describe('sameName', () => {
  it('treats case, spacing and accent as the same person', () => {
    expect(sameName('sam', 'SAM')).toBe(true);
    expect(sameName(' Sam ', 'Sam')).toBe(true);
    expect(sameName('rené', 'Rene')).toBe(true);
  });

  it('keeps different people apart', () => {
    expect(sameName('Sam', 'Sammy')).toBe(false);
  });
});

describe('newDriverId', () => {
  it('does not collide inside one millisecond', () => {
    const ids = new Set(Array.from({ length: 400 }, () => newDriverId(1_700_000_000_000)));
    // 36^4 ≈ 1.68M, so 400 draws colliding at all would be extraordinary.
    expect(ids.size).toBeGreaterThan(395);
  });

  it('sorts roughly by creation time', () => {
    const early = newDriverId(1_700_000_000_000);
    const late = newDriverId(1_800_000_000_000);
    expect(early.length).toBeLessThanOrEqual(late.length);
  });
});

describe('addDriver', () => {
  it('adds and puts the new driver at the wheel', () => {
    const { roster, driver, error } = addDriver(EMPTY_ROSTER, 'Lukas');
    expect(error).toBeNull();
    expect(driver?.name).toBe('Lukas');
    expect(roster.activeId).toBe(driver?.id);
    expect(roster.drivers).toHaveLength(1);
  });

  it('selects the existing driver instead of adding a twin', () => {
    const start = withDrivers('Lukas', 'Marco');
    const { roster, driver, error } = addDriver(start, 'lukas');
    expect(error).toBe('duplicate');
    expect(roster.drivers).toHaveLength(2);
    expect(driver?.name).toBe('Lukas');
    expect(roster.activeId).toBe(driver?.id);
  });

  it('refuses an empty name and changes nothing', () => {
    const start = withDrivers('Lukas');
    const { roster, error } = addDriver(start, '   ');
    expect(error).toBe('empty');
    expect(roster).toBe(start);
  });

  it('refuses past MAX_DRIVERS', () => {
    const full = withDrivers(...Array.from({ length: MAX_DRIVERS }, (_, i) => `Driver${i}`));
    expect(full.drivers).toHaveLength(MAX_DRIVERS);
    const { roster, error } = addDriver(full, 'One more');
    expect(error).toBe('full');
    expect(roster.drivers).toHaveLength(MAX_DRIVERS);
  });
});

describe('renameDriver', () => {
  it('renames in place and keeps the id, so the runs still point at them', () => {
    const start = withDrivers('Lukas');
    const id = start.drivers[0].id;
    const { roster, error } = renameDriver(start, id, 'Luki');
    expect(error).toBeNull();
    expect(roster.drivers[0].id).toBe(id);
    expect(roster.drivers[0].name).toBe('Luki');
  });

  it('refuses a name someone else already has, rather than merging two people', () => {
    const start = withDrivers('Lukas', 'Marco');
    const { roster, error } = renameDriver(start, start.drivers[1].id, 'LUKAS');
    expect(error).toBe('duplicate');
    expect(roster.drivers[1].name).toBe('Marco');
  });

  it('allows renaming to your own name in different case', () => {
    const start = withDrivers('Lukas');
    const { error } = renameDriver(start, start.drivers[0].id, 'LUKAS');
    expect(error).toBeNull();
  });
});

describe('removeDriver', () => {
  it('drops the driver and clears the wheel when it was them', () => {
    const start = withDrivers('Lukas', 'Marco');
    expect(start.activeId).toBe(start.drivers[1].id);
    const after = removeDriver(start, start.drivers[1].id);
    expect(after.drivers.map((d) => d.name)).toEqual(['Lukas']);
    expect(after.activeId).toBeNull();
  });

  it('leaves the wheel alone when it was somebody else', () => {
    const start = setActiveDriver(withDrivers('Lukas', 'Marco'), null);
    const lukas = start.drivers[0].id;
    const withLukas = setActiveDriver(start, lukas);
    const after = removeDriver(withLukas, start.drivers[1].id);
    expect(after.activeId).toBe(lukas);
  });
});

describe('setActiveDriver', () => {
  it('accepts null for nobody', () => {
    expect(setActiveDriver(withDrivers('Lukas'), null).activeId).toBeNull();
  });

  it('clears rather than storing an id nobody holds', () => {
    expect(setActiveDriver(withDrivers('Lukas'), 'not-a-driver').activeId).toBeNull();
  });
});

describe('sanitizeRoster', () => {
  it('turns junk into an empty roster instead of throwing', () => {
    for (const v of [null, undefined, 7, 'nope', [], { drivers: 'no' }]) {
      expect(sanitizeRoster(v)).toEqual(EMPTY_ROSTER);
    }
  });

  it('drops nameless and malformed entries', () => {
    const r = sanitizeRoster({
      drivers: [{ id: 'a', name: 'Lukas', createdAt: 1 }, { id: 'b', name: '   ' }, null, 42, { name: 'Marco' }],
    });
    expect(r.drivers.map((d) => d.name)).toEqual(['Lukas', 'Marco']);
  });

  it('gives an entry with no id one, so it is still usable', () => {
    const r = sanitizeRoster({ drivers: [{ name: 'Marco' }] });
    expect(r.drivers[0].id).toBeTruthy();
    expect(r.drivers[0].createdAt).toBeGreaterThan(0);
  });

  it('de-duplicates by name and by id, keeping the first', () => {
    const r = sanitizeRoster({
      drivers: [
        { id: 'a', name: 'Lukas', createdAt: 1 },
        { id: 'b', name: 'LUKAS', createdAt: 2 },
        { id: 'a', name: 'Someone else', createdAt: 3 },
      ],
    });
    expect(r.drivers).toHaveLength(1);
    expect(r.drivers[0].name).toBe('Lukas');
  });

  it('caps the roster at MAX_DRIVERS', () => {
    const drivers = Array.from({ length: MAX_DRIVERS + 5 }, (_, i) => ({ id: `d${i}`, name: `Driver${i}`, createdAt: i + 1 }));
    expect(sanitizeRoster({ drivers }).drivers).toHaveLength(MAX_DRIVERS);
  });

  it('never leaves activeId pointing at a driver who is not there', () => {
    const r = sanitizeRoster({ drivers: [{ id: 'a', name: 'Lukas', createdAt: 1 }], activeId: 'ghost' });
    expect(r.activeId).toBeNull();
    expect(activeDriver(r)).toBeNull();
  });

  it('keeps a valid activeId', () => {
    const r = sanitizeRoster({ drivers: [{ id: 'a', name: 'Lukas', createdAt: 1 }], activeId: 'a' });
    expect(activeDriver(r)?.name).toBe('Lukas');
  });

  it('round-trips a roster through JSON unchanged', () => {
    const start = withDrivers('Lukas', 'Marco', 'Sam');
    expect(sanitizeRoster(JSON.parse(JSON.stringify(start)))).toEqual(start);
  });
});

describe('driverById', () => {
  it('answers null for no driver, which is a real answer and not a gap', () => {
    const r = withDrivers('Lukas');
    expect(driverById(r, null)).toBeNull();
    expect(driverById(r, undefined)).toBeNull();
    expect(driverById(r, '')).toBeNull();
  });

  it('answers null for a driver who has been forgotten, so their runs list as unassigned', () => {
    const start = withDrivers('Lukas', 'Marco');
    const marco = start.drivers[1].id;
    expect(driverById(removeDriver(start, marco), marco)).toBeNull();
  });
});
