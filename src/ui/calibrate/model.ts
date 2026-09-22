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
 *  • the words for a loose or shaking mount. The TITLE is the HUD's own heading for the same
 *    state, and any sentence this screen prints about a topic is `IntegrityMonitor`'s own
 *    per-topic message (`firstClause`), so the two never describe one condition differently.
 *
 * ONE RULE RUNS THROUGH ALL OF IT: an absence of evidence is never reported as a verdict. The
 * monitor starts permissive (`calibrationOk` true before it has seen a sample, `mount` 'rigid'
 * before its averages have filled) so that it cannot veto a run it knows nothing about — that
 * is the engine declining to object, not the engine asserting a good mount, and this screen may
 * not repeat it as one. Every function below reads `mountVerdict`, which says 'unknown' until
 * the cues mean something, and 'unknown' is a pass NOWHERE.
 */
import { calibrationBand, verticalSettled, CALIBRATION_SHARP, DEFAULT_INTEGRITY_OPTIONS, type GpsState, type MountState } from '../../engine/integrity';
import { DEFAULT_MOUNT_OPTIONS, forwardProgress } from '../../engine/mount';
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
export const SHARP_QUALITY = CALIBRATION_SHARP;

/** Degrees of recline past which the phone is lying down rather than standing up. */
export const FLAT_DEG = 62;

/**
 * The mount verdict, or `unknown` while the monitor's averages are still filling.
 *
 * THE MONITOR SAYS WHEN, not this file. It used to be `elapsedS < 2 × windowS` — four
 * wall-clock seconds, chosen to outlast a startup transient, and measured to be shorter than
 * it: 30 of 48 rigid runs still read `suspect` past the guard, the longest to 4.81 s, so a
 * bolted-down phone got a gold MOUNT LOOKS UNSTEADY banner exactly where the guard existed to
 * prevent one. The transient is now fixed at its source (`MountCalibrator` was publishing the
 * first sample of every run in a frame it had not built yet) and what is left is the engine's
 * own `mountConfident`: one window of evidence, counted in motion fed to the cues.
 */
export function mountVerdict(r: CalibrationReading): MountState | 'unknown' {
  return r.samples === 0 || !r.mountConfident ? 'unknown' : r.mount;
}

/**
 * The monitor has SAID the mount is rigid.
 *
 * The only function allowed to conclude anything good about the mount. `unknown` is not a pass:
 * the whole point of `mountConfident` is that the verdict does not exist yet, and a screen that
 * ticks "clip it to something rigid" while the cues are filling is asserting exactly what it is
 * waiting to find out. Note this implies `samples > 0` — `mountVerdict` is 'unknown' with none.
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
 * thing that already works. Every body here is verb-first AND nothing but the action: each one
 * used to end with the physics behind it ("Gravity fixes which way is up; only the direction of
 * travel fixes which way the car POINTS"), which is a sentence for this file, not for a driver
 * holding a phone that will not start.
 */
