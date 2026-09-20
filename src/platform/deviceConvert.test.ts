import { describe, expect, it } from 'vitest';

import { degToRad, G } from '../engine/types';
import { deviceMotionTimestampS, gpsSampleFromLocation, motionSampleFromDeviceMotion, quaternionFromAttitude, rotationRateToPhoneFrame } from './deviceConvert';

const measurement = (over: Record<string, unknown> = {}) =>
  ({
    acceleration: { x: 0.5, y: -0.2, z: 0.1, timestamp: 1234.5 },
    accelerationIncludingGravity: { x: 0.5, y: -0.2 + 9.7, z: 0.1 - 1.5, timestamp: 1234.5 },
    rotation: { alpha: 0, beta: 0, gamma: 0, timestamp: 1234.5 },
    rotationRate: { alpha: 10, beta: 20, gamma: 30, timestamp: 1234.5 },
    interval: 10,
    orientation: 0,
    ...over,
  }) as unknown as Parameters<typeof motionSampleFromDeviceMotion>[0];

describe('deviceConvert', () => {
  it('maps iOS rotationRate (alpha=z, beta=y, gamma=x) from deg/s to rad/s', () => {
    expect(rotationRateToPhoneFrame({ alpha: 10, beta: 20, gamma: 30 }, 'ios')).toEqual({ x: degToRad(30), y: degToRad(20), z: degToRad(10) });
    expect(rotationRateToPhoneFrame({ alpha: 10, beta: 20, gamma: 30 }, 'android')).toEqual({ x: degToRad(10), y: degToRad(20), z: degToRad(30) });
  });

  it('derives gravity as accelerationIncludingGravity minus user acceleration', () => {
    const s = motionSampleFromDeviceMotion(measurement(), 42);
    expect(s.t).toBe(42);
    expect(s.accel).toEqual({ x: 0.5, y: -0.2, z: 0.1 });
    expect(s.gravity.x).toBeCloseTo(0, 9);
    expect(s.gravity.y).toBeCloseTo(9.7, 9);
    expect(s.gravity.z).toBeCloseTo(-1.5, 9);
    expect(Math.hypot(s.gravity.x, s.gravity.y, s.gravity.z)).toBeCloseTo(G, 0);
    expect(s.rotationRate.z).toBeCloseTo(degToRad(10), 12);
    expect(s.attitude).toEqual({ w: 1, x: 0, y: 0, z: 0 });
  });

  it('tolerates missing sub-objects', () => {
    const s = motionSampleFromDeviceMotion(measurement({ acceleration: null, rotationRate: null, rotation: undefined }), 1);
    expect(s.accel).toEqual({ x: 0, y: 0, z: 0 });
    expect(s.rotationRate).toEqual({ x: 0, y: 0, z: 0 });
    expect(s.attitude).toBeUndefined();
    expect(deviceMotionTimestampS(measurement())).toBe(1234.5);
    expect(deviceMotionTimestampS(measurement({ accelerationIncludingGravity: { x: 0, y: 0, z: 0 }, rotationRate: null, rotation: null, acceleration: null }))).toBeNull();
  });

  it('builds unit quaternions from attitude', () => {
    const q = quaternionFromAttitude(0.3, -0.2, 0.7);
    expect(Math.hypot(q.w, q.x, q.y, q.z)).toBeCloseTo(1, 12);
    const yawOnly = quaternionFromAttitude(Math.PI / 2, 0, 0);
    expect(yawOnly.z).toBeCloseTo(Math.SQRT1_2, 12);
    expect(yawOnly.w).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('maps location fixes, turning unknown (-1/null) speed and course into NaN', () => {
    const fix = (coords: Record<string, unknown>) => ({ coords, timestamp: 0, mocked: false }) as unknown as Parameters<typeof gpsSampleFromLocation>[0];
    const good = gpsSampleFromLocation(fix({ latitude: 47.3, longitude: 8.5, altitude: 410, accuracy: 4, altitudeAccuracy: 3, heading: 271.5, speed: 12.3 }), 7);
    expect(good).toEqual({ t: 7, lat: 47.3, lon: 8.5, speed: 12.3, course: 271.5, hAcc: 4, alt: 410 });
    const bad = gpsSampleFromLocation(fix({ latitude: 1, longitude: 2, altitude: null, accuracy: null, altitudeAccuracy: null, heading: -1, speed: -1 }), 8);
    expect(Number.isNaN(bad.speed)).toBe(true);
    expect(Number.isNaN(bad.course)).toBe(true);
    expect(Number.isNaN(bad.hAcc)).toBe(true);
    expect(bad.alt).toBeUndefined();
    const nul = gpsSampleFromLocation(fix({ latitude: 1, longitude: 2, heading: null, speed: null }), 9);
    expect(Number.isNaN(nul.speed) && Number.isNaN(nul.course)).toBe(true);
  });
});
