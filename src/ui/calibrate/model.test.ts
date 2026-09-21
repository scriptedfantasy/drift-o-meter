/**
 * The calibration screen's words, tested as words.
 *
 * `model.ts` is React-free on purpose — "so the wording can be reasoned about (and read) on its
 * own" — and for four hundred lines of pure decision logic it had no test at all. The severity-1
 * that failed this screen the first time lived in `phaseOf`; the one that failed it the second
 * time was the identical mistake in `stepsOf`, one component over. So this file tests the CLASS
 * as well as the cases: the sweep asserts across every combination of readings that nothing here
 * reports an absence of evidence as a verdict, which is the shape both bugs had.
 *
 * AND THEN A FIXTURE CANNOT BE THE TEST. The third severity-1 was that every mount-titled row on
 * this screen printed a sentence about something else — 100 % of caution frames — and nothing
 * here could catch it, because the fixtures were hand-written: one of them paired
 * `mount: 'suspect'` with `message: 'Mount looks solid'`, a banner the engine can never produce,
 * and the test that used it asserted only the title. So the last block in this file drives every
 * branch from a REAL `MountCalibrator` + `IntegrityMonitor` replay (`testkit.ts`), asserts the
 * claims are TRUE rather than merely present, and asserts that the replays reach every branch —
 * so a test that has stopped being able to fail shows up as a coverage failure.
 */
import { describe, expect, it } from 'vitest';

import { SensorSourceError } from '../../platform/sensorSource';
import { simulateRun, type MountPreset } from '../../sim';
import { replayReadings, type Frame } from './testkit';
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
  orientationOf,
  phaseOf,
  qualityBand,
  SHARP_QUALITY,
  stepsOf,
  TRUST_QUALITY,
  type CalibrationFaultKind,
  type CalibrationReading,
  type CalibrationPhase,
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
    upAged: true,
    quality: 0.7,
    peakQuality: 0.7,
    forwardResolved: true,
    calibrationOk: true,
    mount: 'rigid',
    mountConfident: true,
    // A rigid mount past the bar: the monitor has nothing to say ABOUT THE MOUNT, and the one
    // line it does say is about everything. `message: 'Mount looks solid'` used to sit here,
    // which is a sentence `IntegrityMonitor.composeMessage` cannot produce on any input.
    message: 'Sensors look good — phone is solid and GPS is locked',
    mountMessage: '',
    ...over,
  };
}

/** Measured states, from `npx tsx tools/analysis/calibration-sweep.ts` and the harness routes. */
const NOTHING = { ...IDLE_READING };
/** `?sim=harbor&at=0.5` — gravity seen, the mount cues still filling, nothing worked out. */
const EARLY = reading({
  samples: 50, elapsedS: 0.5, upQuality: 0.5, upAged: false, quality: 0.05, peakQuality: 0.05,
  forwardResolved: false, calibrationOk: false, mountConfident: false,
  message: "Can't tell which way the car points — mount the phone firmly and drive straight for a few seconds",
});
/** `?sim=harbor&looseness=1&at=2` — a real hand-held recording, cues not yet confident. */
const HANDHELD_EARLY = reading({
  samples: 200, elapsedS: 2, upQuality: 0.55, upAged: true, quality: 0.09, peakQuality: 0.09,
  forwardResolved: false, calibrationOk: false, mount: 'loose', mountConfident: false, handheld: true,
  message: "Can't tell which way the car points — mount the phone firmly and drive straight for a few seconds",
  mountMessage: 'Phone looks hand-held — clip it into a rigid mount to score drifts',
});
/** `?sim=harbor&at=3` — the vertical has settled, the forward axis has not resolved. */
const LEVELLED = reading({
  samples: 300, elapsedS: 3, upQuality: 0.9, quality: 0.28, peakQuality: 0.28, forwardResolved: false, calibrationOk: false,
  message: "Can't tell which way the car points — mount the phone firmly and drive straight for a few seconds",
});
/** `?sim=touge&looseness=0.2&at=40` — confidence 34 %, forward resolved, mount 'suspect'. */
const CRADLE = reading({
  elapsedS: 40, quality: 0.339, peakQuality: 0.352, mount: 'suspect',
  message: 'Phone may be shifting in its mount — check it is tight',
  mountMessage: 'Phone may be shifting in its mount — check it is tight',
});
/** `?sim=harbor&looseness=1&at=12` — hand-held, cues confident. */
const LOOSE = reading({
  quality: 0.03, peakQuality: 0.06, forwardResolved: false, calibrationOk: false, mount: 'loose', handheld: true,
  message: 'Phone looks hand-held — clip it into a rigid mount to score drifts',
  mountMessage: 'Phone looks hand-held — clip it into a rigid mount to score drifts',
});
/** The best seed measured at the simulator's default vibration: 0.864. */
const SHARP = reading({ quality: 0.864, peakQuality: 0.864 });
/** A flat phone on a console, from `?mount=flat-console`. */
const FLAT = reading({ gravity: { x: 0.64, y: 0.07, z: -9.78 }, rollDeg: 96.3, reclineDeg: 86.3, quality: 0.68, peakQuality: 0.68 });

