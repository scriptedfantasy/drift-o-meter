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
  /**
   * Running maximum |β| from the segment's first sample, one entry per sample. The halo takes
   * its colour from the peak SO FAR, never from the peak the slide will eventually reach: the
   * final heat of a slide must not be on screen before the slide has built to it.
   */
  peakTo: Float32Array;
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
  /** The scrubber's |β| ribbon as a closed polygon in unit space: x = t / duration, y = 0 at the
   *  top of the band (the widest angle in the run) and 1 on the baseline. */
  ribbon: SkPath;
  /**
   * Track centre line, or the driven path when the session has no track model. ONE path, stroked
   * four times: in this renderer a draw call costs far more than the geometry in it (measured in
   * the harness's software rasteriser at roughly a millisecond a call, whatever is in it), so
   * everything that can share a path does.
   */
  road: SkPath | null;
  roadClosed: boolean;
  edges: SkPath[];
  /** Every kerb in one path — see the note on `road`. */
  kerbs: SkPath | null;
  corners: Array<{ x: number; y: number; radiusM: number }>;
  gate: { ax: number; ay: number; bx: number; by: number } | null;
  runs: LineRun[];
  /** Stretches where the position was dead-reckoned: drawn dashed, never lit. */
  gaps: LineRun[];
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

/** Several contours in one path: the trail is BROKEN wherever the positions were not measured. */
function contours(runs: Pt[][]): SkPath {
  const b = Skia.PathBuilder.Make();
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      if (i === 0) b.moveTo(run[i][0], run[i][1]);
      else b.lineTo(run[i][0], run[i][1]);
    }
  }
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
  const edges = road ? [ROAD_W / 2 - 0.4, -(ROAD_W / 2 - 0.4)].map((d) => keep(polyline(offsetPolyline(roadPts, d, roadClosed), roadClosed))) : [];

  // ---- kerbs at the corners -----------------------------------------------------------
  const kerbParts: Pt[][] = [];
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
      kerbParts.push(offsetPolyline(seg, c.direction * (ROAD_W / 2 + 0.55), false));
    }
  }

  const kerbs = kerbParts.length ? keep(contours(kerbParts)) : null;

  // ---- the driven line, broken at every drift and every data gap ----------------------
  const runs: LineRun[] = [];
  const gaps: LineRun[] = [];
  {
    let run: Pt[] = [];
    let startIndex = 0;
    // cut long runs up as well, for the same reason the road is chunked: a lap of breadcrumbs is
    // one 1 200-point path, and only a few metres of it are ever on screen
    const MAX_RUN = 40;
    const flush = (endIndex: number) => {
      if (run.length > 1) runs.push({ path: keep(polyline(run)), bounds: boundsOf(run), startIndex, endIndex, dead: false });
      run = [];
    };
    for (let i = 0; i < tr.n; i++) {
      if (tr.segmentOf[i] >= 0 || dead[i] === 1) {
        flush(i - 1);
        continue;
      }
      if (run.length === 0) startIndex = i;
      run.push([tr.x[i], tr.y[i]]);
      if (run.length >= MAX_RUN) {
        const last: Pt = [tr.x[i], tr.y[i]];
        flush(i);
        run.push(last);
        startIndex = i;
      }
    }
    flush(tr.n - 1);
    // the stretches with no measured position at all, drift or not: these are dashed, never lit
    let gap: Pt[] = [];
    let gapStart = 0;
    const flushGap = (endIndex: number) => {
      if (gap.length > 1) gaps.push({ path: keep(polyline(gap)), bounds: boundsOf(gap), startIndex: gapStart, endIndex, dead: true });
      gap = [];
    };
    for (let i = 0; i < tr.n; i++) {
      if (dead[i] !== 1) {
        flushGap(i - 1);
        continue;
      }
      if (gap.length === 0) gapStart = Math.max(0, i - 1);
      if (gap.length === 0 && i > 0) gap.push([tr.x[i - 1], tr.y[i - 1]]);
      gap.push([tr.x[i], tr.y[i]]);
    }
    flushGap(tr.n - 1);
  }

  // ---- drift ribbons ------------------------------------------------------------------
  const segments: SegmentGeometry[] = [];
  for (const seg of replay.segments) {
    const parts: Pt[][] = [];
    let part: Pt[] = [];
    let count = 0;
    for (let i = seg.startIndex; i <= seg.endIndex; i++) {
      if (dead[i] === 1) {
        if (part.length > 1) parts.push(part);
        part = [];
        continue;
      }
      part.push([tr.x[i], tr.y[i]]);
      count++;
    }
    if (part.length > 1) parts.push(part);
    const pts: Pt[] = parts.flat();
    if (count < 2 || parts.length === 0) continue;
    // The ribbon's width and colour follow |β| sample by sample, which as separate strokes is a
    // hundred draw calls a segment. Bands of 8° of SLIP ANGLE collapse each one into a single
    // path while keeping the escalation: a band spans 8° of the ramp, and it is coloured and
    // widthed from its OWN MEAN, so neither the colour nor the stroke can be pulled by one spike
    // somewhere else in the slide.
    const chunks: TrailChunk[] = [];
    const BAND_DEG = 8;
    const BANDS = 14;
    for (const hot of [false, true]) {
      const bands: Array<{ parts: Pt[][]; part: Pt[]; inten: number; mag: number; n: number; from: number; to: number }> = [];
      for (let k = 0; k < BANDS; k++) bands.push({ parts: [], part: [], inten: 0, mag: 0, n: 0, from: -1, to: -1 });
      const step = 3;
      for (let a = seg.startIndex; a < seg.endIndex; a += step) {
        const b = Math.min(seg.endIndex, a + step);
        let inten = 0;
        let mag = 0;
        const cp: Pt[] = [];
        for (let i = a; i <= b; i++) {
          if (dead[i] === 1) continue;
          inten += tr.intensity[i];
          mag += Math.abs(tr.beta[i]);
          cp.push([tr.x[i], tr.y[i]]);
        }
        if (cp.length < 2) continue;
        inten /= cp.length;
        mag /= cp.length;
        if (hot && inten < 0.1) continue;
        const k = Math.min(BANDS - 1, Math.max(0, Math.floor(((mag * 180) / Math.PI) / BAND_DEG)));
        const band = bands[k];
        // contours inside a band stay separate, so two distant stretches never join up
        if (band.part.length > 0 && band.to === a) band.part.push(...cp.slice(1));
        else {
          if (band.part.length > 1) band.parts.push(band.part);
          band.part = [...cp];
          if (band.from < 0) band.from = a;
        }
        band.to = b;
        band.inten += inten;
        band.mag += mag;
        band.n++;
      }
      for (let k = 0; k < BANDS; k++) {
        const band = bands[k];
        if (band.part.length > 1) band.parts.push(band.part);
        if (band.parts.length === 0) continue;
        const flat = band.parts.flat();
        const meanAngle = band.mag / Math.max(1, band.n);
        chunks.push({
          path: keep(contours(band.parts)),
          color: hot ? mix(HOT, heatColor(meanAngle), 0.35) : heatColor(meanAngle),
          intensity: band.inten / Math.max(1, band.n),
          hot,
          bounds: boundsOf(flat),
          startIndex: band.from,
          endIndex: band.to,
        });
      }
    }
    const peakTo = new Float32Array(seg.endIndex - seg.startIndex + 1);
    let running = 0;
    for (let i = seg.startIndex; i <= seg.endIndex; i++) {
      running = Math.max(running, Math.abs(tr.beta[i]));
      peakTo[i - seg.startIndex] = running;
    }
    segments.push({ seg, ribbon: keep(contours(parts)), bounds: boundsOf(pts), peakTo, chunks });
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

  // ---- the scrubber's |β| ribbon, in unit space -------------------------------------
  const tel = replay.telemetry;
  const scale = ribbonScale(replay);
  const ribbonPts: Pt[] = [[0, 1]];
  const stride = Math.max(1, Math.floor(tel.n / 600));
  for (let i = 0; i < tel.n; i += stride) ribbonPts.push([clamp(tel.t[i] / Math.max(1e-6, replay.durationS), 0, 1), 1 - clamp(tel.angle[i] / scale, 0, 1)]);
  ribbonPts.push([1, 1 - clamp(tel.angle[tel.n - 1] / scale, 0, 1)], [1, 1]);
  const ribbon = keep(polyline(ribbonPts, true));

  return {
    ribbon,
    road,
    roadClosed,
    edges,
    kerbs,
    corners,
    gate: replay.track?.gate ?? null,
    runs,
    gaps,
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
