/**
 * What the calibration screen says, derived from what the engine reports. Pure: no React, no
 * sensors, so the wording can be reasoned about (and read) on its own.
 *
 * Two things here are deliberately NOT invented:
 *
 *  • the bar. "Calibrated" means the bar the ENGINE uses to trust a run — `calibrationOk` in
 *    `IntegrityMonitor`, i.e. `quality >= DEFAULT_INTEGRITY_OPTIONS.minCalibrationQuality` and a
 *    resolved forward axis. Below it the monitor refuses to believe any slide, whatever the
 *    screen claims; above it every angle counts. A prettier, higher number would be a screen
 *    inventing its own standard. (`docs/DESIGN.md` says 0.8. There is no fixed ceiling to gate
 *    on instead: over 2 tracks × 3 mounts × 8 seeds at the simulator's default vibration —
 *    `npx tsx tools/analysis/calibration-sweep.ts ceiling` — peak confidence runs 0.618 to
 *    0.864, median 0.750, so a 0.8 gate lights on 9 runs in 48 and a 0.74 one on 31. The
 *    spread, not a ceiling, is the fact; the engine naming its own bar is the fix.)
 *  • the words for a loose or shaking mount. They are `IntegrityMonitor`'s own message,
 *    verbatim, so this screen and the HUD never describe the same condition differently.
 *
 * ONE RULE RUNS THROUGH ALL OF IT: an absence of evidence is never reported as a verdict. The
 * monitor starts permissive (`calibrationOk` true before it has seen a sample, `mount` 'rigid'
 * before its averages have filled) so that it cannot veto a run it knows nothing about — that
 * is the engine declining to object, not the engine asserting a good mount, and this screen may
 * not repeat it as one. Every function below reads `mountVerdict`, which says 'unknown' until
 * the cues mean something, and 'unknown' is a pass NOWHERE.
 */
import { DEFAULT_INTEGRITY_OPTIONS, type GpsState, type MountState } from '../../engine/integrity';
import { DEFAULT_MOUNT_OPTIONS } from '../../engine/mount';
import type { Vec3 } from '../../engine/types';
import { G } from '../../engine/types';
// the bare module, never the `platform` barrel: that one reaches expo-sensors and this file
// has to stay importable by a plain node test.
import { describeSensorError, SensorSourceError } from '../../platform/sensorSource';
import type { CalibrateReason } from './params';

/** The bar the engine itself uses before it will believe a slide. */
export const TRUST_QUALITY = DEFAULT_INTEGRITY_OPTIONS.minCalibrationQuality;
/**
 * The point above which the results screen stops qualifying a score for its mount
 * (`integrityNotes`: below 0.75 it says "a few degrees of every angle belong to the mount").
 */
export const SHARP_QUALITY = 0.75;

/** Up-axis quality at which the vertical has stopped moving around. */
export const SETTLED_UP = 0.6;

/** Degrees of recline past which the phone is lying down rather than standing up. */
export const FLAT_DEG = 62;

/**
 * How long the integrity monitor needs before its mount verdict means anything.
 *
 * Every mount cue is an exponential RMS over `windowS`, so for the first couple of windows the
 * averages are still filling and a perfectly bolted phone reads `suspect` — on the simulator's
 * own rigid mount it does exactly that from 0.2 s to 4.1 s. Shouting "your mount is loose" at a
 * driver who has done nothing wrong is worse than saying nothing, so until the cues have had
 * two windows this screen reports the mount as still listening.
 */
export const MOUNT_WARMUP_S = 2 * DEFAULT_INTEGRITY_OPTIONS.windowS;

/** The mount verdict, or `unknown` while the monitor's averages are still filling. */
export function mountVerdict(r: CalibrationReading): MountState | 'unknown' {
  return r.samples === 0 || r.elapsedS < MOUNT_WARMUP_S ? 'unknown' : r.mount;
}

/**
 * The monitor has SAID the mount is rigid.
 *
 * The only function allowed to conclude anything good about the mount. `unknown` is not a pass:
 * the whole point of `MOUNT_WARMUP_S` is that the verdict does not exist yet, and a screen that
 * ticks "clip it to something rigid" during the warm-up is asserting exactly what it is waiting
 * to find out. Note this implies `samples > 0` — `mountVerdict` returns 'unknown' with none.
 */
