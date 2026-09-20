/**
 * Static scene geometry, built once per replay.
 *
 * The world does not change while a replay plays: the road, the kerbs, the driven line and every
 * drift ribbon are fixed in metres, and only the CAMERA moves. So all of it is turned into Skia
 * paths once, here, and the frame loop just draws them under a matrix. The only geometry rebuilt
 * per frame is the piece of the trail that is *currently being drawn* (a few dozen points), the
 * car's slip arc and the smoke — see `scene.ts`.
 *
 * Paths are wasm objects with no finaliser: `dispose()` MUST be called when the screen unmounts,
 * or every visit to a replay leaks the whole track.
 *
 * Imports Skia directly: only ever reached through `ReplayCanvasView`.
 */
import { Skia, type SkPath } from '@shopify/react-native-skia';

import { SEVERITY_EDGES, type Replay, type ReplaySegment } from '../../engine/replay';
import { clamp } from '../../engine/types';
import { HOT, heatColor, mix } from './palette';

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TrailChunk {
  path: SkPath;
  color: string;
  /** Mean drift intensity over the chunk — sets the stroke width. */
  intensity: number;
  hot: boolean;
  bounds: WorldBounds;
  /** Trail index range, so a chunk the car is inside right now can be drawn part-way. */
  startIndex: number;
  endIndex: number;
}

export interface SegmentGeometry {
  seg: ReplaySegment;
  /** The whole segment as one polyline: the translucent halo and glow layers need a single path,
   *  or overlapping chunks blend into a lattice. */
  ribbon: SkPath;
  bounds: WorldBounds;
  color: string;
  chunks: TrailChunk[];
}

export interface LineRun {
  path: SkPath;
  bounds: WorldBounds;
  /** Trail index range this run covers, so the frame loop knows when it is fully played. */
  startIndex: number;
  endIndex: number;
  /** True where the positions were dead-reckoned through a GPS gap. */
  dead: boolean;
}

export interface CarShapes {
  body: SkPath;
  glassFront: SkPath;
  glassRear: SkPath;
  chevron: SkPath;
  wheels: Array<{ x: number; y: number }>;
}

export interface SceneGeometry {
  /** Track centre line (or the driven path when the session has no track model). */
  road: SkPath | null;
  roadClosed: boolean;
  edges: SkPath[];
  kerbs: Array<{ path: SkPath; bounds: WorldBounds }>;
  corners: Array<{ x: number; y: number; radiusM: number }>;
  gate: { ax: number; ay: number; bx: number; by: number } | null;
  runs: LineRun[];
  segments: SegmentGeometry[];
  car: CarShapes;
  /** Unit shapes, scaled at draw time. */
  diamond: SkPath;
  arrowHead: SkPath;
  dispose(): void;
}

export const ROAD_W = 9.5;
const VERGE_W = ROAD_W + 7;

type Pt = [number, number];

function boundsOf(pts: Pt[]): WorldBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function polyline(pts: Pt[], close = false): SkPath {
  const b = Skia.PathBuilder.Make();
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (i === 0) b.moveTo(x, y);
    else b.lineTo(x, y);
  }
  if (close) b.close();
  return b.detach();
}

function offsetPolyline(pts: Pt[], d: number, closed: boolean): Pt[] {
  const n = pts.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    out.push([pts[i][0] - (dy / len) * d, pts[i][1] + (dx / len) * d]);
  }
  return out;
}

function carShapes(): CarShapes {
  const body = Skia.PathBuilder.Make()
    .moveTo(-2.2, -0.9)
    .lineTo(1.15, -0.9)
    .quadTo(2.2, -0.75, 2.2, -0.3)
    .lineTo(2.2, 0.3)
    .quadTo(2.2, 0.75, 1.15, 0.9)
    .lineTo(-2.2, 0.9)
    .quadTo(-2.3, 0, -2.2, -0.9)
    .close()
    .detach();
  const glassFront = polyline(
    [
      [0.15, -0.78],
      [0.95, -0.62],
      [0.95, 0.62],
      [0.15, 0.78],
    ],
    true,
  );
  const glassRear = polyline(
    [
      [-1.95, -0.75],
      [-1.45, -0.62],
      [-1.45, 0.62],
      [-1.95, 0.75],
    ],
    true,
  );
  const chevron = polyline(
    [
      [-0.85, -0.5],
      [0.05, 0],
      [-0.85, 0.5],
      [-0.55, 0],
    ],
    true,
  );
  return {
    body,
    glassFront,
    glassRear,
    chevron,
    wheels: [
      { x: 1.35, y: 1.0 },
      { x: 1.35, y: -1.0 },
      { x: -1.45, y: 1.0 },
      { x: -1.45, y: -1.0 },
    ],
  };
}

