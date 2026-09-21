/**
 * The calibration screen's words, tested as words.
 *
 * `model.ts` is React-free on purpose — "so the wording can be reasoned about (and read) on its
 * own" — and for four hundred lines of pure decision logic it had no test at all. The severity-1
 * that failed this screen the first time lived in `phaseOf`; the one that failed it the second
 * time was the identical mistake in `stepsOf`, one component over. So this file tests the CLASS
 * as well as the cases: the sweep at the bottom asserts across every combination of readings
 * that nothing here reports an absence of evidence as a verdict, which is the shape both bugs
 * had. A fixture table catches the bug you thought of; the sweep catches the next one.
 */
import { describe, expect, it } from 'vitest';

import { SensorSourceError } from '../../platform/sensorSource';
import { simulateRun, type MountPreset } from '../../sim';
import {
  arrivalOf,
  attitudeWords,
  cautionsOf,
  FAULTS,
  faultForError,
  headlineOf,
  IDLE_READING,
  isFlat,
  leaveOf,
  lightsOf,
  mountIsRigid,
  mountVerdict,
  MOUNT_WARMUP_S,
  orientationOf,
  phaseOf,
  qualityBand,
  SHARP_QUALITY,
  stepsOf,
  TRUST_QUALITY,
  type CalibrationFaultKind,
  type CalibrationReading,
} from './model';

function reading(over: Partial<CalibrationReading> = {}): CalibrationReading {
  return {
    ...IDLE_READING,
    status: 'listening',
    samples: 1200,
    has: true,
    elapsedS: 12,
    gravity: { x: 0, y: -9.46, z: -2.59 },
    gMag: 9.81,
    rollDeg: 0.9,
    reclineDeg: 15.3,
    upQuality: 0.9,
    quality: 0.7,
    forwardResolved: true,
    calibrationOk: true,
    mount: 'rigid',
    message: 'Mount looks solid',
    ...over,
  };
}

/** Measured states, from `npx tsx tools/analysis/calibration-sweep.ts` and the harness routes. */
const NOTHING = { ...IDLE_READING };
/** `?sim=harbor&at=0.5` — gravity seen, inside the 4 s mount warm-up, nothing worked out. */
const EARLY = reading({ samples: 50, elapsedS: 0.5, upQuality: 0.5, quality: 0.05, forwardResolved: false, calibrationOk: false, mount: 'suspect' });
/** `?sim=harbor&looseness=1&at=2` — a real hand-held recording, still inside the warm-up. */
const HANDHELD_EARLY = reading({ samples: 200, elapsedS: 2, upQuality: 0.55, quality: 0.09, forwardResolved: false, calibrationOk: false, mount: 'loose', handheld: true });
/** `?sim=harbor&at=3` — the vertical has settled, the forward axis has not resolved. */
const LEVELLED = reading({ samples: 300, elapsedS: 3, upQuality: 0.9, quality: 0.28, forwardResolved: false, calibrationOk: false });
/** `?sim=touge&looseness=0.2&at=40` — confidence 34 %, forward resolved, mount 'suspect'. */
const CRADLE = reading({ elapsedS: 40, quality: 0.339, mount: 'suspect', message: 'Phone may be shifting in its mount — check it is tight' });
/** `?sim=harbor&looseness=1&at=12` — hand-held, past the warm-up. */
const LOOSE = reading({ quality: 0.03, forwardResolved: false, calibrationOk: false, mount: 'loose', handheld: true, message: 'Phone looks hand-held — clip it into a rigid mount to score drifts' });
/** The best seed measured at the simulator's default vibration: 0.864. */
const SHARP = reading({ quality: 0.864 });
/** A flat phone on a console, from `?mount=flat-console`. */
const FLAT = reading({ gravity: { x: 0.64, y: 0.07, z: -9.78 }, rollDeg: 96.3, reclineDeg: 86.3, quality: 0.68 });

