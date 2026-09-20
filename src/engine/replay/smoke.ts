import type { SmokeParticle, SmokeState } from './types';

/** Velocity decay time constant, s: puffs stop drifting after ~1 s. */
const SMOKE_DRAG_TAU = 0.45;
/** Growth: radius reaches size × (1 + SMOKE_GROWTH) at end of life. */
const SMOKE_GROWTH = 2.6;

/**
 * Where a smoke puff is, how big and how visible at replay time `t`.
 * Returns null when the particle is not alive at `t`. Pure and deterministic so the Skia
 * and SVG renderers agree pixel for pixel.
 */
export function smokeAt(p: SmokeParticle, t: number): SmokeState | null {
  const dt = t - p.birthT;
  if (dt < 0 || dt >= p.life) return null;
  const age = dt / p.life;
  // integrated exponential drag: x(t) = x0 + v0 τ (1 − e^{−t/τ})
  const k = SMOKE_DRAG_TAU * (1 - Math.exp(-dt / SMOKE_DRAG_TAU));
  const x = p.x + p.vx * k;
  const y = p.y + p.vy * k;
  // fast bloom then slow growth
  const grow = 1 - Math.pow(1 - age, 2);
  const radius = p.size * (1 + SMOKE_GROWTH * grow);
  // opacity: quick fade-in over the first 8 %, then (1-age)^1.15 fade-out
  const fadeIn = Math.min(1, age / 0.08);
  const opacity = p.strength * fadeIn * Math.pow(1 - age, 1.15);
  return { x, y, radius, opacity, age };
}

/** Particles alive at `t` (binary search on birthT — smoke is emitted in time order). */
export function liveSmoke(smoke: SmokeParticle[], t: number): SmokeParticle[] {
  if (smoke.length === 0) return [];
  // first particle whose birthT > t
  let lo = 0;
  let hi = smoke.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (smoke[mid].birthT <= t) lo = mid + 1;
    else hi = mid;
  }
  const out: SmokeParticle[] = [];
  for (let i = lo - 1; i >= 0; i--) {
    const p = smoke[i];
    if (t - p.birthT >= p.life) {
      // lives are uniform, so every earlier particle is dead too
      if (p.life === smoke[0].life) break;
      continue;
    }
    out.push(p);
  }
  out.reverse();
  return out;
}
