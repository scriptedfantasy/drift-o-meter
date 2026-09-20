import { wrapAngle } from '../engine/types';

/**
 * Track geometry for the simulator: control points → centripetal Catmull-Rom spline →
 * uniform arc-length samples with tangent angle and smoothed curvature.
 * Coordinates are local ENU metres (x east, y north). Tangent angle is the math heading.
 */
export interface TrackDef {
  id: 'harbor' | 'touge';
  name: string;
  tagline: string;
  closed: boolean;
  /** Control points in metres. */
  points: Array<[number, number]>;
  /** Origin used to convert to lat/lon. */
  originLat: number;
  originLon: number;
  /** Road grade (rise/run) and banking (radians) as functions of arc length, optional. */
  grade?: (s: number) => number;
  banking?: (s: number, kappa: number) => number;
  /** Top speed the scripted driver aims for on straights, m/s. */
  vTop: number;
}

export interface PathSample {
  s: number;
  x: number;
  y: number;
  /** Tangent angle, math convention, radians. */
  chi: number;
  /** Curvature dχ/ds (1/m), + = left (CCW). Smoothed over ~6 m. */
  kappa: number;
}

export interface Path {
  def: TrackDef;
  samples: PathSample[];
  ds: number;
  length: number;
  at(s: number): PathSample;
}

export const TRACKS: Record<'harbor' | 'touge', TrackDef> = {
  harbor: {
    id: 'harbor',
    name: 'Harbor Circuit',
    tagline: 'Container-yard drift course: sweeper, chicane, hairpin, back straight',
    closed: true,
    originLat: 35.6205,
    originLon: 139.7745,
    vTop: 30,
    points: [
      [0, 0],
      [90, 0],
      [180, 0],
      [250, 8],
      [300, 40], // long right-hand sweeper (turning clockwise → κ<0)
      [320, 90],
      [300, 140],
      [250, 170], // exits into a left–right chicane
      [215, 200],
      [200, 240],
      [225, 275],
      [260, 300],
      [270, 340], // hairpin right at the top
      [240, 370],
      [195, 360],
      [165, 320],
      [140, 270],
      [100, 235], // long left-hander back toward the straight
      [50, 215],
      [5, 190],
      [-30, 140],
      [-35, 80],
      [-20, 25],
    ],
  },
  touge: {
    id: 'touge',
    name: 'Mountain Pass',
    tagline: 'Downhill touge: linked S-bends, off-camber hairpins, one long uphill exit',
    closed: false,
    originLat: 35.3606,
    originLon: 138.7274,
    vTop: 24,
    points: [
      [0, 0],
      [60, 5],
      [120, 25],
      [160, 60], // right-left S-bend
      [150, 110],
      [110, 140],
      [80, 185],
      [95, 230], // left hairpin-ish
      [140, 250],
      [190, 240],
      [230, 270], // right
      [235, 320],
      [200, 355], // left
      [150, 370],
      [110, 400], // right
      [120, 450],
      [165, 470], // left
      [220, 465],
      [265, 495], // right
      [275, 545],
      [240, 585], // left
      [190, 600],
      [150, 640], // right
      [160, 690],
      [210, 720],
      [270, 730],
      [340, 725],
    ],
    grade: (s) => -0.06 + 0.04 * Math.sin(s / 140),
    banking: (_s, kappa) => -0.25 * kappa * 8, // slight off-camber (banks away from the turn)
  },
};

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function buildPath(def: TrackDef, ds = 0.5): Path {
  const pts = def.points;
  const n = pts.length;
  const segs = def.closed ? n : n - 1;
  const dense: Array<[number, number]> = [];
  const per = 400;
  for (let i = 0; i < segs; i++) {
    const p0 = pts[def.closed ? (i - 1 + n) % n : Math.max(i - 1, 0)];
    const p1 = pts[i % n];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[def.closed ? (i + 2) % n : Math.min(i + 2, n - 1)];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      dense.push([catmullRom(p0[0], p1[0], p2[0], p3[0], t), catmullRom(p0[1], p1[1], p2[1], p3[1], t)]);
    }
  }
  if (!def.closed) dense.push(pts[n - 1]);
  else dense.push(dense[0]);

  // cumulative arc length of the dense polyline
  const cum: number[] = [0];
  for (let i = 1; i < dense.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  }
  const length = cum[cum.length - 1];
  const count = Math.floor(length / ds);
  const samples: PathSample[] = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const s = i * ds;
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const f = (s - cum[j]) / Math.max(cum[j + 1] - cum[j], 1e-9);
    samples.push({
      s,
      x: dense[j][0] + (dense[j + 1][0] - dense[j][0]) * f,
      y: dense[j][1] + (dense[j + 1][1] - dense[j][1]) * f,
      chi: 0,
      kappa: 0,
    });
  }
  const m = samples.length;
  const idx = (i: number) => (def.closed ? (i + m) % m : Math.min(Math.max(i, 0), m - 1));
  const rawChi: number[] = new Array(m);
  for (let i = 0; i < m; i++) {
    const a = samples[idx(i - 1)];
    const b = samples[idx(i + 1)];
    rawChi[i] = Math.atan2(b.y - a.y, b.x - a.x);
  }
  // smooth the tangent angle over ~6 m by averaging unit vectors (wrap-safe)
  const half = Math.round(3 / ds);
  for (let i = 0; i < m; i++) {
    let cx = 0;
    let cy = 0;
    for (let k = -half; k <= half; k++) {
      const ii = def.closed ? (i + k + m) % m : i + k;
      if (ii < 0 || ii >= m) continue;
      cx += Math.cos(rawChi[ii]);
      cy += Math.sin(rawChi[ii]);
    }
    samples[i].chi = Math.atan2(cy, cx);
  }
  // curvature = dχ/ds of the smoothed tangent, then one more light smoothing pass
  const rawK: number[] = new Array(m);
  for (let i = 0; i < m; i++) {
    const a = samples[idx(i - 1)];
    const b = samples[idx(i + 1)];
    rawK[i] = wrapAngle(b.chi - a.chi) / (2 * ds);
  }
  for (let i = 0; i < m; i++) {
    let acc = 0;
    let cnt = 0;
    for (let k = -half; k <= half; k++) {
      const ii = def.closed ? (i + k + m) % m : i + k;
      if (ii < 0 || ii >= m) continue;
      acc += rawK[ii];
      cnt++;
    }
    samples[i].kappa = acc / cnt;
  }
  const total = def.closed ? count * ds : samples[m - 1].s;
  const path: Path = {
    def,
    samples,
    ds,
    length: total,
    at(s: number): PathSample {
      let ss = s;
      if (def.closed) {
        ss = ((s % total) + total) % total;
      } else {
        ss = Math.min(Math.max(s, 0), samples[m - 1].s);
      }
      const fi = ss / ds;
      const i0 = Math.floor(fi);
      const i1 = def.closed ? (i0 + 1) % m : Math.min(i0 + 1, m - 1);
      const f = fi - i0;
      const a = samples[Math.min(i0, m - 1)];
      const b = samples[i1];
      return {
        s,
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        chi: a.chi + wrapAngle(b.chi - a.chi) * f,
        kappa: a.kappa + (b.kappa - a.kappa) * f,
      };
    },
  };
  return path;
}
