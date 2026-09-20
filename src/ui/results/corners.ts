/** Naming corners so the screen can say "the hairpin at Turn 4" instead of "corner 3". */
import type { TrackCorner, TrackModel } from '../../engine/types';

export function cornerShape(c: TrackCorner): string {
  if (c.radiusM < 24) return 'hairpin';
  if (c.radiusM < 48) return c.direction === 1 ? 'left-hander' : 'right-hander';
  return c.direction === 1 ? 'long left' : 'long right';
}

/** "the hairpin at Turn 4" — for prose. */
export function cornerLabel(c: TrackCorner): string {
  return `the ${cornerShape(c)} at Turn ${c.id + 1}`;
}

/** "TURN 4 · HAIRPIN" — for tables. */
export function cornerTag(c: TrackCorner): string {
  return `Turn ${c.id + 1} · ${cornerShape(c)}`;
}

/** Nearest corner apex to a point, within `maxM` metres. */
export function cornerAt(track: TrackModel | null, x: number, y: number, maxM = 70): TrackCorner | null {
  if (!track || !track.corners.length) return null;
  let best: TrackCorner | null = null;
  let bestD = maxM * maxM;
  for (const c of track.corners) {
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