describe('phaseOf', () => {
  it('claims nothing with no samples', () => {
    // `IntegrityMonitor` starts with calibrationOk true so it cannot veto a run it has not
    // seen. That is not a verdict, and this must not read it as one.
    expect(IDLE_READING.calibrationOk).toBe(false);
    expect(phaseOf(NOTHING)).toBe('starting');
    expect(phaseOf(reading({ samples: 0, has: false, calibrationOk: true, forwardResolved: true }))).toBe('starting');
  });

  it('is not READY while the mount verdict is still unknown', () => {
    const warming = reading({ elapsedS: MOUNT_WARMUP_S - 0.1 });
    expect(mountVerdict(warming)).toBe('unknown');
    expect(phaseOf(warming)).toBe('unsteady');
    expect(phaseOf(reading({ elapsedS: MOUNT_WARMUP_S + 0.1 }))).toBe('ready');
  });

  it('is not READY over a shaking mount', () => {
    // The frame this failed on: 34 %, everything else resolved, "CALIBRATED / Ready to
    // measure" sat directly above a gold MOUNT LOOKS UNSTEADY.
    expect(CRADLE.calibrationOk && CRADLE.forwardResolved).toBe(true);
    expect(phaseOf(CRADLE)).toBe('unsteady');
  });

  it('blocks on a loose mount and fails on a fault', () => {
    expect(phaseOf(LOOSE)).toBe('blocked');
    expect(phaseOf(reading({ fault: FAULTS.permission }))).toBe('failed');
    // a fault outranks everything, including a perfectly good reading
    expect(phaseOf(reading({ fault: FAULTS.failed, quality: 0.9 }))).toBe('failed');
  });

  it('reports progress while the axes are still resolving', () => {
    expect(phaseOf(LEVELLED)).toBe('seeking');
    expect(phaseOf(EARLY)).toBe('levelling');
  });
});

describe('stepsOf', () => {
  it('does not tick step 01 while the monitor is still listening', () => {
    // The 6.5/10 finding, verbatim: a green tick and a strike-through on "Clip it to something
    // rigid" while the MOUNT light beside it read "Listening" and confidence read 9 %.
    expect(mountVerdict(HANDHELD_EARLY)).toBe('unknown');
    const [one, two] = stepsOf(HANDHELD_EARLY);
    expect(one.state).toBe('active');
    expect(one.progress).toBe(0);
    expect(two.state).toBe('todo');
    // and the light beside it agrees
    expect(lightsOf(HANDHELD_EARLY)[2].detail).toBe('Listening');
  });

  it('does not tick step 01 for a shaking or loose mount either', () => {
    expect(stepsOf(CRADLE)[0].state).toBe('active');
    expect(stepsOf(LOOSE)[0].state).toBe('active');
  });

  it('ticks step 01 once the monitor has said rigid', () => {
    expect(stepsOf(SHARP)[0].state).toBe('done');
    expect(stepsOf(SHARP)[1].state).toBe('done');
  });

  it('will not tick a rigid phone that is lying flat', () => {
    expect(mountIsRigid(FLAT)).toBe(true);
    expect(isFlat(FLAT)).toBe(true);
    expect(stepsOf(FLAT)[0].state).toBe('active');
  });

  it('shows how far the straight-line evidence has got', () => {
    const half = reading({ elapsedS: 6, forwardResolved: false, calibrationOk: false, lineEvidenceS: 0.4 });
    expect(stepsOf(half)[1].progress).toBeCloseTo(0.5, 2);
  });
});

