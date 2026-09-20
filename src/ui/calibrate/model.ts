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
 *    inventing its own standard. (`docs/DESIGN.md` says 0.8; the calibrator's ceiling on a
 *    typical mount is ~0.74 because road vibration caps the accelerometer fit, so 0.8 would be
 *    a bar the engine can seldom clear — see the note in tools/harness/README.md.)
 *  • the words for a loose mount. They are `IntegrityMonitor`'s own message, verbatim, so this
 *    screen and the HUD never describe the same condition differently.
 */
import { DEFAULT_INTEGRITY_OPTIONS, type GpsState, type MountState } from '../../engine/integrity';
import { DEFAULT_MOUNT_OPTIONS } from '../../engine/mount';
import type { Vec3 } from '../../engine/types';
import { G } from '../../engine/types';
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

export type CalibrationFaultKind = 'permission' | 'unsupported' | 'services' | 'failed';

export interface CalibrationFault {
  kind: CalibrationFaultKind;
  title: string;
  body: string;
  /** True when trying again might work. */
  retryable: boolean;
}

/**
 * The four ways this screen cannot do its job. They are the whole reason it exists now, so they
 * are named rather than reachable only by breaking a phone — `?fault=<kind>` shows one (see
 * `params.ts`), the same way the drive display's `?integrity=` shows a warning state.
 */
export const FAULTS: Record<CalibrationFaultKind, CalibrationFault> = {
  permission: {
    kind: 'permission',
    title: 'Motion access is off',
    body: 'Calibration reads the accelerometer and gyroscope. Turn on Motion & Fitness (and Location, for the direction of travel) in Settings → Drift-O-Meter, then try again.',
    retryable: true,
  },
  unsupported: {
    kind: 'unsupported',
    title: 'No motion sensors here',
    body: 'This device has no usable gyroscope, so there is no mount to calibrate. Switch to the simulated source in Settings to see what the judge does with a run.',
    retryable: false,
  },
  services: {
    kind: 'services',
    title: 'Location is off',
    body: 'Gravity alone fixes which way is up. Which way the car POINTS needs the direction of travel, and that needs Location Services.',
    retryable: true,
  },
  failed: {
    kind: 'failed',
    title: 'Sensors would not start',
    body: 'The motion stream did not open. Close anything else reading the sensors, then try again.',
    retryable: true,
  },
};

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
 */
export function orientationOf(g: Vec3): { rollDeg: number; reclineDeg: number; mag: number; has: boolean } {
  const mag = Math.hypot(g.x, g.y, g.z);
  if (!Number.isFinite(mag) || mag < 1) return { rollDeg: 0, reclineDeg: 0, mag: Number.isFinite(mag) ? mag : 0, has: false };
  const rollDeg = (Math.atan2(g.x, -g.y) * 180) / Math.PI;
  const reclineDeg = (Math.asin(Math.max(-1, Math.min(1, -g.z / mag))) * 180) / Math.PI;
  return { rollDeg, reclineDeg, mag, has: true };
}

/** Plain words for the attitude, e.g. `UPRIGHT · 15° BACK` or `LYING FLAT, SCREEN UP`. */
export function attitudeWords(r: CalibrationReading): string {
  if (!r.has) return 'Waiting for the first reading';
  if (isFlat(r)) return r.reclineDeg > 0 ? 'Lying flat, screen up' : 'Lying flat, screen down';
  const roll = Math.abs(r.rollDeg);
  const side = roll < 25 ? 'Upright' : roll > 155 ? 'Upside down' : r.rollDeg > 0 ? 'On its left edge' : 'On its right edge';
  const lean = Math.abs(r.reclineDeg) < 6 ? 'vertical' : `${Math.round(Math.abs(r.reclineDeg))}° ${r.reclineDeg > 0 ? 'back' : 'forward'}`;
  return `${side} · ${lean}`;
}

export function isFlat(r: CalibrationReading): boolean {
  return r.has && Math.abs(r.reclineDeg) >= FLAT_DEG;
}

