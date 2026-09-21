/**
 * The calibration controller: sensors → `MountCalibrator` + `IntegrityMonitor` → one snapshot
 * at 12 Hz.
 *
 * It is the same wiring `DriftPipeline` uses (calibrator first, its output and the raw stream
 * both handed to the integrity monitor, the calibration pushed back in as an integrity cue), so
 * the numbers on this screen are the numbers a run will be judged by — not a preview of them.
 *
 * There is no start button and no gesture: the calibrator finds the vertical from gravity and
 * the forward axis from the car accelerating, so the screen simply starts listening. Leaving is
 * allowed — `/drive` builds its own calibrator and carries on from scratch — but what it COSTS
 * depends on the phase, and `leaveOf` in `model.ts` owns that sentence, measured per phase.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { IntegrityMonitor } from '../../engine/integrity';
import { MountCalibrator } from '../../engine/mount';
import type { GpsSample, MotionSample } from '../../engine/types';
import { currentSearch, selectSensorSource, type SensorSource, type SourceSelection } from '../../platform';
import { simulateRun } from '../../sim';
import { SimPlayer } from '../hud/simPlayer';
import { FAULTS, faultForError, IDLE_READING, orientationOf, type CalibrationReading } from './model';
import { parseCalibrateParams, type CalibrateParams } from './params';

/** UI refresh rate. Words, not motion — the glyph does not need 60 Hz to read as live. */
const PUBLISH_HZ = 12;

export interface Calibration {
  reading: CalibrationReading;
  params: CalibrateParams;
  /** Restart the source after a fault, or after the recording ran out. */
  retry(): void;
}

export function useCalibration(): Calibration {
  const [params] = useState<CalibrateParams>(() => parseCalibrateParams(currentSearch()));
  const [reading, setReading] = useState<CalibrationReading>(IDLE_READING);
  const [attempt, setAttempt] = useState(0);

  const sourceRef = useRef<SensorSource | null>(null);
  const playerRef = useRef<SimPlayer | null>(null);
  const hot = useRef({ t0: NaN, tLast: NaN, samples: 0, speedKmh: 0 });

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    // `?fault=` shows one of the five faults without touching the sensors. Presentation only:
    // the states this screen exists for are otherwise unreachable outside a broken phone.
    if (params.fault) {
      setReading({ ...IDLE_READING, status: 'error', fault: FAULTS[params.fault] });
      return;
    }
    let alive = true;
    let ticker: ReturnType<typeof setInterval> | null = null;
    let selection: SourceSelection | null = null;

    const calibrator = new MountCalibrator();
    const monitor = new IntegrityMonitor();
    /** The newest gravity vector, for the orientation glyph. */
    const lastGravity = { x: 0, y: 0, z: 0 };
    hot.current = { t0: NaN, tLast: NaN, samples: 0, speedKmh: 0 };
    setReading({ ...IDLE_READING, status: 'starting' });

    const onMotion = (m: MotionSample) => {
      const h = hot.current;
      lastGravity.x = m.gravity.x;
      lastGravity.y = m.gravity.y;
      lastGravity.z = m.gravity.z;
      if (!Number.isFinite(h.t0)) h.t0 = m.t;
      h.tLast = m.t;
      h.samples++;
      const vehicle = calibrator.push(m);
      const cal = calibrator.calibration;
      monitor.pushCalibration(cal);
      monitor.pushMotion(m, vehicle);
    };

    const onGps = (g: GpsSample) => {
      calibrator.pushGps(g);
      monitor.pushGps(g);
      if (Number.isFinite(g.speed) && g.speed >= 0) hot.current.speedKmh = g.speed * 3.6;
    };

    const publish = (status: CalibrationReading['status']) => {
      if (!alive) return;
      const h = hot.current;
      const cal = calibrator.calibration;
      const diag = calibrator.diagnostics();
      const state = monitor.state;
      const g = { x: lastGravity.x, y: lastGravity.y, z: lastGravity.z };
      const o = orientationOf(g);
      setReading({
        status,
        fault: null,
        sourceLabel: selection?.label ?? null,
        sourceKind: selection?.kind ?? null,
        elapsedS: Number.isFinite(h.t0) && Number.isFinite(h.tLast) ? h.tLast - h.t0 : 0,
        samples: h.samples,
        has: o.has,
        gravity: g,
        gMag: o.mag,
        rollDeg: o.rollDeg,
        reclineDeg: o.reclineDeg,
        quality: cal.quality,
        upQuality: diag.upQuality,
        upSettled: diag.upSettled,
        peakQuality: diag.peakQuality,
        forwardResolved: cal.forwardResolved,
        calibrationOk: state.calibrationOk,
        mount: state.mount,
        mountConfident: state.mountConfident,
        handheld: state.flags.includes('handheld'),
        looseScore: state.looseScore,
        message: state.message,
        mountMessage: state.mountMessage,
        gpsMessage: state.gpsMessage,
        gps: state.gps,
        speedKmh: h.speedKmh,
        lineEvidenceS: diag.lineEvidence,
        lineAnisotropy: diag.lineAnisotropy,
        signScore: diag.signScore,
        knocks: diag.knocks,
      });
    };

    (async () => {
      try {
        selection = await selectSensorSource({ loop: false });
        if (!alive) {
          selection.source.stop();
          return;
        }

        if (selection.sim) {
          // `?mount=` asks for the same drive with the phone sitting somewhere else: regenerate
          // the recording rather than pretend, so gravity really points where it would.
          const p = selection.sim.params;
          const run = params.mount
            ? simulateRun(p.track, { seed: p.seed, laps: p.laps, looseness: p.looseness, gpsDropouts: p.gpsDropouts, mount: params.mount })
            : selection.sim.run;
          const player = new SimPlayer(run, {
            rate: p.rate,
            onMotion,
            onGps,
            onEnd: () => {
              publish('ended');
              if (ticker) clearInterval(ticker);
              ticker = null;
            },
          });
          playerRef.current = player;
          if (Number.isFinite(params.at)) player.warpTo(params.at);
          if (params.hold) {
            publish('held');
            return;
          }
          player.start();
        } else {
          await selection.source.start({ onMotion, onGps });
          sourceRef.current = selection.source;
        }
        if (!alive) return;
        publish('listening');
        ticker = setInterval(() => publish('listening'), Math.round(1000 / PUBLISH_HZ));
      } catch (err) {
        if (!alive) return;
        console.warn('[calibrate] source failed to start', err);
        setReading({ ...IDLE_READING, status: 'error', fault: faultForError(err), sourceKind: selection?.kind ?? null, sourceLabel: selection?.label ?? null });
      }
    })();

    return () => {
      alive = false;
      if (ticker) clearInterval(ticker);
      playerRef.current?.stop();
      playerRef.current = null;
      sourceRef.current?.stop();
      sourceRef.current = null;
    };
  }, [attempt, params.at, params.fault, params.hold, params.mount]);

  return { reading, params, retry };
}
