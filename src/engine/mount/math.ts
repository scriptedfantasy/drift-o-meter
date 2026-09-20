import type { Vec3 } from '../types';

type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** Row i of a row-major 3×3 matrix as a Vec3 (row i of a phone→vehicle R is vehicle axis i in phone coordinates). */
export function rowOf(r: Mat3, i: 0 | 1 | 2): Vec3 {
  return { x: r[i * 3], y: r[i * 3 + 1], z: r[i * 3 + 2] };
}

/** Angle between two vectors, degrees. */
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const na = Math.hypot(a.x, a.y, a.z);
  const nb = Math.hypot(b.x, b.y, b.z);
  if (na < 1e-12 || nb < 1e-12) return 0;
  const c = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (na * nb)));
  return (Math.acos(c) * 180) / Math.PI;
}

/** v_out = R · v. */
export function applyRotation(r: Mat3, v: Vec3): Vec3 {
  return {
    x: r[0] * v.x + r[1] * v.y + r[2] * v.z,
    y: r[3] * v.x + r[4] * v.y + r[5] * v.z,
    z: r[6] * v.x + r[7] * v.y + r[8] * v.z,
  };
}
