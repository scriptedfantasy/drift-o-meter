/**
 * Replay a simulated recording through the calibration screen's OWN wiring and hand back the
 * exact `CalibrationReading` objects `useCalibration` would publish.
 *
 * NOT part of the screen's runtime surface — it imports the simulator, so only vitest and
 * `tools/analysis` use it (same rule as `src/engine/slip/testkit.ts`).
 *
 * WHY IT EXISTS. `model.test.ts` was a table of hand-written fixtures, and a hand-written
 * fixture can hold a combination the engine can never produce: one of them paired
 * `mount: 'suspect'` with `message: 'Mount looks solid'` and the suite passed while the screen
 * printed a forward-axis sentence under a MOUNT LOOKS UNSTEADY title on every frame of every
 * run. A fixture cannot catch that, because the fixture is where the lie was. These readings
 * come out of a real `MountCalibrator` + `IntegrityMonitor`, in `SimPlayer`'s delivery order
 * (GPS first on a tie), with every field filled exactly as `useCalibration.publish` fills it —
 * so a combination that appears here is one a driver can actually see, and one that never
 * appears is one no test should assert about.
 */
import { IntegrityMonitor } from '../../engine/integrity';
import { MountCalibrator } from '../../engine/mount';
import { simulateRun, type MountPreset, type TrackId } from '../../sim';
import { IDLE_READING, orientationOf, type CalibrationReading } from './model';

export interface ReplaySpec {
  track: TrackId;
  mount: MountPreset;
  seed: number;
  looseness?: number;
  vibration?: number;
  dropouts?: boolean;
  laps?: number;
  aggression?: number;
}

/** One published frame: the reading plus the clock the screen never shows. */
export interface Frame {
  /** Seconds since the first motion sample — what the reading calls `elapsedS`. */
  t: number;
  reading: CalibrationReading;
}

/**
 * Every field `useCalibration.publish` sets, from a live calibrator + monitor.
 *
 * `snapshotHz` is the publish rate. The screen publishes at 12 Hz; a sweep that wants the exact
 * moment a phase flips asks for more.
 */
export function replayReadings(spec: ReplaySpec, snapshotHz = 12): Frame[] {
  const run = simulateRun(spec.track, {
    seed: spec.seed,
    laps: spec.laps ?? 2,
    mount: spec.mount,
    looseness: spec.looseness,
    vibration: spec.vibration,
    gpsDropouts: spec.dropouts,
    aggression: spec.aggression,
  });
  const calibrator = new MountCalibrator();
  const monitor = new IntegrityMonitor();
  const t0 = run.motion[0].t;
  const out: Frame[] = [];
  const period = 1 / snapshotHz;
  let im = 0;
  let ig = 0;
  let due = t0;
  let speedKmh = 0;
  for (;;) {
    const tm = im < run.motion.length ? run.motion[im].t : Infinity;
    const tg = ig < run.gps.length ? run.gps[ig].t : Infinity;
    if (tm === Infinity && tg === Infinity) break;
    if (tg <= tm) {
      const g = run.gps[ig++];
      calibrator.pushGps(g);
      monitor.pushGps(g);
      if (Number.isFinite(g.speed) && g.speed >= 0) speedKmh = g.speed * 3.6;
      continue;
    }
    const m = run.motion[im++];
    const vehicle = calibrator.push(m);
    const cal = calibrator.calibration;
    monitor.pushCalibration(cal);
    monitor.pushMotion(m, vehicle);
    if (m.t < due) continue;
    due = m.t + period;
    const diag = calibrator.diagnostics();
    const state = monitor.state;
    const o = orientationOf(m.gravity);
    out.push({
      t: m.t - t0,
      reading: {
        ...IDLE_READING,
        status: 'listening',
        elapsedS: m.t - t0,
        samples: im,
        has: o.has,
        gravity: { x: m.gravity.x, y: m.gravity.y, z: m.gravity.z },
        gMag: o.mag,
        rollDeg: o.rollDeg,
        reclineDeg: o.reclineDeg,
        quality: cal.quality,
        upQuality: diag.upQuality,
        upSettled: diag.upSettled,
        forwardResolved: cal.forwardResolved,
        calibrationOk: state.calibrationOk,
        mount: state.mount,
        mountConfident: state.mountConfident,
        mountMessage: state.mountMessage,
        handheld: state.flags.includes('handheld'),
        looseScore: state.looseScore,
        message: state.message,
        gps: state.gps,
        speedKmh,
        peakQuality: diag.peakQuality,
        lineEvidenceS: diag.lineEvidence,
        lineAnisotropy: diag.lineAnisotropy,
        signScore: diag.signScore,
        knocks: diag.knocks,
      },
    });
  }
  return out;
}

/** The newest frame at or before `t` — what `?at=<t>&hold=1` freezes on. */
export function frameAt(frames: readonly Frame[], t: number): Frame {
  let best = frames[0];
  for (const f of frames) {
    if (f.t > t) break;
    best = f;
  }
  return best;
}