export const FAULTS: Record<CalibrationFaultKind, CalibrationFault> = {
  permission: {
    kind: 'permission',
    title: 'Motion access is off',
    body: 'Turn on Motion & Fitness for Drift-O-Meter in the phone’s Settings, then come back and tap Try again.',
    retryable: true,
    destination: 'phone-settings',
    actionLabel: 'Open iPhone settings',
  },
  location: {
    kind: 'location',
    title: 'Location access is off',
    body: 'Allow Location for Drift-O-Meter in the phone’s Settings, then come back and tap Try again.',
    retryable: true,
    destination: 'phone-settings',
    actionLabel: 'Open iPhone settings',
  },
  unsupported: {
    kind: 'unsupported',
    title: 'No motion sensors here',
    body: 'Switch to the simulated source in this app’s settings to see what the judge does with a run.',
    retryable: false,
    destination: 'app-settings',
    actionLabel: 'App settings',
  },
  services: {
    kind: 'services',
    title: 'Location Services are off',
    body: 'Turn Location Services back on in the phone’s Settings → Privacy & Security, then come back and tap Try again.',
    retryable: true,
    destination: 'phone-settings',
    actionLabel: 'Open iPhone settings',
  },
  failed: {
    kind: 'failed',
    title: 'Sensors would not start',
    body: 'Close anything else reading the sensors — another fitness or navigation app — then tap Try again.',
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
  /** The engine's own "the up axis has had its settling time"; `band.ts` turns it into a verdict. */
  upAged: boolean;
  /** The highest confidence this calibration has reached, from `MountCalibrator`. */
  peakQuality: number;
  mount: MountState;
  /** The engine's own verdict on whether `mount` is a verdict yet. */
  mountConfident: boolean;
  /** The monitor's own `handheld` flag: a loose mount that is swinging like a hand, not a cradle. */
  handheld: boolean;
  looseScore: number;
  /**
   * IntegrityMonitor's own sentence about the ROOT CAUSE. Never rewritten here — and never
   * printed under a heading of this screen's own choosing either: it answers "of everything
   * wrong, what is most wrong", so under a MOUNT title it will happily print a GPS or
   * forward-axis sentence. Anything this screen heads "Mount" quotes `mountMessage`.
   */
  message: string;
  /** The monitor's sentence about the MOUNT alone; `''` when it has nothing to say about it. */
  mountMessage: string;
  /** The monitor's sentence about the GPS FIX alone; `''` when there is nothing to report. */
  gpsMessage: string;
  gps: GpsState;
  speedKmh: number;
  /** Seconds of straight-line acceleration evidence the forward axis is built from. */
  lineEvidenceS: number;
  /** How well that evidence lines up on one axis, 0..1. */
  lineAnisotropy: number;
  /**
   * The engine's own line quality, 0..1: anisotropy times capped evidence.
   *
   * Carried rather than recomputed from the two above, because the cap is the whole point —
   * a screen multiplying them itself is one refactor away from dropping it and printing
   * 1730 % again.
   */
  lineQuality: number;
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
  upAged: false,
  peakQuality: 0,
  forwardResolved: false,
  calibrationOk: false,
  mount: 'rigid',
  mountConfident: false,
  handheld: false,
  looseScore: 0,
  message: '',
  mountMessage: '',
  gpsMessage: '',
  gps: 'none',
  speedKmh: 0,
  lineEvidenceS: 0,
  lineAnisotropy: 0,
  lineQuality: 0,
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

/**
 * The vertical has settled — the ENGINE's edge (`MountCalibrator.diagnostics().upSettled`),
 * not a number kept here.
 *
 * It used to be `upQuality >= 0.6`, the last threshold this screen owned on an engine quantity,
 * and it contradicted the screen's own headline: `upQuality` is age × accelerometer fit, and a
 * shaking cradle degrades the fit, so at simulator looseness 0.1 the phase was READY while the
 * VERTICAL light read "Settling" on 29,476 of 40,864 READY frames, and on 18,932 of 18,932 at
 * looseness 0.15. `band.ts` names the edge off the engine's own floor instead, so READY implies
 * settled by construction and this screen knows no edges at all.
 */
export function isSettled(r: CalibrationReading): boolean {
  return verticalSettled(r.upQuality, r.upAged);
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
  /**
   * `working` is "still listening" (blue), `warn` is a verdict that is not fatal (greenHot),
   * `bad` is one that is (red). `suspect` used to share the working colour with `unknown`, so a
   * mount the engine HAD judged looked exactly like one it had not — while the headline above
   * painted that same state as a caution. Three lights read at arm's length have one job, which
   * is to carry the verdict.
   */
  state: 'on' | 'working' | 'warn' | 'bad';
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
      // Two questions, not one: finding the LINE the car moves along, and finding which END of
      // it points at the windscreen. They fail independently, and reporting only the evidence
      // behind the first printed "1730% there" on a mount that had resolved neither — a phone
      // lying flat gathers straight-line evidence all day while the line itself stays smeared
      // across two axes. `forwardProgress` is the engine's own gate, so this cannot drift from
      // the condition it is reporting on.
      detail: forwardDetail(r),
    },
    {
      key: 'mount',
      label: 'Mount',
      state: mount === 'rigid' ? 'on' : mount === 'loose' ? 'bad' : mount === 'suspect' ? 'warn' : 'working',
      detail: mount === 'rigid' ? 'Rigid' : mount === 'loose' ? 'Moving' : mount === 'suspect' ? 'Unsteady' : 'Listening',
    },
  ];
}

