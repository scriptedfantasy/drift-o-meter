/**
 * The calibration controller: sensors → `MountCalibrator` + `IntegrityMonitor` → one snapshot
 * at 12 Hz.
 *
 * It is the same wiring `DriftPipeline` uses (calibrator first, its output and the raw stream
 * both handed to the integrity monitor, the calibration pushed back in as an integrity cue), so
 * the numbers on this screen are the numbers a run will be judged by — not a preview of them.
 *
 * There is no start button and no gesture: the calibrator finds the vertical from gravity and
 * the forward axis from the car accelerating, so the screen simply starts listening. Leaving it
 * is allowed and costs nothing — `/drive` builds its own calibrator and carries on from
 * scratch with the same recording or the same sensors.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { IntegrityMonitor } from '../../engine/integrity';
import { MountCalibrator } from '../../engine/mount';
import type { GpsSample, MotionSample } from '../../engine/types';
import {
  currentSearch,
  describeSensorError,
  selectSensorSource,
  SensorSourceError,
  type SensorSource,
  type SourceSelection,
} from '../../platform';
import { simulateRun } from '../../sim';
import { SimPlayer } from '../hud/simPlayer';
import { IDLE_READING, orientationOf, type CalibrationFault, type CalibrationReading } from './model';
import { parseCalibrateParams, type CalibrateParams } from './params';

/** UI refresh rate. Words, not motion — the glyph does not need 60 Hz to read as live. */
const PUBLISH_HZ = 12;

function faultFor(err: unknown): CalibrationFault {
  const code = err instanceof SensorSourceError ? err.code : null;
  switch (code) {
    case 'permission-denied':
      return {
        kind: 'permission',
        title: 'Motion access is off',
        body: 'Calibration reads the accelerometer and gyroscope. Turn on Motion & Fitness (and Location, for the direction of travel) in Settings → Drift-O-Meter, then try again.',
        retryable: true,
      };
    case 'unsupported':
      return {
        kind: 'unsupported',
        title: 'No motion sensors here',
        body: 'This device has no usable gyroscope, so there is no mount to calibrate. Switch to the simulated source in Settings to see what the judge does with a run.',
        retryable: false,
      };
    case 'services-disabled':
      return {
        kind: 'services',
        title: 'Location is off',
        body: 'Gravity alone fixes which way is up. Which way the car POINTS needs the direction of travel, and that needs Location Services.',
        retryable: true,
      };
    default:
      return { kind: 'failed', title: 'Sensors would not start', body: describeSensorError(err), retryable: true };
  }
}

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
        forwardResolved: cal.forwardResolved,
        calibrationOk: state.calibrationOk,
        mount: state.mount,
        looseScore: state.looseScore,
        message: state.message,
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
        setReading({ ...IDLE_READING, status: 'error', fault: faultFor(err), sourceKind: selection?.kind ?? null, sourceLabel: selection?.label ?? null });
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
  }, [attempt, params.at, params.hold, params.mount]);

  return { reading, params, retry };
}
