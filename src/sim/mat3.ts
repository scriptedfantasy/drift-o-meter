import type { Vec3 } from '../engine/types';

/** Row-major 3×3 matrix helpers used by the simulator's sensor model. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r: number[] = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r as Mat3;
}

export function transpose(a: Mat3): Mat3 {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

export function apply(a: Mat3, v: Vec3): Vec3 {
  return {
    x: a[0] * v.x + a[1] * v.y + a[2] * v.z,
    y: a[3] * v.x + a[4] * v.y + a[5] * v.z,
    z: a[6] * v.x + a[7] * v.y + a[8] * v.z,
  };
}

/** Rotation about x by angle a (right-hand rule). */
export function rotX(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function rotY(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotZ(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Build a matrix from three column vectors (images of the basis vectors). */
export function fromColumns(c0: Vec3, c1: Vec3, c2: Vec3): Mat3 {
  return [c0.x, c1.x, c2.x, c0.y, c1.y, c2.y, c0.z, c1.z, c2.z];
}