describe('headlineOf', () => {
  it('names the condition the HUD names, in the monitor’s own words', () => {
    expect(headlineOf(LOOSE)).toMatchObject({ title: 'Hand-held', because: LOOSE.message, color: 'red' });
    expect(headlineOf(reading({ mount: 'loose', handheld: false, message: 'm' })).title).toBe('Loose mount');
    expect(headlineOf(CRADLE)).toMatchObject({ title: 'Mount shaking', because: CRADLE.message, color: 'gold' });
  });

  it('moves the reason with the number instead of one clause for the whole range', () => {
    const low = headlineOf(reading({ quality: 0.33 })).because;
    const mid = headlineOf(reading({ quality: 0.6 })).because;
    const high = headlineOf(SHARP).because;
    expect(new Set([low, mid, high]).size).toBe(3);
    expect(low).toMatch(/barely/);
    expect(high).toMatch(/face value/);
    expect(headlineOf(SHARP).color).toBe('green');
    expect(headlineOf(reading({ quality: 0.33 })).color).toBe('ember');
  });

  it('does not repeat the band label word for word', () => {
    // "good enough to score — a couple of degrees…" sat directly above "GOOD ENOUGH TO SCORE".
    for (const q of [0.31, 0.4, 0.55, 0.74, 0.8, 0.86]) {
      const r = reading({ quality: q });
      const because = headlineOf(r).because.toLowerCase();
      const label = qualityBand(r).label.toLowerCase();
      expect(because.includes(label)).toBe(false);
    }
  });

  it('says one idea once on the unresolved-arrival frame', () => {
    const r = LEVELLED;
    const sentences = [arrivalOf('unresolved')!.body, headlineOf(r).because, stepsOf(r)[1].because].map((s) => s.toLowerCase());
    for (const s of sentences) expect(s.length).toBeGreaterThan(0);
    // the instruction belongs to exactly one of them
    expect(sentences.filter((s) => s.includes('straight line')).length).toBe(1);
  });
});

describe('qualityBand', () => {
  it('shows an absence of a number as an absence', () => {
    expect(qualityBand(NOTHING).display).toBe('--');
    expect(qualityBand(reading({ samples: 1 })).display).toMatch(/%$/);
    expect(qualityBand(reading({ quality: Number.NaN })).value).toBe(0);
    expect(qualityBand(reading({ quality: 4 })).value).toBe(1);
  });

  it('will not promise "nothing will be qualified" over a mount the results screen will qualify', () => {
    // `src/ui/results/model.ts` adds a "Mount looked unsteady" note for a suspect mount at ANY
    // confidence, so a sharp number over a suspect mount is not an uncaveated score.
    const sharpButShaking = reading({ quality: 0.86, mount: 'suspect', elapsedS: 40 });
    expect(qualityBand(sharpButShaking).label).not.toMatch(/nothing will be qualified/);
    expect(qualityBand(sharpButShaking).color).toBe('gold');
    expect(qualityBand(reading({ quality: 0.86, elapsedS: MOUNT_WARMUP_S - 0.1 })).color).toBe('cyan');
  });

  it('bands a resolved, rigid mount by the number', () => {
    expect(qualityBand(SHARP)).toMatchObject({ label: expect.stringMatching(/^Sharp/), color: 'green' });
    expect(qualityBand(reading({ quality: SHARP_QUALITY - 0.01 })).color).toBe('ember');
    expect(qualityBand(reading({ quality: TRUST_QUALITY - 0.01, calibrationOk: false })).color).toBe('red');
    // the band reads the engine's verdict rather than re-deriving the same threshold
    expect(qualityBand(reading({ quality: 0.9, calibrationOk: false })).color).toBe('red');
    expect(qualityBand(LOOSE).color).toBe('red');
    expect(qualityBand(LEVELLED).label).toMatch(/not resolved/);
  });
});

describe('lightsOf', () => {
  it('does not paint an absence of evidence red', () => {
    // With zero samples the vertical read red "No reading" beside a cyan "Listening" on the
    // mount, for the identical absence. Red is the danger colour (`theme.ts`).
    const [level, forward, mount] = lightsOf(NOTHING);
    expect(level).toMatchObject({ state: 'working', detail: 'Listening' });
    expect(forward.state).toBe('working');
    expect(mount).toMatchObject({ state: 'working', detail: 'Listening' });
    expect(lightsOf(NOTHING).some((l) => l.state === 'bad')).toBe(false);
  });

  it('goes red only when the engine has found something wrong', () => {
    expect(lightsOf(LOOSE)[2]).toMatchObject({ state: 'bad', detail: 'Moving' });
    expect(lightsOf(SHARP).map((l) => l.state)).toEqual(['on', 'on', 'on']);
  });

  it('keeps the forward detail short enough for one line', () => {
    for (const evidence of [0, 0.2, 0.4, 0.8]) {
      const d = lightsOf(reading({ forwardResolved: false, lineEvidenceS: evidence }))[1].detail;
      expect(d.length).toBeLessThanOrEqual(14);
    }
  });
});

