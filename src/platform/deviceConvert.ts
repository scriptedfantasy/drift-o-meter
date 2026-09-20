/**
 * Pure conversions from expo-sensors / expo-location payloads into engine sample types.
 * Kept free of native imports so they run in vitest.
 *
 * expo-sensors DeviceMotion facts (verified against expo-sensors 57 sources):
 *  - `acceleration` = CoreMotion userAcceleration × 9.80665  (m/s², gravity removed)
 *  - `accelerationIncludingGravity` = (userAcceleration + gravity) × 9.80665
 *    ⇒ gravity = accelerationIncludingGravity − acceleration, points DOWN, |g| ≈ 9.81.
 *  - `rotationRate` is in DEG/S and the axis naming differs per platform:
 *      iOS     (DeviceMotionModule.swift): alpha = z, beta = y, gamma = x
 *      Android (DeviceMotionModule.kt):    alpha = x, beta = y, gamma = z
 *  - `rotation` (attitude) is yaw/pitch/roll in radians on iOS (alpha = yaw, beta = pitch, gamma = roll).
 *  - Every sub-object carries `timestamp` in seconds since boot (CoreMotion / SensorEvent clock).
 */
import type { LocationObject } from 'expo-location';
import type { DeviceMotionMeasurement } from 'expo-sensors';

import { degToRad, type GpsSample, type MotionSample, type Quaternion, type Vec3 } from '../engine/types';

export type DevicePlatform = 'ios' | 'android';

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

/** expo's `{alpha, beta, gamma}` rotation rate (deg/s) → phone-frame `{x, y, z}` in rad/s. */
export function rotationRateToPhoneFrame(rr: { alpha: number; beta: number; gamma: number }, platform: DevicePlatform = 'ios'): Vec3 {
  if (platform === 'android') {
    return { x: degToRad(rr.alpha), y: degToRad(rr.beta), z: degToRad(rr.gamma) };
  }
  return { x: degToRad(rr.gamma), y: degToRad(rr.beta), z: degToRad(rr.alpha) };
}

function qMul(a: Quaternion, b: Quaternion): Quaternion {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/**
 * CoreMotion attitude (yaw about z, pitch about x, roll about y; radians) → quaternion,
 * composed as Rz(yaw) · Rx(pitch) · Ry(roll). The engine treats attitude as optional, so an
 * imperfect composition order only affects diagnostics, never the slip estimate.
 */
export function quaternionFromAttitude(yaw: number, pitch: number, roll: number): Quaternion {
  const qz: Quaternion = { w: Math.cos(yaw / 2), x: 0, y: 0, z: Math.sin(yaw / 2) };
  const qx: Quaternion = { w: Math.cos(pitch / 2), x: Math.sin(pitch / 2), y: 0, z: 0 };
  const qy: Quaternion = { w: Math.cos(roll / 2), x: 0, y: Math.sin(roll / 2), z: 0 };
  return qMul(qMul(qz, qx), qy);
}

/** The sensor's own timestamp (seconds since boot), if the payload carries one. */
export function deviceMotionTimestampS(m: DeviceMotionMeasurement): number | null {
  const ts = m.accelerationIncludingGravity?.timestamp ?? m.rotationRate?.timestamp ?? m.rotation?.timestamp ?? m.acceleration?.timestamp;
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
}

/**
 * Build an engine `MotionSample` from a DeviceMotion payload. `t` is the sample time on the
 * app's monotonic clock (the caller re-bases the sensor timestamp; see `DeviceSensorSource`).
 */
export function motionSampleFromDeviceMotion(m: DeviceMotionMeasurement, t: number, platform: DevicePlatform = 'ios'): MotionSample {
  const user = m.acceleration ?? ZERO;
  const incl = m.accelerationIncludingGravity ?? ZERO;
  const accel: Vec3 = { x: user.x, y: user.y, z: user.z };
  const gravity: Vec3 = { x: incl.x - user.x, y: incl.y - user.y, z: incl.z - user.z };
  const rotationRate = m.rotationRate ? rotationRateToPhoneFrame(m.rotationRate, platform) : { ...ZERO };
  const sample: MotionSample = { t, accel, gravity, rotationRate };
  if (m.rotation && Number.isFinite(m.rotation.alpha) && Number.isFinite(m.rotation.beta) && Number.isFinite(m.rotation.gamma)) {
    sample.attitude = quaternionFromAttitude(m.rotation.alpha, m.rotation.beta, m.rotation.gamma);
  }
  return sample;
}

function validOrNaN(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : NaN;
}

/**
 * expo-location fix → `GpsSample`. `coords.heading` on iOS is CLLocation.course (direction of
 * travel, degrees clockwise from north), −1 when unknown; `speed` is m/s, −1 when unknown.
 */
export function gpsSampleFromLocation(loc: LocationObject, t: number): GpsSample {
  const c = loc.coords;
  const sample: GpsSample = {
    t,
    lat: c.latitude,
    lon: c.longitude,
    speed: validOrNaN(c.speed),
    course: validOrNaN(c.heading),
    hAcc: typeof c.accuracy === 'number' && Number.isFinite(c.accuracy) ? c.accuracy : NaN,
  };
  if (typeof c.altitude === 'number' && Number.isFinite(c.altitude)) sample.alt = c.altitude;
  return sample;
}