export interface Headline {
  kicker: string;
  title: string;
  /**
   * A `theme.ts` token: `blue` while the engine is still working, `green` for a verdict in the
   * driver's favour, `greenHot` for a caution, `red` for a stop. Nothing is green until the
   * engine will believe the mount — green means a run is being measured, and `seeking` is not.
   */
  color: 'blue' | 'green' | 'greenHot' | 'red';
}

/**
 * The two biggest words on the screen, and the kicker over them.
 *
 * THERE IS NO REASON LINE. Every branch used to carry a `because` clause under the title —
 * "one hard pull in a straight line is what settles it", "gravity is telling it which way is
 * up" — and this screen is read in a car, in a hurry, sometimes in the dark. The instruction is
 * `stepsOf`, the measurement is `qualityBand` and `leaveOf`, and the condition is the title
 * itself, so the clause could only ever repeat one of the three.
 *
 * Two of those clauses were load-bearing, and this is where they went:
 *
 *  • `blocked` and `unsteady` quoted `IntegrityMonitor.mountMessage` — never `message`, which
 *    answers the ROOT CAUSE and so printed "GPS signal lost 5 s ago" under MOUNT SHAKING on
 *    2,760 of 102,944 measured frames. The title is the HUD's own heading for the same state
 *    (`HudChrome.tsx`) and says the same thing in two words, so the quote was the title again.
 *    Where the monitor knows something the screen cannot say for itself — how long the GPS has
 *    been gone — it is a caution row, per topic, in the monitor's words (`cautionsOf`).
 *  • `ready` graded the number in prose, in three bands. `qualityBand().label` grades it in one
 *    place, off the engine's own scale, which is why there is no second copy here.
 */
export function headlineOf(r: CalibrationReading): Headline {
  switch (phaseOf(r)) {
    case 'failed':
      return { kicker: 'Cannot calibrate', title: r.fault?.title ?? 'Sensors unavailable', color: 'red' };
    case 'blocked':
      // The biggest words on the loudest frame have to be the condition, not a noise.
      return { kicker: 'Mount', title: r.handheld ? 'Hand-held' : 'Loose mount', color: 'red' };
    case 'unsteady':
      return mountVerdict(r) === 'suspect'
        ? { kicker: 'Mount', title: 'Mount shaking', color: 'greenHot' }
        : { kicker: 'Mount', title: 'Still listening', color: 'blue' };
    case 'ready':
      // ONE GREEN, not two. The old pair was ember for "past the bar" and green for "sharp",
      // and the repaint (`theme.ts`) collapsed ember into green — two names for #8AF606 would
      // now paint the same pixels while pretending to be a distinction. The distinction is
      // real and it is `qualityBand().label`, which says which side of 0.75 this is.
      return { kicker: 'Calibrated', title: 'Ready to measure', color: 'green' };
    case 'seeking':
      return { kicker: 'Almost', title: 'Finding forward', color: 'blue' };
    case 'levelling':
      return { kicker: 'Working', title: 'Finding level', color: 'blue' };
    default:
      return { kicker: 'Waking up', title: 'Listening', color: 'blue' };
  }
}

/** What the forward tile says: the part that is further from done, as a share of its own bar. */
function forwardDetail(r: CalibrationReading): string {
  if (r.forwardResolved) return 'Resolved';
  const p = forwardProgress({ lineQuality: r.lineQuality, signScore: r.signScore });
  if (p.axis <= 0 && p.direction <= 0) return 'Needs a pull';
  const share = p.blocking === 'direction' ? p.direction : p.axis;
  return `${Math.round(share * 100)}%`;
}

export interface Step {
  n: string;
  title: string;
  state: 'done' | 'active' | 'todo';
  /** 0..1 when the engine can say how far along this step is. */
  progress: number;
}