export function isSettled(r: CalibrationReading): boolean {
  return r.upQuality >= SETTLED_UP;
}

export type CalibrationPhase = 'failed' | 'blocked' | 'ready' | 'seeking' | 'levelling' | 'starting';

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
  // A phone that is moving against the car invalidates everything downstream of it, resolved
  // forward axis or not — the monitor will not believe a slide while this is true.
  if (mountVerdict(r) === 'loose') return 'blocked';
  if (r.calibrationOk && r.forwardResolved) return 'ready';
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
      key: 'level',
      label: 'Vertical',
      state: settled ? 'on' : r.has ? 'working' : 'bad',
      detail: settled ? 'Settled' : r.has ? 'Settling' : 'No reading',
    },
    {
      key: 'forward',
      label: 'Forward',
      state: r.forwardResolved ? 'on' : 'working',
      detail: r.forwardResolved ? 'Resolved' : r.lineEvidenceS > 0.05 ? `${Math.round((r.lineEvidenceS / DEFAULT_MOUNT_OPTIONS.lineMinEvidence) * 100)}% of the evidence` : 'Needs one hard pull',
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
    case 'ready':
      return {
        kicker: 'Calibrated',
        title: 'Ready to measure',
        because:
          r.quality >= SHARP_QUALITY
            ? 'the judge will take every angle this mount reports at face value'
            : 'good enough to score — a couple of degrees of each angle still belong to the mount',
        color: r.quality >= SHARP_QUALITY ? 'green' : 'ember',
      };
    case 'seeking':
      return { kicker: 'Almost', title: 'Finding forward', because: 'one hard pull in a straight line is what tells it which way the car points', color: 'ember' };
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
  const mount = mountVerdict(r);
  const mountOk = (mount === 'rigid' || mount === 'unknown') && r.samples > 0 && !isFlat(r);
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
      because: 'that one burst is what separates forwards from sideways',
      state: r.forwardResolved ? 'done' : mountOk ? 'active' : 'todo',
      progress: r.forwardResolved ? 1 : evidence,
    },
  ];
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
  const steady = mount === 'rigid' || mount === 'unknown';
  if (isFlat(r)) {
    out.push({
      title: 'The phone is lying flat',
      body: steady
        ? 'A flat dash pad is fine if it is stuck down. On a seat it will slide at the first corner, and a sliding phone cannot be calibrated.'
        : 'Flat and already moving — on a seat or a loose pad it slides with every corner. Clip it to something.',
      tone: steady ? 'gold' : 'red',
    });
  }
  if (mount === 'suspect' && !isFlat(r)) {
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
        body: 'The engine would not vouch for a single angle in it. Nothing below takes more than a minute of driving to put right.',
        tone: 'red',
      };
    case 'loose':
      return {
        title: 'The phone was moving in its mount',
        body: 'Last run was scored, but movement in the cradle reads as slip the car never made. Get it rigid and the same driving is worth more.',
        tone: 'red',
      };
    case 'unresolved':
      return {
        title: 'Last run never worked out which way the car points',
        body: 'Without a forward axis a slide and a lane change look alike. One hard pull in a straight line is the whole fix.',
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
  color: 'ember' | 'green' | 'red' | 'cyan';
}

export function qualityBand(r: CalibrationReading): QualityBand {
  const value = Number.isFinite(r.quality) ? Math.max(0, Math.min(1, r.quality)) : 0;
  const display = r.samples === 0 ? '--' : `${Math.round(value * 100)}%`;
  if (mountVerdict(r) === 'loose') return { value, display, label: 'The mount is moving · nothing here can be believed', color: 'red' };
  if (!r.forwardResolved) return { value, display, label: 'Forward axis not resolved · nothing is scored yet', color: 'cyan' };
  if (value >= SHARP_QUALITY) return { value, display, label: 'Sharp · nothing will be qualified for the mount', color: 'green' };
  if (value >= TRUST_QUALITY) return { value, display, label: 'Good enough to score', color: 'ember' };
  return { value, display, label: 'Below the bar the judge believes', color: 'red' };
}