export function mountIsRigid(r: CalibrationReading): boolean {
  return mountVerdict(r) === 'rigid';
}

export type CalibrationFaultKind = 'permission' | 'location' | 'unsupported' | 'services' | 'failed';

/** Where the second button on a fault goes. Two different places, so it is never guessed. */
export type FaultDestination = 'phone-settings' | 'app-settings';

export interface CalibrationFault {
  kind: CalibrationFaultKind;
  title: string;
  body: string;
  /** True when trying again might work. */
  retryable: boolean;
  /**
   * Which Settings the secondary button opens, and what it is therefore called. A button
   * labelled OPEN SETTINGS that reached the app's own settings screen while the sentence above
   * it said "Settings → Drift-O-Meter" was two destinations wearing one name.
   */
  destination: FaultDestination;
  actionLabel: string;
}

/**
 * The five ways this screen cannot do its job. They are the whole reason it exists now, so they
 * are named rather than reachable only by breaking a phone — `?fault=<kind>` shows one (see
 * `params.ts`), the same way the drive display's `?integrity=` shows a warning state.
 *
 * `permission` and `location` are separate because `DeviceSensorSource` can fail on either, and
 * telling a driver whose location is denied to turn on Motion & Fitness sends them to fix the
 * thing that already works. Every body here is verb-first: this screen's only job in a fault is
 * to name the one action.
 */
export const FAULTS: Record<CalibrationFaultKind, CalibrationFault> = {
  permission: {
    kind: 'permission',
    title: 'Motion access is off',
    body: 'Turn on Motion & Fitness for Drift-O-Meter in the phone’s Settings, then come back and tap Try again. Calibration reads the accelerometer and gyroscope; without them there is no mount to measure.',
    retryable: true,
    destination: 'phone-settings',
    actionLabel: 'Open iPhone settings',
  },
  location: {
    kind: 'location',
    title: 'Location access is off',
    body: 'Allow Location for Drift-O-Meter in the phone’s Settings, then come back and tap Try again. Gravity fixes which way is up; only the direction of travel fixes which way the car POINTS.',
    retryable: true,
    destination: 'phone-settings',
    actionLabel: 'Open iPhone settings',
  },
  unsupported: {
    kind: 'unsupported',
    title: 'No motion sensors here',
    body: 'Switch to the simulated source in this app’s settings to see what the judge does with a run. This device has no usable gyroscope, so there is no mount to calibrate.',
    retryable: false,
    destination: 'app-settings',
    actionLabel: 'App settings',
  },
  services: {
    kind: 'services',
    title: 'Location Services are off',
    body: 'Turn Location Services back on in the phone’s Settings → Privacy & Security, then come back and tap Try again. It is switched off for the whole phone, so no app can see the direction of travel.',
    retryable: true,
    destination: 'phone-settings',
    actionLabel: 'Open iPhone settings',
  },
  failed: {
    kind: 'failed',
    title: 'Sensors would not start',
    body: 'Close anything else reading the sensors — another fitness or navigation app — then tap Try again. The motion stream did not open.',
    retryable: true,
    destination: 'app-settings',
    actionLabel: 'App settings',
  },
};

/**
 * Which fault a failure to start the sensors is.
 *
 * Every `SensorErrorCode` is named. The default branch is for a throw that is not a
 * `SensorSourceError` at all — a code falling into it produced a fault whose title contradicted
 * its own body: a phone with no gyroscope ('unavailable') was told "Sensors would not start /
 * Close anything else reading the sensors, then try again", offering a retry that cannot
 * succeed. The exhaustive `never` below makes the next unmapped code a compile error.
 */
export function faultForError(err: unknown): CalibrationFault {
  const code = err instanceof SensorSourceError ? err.code : null;
  switch (code) {
    case 'permission-denied':
      return FAULTS.permission;
    case 'location-permission-denied':
      return FAULTS.location;
    case 'unsupported':
    case 'unavailable':
      // No usable gyroscope: there is no mount to calibrate and no amount of retrying changes
      // that, so it gets the one fault that does not offer one.
      return FAULTS.unsupported;
    case 'services-disabled':
      return FAULTS.services;
    case 'failed':
    case null:
      // the real reason, when there is one, beats the generic sentence
      return { ...FAULTS.failed, body: describeSensorError(err) };
    default: {
      const exhaustive: never = code;
      void exhaustive;
      return { ...FAULTS.failed, body: describeSensorError(err) };
    }
  }
}