describe('orientationOf / attitudeWords', () => {
  const G = 9.81;
  it('reads the phone frame the way src/engine/types.ts defines it', () => {
    // phone frame: x right, y top of screen, z out of the screen; gravity POINTS DOWN. So the
    // axis that gravity lies along is the edge that is resting on the floor.
    expect(orientationOf({ x: 0, y: -G, z: 0 }).rollDeg).toBeCloseTo(0, 3);
    expect(orientationOf({ x: G, y: 0, z: 0 }).rollDeg).toBeCloseTo(90, 3);
    expect(orientationOf({ x: -G, y: 0, z: 0 }).rollDeg).toBeCloseTo(-90, 3);
    expect(orientationOf({ x: 0, y: 0, z: -G }).reclineDeg).toBeCloseTo(90, 3);
    expect(orientationOf({ x: 0, y: 0, z: 0 }).has).toBe(false);
    expect(orientationOf({ x: Number.NaN, y: 0, z: 0 }).has).toBe(false);
  });

  it('calls the edge the phone is resting on by its own name', () => {
    // +x is the phone's RIGHT edge, so gravity along +x means the right edge is down. This read
    // "On its left edge" for eighteen months of this screen's life; the Skia glyph, which
    // rotates clockwise for a positive roll, was drawing the opposite of its own caption.
    const on = (g: { x: number; y: number; z: number }) => attitudeWords(reading({ ...orientationOf(g), gravity: g, gMag: G, has: true }));
    expect(on({ x: G, y: 0, z: 0 })).toBe('On its right edge · vertical');
    expect(on({ x: -G, y: 0, z: 0 })).toBe('On its left edge · vertical');
    expect(on({ x: 0, y: -G, z: 0 })).toBe('Upright · vertical');
    expect(on({ x: 0, y: G, z: 0 })).toBe('Upside down · vertical');
  });

  it('agrees with every mount the simulator can actually put the phone in', () => {
    // The regression test that would have caught it: the simulator states where each preset
    // puts the phone (`src/sim/sensors.ts`), so the words are checkable against the physics
    // rather than against themselves.
    const expected: Record<Exclude<MountPreset, 'random'>, RegExp> = {
      // upright in a vent clip, reclined ~15°
      'portrait-vent': /^Upright · 1[0-9]° back$/,
      // "portrait-vent rotated 90° CCW about the screen normal": the LEFT edge goes down
      'landscape-dash': /^On its left edge · 1[0-9]° back$/,
      // flat on the console, screen up
      'flat-console': /^Flat · screen up$/,
    };
    for (const [mount, pattern] of Object.entries(expected) as Array<[Exclude<MountPreset, 'random'>, RegExp]>) {
      const run = simulateRun('harbor', { seed: 1, laps: 1, mount });
      // average the parked first second: one sample carries vibration
      let x = 0;
      let y = 0;
      let z = 0;
      let n = 0;
      for (const m of run.motion) {
        if (m.t > run.motion[0].t + 1) break;
        x += m.gravity.x;
        y += m.gravity.y;
        z += m.gravity.z;
        n++;
      }
      const g = { x: x / n, y: y / n, z: z / n };
      const o = orientationOf(g);
      const words = attitudeWords(reading({ ...o, gravity: g, gMag: o.mag, has: o.has }));
      expect(`${mount}: ${words}`).toMatch(new RegExp(`^${mount}: ${pattern.source.slice(1, -1)}$`));
    }
  });

  it('keeps the flat words short enough to survive the one-line tag', () => {
    // `LYING FLAT, SCREEN UP` truncated to `LYING FLAT, SCREEN …`, losing the only word that
    // separates a phone face-up on a stuck pad from one lying face-down.
    const up = attitudeWords(reading({ reclineDeg: 86, has: true }));
    const down = attitudeWords(reading({ reclineDeg: -86, has: true }));
    expect(up).toBe('Flat · screen up');
    expect(down).toBe('Flat · screen down');
    for (const w of [up, down]) expect(w.length).toBeLessThanOrEqual(18);
    expect(attitudeWords(reading({ has: false }))).toBe('No reading yet');
  });
});