describe('phaseOf', () => {
  it('claims nothing with no samples', () => {
    // `IntegrityMonitor` starts with calibrationOk true so it cannot veto a run it has not
    // seen. That is not a verdict, and this must not read it as one.
    expect(IDLE_READING.calibrationOk).toBe(false);
    expect(phaseOf(NOTHING)).toBe('starting');
    expect(phaseOf(reading({ samples: 0, has: false, calibrationOk: true, forwardResolved: true }))).toBe('starting');
  });

  it('is not READY while the mount verdict is still unknown', () => {
    // and the SCREEN does not decide when that is: `mountConfident` is the monitor's own word
    // for "the cues have a full window behind them", so no wall-clock guard lives here.
    const warming = reading({ mountConfident: false });
    expect(mountVerdict(warming)).toBe('unknown');
    expect(phaseOf(warming)).toBe('unsteady');
    expect(phaseOf(reading({ mountConfident: true }))).toBe('ready');
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
    expect(headlineOf(LOOSE)).toMatchObject({ title: 'Hand-held', because: LOOSE.mountMessage, color: 'red' });
    expect(headlineOf(reading({ mount: 'loose', handheld: false, mountMessage: 'm' })).title).toBe('Loose mount');
    expect(headlineOf(CRADLE)).toMatchObject({ title: 'Mount shaking', because: CRADLE.mountMessage, color: 'gold' });
    // and it quotes the MOUNT sentence, not the root-cause one: `message` answers a different
    // question and printed "GPS signal lost 5 s ago" under MOUNT SHAKING on 2.7 % of frames.
    const shakingWithNoFix = reading({ mount: 'suspect', message: 'GPS signal lost 5 s ago — waiting for it to come back', mountMessage: 'Phone may be shifting in its mount — check it is tight' });
    expect(headlineOf(shakingWithNoFix).because).toBe(shakingWithNoFix.mountMessage);
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
    expect(qualityBand(reading({ quality: 0.86, mountConfident: false })).color).toBe('cyan');
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
    const flatEarly = reading({ elapsedS: 1, reclineDeg: 86, mount: 'loose', mountConfident: false });
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
    const stillSeeking = reading({
      elapsedS: 12, mount: 'suspect', forwardResolved: false, calibrationOk: false,
      message: "Can't tell which way the car points — mount the phone firmly and drive straight for a few seconds",
      mountMessage: 'Phone may be shifting in its mount — check it is tight',
    });
    expect(phaseOf(stillSeeking)).toBe('seeking');
    const banner = cautionsOf(stillSeeking).find((c) => c.title === 'Mount looks unsteady');
    // THE COUPLING, which is what was missing: a banner titled about the mount says what the
    // monitor says about the MOUNT. Quoting `message` here printed the forward-axis sentence
    // on 105,439 of 105,439 measured frames — and structurally so, because the only way to
    // reach this branch is for `calibrationOk` to be false, which is the cause that outranks it.
    expect(banner?.body).toBe(stillSeeking.mountMessage);
    expect(banner?.body).not.toBe(stillSeeking.message);
  });

  it('gives a GPS condition its own row instead of a mount banner\u2019s body', () => {
    // This screen has no GPS light, so before this the only place a dropout surfaced was under
    // a mount heading. The words are the monitor's; the title names GPS.
    const lost = reading({ gps: 'none', gpsMessage: 'GPS signal lost 5 s ago — waiting for it to come back' });
    expect(cautionsOf(lost).map((c) => c.title)).toContain('No GPS fix');
    expect(cautionsOf(lost).find((c) => c.title === 'No GPS fix')!.body).toBe(lost.gpsMessage);
    const vague = reading({ gps: 'poor', gpsMessage: 'GPS accuracy is poor (±16 m) — drift angles may be off' });
    expect(cautionsOf(vague).map((c) => c.title)).toContain('GPS is vague');
    // and nothing is drawn while the monitor has nothing to say — which is the normal first
    // seconds of a session, before a first fix is late rather than missing.
    expect(cautionsOf(reading({ gps: 'none', gpsMessage: '' })).some((c) => /GPS/.test(c.title))).toBe(false);
  });

  it('reports knocks and impossible gravity', () => {
    expect(cautionsOf(reading({ knocks: 1 })).some((c) => c.title === 'The phone was knocked')).toBe(true);
    expect(cautionsOf(reading({ knocks: 3 })).some((c) => c.title === 'The phone was knocked 3 times')).toBe(true);
    expect(cautionsOf(reading({ gMag: 14 })).some((c) => c.title === 'Gravity reads wrong')).toBe(true);
  });

  it('does not promise a knock cost nothing on a frame that says it cost everything', () => {
    // "Nothing is lost" was unconditional, ~200 px above a footer reading "Leave now and
    // nothing in it is scored", on a 0 % frame.
    const lost = cautionsOf(reading({ knocks: 1, quality: 0, peakQuality: 0, calibrationOk: false, forwardResolved: false })).find((c) => /knocked/.test(c.title))!;
    expect(lost.body).not.toMatch(/Nothing is lost/i);
    expect(lost.body).toMatch(/not caught up/);
    expect(cautionsOf(reading({ knocks: 1 })).find((c) => /knocked/.test(c.title))!.body).toMatch(/caught up/);
  });
});