export interface CalibrationReading {
  status: 'starting' | 'listening' | 'held' | 'ended' | 'error';
  fault: CalibrationFault | null;
  sourceLabel: string | null;
  sourceKind: 'device' | 'simulated' | null;
  /** Seconds of motion fed to the calibrator. */
  elapsedS: number;
  samples: number;
  /** Gravity as sensed in the phone frame; `has` is false until the first sample. */
  has: boolean;
  gravity: Vec3;
  gMag: number;
  /** In-plane rotation of the phone, degrees: 0 upright, ±90 on its side, 180 upside down. */
  rollDeg: number;
  /** Tilt out of the screen plane, degrees: 0 standing up, +90 face-up flat, −90 face-down. */
  reclineDeg: number;
  quality: number;
  upQuality: number;
  forwardResolved: boolean;
  /** The engine's own verdict on whether this calibration may be believed. */
  calibrationOk: boolean;
  mount: MountState;
  /** The monitor's own `handheld` flag: a loose mount that is swinging like a hand, not a cradle. */
  handheld: boolean;
  looseScore: number;
  /** IntegrityMonitor's own sentence. Never rewritten here. */
  message: string;
  gps: GpsState;
  speedKmh: number;
  /** Seconds of straight-line acceleration evidence the forward axis is built from. */
  lineEvidenceS: number;
  /** How well that evidence lines up on one axis, 0..1. */
  lineAnisotropy: number;
  /** Which end of that axis is forward: |score| past `signAcceptScore` settles it. */
  signScore: number;
  /** Times the phone was knocked out of position since the screen opened. */
  knocks: number;
}

export const IDLE_READING: CalibrationReading = {
  status: 'starting',
  fault: null,
  sourceLabel: null,
  sourceKind: null,
  elapsedS: 0,
  samples: 0,
  has: false,
  gravity: { x: 0, y: 0, z: 0 },
  gMag: 0,
  rollDeg: 0,
  reclineDeg: 0,
  quality: 0,
  upQuality: 0,
  forwardResolved: false,
  calibrationOk: false,
  mount: 'rigid',
  handheld: false,
  looseScore: 0,
  message: '',
  gps: 'none',
  speedKmh: 0,
  lineEvidenceS: 0,
  lineAnisotropy: 0,
  signScore: 0,
  knocks: 0,
};

/**
 * How the phone is sitting, straight out of the gravity vector. Gravity points DOWN in the
 * phone frame, so its in-plane direction is the roll and its out-of-plane part is the recline.
 *
 * SIGNS (`src/engine/types.ts`: phone frame is x right, y up/top of screen, z out of the
 * screen; gravity POINTS DOWN). A phone resting on its right edge has its +x axis pointing at
 * the floor, so gravity reads +x and `atan2(+x, −y)` gives rollDeg +90. Positive roll is
 * therefore RIGHT edge down — which is also what `MountDial` draws, since a positive Skia
 * rotation swings the glyph's top to the right.
 */
export function orientationOf(g: Vec3): { rollDeg: number; reclineDeg: number; mag: number; has: boolean } {
  const mag = Math.hypot(g.x, g.y, g.z);
  if (!Number.isFinite(mag) || mag < 1) return { rollDeg: 0, reclineDeg: 0, mag: Number.isFinite(mag) ? mag : 0, has: false };
  const rollDeg = (Math.atan2(g.x, -g.y) * 180) / Math.PI;
  const reclineDeg = (Math.asin(Math.max(-1, Math.min(1, -g.z / mag))) * 180) / Math.PI;
  return { rollDeg, reclineDeg, mag, has: true };
}

/**
 * Plain words for the attitude, e.g. `UPRIGHT · 15° BACK` or `FLAT · SCREEN UP`.
 *
 * Short on purpose: it is rendered in a one-line `Tag`, and `LYING FLAT, SCREEN UP` truncated
 * to `LYING FLAT, SCREEN …` — dropping the only word that separates a phone face-up on a stuck
 * dash pad from one lying face-down.
 */
