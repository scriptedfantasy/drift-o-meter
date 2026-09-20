import { describe, expect, it } from 'vitest';

import type { GpsSample, MotionSample } from '../engine/types';
import { now } from './clock';
import { SimulatedSensorSource } from './simulatedSensorSource';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeStreams(durationS: number, motionHz = 100, gpsHz = 10, tStart = 100) {
  const motion: MotionSample[] = [];
  const gps: GpsSample[] = [];
  const n = Math.round(durationS * motionHz);
  for (let i = 0; i <= n; i++) {
    const t = tStart + i / motionHz;
    motion.push({ t, accel: { x: 0, y: 0, z: 0 }, gravity: { x: 0, y: 0, z: -9.81 }, rotationRate: { x: 0, y: 0, z: i } });
  }
  const ng = Math.round(durationS * gpsHz);
  for (let i = 0; i <= ng; i++) {
    const t = tStart + i / gpsHz;
    gps.push({ t, lat: 0, lon: 0, speed: i, course: 0, hAcc: 3 });
  }
  return { motion, gps };
}

describe('SimulatedSensorSource', () => {
  it('delivers every sample in time order at 1x, re-based onto the live clock', async () => {
    const data = makeStreams(0.2);
    const src = new SimulatedSensorSource(data);
    expect(src.durationS).toBeCloseTo(0.2, 6);
    const got: Array<['m' | 'g', number]> = [];
    const before = now();
    await src.start({ onMotion: (s) => got.push(['m', s.t]), onGps: (s) => got.push(['g', s.t]) });
    expect(src.isRunning).toBe(true);
    await sleep(450);
    expect(got.length).toBe(data.motion.length + data.gps.length);
    for (let i = 1; i < got.length; i++) expect(got[i][1]).toBeGreaterThanOrEqual(got[i - 1][1]);
    // first sample sits at the start time on the live clock (not at the recording's t = 100)
    expect(got[0][1]).toBeGreaterThanOrEqual(before - 1e-6);
    expect(got[0][1] - before).toBeLessThan(0.1);
    // original spacing is preserved exactly
    expect(got[got.length - 1][1] - got[0][1]).toBeCloseTo(0.2, 6);
    expect(src.isRunning).toBe(false);
    expect(src.progress).toBe(1);
  });

  it('fast-forwards at rate > 1 while keeping the sample spacing', async () => {
    const data = makeStreams(1.0);
    const src = new SimulatedSensorSource(data, { rate: 8 });
    const ts: number[] = [];
    await src.start({ onMotion: (s) => ts.push(s.t), onGps: () => {} });
    await sleep(400); // 1 s of data at 8x = 125 ms wall
    expect(ts.length).toBe(data.motion.length);
    expect(ts[ts.length - 1] - ts[0]).toBeCloseTo(1.0, 6);
    expect(src.isRunning).toBe(false);
  });

  it('stop() halts delivery immediately', async () => {
    const data = makeStreams(1.0);
    const src = new SimulatedSensorSource(data);
    let count = 0;
    await src.start({ onMotion: () => count++, onGps: () => {} });
    await sleep(80);
    src.stop();
    const atStop = count;
    expect(atStop).toBeGreaterThan(0);
    expect(atStop).toBeLessThan(data.motion.length);
    await sleep(120);
    expect(count).toBe(atStop);
    expect(src.isRunning).toBe(false);
  });

  it('calls onEnd exactly once and loops when asked', async () => {
    const data = makeStreams(0.1);
    let ends = 0;
    const src = new SimulatedSensorSource(data, { onEnd: () => ends++ });
    await src.start({ onMotion: () => {}, onGps: () => {} });
    await sleep(300);
    expect(ends).toBe(1);

    let count = 0;
    const looping = new SimulatedSensorSource(data, { loop: true, onEnd: () => ends++ });
    await looping.start({ onMotion: () => count++, onGps: () => {} });
    await sleep(350);
    looping.stop();
    expect(count).toBeGreaterThan(data.motion.length);
    expect(ends).toBe(1);
  });

  it('handles empty data and rejects a non-positive rate', async () => {
    let ended = false;
    const empty = new SimulatedSensorSource({ motion: [], gps: [] }, { onEnd: () => (ended = true) });
    await empty.start({ onMotion: () => {}, onGps: () => {} });
    await sleep(20);
    expect(ended).toBe(true);
    expect(() => new SimulatedSensorSource({ motion: [], gps: [] }, { rate: 0 })).toThrow();
  });
});
