/**
 * React hook: selects a sensor source, starts it, and exposes the latest samples at a UI-safe
 * rate (default 15 Hz) together with counters and error state. Screens use it to show live
 * telemetry before/after the engine pipeline is wired in.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { GpsSample, MotionSample } from '../engine/types';
import { now } from './clock';
import { describeSensorError, type SensorSource } from './sensorSource';
import { selectSensorSource, type SourceSelection } from './sourceSelector';

export type FeedStatus = 'idle' | 'starting' | 'running' | 'ended' | 'error';

export interface SensorFeed {
  status: FeedStatus;
  error: string | null;
  label: string | null;
  kind: 'device' | 'simulated' | null;
  motion: MotionSample | null;
  gps: GpsSample | null;
  motionCount: number;
  gpsCount: number;
  /** Seconds since the source started. */
  elapsedS: number;
  /** Data played back so far, 0..1 (simulated only; NaN for device). */
  progress: number;
  stop(): void;
}

export interface UseSensorFeedOptions {
  enabled?: boolean;
  /** UI refresh rate. */
  hz?: number;
  loop?: boolean;
}

const INITIAL: Omit<SensorFeed, 'stop'> = {
  status: 'idle',
  error: null,
  label: null,
  kind: null,
  motion: null,
  gps: null,
  motionCount: 0,
  gpsCount: 0,
  elapsedS: 0,
  progress: NaN,
};

export function useSensorFeed({ enabled = true, hz = 15, loop = false }: UseSensorFeedOptions = {}): SensorFeed {
  const [state, setState] = useState<Omit<SensorFeed, 'stop'>>(INITIAL);
  const sourceRef = useRef<SensorSource | null>(null);
  const latest = useRef({ motion: null as MotionSample | null, gps: null as GpsSample | null, motionCount: 0, gpsCount: 0, startedAt: 0 });
  const [stopped, setStopped] = useState(false);

  const stop = useCallback(() => {
    sourceRef.current?.stop();
    sourceRef.current = null;
    setStopped(true);
    setState((s) => (s.status === 'running' || s.status === 'starting' ? { ...s, status: 'ended' } : s));
  }, []);

  useEffect(() => {
    if (!enabled || stopped) return;
    let alive = true;
    let ticker: ReturnType<typeof setInterval> | null = null;
    let selection: SourceSelection | null = null;

    setState({ ...INITIAL, status: 'starting' });
    latest.current = { motion: null, gps: null, motionCount: 0, gpsCount: 0, startedAt: now() };

    const publish = (status: FeedStatus) => {
      if (!alive) return;
      const l = latest.current;
      const src = selection?.source;
      const progress = src && src.kind === 'simulated' && 'progress' in src ? (src as { progress: number }).progress : NaN;
      setState((s) => ({
        ...s,
        status,
        label: selection?.label ?? s.label,
        kind: selection?.kind ?? s.kind,
        motion: l.motion,
        gps: l.gps,
        motionCount: l.motionCount,
        gpsCount: l.gpsCount,
        elapsedS: now() - l.startedAt,
        progress,
      }));
    };

    (async () => {
      try {
        selection = await selectSensorSource({
          loop,
          onEnd: () => {
            publish('ended');
            if (ticker) clearInterval(ticker);
            ticker = null;
          },
        });
        if (!alive) {
          selection.source.stop();
          return;
        }
        sourceRef.current = selection.source;
        await selection.source.start({
          onMotion: (m) => {
            latest.current.motion = m;
            latest.current.motionCount++;
          },
          onGps: (g) => {
            latest.current.gps = g;
            latest.current.gpsCount++;
          },
        });
        if (!alive) return;
        latest.current.startedAt = now();
        publish('running');
        ticker = setInterval(() => publish('running'), Math.max(16, Math.round(1000 / hz)));
      } catch (err) {
        if (!alive) return;
        console.warn('[sensors] source failed to start', err);
        setState((s) => ({ ...s, status: 'error', error: describeSensorError(err), label: selection?.label ?? s.label, kind: selection?.kind ?? s.kind }));
      }
    })();

    return () => {
      alive = false;
      if (ticker) clearInterval(ticker);
      sourceRef.current?.stop();
      sourceRef.current = null;
    };
  }, [enabled, hz, loop, stopped]);

  return { ...state, stop };
}