export function attitudeWords(r: CalibrationReading): string {
  if (!r.has) return 'No reading yet';
  if (isFlat(r)) return r.reclineDeg > 0 ? 'Flat · screen up' : 'Flat · screen down';
  const roll = Math.abs(r.rollDeg);
  // +roll = gravity towards +x = the phone's RIGHT edge is the one on the floor.
  const side = roll < 25 ? 'Upright' : roll > 155 ? 'Upside down' : r.rollDeg > 0 ? 'On its right edge' : 'On its left edge';
  const lean = Math.abs(r.reclineDeg) < 6 ? 'vertical' : `${Math.round(Math.abs(r.reclineDeg))}° ${r.reclineDeg > 0 ? 'back' : 'forward'}`;
  return `${side} · ${lean}`;
}

export function isFlat(r: CalibrationReading): boolean {
  return r.has && Math.abs(r.reclineDeg) >= FLAT_DEG;
}

export function isSettled(r: CalibrationReading): boolean {
  return r.upQuality >= SETTLED_UP;
}

export type CalibrationPhase = 'failed' | 'blocked' | 'unsteady' | 'ready' | 'seeking' | 'levelling' | 'starting';

export function phaseOf(r: CalibrationReading): CalibrationPhase {
  if (r.fault) return 'failed';
  // NOTHING is claimed before there is evidence. `IntegrityMonitor` starts with
  // `calibrationOk` true on purpose — a monitor that knows nothing must not veto a run — but
  // that is the engine declining to object, not the engine asserting a good mount. Reading it
  // as a verdict put CALIBRATED / "Ready to measure" on screen with zero samples, dashes for
  // confidence and a red "No reading" light underneath. This check goes FIRST, and READY
  // additionally requires the forward axis, because a calibration that cannot say which way
  // the car points has not calibrated anything.
  if (!r.has || r.samples === 0) return 'starting';
  const mount = mountVerdict(r);
  // A phone that is moving against the car invalidates everything downstream of it, resolved
  // forward axis or not — the monitor will not believe a slide while this is true.
  if (mount === 'loose') return 'blocked';
  // READY is a statement about the MOUNT as well as about the fit, so it needs the mount
  // verdict to exist and to be good. `calibrationOk && forwardResolved` alone put
  // CALIBRATED / "Ready to measure" over a gold "MOUNT LOOKS UNSTEADY" on the same frame:
  // measured on touge at looseness 0.2, seeds 1–4 read 34/36/31/32 % with mount 'suspect' and
  // all four said ready (`npx tsx tools/analysis/calibration-sweep.ts suspect`). The angles in
  // that band are inflated by the sway and nothing else on the screen was saying so.
  if (r.calibrationOk && r.forwardResolved) return mount === 'rigid' ? 'ready' : 'unsteady';
  return isSettled(r) ? 'seeking' : 'levelling';
}

export interface Light {
  key: 'level' | 'forward' | 'mount';
  label: string;
  state: 'on' | 'working' | 'bad';
  detail: string;
}

export function lightsOf(r: CalibrationReading): Light[] {
  const settled = isSettled(r);
  const mount = mountVerdict(r);
  return [
    {
      // `bad` is red, the danger colour, and NO DATA IS NOT A FAULT: with zero samples this
      // light used to read red "No reading" beside a cyan "Listening" on the mount light, for
      // the identical absence of evidence. Red is reserved for something the engine has
      // actually found wrong, which for the vertical is nothing — gravity always arrives.
      key: 'level',
      label: 'Vertical',
      state: settled ? 'on' : 'working',
      detail: settled ? 'Settled' : r.has ? 'Settling' : 'Listening',
    },
    {
      key: 'forward',
      label: 'Forward',
      // Short enough to survive one line in a third of the screen: `26% of the evidence` wrapped
      // to two lines in portrait and truncated in the compact landscape chip.
      state: r.forwardResolved ? 'on' : 'working',
      detail: r.forwardResolved ? 'Resolved' : r.lineEvidenceS > 0.05 ? `${Math.round((r.lineEvidenceS / DEFAULT_MOUNT_OPTIONS.lineMinEvidence) * 100)}% there` : 'Needs a pull',
    },
    {
      key: 'mount',
      label: 'Mount',
      state: mount === 'rigid' ? 'on' : mount === 'loose' ? 'bad' : 'working',
      detail: mount === 'rigid' ? 'Rigid' : mount === 'loose' ? 'Moving' : mount === 'suspect' ? 'Unsteady' : 'Listening',
    },
  ];
}