describe('cautionsOf', () => {
  it('does not accuse a mount the monitor has not judged', () => {
    const flatEarly = reading({ elapsedS: 1, reclineDeg: 86, mount: 'loose' });
    expect(mountVerdict(flatEarly)).toBe('unknown');
    expect(cautionsOf(flatEarly)[0]).toMatchObject({ tone: 'gold' });
    expect(cautionsOf(flatEarly)[0].body).not.toMatch(/already moving/);
  });

  it('is harsher once it has', () => {
    const flatLoose = reading({ elapsedS: 12, reclineDeg: 86, mount: 'loose' });
    expect(cautionsOf(flatLoose)[0]).toMatchObject({ tone: 'red' });
    expect(cautionsOf(flatLoose)[0].body).toMatch(/already moving/);
  });

  it('does not repeat a headline that is already saying it', () => {
    // the shaking mount is the headline on this frame, in the monitor's own words
    expect(phaseOf(CRADLE)).toBe('unsteady');
    expect(cautionsOf(CRADLE).some((c) => c.title === 'Mount looks unsteady')).toBe(false);
    // …but it still gets a banner when the headline is about something else
    const stillSeeking = reading({ elapsedS: 12, mount: 'suspect', forwardResolved: false, calibrationOk: false });
    expect(phaseOf(stillSeeking)).toBe('seeking');
    expect(cautionsOf(stillSeeking).some((c) => c.title === 'Mount looks unsteady')).toBe(true);
  });

  it('reports knocks and impossible gravity', () => {
    expect(cautionsOf(reading({ knocks: 1 })).some((c) => c.title === 'The phone was knocked')).toBe(true);
    expect(cautionsOf(reading({ knocks: 3 })).some((c) => c.title === 'The phone was knocked 3 times')).toBe(true);
    expect(cautionsOf(reading({ gMag: 14 })).some((c) => c.title === 'Gravity reads wrong')).toBe(true);
  });
});

describe('leaveOf', () => {
  it('does not promise the number will improve, because it does not', () => {
    // Measured over 2 tracks × 3 mounts × 8 seeds: the final confidence is BELOW the peak in
    // 48 of 48, median −0.017, worst −0.114. The old sentence was "the calibration keeps
    // sharpening during the run — nothing here is final".
    const note = leaveOf(SHARP).note;
    expect(note).not.toMatch(/sharpen|keeps? improving|nothing here is final/i);
    expect(note).toMatch(/peaks seconds after you drive off/);
    expect(leaveOf(SHARP)).toMatchObject({ primary: true, label: 'Done — drive' });
  });

  it('does not tell a driver with a loose mount that leaving is free', () => {
    // 0 of 24 runs at looseness ≥ 0.5 ever reached the engine's bar.
    expect(phaseOf(LOOSE)).toBe('blocked');
    const { label, note, primary } = leaveOf(LOOSE);
    expect(primary).toBe(false);
    expect(label).toBe('Drive without a score');
    expect(note).not.toMatch(/do not have to sit here|calibrates itself/i);
    expect(note).toMatch(/nothing in it is scored/i);
    expect(note.length).toBeLessThanOrEqual(90);
  });

  it('keeps the reassurance where it is true', () => {
    // A rigid mount really does finish by itself: 48 of 48 resolved the forward axis and
    // cleared the bar with no gesture at all.
    for (const r of [NOTHING, EARLY, LEVELLED]) {
      expect(leaveOf(r)).toMatchObject({ primary: false, label: 'Finish it while driving' });
      expect(leaveOf(r).note).toMatch(/calibrates itself/);
    }
  });

  it('tells a shaking mount what it is trading', () => {
    expect(leaveOf(CRADLE)).toMatchObject({ primary: false, label: 'Drive anyway' });
    expect(leaveOf(CRADLE).note).toMatch(/cradle/);
  });

  it('keeps every note short enough for the landscape rail', () => {
    // 296 pt at 14 px Barlow is ~45 characters a line, and the rail allows two.
    for (const r of [NOTHING, EARLY, LEVELLED, CRADLE, LOOSE, SHARP]) expect(leaveOf(r).note.length).toBeLessThanOrEqual(90);
  });
});