/** Build every fixed path in the scene. `dead` marks trail samples with no GPS behind them. */
export function buildSceneGeometry(replay: Replay, dead: Uint8Array): SceneGeometry {
  const tr = replay.trail;
  const owned: SkPath[] = [];
  const keep = <T extends SkPath>(p: T): T => {
    owned.push(p);
    return p;
  };

  // ---- road ---------------------------------------------------------------------------
  let roadPts: Pt[] = [];
  let roadClosed = false;
  if (replay.track && replay.track.path.length > 1) {
    roadPts = replay.track.path.map((p) => [p.x, p.y] as Pt);
    roadClosed = replay.track.closed;
  } else {
    for (let i = 0; i < tr.n; i += 4) roadPts.push([tr.x[i], tr.y[i]]);
  }
  const road = roadPts.length > 1 ? keep(polyline(roadPts, roadClosed)) : null;
  const edges = road
    ? [ROAD_W / 2 - 0.4, -(ROAD_W / 2 - 0.4)].map((d) => keep(polyline(offsetPolyline(roadPts, d, roadClosed), roadClosed)))
    : [];

  // ---- kerbs at the corners -----------------------------------------------------------
  const kerbs: SceneGeometry['kerbs'] = [];
  const corners: SceneGeometry['corners'] = [];
  if (replay.track?.corners?.length && roadPts.length > 2) {
    const n = roadPts.length;
    for (const c of replay.track.corners) {
      corners.push({ x: c.x, y: c.y, radiusM: c.radiusM });
      let ai = 0;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = (roadPts[i][0] - c.x) ** 2 + (roadPts[i][1] - c.y) ** 2;
        if (d < bestD) {
          bestD = d;
          ai = i;
        }
      }
      const span = Math.max(6, Math.round(Math.min(40, c.radiusM * 0.9)));
      const seg: Pt[] = [];
      for (let k = -span; k <= span; k += 2) {
        const i = roadClosed ? (ai + k + n) % n : clamp(ai + k, 0, n - 1);
        seg.push(roadPts[i]);
      }
      if (seg.length < 3) continue;
      const inside = offsetPolyline(seg, c.direction * (ROAD_W / 2 + 0.55), false);
      kerbs.push({ path: keep(polyline(inside)), bounds: boundsOf(inside) });
    }
  }

  // ---- the driven line, split into runs at every drift and every data gap --------------
  const runs: LineRun[] = [];
  {
    let run: Pt[] = [];
    let startIndex = 0;
    let deadRun = false;
    const flush = (endIndex: number) => {
      if (run.length > 1) runs.push({ path: keep(polyline(run)), bounds: boundsOf(run), startIndex, endIndex, dead: deadRun });
      run = [];
    };
    for (let i = 0; i < tr.n; i++) {
      const isDead = dead[i] === 1;
      if (tr.segmentOf[i] >= 0) {
        flush(i - 1);
        continue;
      }
      if (run.length > 0 && isDead !== deadRun) {
        // keep the two runs joined: the gap run starts where the good one stopped
        run.push([tr.x[i], tr.y[i]]);
        flush(i - 1);
      }
      if (run.length === 0) {
        startIndex = i;
        deadRun = isDead;
      }
      run.push([tr.x[i], tr.y[i]]);
    }
    flush(tr.n - 1);
  }

  // ---- drift ribbons ------------------------------------------------------------------
  const segments: SegmentGeometry[] = [];
  for (const seg of replay.segments) {
    const pts: Pt[] = [];
    let peak = 0;
    for (let i = seg.startIndex; i <= seg.endIndex; i++) {
      pts.push([tr.x[i], tr.y[i]]);
      if (Math.abs(tr.beta[i]) > peak) peak = Math.abs(tr.beta[i]);
    }
    if (pts.length < 2) continue;
    const chunks: TrailChunk[] = [];
    for (const hot of [false, true]) {
      const step = 3;
      for (let a = seg.startIndex; a < seg.endIndex; a += step) {
        const b = Math.min(seg.endIndex, a + step);
        let inten = 0;
        let mag = 0;
        const cp: Pt[] = [];
        for (let i = a; i <= b; i++) {
          inten += tr.intensity[i];
          mag = Math.max(mag, Math.abs(tr.beta[i]));
          cp.push([tr.x[i], tr.y[i]]);
        }
        inten /= b - a + 1;
        if (hot && inten < 0.1) continue;
        chunks.push({
          path: keep(polyline(cp)),
          color: hot ? mix(HOT, heatColor(mag), 0.35) : heatColor(mag),
          intensity: inten,
          hot,
          bounds: boundsOf(cp),
          startIndex: a,
          endIndex: b,
        });
      }
    }
    segments.push({ seg, ribbon: keep(polyline(pts)), bounds: boundsOf(pts), color: heatColor(peak), chunks });
  }

  const car = carShapes();
  owned.push(car.body, car.glassFront, car.glassRear, car.chevron);
  const diamond = keep(
    polyline(
      [
        [0, 1],
        [0.72, 0],
        [0, -1],
        [-0.72, 0],
      ],
      true,
    ),
  );
  const arrowHead = keep(
    polyline(
      [
        [0.9, 0],
        [-1, 0.6],
        [-1, -0.6],
      ],
      true,
    ),
  );

  return {
    road,
    roadClosed,
    edges,
    kerbs,
    corners,
    gate: replay.track?.gate ?? null,
    runs,
    segments,
    car,
    diamond,
    arrowHead,
    dispose() {
      for (const p of owned) {
        try {
          p.dispose();
        } catch {
          // a path already released by a hot reload is not worth crashing over
        }
      }
      owned.length = 0;
    },
  };
}

/** Widest |β| the scrubber ribbon is scaled to (never less than the spin edge). */
export function ribbonScale(replay: Replay): number {
  return Math.max(SEVERITY_EDGES.spin, replay.telemetry.maxAngle * 1.05);
}