export interface Headline {
  kicker: string;
  title: string;
  /** One clause, the reason — never a paragraph. */
  because: string;
  color: 'ember' | 'cyan' | 'green' | 'red' | 'gold';
}

export function headlineOf(r: CalibrationReading): Headline {
  switch (phaseOf(r)) {
    case 'failed':
      return { kicker: 'Cannot calibrate', title: r.fault?.title ?? 'Sensors unavailable', because: r.fault?.body ?? '', color: 'red' };
    case 'blocked':
      // The biggest words on the loudest frame have to be the condition, not a noise. The name
      // is the HUD's own heading for the same state, and the sentence under it is the
      // monitor's, verbatim and once — there is no second banner repeating it.
      return { kicker: 'Mount', title: r.handheld ? 'Hand-held' : 'Loose mount', because: r.message, color: 'red' };
    case 'unsteady':
      // Same rule as `blocked`: the HUD's own heading for `mount === 'suspect'` is MOUNT
      // SHAKING (`HudChrome.tsx`), and the sentence is the monitor's own, said once —
      // `cautionsOf` drops its duplicate banner while this headline is carrying it.
      return mountVerdict(r) === 'suspect'
        ? { kicker: 'Mount', title: 'Mount shaking', because: r.message, color: 'gold' }
        : { kicker: 'Mount', title: 'Still listening', because: `the sway cues need ${MOUNT_WARMUP_S} s of data before they mean anything`, color: 'cyan' };
    case 'ready':
      // The clause moves with the number: one sentence cannot honestly cover 30 % to 86 %.
      return {
        kicker: 'Calibrated',
        title: 'Ready to measure',
        because:
          r.quality >= SHARP_QUALITY
            ? 'the judge will take every angle this mount reports at face value'
            : r.quality >= (TRUST_QUALITY + SHARP_QUALITY) / 2
              ? 'clear of the bar — the results will still note the mount against every angle'
              : 'barely past the bar: it will score, and every angle will carry a mount caveat',
        color: r.quality >= SHARP_QUALITY ? 'green' : 'ember',
      };
    case 'seeking':
      return { kicker: 'Almost', title: 'Finding forward', because: 'one hard pull in a straight line is what settles it', color: 'ember' };
    case 'levelling':
      return { kicker: 'Working', title: 'Finding level', because: 'gravity is telling it which way is up', color: 'cyan' };
    default:
      return { kicker: 'Waking up', title: 'Listening', because: 'the first readings are on their way', color: 'cyan' };
  }
}

export interface Step {
  n: string;
  title: string;
  /** Why, in one clause. */
  because: string;
  state: 'done' | 'active' | 'todo';
  /** 0..1 when the engine can say how far along this step is. */
  progress: number;
}

/**
 * The two things a driver has to do. Deliberately two: the calibrator needs no gesture and no
 * standing still — it takes the vertical from gravity by itself and the forward axis from the
 * car accelerating. Anything else on this list would be ceremony.
 */
export function stepsOf(r: CalibrationReading): Step[] {
  // `mount === 'unknown'` used to count here, so for the whole 4 s warm-up step 01 was struck
  // through with a green tick while the MOUNT light beside it read "Listening" and confidence
  // read 9 % — the screen ticking a step the engine had not decided, in the first thing a
  // driver reads. A tick is a verdict; only `rigid` is one.
  const mountOk = mountIsRigid(r) && !isFlat(r);
  const evidence = Math.min(1, r.lineEvidenceS / DEFAULT_MOUNT_OPTIONS.lineMinEvidence);
  return [
    {
      n: '01',
      title: 'Clip it to something rigid',
      because: 'a phone that shifts in its cradle reads as slip the car never made',
      state: mountOk ? 'done' : 'active',
      progress: mountOk ? 1 : 0,
    },
    {
      n: '02',
      title: 'Drive off and accelerate hard, once, in a straight line',
      // The title already gives the action and the headline gives the instruction; this is the
      // only one of the three that has to carry the mechanism.
      because: 'acceleration only ever points forwards — nothing else can fix the axis',
      state: r.forwardResolved ? 'done' : mountOk ? 'active' : 'todo',
      progress: r.forwardResolved ? 1 : evidence,
    },
  ];
}