/**
 * The two things a driver has to do. Deliberately two: the calibrator needs no gesture and no
 * standing still — it takes the vertical from gravity by itself and the forward axis from the
 * car accelerating. Anything else on this list would be ceremony.
 *
 * TITLES ONLY. Each step used to print its reason underneath, and both reasons are true and
 * neither is actionable: a driver clipping a phone into a cradle is not deciding whether to,
 * and the second one explains a mechanism the FORWARD tile is already reporting progress on.
 * They are kept here, where the next person to wonder why these two steps and no others is
 * the one who needs them:
 *
 *  • 01 — a phone that shifts in its cradle reads as slip the car never made. That is the
 *    whole of `IntegrityMonitor`'s mount block: cradle sway lands in the same rotation channel
 *    the slip angle is read out of, and nothing downstream can tell the two apart.
 *  • 02 — acceleration only ever points forwards, so one hard pull is the only thing that can
 *    say which END of the line the car moves along is the windscreen (`signAcceptScore`). The
 *    line itself comes free from driving; the sign does not.
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
      state: mountOk ? 'done' : 'active',
      progress: mountOk ? 1 : 0,
    },
    {
      n: '02',
      title: 'Drive off and accelerate hard, once, in a straight line',
      state: r.forwardResolved ? 'done' : mountOk ? 'active' : 'todo',
      progress: r.forwardResolved ? 1 : evidence,
    },
  ];
}

/** The button that leaves this screen, and what leaving actually costs. */
export interface Leave {
  label: string;
  /** The green slab, or the quieter secondary. */
  primary: boolean;
  /**
   * One clause under the button: a measurement, or what leaving costs. It has to be TRUE in
   * this phase, which is why it is not one clause for all of them.
   */
  note: string;
}

/**
 * The way out, and what leaving costs.
 *
 * THE SHAPE FIRST. This screen gates nothing: the calibrator needs no gesture, and 288 measured
 * runs — 48 rigid + 240 across aggression, vibration, track, mount and seed — resolved the
 * forward axis 288 times with nobody touching anything, at 5.1–6.1 s of DRIVING. A parked
 * driver therefore cannot reach READY at all. So reserving the ember slab for READY, and
 * labelling it "Done — drive", gave the biggest brightest button on the screen to a state that
 * only arrives after the driver has already left, and called finishing something they had not
 * done. Driving IS the action, in every phase a parked driver can be in, so driving gets the
 * slab — and the two states where the screen has something better to offer than leaving keep
 * the quiet button: a loose mount (leaving costs the whole run) and a shaking one (leaving
 * costs part of every angle).
 *
 * THEN THE SENTENCE — one clause of it. Every note is a measurement
 * (`npx tsx tools/analysis/calibration-sweep.ts`), and it has to hold on EVERY frame of the
 * phase, not on the frame it was measured from. What each one no longer carries is the second
 * clause explaining the first: "it moves both ways as you drive", "a moving phone never
 * reaches the judge's bar", "re-clip it and it is worth more". The first clause is the fact;
 * the second was the screen arguing with the driver about it.
 *
 *  • READY said "As sharp as it gets — it peaks seconds after you drive off, and never climbs
 *    later". The measurement behind it compared FINAL to PEAK, and it was right about that: the
 *    final value is below the peak in 48 of 48. But the sentence is read at FIRST READY, which
 *    lands at 4.6–5.3 s while the peak lands at 5.1–8.0 s — so it answered a different
 *    question from the one it was asked. Re-measured at the moment it is read, the number
 *    climbs afterwards in 33 of 48 runs, by ≥ 0.05 in 13 and ≥ 0.10 in 8, worst +0.209
 *    (harbor / portrait-vent / seed 6: 0.589 at 4.6 s → 0.798 at 5.5 s), and the screen's own
 *    band flips trusted → sharp under the word "never" in 22 of 48. The replacement says only
 *    what the engine can back on every frame: `MountCalibrator` publishes its own running peak,
 *    so "best so far" is a fact rather than a forecast, and "moves both ways" covers both the
 *    33 that climb and the 48 that end below their peak.
 *  • BLOCKED said "you do not have to sit here, the run calibrates itself on the way to the
 *    first corner". At looseness ≥ 0.5, across 2 tracks × 4 seeds × 3 looseness levels, 0 of 24
 *    runs ever reached the engine's bar: final confidence 0.000–0.060, the forward axis
 *    unresolved in 23 of 24. This is the ONE state where leaving costs the whole run.
 *
 * It switches on the MOUNT VERDICT as well as the phase, and both halves of that were bugs.
 * Switching on the phase alone printed "It scores, but part of every angle is the cradle" on
 * the same frame whose headline correctly said "Still listening" — the screen naming a cradle
 * the engine had not judged. And the reassurance was measured on RIGID runs only: on a mount
 * the monitor has called `suspect` but which has not yet cleared the bar, the screen went on
 * promising that "the run calibrates itself before the first corner" for 54,289 frames across
 * 31 measured runs, of which only 3 ever reached READY (final confidence 0.130–0.352 against
 * a bar of 0.300). So `suspect` is answered once, before the phase, and what it costs depends
 * on whether the engine will believe the run yet.
 */