describe('leaveOf', () => {
  it('claims nothing about the number it cannot back on the frame it is read', () => {
    // Two absolutes have now been wrong here in opposite directions: "the calibration keeps
    // sharpening during the run" (the final value is below the peak in 48 of 48) and then "it
    // peaks seconds after you drive off, and NEVER climbs later" (read at first READY, which
    // lands at 4.6–5.3 s while the peak lands at 5.1–8.0 s — so it climbs afterwards in 33 of
    // 48 runs, worst +0.209, and the screen's own band flips trusted → sharp under the word
    // "never" in 22 of 48). What is left is a fact the engine publishes and a direction that
    // holds both ways.
    const note = leaveOf(SHARP).note;
    expect(note).not.toMatch(/sharpen|keeps? improving|nothing here is final|never|as sharp as it gets|peaks/i);
    expect(note).toMatch(/^Best so far 86%\./);
    // and the number in it is the ENGINE's running peak, not the current reading
    expect(leaveOf(reading({ quality: 0.59, peakQuality: 0.8 })).note).toMatch(/^Best so far 80%\./);
    expect(leaveOf(SHARP)).toMatchObject({ primary: true, label: 'Drive' });
  });

  it('gives the slab to the action, not to a state a parked driver cannot reach', () => {
    // 288 measured runs resolved the forward axis with no gesture, at 5.1–6.1 s of DRIVING, so
    // READY only ever arrives after the driver has left. Reserving the ember slab for it, and
    // calling it "Done", put the loudest button on the screen out of reach and then claimed a
    // step the driver had not taken.
    for (const r of [NOTHING, EARLY, LEVELLED, SHARP]) {
      expect(leaveOf(r).primary).toBe(true);
      expect(leaveOf(r).label).toBe('Drive');
      expect(leaveOf(r).label).not.toMatch(/done/i);
    }
    // the two states where the screen has something better to offer keep the quiet button
    expect(leaveOf(LOOSE).primary).toBe(false);
    expect(leaveOf(CRADLE).primary).toBe(false);
  });

  it('does not promise a shaking mount will calibrate itself, because it usually does not', () => {
    // The reassurance was measured on RIGID runs. On a mount the monitor calls `suspect` and
    // which has not cleared the engine's bar, it went on saying "the run calibrates itself
    // before the first corner" for 54,289 frames across 31 measured runs — 3 of which ever
    // reached READY.
    const shakingUnderTheBar = reading({
      mount: 'suspect', quality: 0.29, peakQuality: 0.3, calibrationOk: false, forwardResolved: false,
      message: "Can't tell which way the car points — mount the phone firmly and drive straight for a few seconds",
      mountMessage: 'Phone may be shifting in its mount — check it is tight',
    });
    expect(phaseOf(shakingUnderTheBar)).toBe('seeking');
    expect(mountVerdict(shakingUnderTheBar)).toBe('suspect');
    const l = leaveOf(shakingUnderTheBar);
    expect(l.note).not.toMatch(/calibrates itself/);
    expect(l.note).toMatch(/holds it under the bar/);
    expect(l).toMatchObject({ primary: false, label: 'Drive anyway' });
  });

  it('does not name a cradle the engine has not judged', () => {
    // `leaveOf` switched on the phase alone, so an `unsteady` phase whose mount verdict is
    // still `unknown` printed "part of every angle is the cradle" on the same frame whose
    // headline correctly said "Still listening".
    const warming = reading({ mount: 'suspect', mountConfident: false });
    expect(phaseOf(warming)).toBe('unsteady');
    expect(mountVerdict(warming)).toBe('unknown');
    expect(headlineOf(warming).title).toBe('Still listening');
    expect(leaveOf(warming).note).not.toMatch(/cradle/);
    expect(leaveOf(warming).primary).toBe(true);
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
      expect(leaveOf(r)).toMatchObject({ primary: true, label: 'Drive' });
      expect(leaveOf(r).note).toMatch(/calibrates itself/);
    }
  });

  it('tells a shaking mount what it is trading', () => {
    expect(mountVerdict(CRADLE)).toBe('suspect');
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
    for (const mountConfident of [false, true]) {
      for (const mount of ['rigid', 'suspect', 'loose'] as const) {
        for (const forwardResolved of [false, true]) {
          for (const calibrationOk of [false, true]) {
            for (const quality of [0, 0.1, 0.29, 0.5, 0.86]) {
              readings.push(
                reading({
                  samples,
                  elapsedS: samples ? 40 : 0,
                  mountConfident,
                  mount,
                  forwardResolved,
                  calibrationOk,
                  quality,
                  peakQuality: quality,
                  has: samples > 0,
                  upQuality: samples > 0 ? 0.9 : 0,
                  upAged: samples > 0 && quality > 0,
                  // the per-topic sentence the monitor would publish for this mount
                  mountMessage: mount === 'loose' ? 'Phone is moving in its mount — tighten it' : mount === 'suspect' ? 'Phone may be shifting in its mount — check it is tight' : '',
                }),
              );
            }
          }
        }
      }
    }
  }

  it('reaches every phase, so the assertions below have something to bite on', () => {
    // `expect(readings.length).toBe(3 * 5 * 3 * 2 * 2 * 5)` used to sit here, which restates
    // the loop bounds above it and cannot fail. What a coverage check is FOR is noticing when
    // a grid has stopped reaching a branch, so it asserts the branches.
    const phases = new Set(readings.map(phaseOf));
    expect([...phases].sort()).toEqual(['blocked', 'levelling', 'ready', 'seeking', 'starting', 'unsteady']);
    expect(new Set(readings.map(mountVerdict))).toEqual(new Set(['unknown', 'rigid', 'suspect', 'loose']));
    expect(new Set(readings.flatMap((r) => lightsOf(r).map((l) => l.state)))).toEqual(new Set(['on', 'working', 'warn', 'bad']));
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
        if (l.state === 'bad') {
          // the only red light is the mount, and only on a delivered 'loose' verdict
          expect(l.key).toBe('mount');
          expect(mountVerdict(r)).toBe('loose');
        }
        // gold is for a verdict too — never for an absence of one
        if (l.state === 'warn') expect([l.key, mountVerdict(r)]).toEqual(['mount', 'suspect']);
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
      // `expect(l.note.length).toBeGreaterThan(0)` used to be the whole of this: proof that a
      // string existed, on a function whose entire contract is that the string is TRUE in this
      // phase. Every branch's claim is now checked against the state it is claimed about.
      const mount = mountVerdict(r);
      if (p === 'ready') {
        expect(l.note).toBe(`Best so far ${Math.round(r.peakQuality * 100)}%. It moves both ways as you drive — past the bar is what counts.`);
      } else if (p === 'blocked') {
        expect(mount).toBe('loose');
        expect(l.note).toMatch(/nothing in it is scored/);
      } else if (mount === 'suspect') {
        // a cradle the engine HAS judged, and what it costs depends on the engine's own verdict
        expect(l.note).toMatch(/cradle/);
        expect(l.note).toMatch(r.calibrationOk ? /part of every angle/ : /holds it under the bar/);
      } else {
        // nothing else may name a cradle, a lost run, or a number it is not showing
        expect(l.note).not.toMatch(/cradle|nothing in it is scored|Best so far/);
        // …and only a mount the engine has not objected to gets the self-calibration promise
        if (/calibrates itself/.test(l.note)) expect(mount).not.toBe('suspect');
      }
      // and no note in any phase promises the number will get better
      expect(l.note).not.toMatch(/sharpen|keeps? improving|never climbs|as sharp as it gets|peaks seconds/i);
      // the slab is the action, and it is withheld only where the screen has a better offer
      expect(l.primary).toBe(!(p === 'blocked' || mount === 'suspect'));
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

/**
 * DRIVEN BY THE ENGINE, not by a fixture.
 *
 * Everything above hands `model.ts` a `CalibrationReading` somebody typed. That is how the
 * third severity-1 survived a 559-line suite: the fixture for "a shaking mount whose headline
 * is about something else" carried `message: 'Mount looks solid'`, a sentence
 * `IntegrityMonitor` cannot produce on any input, and the test asserted only the title — so
 * the suite was green while every mount-titled row on the screen printed a forward-axis
 * sentence, on 105,439 of 105,439 caution frames.
 *
 * These readings come out of a real `MountCalibrator` + `IntegrityMonitor` fed a simulated
 * recording, with every field filled exactly as `useCalibration.publish` fills it. Five
 * recordings reach every branch this screen has; the first test asserts that they do, so a
 * branch that stops being exercised fails here rather than quietly going untested.
 */
describe('against a real MountCalibrator + IntegrityMonitor replay', () => {
  const RIGID = replayReadings({ track: 'harbor', mount: 'portrait-vent', seed: 1 });
  const FLAT_RUN = replayReadings({ track: 'touge', mount: 'flat-console', seed: 2 });
  // looseness 0.2, not 0.25: at 0.25 the confidence itself falls under the engine's bar, so the
  // phase is `seeking` and the `unsteady` branch never runs. 0.2 is the band
  // `docs/ARCHITECTURE.md` names — scorable, and inflated by sway that nothing else flags.
  const SHAKING = replayReadings({ track: 'touge', mount: 'portrait-vent', seed: 3, looseness: 0.2 });
  const HELD = replayReadings({ track: 'harbor', mount: 'portrait-vent', seed: 1, looseness: 1 });
  const DROPOUTS = replayReadings({ track: 'harbor', mount: 'portrait-vent', seed: 2, dropouts: true });
  const ALL: Frame[] = [...RIGID, ...FLAT_RUN, ...SHAKING, ...HELD, ...DROPOUTS];

  /** Every sentence `IntegrityMonitor` can publish about a mount, and nothing else. */
  const MOUNT_SENTENCES = new Set([
    'Phone looks hand-held \u2014 clip it into a rigid mount to score drifts',
    'Phone is moving in its mount \u2014 tighten it',
    'Phone may be shifting in its mount \u2014 check it is tight',
  ]);

  it('reaches every phase, every mount verdict and every light state', () => {
    const phases = new Set(ALL.map((f) => phaseOf(f.reading)));
    // `starting` is the state before the first sample, which a replay by definition never
    // publishes; `IDLE_READING` covers it above. `failed` needs a sensor that will not open.
    for (const p of ['levelling', 'seeking', 'ready', 'unsteady', 'blocked'] as CalibrationPhase[]) {
      expect(`${p}: ${phases.has(p)}`).toBe(`${p}: true`);
    }
    expect(new Set(ALL.map((f) => mountVerdict(f.reading)))).toEqual(new Set(['unknown', 'rigid', 'suspect', 'loose']));
    expect(new Set(ALL.flatMap((f) => lightsOf(f.reading).map((l) => l.state)))).toEqual(new Set(['on', 'working', 'warn', 'bad']));
    // and a GPS row really does appear, which is what the dropout recording is for
    expect(DROPOUTS.some((f) => cautionsOf(f.reading).some((c) => /GPS/.test(c.title)))).toBe(true);
  });

  it('never puts a sentence about something else under a heading about the mount', () => {
    // THE CLASS. Not "the caution is right on this fixture" — every frame of every recording,
    // for every row this screen heads with the mount.
    let checked = 0;
    for (const f of ALL) {
      const h = headlineOf(f.reading);
      if (h.kicker === 'Mount' && h.title !== 'Still listening') {
        expect(`${h.title} / ${h.because}`).toBe(`${h.title} / ${f.reading.mountMessage}`);
        expect(MOUNT_SENTENCES.has(h.because)).toBe(true);
        checked++;
      }
      for (const c of cautionsOf(f.reading)) {
        if (!/mount/i.test(c.title)) continue;
        expect(MOUNT_SENTENCES.has(c.body)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('never puts a mount sentence under a heading about GPS', () => {
    let checked = 0;
    for (const f of ALL) {
      for (const c of cautionsOf(f.reading)) {
        if (!/GPS/.test(c.title)) continue;
        expect(c.body).toBe(f.reading.gpsMessage);
        expect(MOUNT_SENTENCES.has(c.body)).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('says nothing unsteady about a mount the simulator bolted down', () => {
    // The 4 s warm-up was shorter than the artefact it was sized to hide: 30 of 48 rigid runs
    // still read `suspect` past it, to 4.81 s, so a bolted phone got the gold banner the guard
    // existed to prevent. The artefact is fixed in `MountCalibrator` now, and this asserts the
    // consequence rather than the guard: on a rigid recording nothing ever says otherwise.
    for (const f of [...RIGID, ...FLAT_RUN]) {
      expect(`${f.t.toFixed(2)}s ${mountVerdict(f.reading)}`).not.toMatch(/suspect|loose/);
      expect(`${f.t.toFixed(2)}s ${headlineOf(f.reading).title}`).not.toMatch(/shaking|Loose|Hand-held/);
      expect(lightsOf(f.reading)[2].state).not.toBe('warn');
    }
  });

  it('is READY only with the vertical settled, so the light cannot contradict the headline', () => {
    // `SETTLED_UP = 0.6` was the last threshold this screen owned on an engine quantity, and
    // it disagreed with the screen's own headline on 72–100 % of READY frames at looseness
    // 0.1–0.15, because `upQuality` is age × accelerometer fit and a rattling cradle spoils
    // the fit. `upSettled` asks only the question the light asks.
    let ready = 0;
    for (const f of [...RIGID, ...SHAKING, ...DROPOUTS, ...replayReadings({ track: 'harbor', mount: 'landscape-dash', seed: 4, looseness: 0.1 })]) {
      if (phaseOf(f.reading) !== 'ready') continue;
      ready++;
      expect(`${f.t.toFixed(2)}s ${lightsOf(f.reading)[0].detail}`).toBe(`${f.t.toFixed(2)}s Settled`);
    }
    expect(ready).toBeGreaterThan(100);
  });

  it('tells the truth about the number on every frame it is read, not on the last one', () => {
    // The previous sentence was measured by comparing FINAL to PEAK and then read at FIRST
    // READY — a sound measurement answering a different question. This asserts the claim where
    // it is made: on each READY frame the note's number is the best the calibration has
    // actually reached by that instant.
    let total = 0;
    for (const run of [RIGID, FLAT_RUN, DROPOUTS]) {
      let best = 0;
      let readyFrames = 0;
      for (const f of run) {
        if (f.reading.quality > best) best = f.reading.quality;
        if (phaseOf(f.reading) !== 'ready') continue;
        readyFrames++;
        const claimed = leaveOf(f.reading).note.match(/^Best so far (\d+)%/);
        expect(`${f.t.toFixed(2)}s ${claimed?.[1]}`).toBe(`${f.t.toFixed(2)}s ${Math.round(best * 100)}`);
      }
      total += readyFrames;
    }
    // and the number really does move under the sentence: the run that motivated this climbs
    // +0.209 after its first READY frame, which is why no absolute belongs in it.
    expect(total).toBeGreaterThan(1000);
  });

  it('agrees with itself on every frame of every recording', () => {
    for (const f of ALL) {
      const r = f.reading;
      const where = `${f.t.toFixed(2)}s`;
      const phase = phaseOf(r);
      const mount = mountVerdict(r);
      // a tick is a verdict
      if (stepsOf(r)[0].state === 'done') expect(`${where} ${mount}`).toBe(`${where} rigid`);
      // READY is the engine's own two conditions plus a rigid mount
      if (phase === 'ready') expect(`${where} ${r.calibrationOk} ${r.forwardResolved} ${mount}`).toBe(`${where} true true rigid`);
      // the headline, the band and the way out never describe three different mounts
      if (mount === 'suspect' && r.forwardResolved) expect(`${where} ${qualityBand(r).color}`).toBe(`${where} gold`);
      if (phase === 'blocked' || mount === 'suspect') expect(`${where} ${leaveOf(r).primary}`).toBe(`${where} false`);
      // the self-calibration promise is measured on rigid runs, so it is only made about them
      if (/calibrates itself/.test(leaveOf(r).note)) expect(`${where} ${mount}`).not.toMatch(/suspect|loose/);
      // every way-out note fits the landscape rail
      expect(`${where} ${leaveOf(r).note.length <= 90}`).toBe(`${where} true`);
    }
  });
});
