import type { SmokeParticle, SmokeState } from './types';

/** Velocity decay time constant, s: puffs stop drifting after ~1 s. */
const SMOKE_DRAG_TAU = 0.45;
/** Growth: radius reaches size × (1 + SMOKE_GROWTH) at end of life. */
const SMOKE_GROWTH = 2.1;
/** Turbulence: metres of swirl by end of life. */
const SMOKE_TURBULENCE = 1.4;
/** Buoyancy: slow outward/upward drift (screen-up is +y in world terms here), m/s. */
const SMOKE_BUOYANCY = 0.35;

/**
 * Where a smoke puff is, how big, how hot and how visible at replay time `t`.
 * Returns null when the particle is not alive at `t`. Pure and deterministic so the Skia
 * and SVG renderers agree exactly.
 */
export function smokeAt(p: SmokeParticle, t: number): SmokeState | null {
  if (!Number.isFinite(t) || !Number.isFinite(p.birthT) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  const dt = t - p.birthT;
  if (dt < 0 || dt >= p.life) return null;
  const age = dt / p.life;
  // integrated exponential drag: x(t) = x0 + v0 τ (1 − e^{−t/τ})
  const k = SMOKE_DRAG_TAU * (1 - Math.exp(-dt / SMOKE_DRAG_TAU));
  // per-particle swirl so a cloud is not a row of identical discs
  const ph = p.seed * Math.PI * 2;
  const sw = SMOKE_TURBULENCE * age * age;
  const x = p.x + p.vx * k + Math.cos(ph + 2.1 * age) * sw + p.vx * 0.05 * SMOKE_BUOYANCY * dt;
  const y = p.y + p.vy * k + Math.sin(ph + 2.1 * age) * sw + p.vy * 0.05 * SMOKE_BUOYANCY * dt;
  // fast bloom then slow growth
  const grow = 1 - Math.pow(1 - age, 2);
  const radius = p.size * (1 + SMOKE_GROWTH * grow);
  // opacity: quick fade-in over the first 8 %, then (1-age)^1.15 fade-out
  const fadeIn = Math.min(1, age / 0.08);
  const opacity = p.strength * fadeIn * Math.pow(1 - age, 1.15);
  // white-hot at birth, cooling to grey dust
  const heat = p.heat * Math.pow(1 - age, 1.8);
  return { x, y, radius, opacity, age, heat, rotation: ph + 1.4 * age * (p.seed > 0.5 ? 1 : -1), seed: p.seed };
}

/** Particles alive at `t` (binary search on birthT — smoke is emitted in time order). */
export function liveSmoke(smoke: SmokeParticle[], t: number): SmokeParticle[] {
  if (smoke.length === 0 || !Number.isFinite(t)) return [];
  let lo = 0;
  let hi = smoke.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (smoke[mid].birthT <= t) lo = mid + 1;
    else hi = mid;
  }
  const out: SmokeParticle[] = [];
  // lives vary per particle, so scan back over the longest possible life
  let maxLife = 0;
  for (let i = 0; i < smoke.length; i += Math.max(1, Math.floor(smoke.length / 32))) maxLife = Math.max(maxLife, smoke[i].life);
  maxLife = Math.max(maxLife, 2.5);
  for (let i = lo - 1; i >= 0; i--) {
    const p = smoke[i];
    if (t - p.birthT > maxLife) break;
    if (t - p.birthT < p.life) out.push(p);
  }
  out.reverse();
  return out;
}