export function leaveOf(r: CalibrationReading): Leave {
  const phase = phaseOf(r);
  const mount = mountVerdict(r);
  if (phase === 'ready') {
    return {
      label: 'Drive',
      primary: true,
      note: `Best so far ${Math.round(Math.max(0, Math.min(1, r.peakQuality)) * 100)}%.`,
    };
  }
  if (phase === 'blocked') {
    // Not "drive without a score": scoring is being deleted from this app, and the thing a
    // loose mount actually costs is the measurement itself — the monitor will not believe one
    // angle of it. 0 of 24 runs at looseness >= 0.5 ever reached the engine's bar.
    return {
      label: 'Drive without measuring',
      primary: false,
      note: 'A moving phone never clears the bar.',
    };
  }
  if (mount === 'suspect') {
    // THE ACTION, not the cost: `qualityBand().label` is already saying that part of every
    // angle is the cradle, two lines above this, and for one frame the two said it in the
    // identical words. What this note has that nothing else on the screen has is what
    // re-clipping buys — and, under the bar, that driving on usually will not do instead:
    // 3 of 31 measured `suspect` runs ever reached READY.
    return {
      label: 'Drive anyway',
      primary: false,
      note: r.calibrationOk ? 'Re-clip it and the angles are the car’s alone.' : 'Re-clip it — driving on rarely clears it.',
    };
  }
  if (phase === 'unsteady') {
    return {
      label: 'Drive',
      primary: true,
      note: 'Past the bar — the sway cues fill as you drive.',
    };
  }
  return {
    label: 'Drive',
    primary: true,
    note: 'It calibrates itself on the way.',
  };
}

/** A caution that is true but not fatal — the phone is flat, or it has been knocked. */
export interface Caution {
  title: string;
  /**
   * At most one clause, and `''` when the heading has already said it. A caution is read at a
   * glance in a car: the heading names the condition, and the body only earns its line by
   * carrying something the heading cannot — a measurement ("GPS signal lost 8 s ago"), or when
   * the condition is harmless ("Fine only on a pad that is stuck down").
   */
  body: string;
  tone: 'greenHot' | 'red';
}

/**
 * The monitor's sentence, up to its em dash.
 *
 * `IntegrityMonitor` writes for the HUD, where there is room for one line and it has to say
 * everything: a claim, then what to do about it — "GPS signal lost 8 s ago — waiting for it to
 * come back", "Phone may be shifting in its mount — check it is tight". This screen already
 * carries the instruction (`stepsOf`) and the cost (`leaveOf`), so a caution row takes the
 * claim and drops the tail. Still the monitor's own words, never this screen's, and still per
 * topic: a row headed GPS quoting `message` printed a mount sentence, which is the defect
 * `gpsMessage` and `mountMessage` exist to prevent.
 */