/** The button that leaves this screen, and what leaving actually costs. */
export interface Leave {
  label: string;
  /** Ember slab, or the quieter secondary: this is not the finished action in every phase. */
  primary: boolean;
  /** One sentence. It has to be TRUE in this phase, which is why it is not one sentence. */
  note: string;
}

/**
 * Leaving is allowed — the calibrator needs no gesture and finishes while driving — but what
 * that costs depends entirely on the phase, and one reassurance for all of them was wrong in
 * two directions at once. Both replacements are measurements
 * (`npx tsx tools/analysis/calibration-sweep.ts`):
 *
 *  • READY said "the calibration keeps sharpening during the run — nothing here is final".
 *    Over 2 tracks × 3 mounts × 8 seeds the confidence peaks between 5.1 s and 8.0 s (median
 *    5.8 s, i.e. within a few seconds of driving off) and the FINAL value is below the peak in
 *    48 of 48 — median −0.017, worst −0.114 (harbor / flat-console / seed 5: 0.618 → 0.504).
 *    The number on screen is the best it will ever be, so the screen says so.
 *  • BLOCKED said "you do not have to sit here, the run calibrates itself on the way to the
 *    first corner". At looseness ≥ 0.5, across 2 tracks × 4 seeds × 3 looseness levels, 0 of 24
 *    runs ever reached the engine's bar: final confidence 0.000–0.060, the forward axis
 *    unresolved in 23 of 24. This is the ONE state where leaving costs the whole run.
 *
 * The other phases keep the reassurance, because for a rigid mount it is true: the same 48 runs
 * resolved the forward axis and cleared the bar by themselves, with no gesture, 48 times.
 */
export function leaveOf(r: CalibrationReading): Leave {
  switch (phaseOf(r)) {
    case 'ready':
      return {
        label: 'Done — drive',
        primary: true,
        note: 'As sharp as it gets — it peaks seconds after you drive off, and never climbs later.',
      };
    case 'blocked':
      return {
        label: 'Drive without a score',
        primary: false,
        note: 'Leave now and nothing in it is scored: a moving phone never reaches the judge’s bar.',
      };
    case 'unsteady':
      return {
        label: 'Drive anyway',
        primary: false,
        note: 'It scores, but part of every angle is the cradle. Re-clip it and it is worth more.',
      };
    default:
      return {
        label: 'Finish it while driving',
        primary: false,
        note: 'You need not sit here: the run calibrates itself before the first corner.',
      };
  }
}

/** A caution that is true but not fatal — the phone is flat, or it has been knocked. */
export interface Caution {
  title: string;
  body: string;
  tone: 'gold' | 'red';
}

export function cautionsOf(r: CalibrationReading): Caution[] {
  const out: Caution[] = [];
  const mount = mountVerdict(r);
  // Gated on EVIDENCE OF MOVEMENT, not on the absence of it: the harsher of the two sentences
  // ("already moving") is a verdict and needs the monitor to have reached one. With the verdict
  // still 'unknown' the milder sentence is the honest one, because it only says what a flat
  // phone risks, which is true whatever the cues end up showing.
  const moving = mount === 'suspect' || mount === 'loose';
  if (isFlat(r)) {
    out.push({
      title: 'The phone is lying flat',
      // Short, and it does not repeat step 01's clause back at the driver.
      body: moving
        ? 'Flat and already moving — on a seat or a loose pad it slides with every corner.'
        : 'Fine on a dash pad that is stuck down. On a seat it will slide at the first corner.',
      tone: moving ? 'red' : 'gold',
    });
  }
  // Only when the headline is not already carrying it, in the monitor's own words.
  if (mount === 'suspect' && !isFlat(r) && phaseOf(r) !== 'unsteady') {
    out.push({ title: 'Mount looks unsteady', body: r.message, tone: 'gold' });
  }
  if (r.knocks > 0) {
    out.push({
      title: r.knocks === 1 ? 'The phone was knocked' : `The phone was knocked ${r.knocks} times`,
      body: 'It started again from the new position. Nothing is lost, but the mount is not holding.',
      tone: 'gold',
    });
  }
  if (r.has && Math.abs(r.gMag - G) > 1.2) {
    out.push({
      title: 'Gravity reads wrong',
      body: `The phone is sensing ${r.gMag.toFixed(1)} m/s² where it should sense ${G.toFixed(1)}. Something is shaking it hard enough to matter.`,
      tone: 'red',
    });
  }
  return out;
}