describe('FAULTS', () => {
  const kinds: CalibrationFaultKind[] = ['permission', 'location', 'unsupported', 'services', 'failed'];

  it('has one entry per kind, keyed by itself', () => {
    expect(Object.keys(FAULTS).sort()).toEqual([...kinds].sort());
    for (const k of kinds) expect(FAULTS[k].kind).toBe(k);
  });

  it('opens the Settings its own sentence names', () => {
    // OPEN SETTINGS used to reach the app's own settings screen on every fault, including the
    // two whose body sends the driver to the phone's Settings.
    expect(FAULTS.permission.destination).toBe('phone-settings');
    expect(FAULTS.location.destination).toBe('phone-settings');
    expect(FAULTS.services.destination).toBe('phone-settings');
    expect(FAULTS.unsupported.destination).toBe('app-settings');
    for (const k of kinds) {
      const f = FAULTS[k];
      const phone = /phone’s Settings|Privacy & Security/.test(f.body);
      expect(phone ? 'phone-settings' : f.destination).toBe(f.destination);
      if (f.destination === 'phone-settings') expect(f.actionLabel).toMatch(/iPhone/);
    }
  });

  it('names one action, first, in every fault', () => {
    // `services` explained the physics and never said what to do — the only fault with no
    // instruction, on the screen whose whole job is to give one.
    for (const k of kinds) {
      const first = FAULTS[k].body.split(' ')[0];
      expect(['Turn', 'Allow', 'Switch', 'Close', 'Open']).toContain(first);
    }
  });

  it('offers a retry only where one could work', () => {
    expect(FAULTS.unsupported.retryable).toBe(false);
    for (const k of ['permission', 'location', 'services', 'failed'] as CalibrationFaultKind[]) expect(FAULTS[k].retryable).toBe(true);
  });

  it('keeps motion and location apart', () => {
    expect(FAULTS.permission.title).toMatch(/Motion/);
    expect(FAULTS.permission.body).toMatch(/Motion & Fitness/);
    expect(FAULTS.location.title).toMatch(/Location/);
    expect(FAULTS.location.body).not.toMatch(/Motion & Fitness/);
  });

  it('is what the headline shows', () => {
    for (const k of kinds) {
      const h = headlineOf(reading({ fault: FAULTS[k] }));
      expect(h).toMatchObject({ kicker: 'Cannot calibrate', title: FAULTS[k].title, color: 'red' });
    }
  });
});

describe('faultForError', () => {
  it('does not send a denied LOCATION permission to the motion switch', () => {
    // `deviceSensorSource.ts` threw one 'permission-denied' for both, so a driver whose
    // location was denied read "Motion access is off / Turn on Motion & Fitness" — told to fix
    // the sensor that already works.
    expect(faultForError(new SensorSourceError('permission-denied', 'm'))).toBe(FAULTS.permission);
    expect(faultForError(new SensorSourceError('location-permission-denied', 'l'))).toBe(FAULTS.location);
  });

  it('does not offer a gyro-less phone a retry that cannot succeed', () => {
    // 'unavailable' fell into the default branch and came back as "Sensors would not start /
    // Close anything else reading the sensors, then try again" — a title contradicting its own
    // body, and a retryable fault that can never clear.
    const f = faultForError(new SensorSourceError('unavailable', 'This device has no usable motion sensors.'));
    expect(f).toBe(FAULTS.unsupported);
    expect(f.retryable).toBe(false);
    expect(faultForError(new SensorSourceError('unsupported', 'x'))).toBe(FAULTS.unsupported);
  });

  it('keeps the real reason when there is one', () => {
    expect(faultForError(new SensorSourceError('services-disabled', 'x'))).toBe(FAULTS.services);
    expect(faultForError(new SensorSourceError('failed', 'the stream died'))).toMatchObject({ kind: 'failed', body: 'the stream died', retryable: true });
    expect(faultForError(new Error('boom'))).toMatchObject({ kind: 'failed', body: 'boom' });
    expect(faultForError('nope')).toMatchObject({ kind: 'failed', body: 'nope' });
  });
});

