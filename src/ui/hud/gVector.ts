/**
 * Engine axes → the g radar's face. One implementation, because a sign convention is the thing
 * that silently flips.
 *
 * The engine's frame (`VehicleMotionSample` in `src/engine/types.ts`): `ax` is + accelerating
 * FORWARD, `ay` is + to the LEFT. The face's frame is a screen canvas: x grows right, y grows
 * DOWN. So both axes negate, and the result is the acceleration vector as seen from above the
 * car with the car pointing up the screen — a right-hand push leans right, throttle leans up,
 * braking leans down.
 *
 * This is deliberately the ACCELERATION and not the force the driver feels, which is its
 * opposite. The gauge next to it sweeps right for a right-hand slide; two instruments side by
 * side that disagree about which way right is are worse than one instrument.
 *
 * CLAMPED ON THE VECTOR, NOT PER AXIS. Clamping x and y separately drags a reading past full
 * scale towards the nearest corner: 1.5 g of pure braking would come back as 1 g of braking, and
 * 1.2 g of braking-while-turning-right as a 45° diagonal the car never had. Scaling the whole
 * vector down to the rim keeps the heading and pins the length, which is the correct reading of
 * an acceleration off the end of the scale.
 */

/** Where the vector's tip sits, in units of the face's radius, plus its length 0..1. */
export interface GVector {
  /** −1..1, + is right on screen. */
  x: number;
  /** −1..1, + is DOWN on screen (so braking is positive). */
  y: number;
  /** 0..1 of full scale, clamped — the fraction of the radius the vector reaches. */
  mag: number;
}

/**
 * @param ayG lateral acceleration in g, + to the left (engine convention)
 * @param axG longitudinal acceleration in g, + forward (engine convention)
 * @param fullScaleG the magnitude at the rim
 */
export function gToFace(ayG: number, axG: number, fullScaleG: number): GVector {
  'worklet';
  // A non-finite sample must not put the vector somewhere undefined on screen: park it at zero,
  // which is the one position that claims nothing. The engine guards its own streams, but this
  // runs on whatever the shared value last held, including the frame a run is torn down on.
  if (!Number.isFinite(ayG) || !Number.isFinite(axG) || !(fullScaleG > 0)) return { x: 0, y: 0, mag: 0 };
  const x = -ayG / fullScaleG;
  const y = -axG / fullScaleG;
  const m = Math.sqrt(x * x + y * y);
  if (m <= 1) return { x, y, mag: m };
  return { x: x / m, y: y / m, mag: 1 };
}