/**
 * Why the driver is here.
 *
 * This screen is not a step in the flow — it is where the app sends someone when something is
 * actually wrong. Arriving that way should say so at the top, in the words of whatever went
 * wrong, before a single instruction.
 */
export interface Arrival {
  title: string;
  body: string;
  tone: 'red' | 'gold';
}

export function arrivalOf(why: CalibrateReason | null): Arrival | null {
  switch (why) {
    case 'rejected':
      return {
        title: 'Your last run was thrown out',
        body: 'Not one angle in it could be vouched for.',
        tone: 'red',
      };
    case 'loose':
      return {
        title: 'The phone was moving in its mount',
        body: 'It was scored, but cradle movement reads as slip the car never made. Rigid, the same driving is worth more.',
        tone: 'red',
      };
    case 'unresolved':
      // What HAPPENED, and nothing else. The headline gives the instruction and step 02 gives
      // the mechanism; all three said "one hard pull in a straight line" on the same frame.
      return {
        title: 'Last run never worked out which way the car points',
        body: 'Without a forward axis a slide and a lane change look alike, so none of it could be scored.',
        tone: 'gold',
      };
    case 'suspect':
      return {
        title: 'Last run’s mount looked unsteady',
        body: 'Nothing was invalid, but some of the angle may have been cradle rattle rather than the car.',
        tone: 'gold',
      };
    default:
      return null;
  }
}

/** The one honest number: where the calibration sits against the bar the engine uses. */
export interface QualityBand {
  value: number;
  /** Percentage text, or `--` before there is anything to report. */
  display: string;
  label: string;
  color: 'ember' | 'green' | 'red' | 'cyan' | 'gold';
}

/**
 * The band the number sits in — and it may not out-run the mount verdict either. "Sharp ·
 * nothing will be qualified for the mount" is a claim about what the RESULTS screen will do,
 * and `src/ui/results/model.ts` adds a note for a `suspect` mount at any confidence, so the
 * mount has to be checked before the number is graded.
 */
export function qualityBand(r: CalibrationReading): QualityBand {
  const value = Number.isFinite(r.quality) ? Math.max(0, Math.min(1, r.quality)) : 0;
  const display = r.samples === 0 ? '--' : `${Math.round(value * 100)}%`;
  const mount = mountVerdict(r);
  if (mount === 'loose') return { value, display, label: 'The mount is moving · nothing here can be believed', color: 'red' };
  if (!r.forwardResolved) return { value, display, label: 'Forward axis not resolved · nothing is scored yet', color: 'cyan' };
  if (mount === 'suspect') return { value, display, label: 'The cradle is moving · some of every angle is it', color: 'gold' };
  if (mount === 'unknown') return { value, display, label: 'Still reading the mount · a few seconds more', color: 'cyan' };
  // The ENGINE's verdict, not a second copy of its threshold. `calibrationOk` already is
  // `quality >= minCalibrationQuality` with the forward axis resolved, and re-deriving it here
  // from `value >= TRUST_QUALITY` let the band say "below the bar" on a frame the headline was
  // calling READY. A screen may display the engine's number; it may not re-decide with it.
  if (!r.calibrationOk) return { value, display, label: 'Below the bar the judge believes', color: 'red' };
  if (value >= SHARP_QUALITY) return { value, display, label: 'Sharp · nothing will be qualified for the mount', color: 'green' };
  return { value, display, label: 'Good enough to score', color: 'ember' };
}