describe('arrivalOf', () => {
  it('leads with what happened, for each way in', () => {
    expect(arrivalOf(null)).toBeNull();
    for (const why of ['rejected', 'loose', 'unresolved', 'suspect'] as const) {
      const a = arrivalOf(why)!;
      expect(a.title.length).toBeGreaterThan(0);
      expect(a.body.length).toBeGreaterThan(0);
      expect(['red', 'gold']).toContain(a.tone);
    }
  });
});

/**
 * THE CLASS, not the line.
 *
 * Both severity-1s on this screen were "an absence of evidence, or an engine's internal
 * permissiveness, reported as an assertion about the world". The first was in `phaseOf`, the
 * second in `stepsOf` after `phaseOf` had been fixed. So this sweeps every reading the screen
 * can hold and asserts the property across all of them, rather than asserting the two frames
 * somebody happened to photograph.
 */
describe('nothing is claimed without evidence', () => {
  const readings: CalibrationReading[] = [];
  for (const samples of [0, 1, 1200]) {
    for (const elapsedS of [0, 1, MOUNT_WARMUP_S - 0.01, MOUNT_WARMUP_S, 40]) {
      for (const mount of ['rigid', 'suspect', 'loose'] as const) {
        for (const forwardResolved of [false, true]) {
          for (const calibrationOk of [false, true]) {
            for (const quality of [0, 0.1, 0.29, 0.5, 0.86]) {
              readings.push(reading({ samples, elapsedS, mount, forwardResolved, calibrationOk, quality, has: samples > 0, upQuality: samples > 0 ? 0.9 : 0 }));
            }
          }
        }
      }
    }
  }

  it('covers the grid', () => {
    expect(readings.length).toBe(3 * 5 * 3 * 2 * 2 * 5);
  });

  it('never ticks a step, or says READY, without a rigid verdict', () => {
    for (const r of readings) {
      if (mountIsRigid(r)) continue;
      expect([phaseOf(r), stepsOf(r)[0].state]).toEqual([expect.not.stringMatching(/^ready$/), 'active']);
    }
  });

  it('never says READY without the engine’s own two conditions', () => {
    for (const r of readings) {
      if (phaseOf(r) !== 'ready') continue;
      expect(r.calibrationOk).toBe(true);
      expect(r.forwardResolved).toBe(true);
      expect(r.samples).toBeGreaterThan(0);
      expect(mountVerdict(r)).toBe('rigid');
    }
  });

  it('never paints a light red for something the engine has not found', () => {
    for (const r of readings) {
      for (const l of lightsOf(r)) {
        if (l.state !== 'bad') continue;
        // the only red light is the mount, and only on a delivered 'loose' verdict
        expect(l.key).toBe('mount');
        expect(mountVerdict(r)).toBe('loose');
      }
    }
  });

  it('never shows a number it does not have, and never hides one it does', () => {
    for (const r of readings) {
      expect(qualityBand(r).display === '--').toBe(r.samples === 0);
      expect(Number.isFinite(qualityBand(r).value)).toBe(true);
    }
  });

  it('gives every reading exactly one phase, one headline and one way out', () => {
    for (const r of readings) {
      const p = phaseOf(r);
      expect(['failed', 'blocked', 'unsteady', 'ready', 'seeking', 'levelling', 'starting']).toContain(p);
      const h = headlineOf(r);
      expect(h.title.length).toBeGreaterThan(0);
      expect(h.because.length).toBeGreaterThan(0);
      const l = leaveOf(r);
      expect(l.label.length).toBeGreaterThan(0);
      expect(l.note.length).toBeGreaterThan(0);
      // only the finished state gets the ember slab
      expect(l.primary).toBe(p === 'ready');
    }
  });

  it('agrees with itself: the light, the step and the headline tell one story', () => {
    for (const r of readings) {
      const mountLight = lightsOf(r)[2];
      const ticked = stepsOf(r)[0].state === 'done';
      if (ticked) expect(mountLight.detail).toBe('Rigid');
      if (mountLight.detail === 'Listening') expect(ticked).toBe(false);
      if (phaseOf(r) === 'ready') expect(qualityBand(r).color).not.toBe('red');
    }
  });
});