function firstClause(s: string): string {
  const dash = s.indexOf('\u2014');
  return (dash < 0 ? s : s.slice(0, dash)).trim();
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
      // The mild one earns its line by saying when flat is FINE, which the heading cannot; the
      // harsh one is the verdict the heading cannot carry either, because the heading is the
      // same in both. Neither repeats step 01 back at the driver.
      body: moving ? 'Already moving.' : 'Fine only on a pad that is stuck down.',
      tone: moving ? 'red' : 'greenHot',
    });
  }
  // NO BODY. This row used to quote the monitor underneath itself — "Phone may be shifting in
  // its mount" under MOUNT LOOKS UNSTEADY — which is the heading again in the engine's words.
  // Its history is why the coupling still matters: quoting `message` here put a forward-axis
  // sentence under this title on 105,439 of 105,439 measured caution frames, 100 % and
  // structurally so, because `message` answers the root cause and the only way to reach this
  // branch is for `calibrationOk` to be false, which IS the cause that outranks the mount. The
  // row is still gated on the monitor having something to say about the MOUNT (`mountMessage`),
  // so it cannot appear for a condition the monitor never named.
  if (mount === 'suspect' && !isFlat(r) && phaseOf(r) !== 'unsteady' && r.mountMessage) {
    out.push({ title: 'Mount looks unsteady', body: '', tone: 'greenHot' });
  }
  // A GPS condition gets its OWN row rather than a stolen reason line. This screen has no GPS
  // light — three lights is what fits at arm's length — so before this the only place a
  // dropout surfaced was as the body of a mount banner, which named the cradle for it. The
  // monitor decides when there is something to say: `gpsMessage` stays empty through the normal
  // first seconds of a session, when no fix has arrived yet and none is late.
  if (r.gpsMessage) {
    // The clause, not the sentence: "GPS signal lost 8 s ago" is the measurement this screen
    // has nowhere else (there is no GPS light), and "waiting for it to come back" is the HUD
    // telling a driver at 60 km/h not to worry, which is not this screen's job.
    out.push({ title: r.gps === 'poor' ? 'GPS is vague' : 'No GPS fix', body: firstClause(r.gpsMessage), tone: 'greenHot' });
  }
  if (r.knocks > 0) {
    out.push({
      title: r.knocks === 1 ? 'The phone was knocked' : `The phone was knocked ${r.knocks} times`,
      // "Nothing is lost" was unconditional, and it sat two rows above a footer saying the run
      // was worth nothing on a 0 % frame. What a knock costs depends on whether the calibration
      // that restarted after it got anywhere, which the engine already says. That is the whole
      // body: "the mount is not holding" is what the heading means.
      body: r.calibrationOk ? 'It has caught up.' : 'It has not caught up.',
      tone: 'greenHot',
    });
  }
  if (r.has && Math.abs(r.gMag - G) > 1.2) {
    out.push({
      title: 'Gravity reads wrong',
      body: `${r.gMag.toFixed(1)} m/s² where it should read ${G.toFixed(1)}.`,
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
  /** One clause: the consequence the heading does not already carry. */
  body: string;
  tone: 'red' | 'greenHot';
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
        body: 'Cradle movement reads as slip the car never made.',
        tone: 'red',
      };
    case 'unresolved':
      // What HAPPENED, and nothing else. Step 02 gives the instruction; this used to give it
      // again, and so did the headline, so "one hard pull in a straight line" appeared three
      // times on one frame.
      return {
        title: 'Last run never worked out which way the car points',
        body: 'A slide and a lane change look alike without it.',
        tone: 'greenHot',
      };
    case 'suspect':
      return {
        title: 'Last run’s mount looked unsteady',
        body: 'Some of the angle may have been cradle rattle.',
        tone: 'greenHot',
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
  /**
   * What that number means, in one line under the title. It is the ONLY place the confidence is
   * graded in words, now that the headline does not, so it is where "sharp" and "past the bar"
   * are distinguished — and it says nothing about scoring, which is being taken out of this app.
   */
  label: string;
  color: 'blue' | 'green' | 'greenHot' | 'red';
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
  // NOT "nothing is scored yet". Scoring is leaving this app, and the true statement is
  // simpler: without a forward axis the engine cannot tell a slide from a lane change, so it
  // measures nothing at all yet.
  if (!r.forwardResolved) return { value, display, label: 'Forward axis not resolved · nothing measured yet', color: 'blue' };
  if (mount === 'suspect') return { value, display, label: 'Part of every angle is the cradle', color: 'greenHot' };
  if (mount === 'unknown') return { value, display, label: 'Still reading the mount', color: 'blue' };
  // The ENGINE's verdict, not a second copy of its threshold. `calibrationOk` already is
  // `quality >= minCalibrationQuality` with the forward axis resolved, and re-deriving it here
  // from `value >= TRUST_QUALITY` let the band say "below the bar" on a frame the headline was
  // calling READY. A screen may display the engine's number; it may not re-decide with it.
  if (!r.calibrationOk) return { value, display, label: 'Below the bar', color: 'red' };
  if (calibrationBand(r.quality, r.forwardResolved) === 'sharp') return { value, display, label: 'Sharp · no mount caveat', color: 'green' };
  return { value, display, label: 'Past the bar · a mount caveat on every angle', color: 'green' };
}
