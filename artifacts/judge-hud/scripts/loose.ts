/** Independent verification: drive DriftPipeline myself and audit every paying path. */
import { DriftPipeline, type LiveFrame } from '../../../src/engine/pipeline';
import { simulateRun, type TrackId } from '../../../src/sim';

interface Row {
  track: string; seed: number; looseness: number;
  frames: number; counting: number; countingPct: number;
  liveTotalEnd: number; finishTotal: number; grade: string; trusted: boolean;
  paidWhileNotCounting: number;       // frames where total rose with counting=false
  paidPoints: number;                 // sum of those rises
  calloutPtsWhileNotCounting: number; // callout points on non-counting frames
  bankedWhileNotCounting: number;     // banked events on non-counting frames
  bankedPtsWhileNotCounting: number;
  drifts: number; suppressedS: number; implausibleFraction: number;
  maxTotalSeen: number;
  believableFrames: number;
}

function drive(track: TrackId, seed: number, looseness: number): Row {
  const run = simulateRun(track, { seed, laps: 2, aggression: 0.8, consistency: 0.85, looseness, mount: 'portrait-vent' });
  const p = new DriftPipeline({ gpsLatencyS: 0.45, id: `x`, name: 'x', startedAt: 0 });
  const gps = run.gps.slice().sort((a, b) => a.t - b.t);
  let j = 0;
  let frames = 0, counting = 0, paidN = 0, paidPts = 0, calloutPts = 0, bankedN = 0, bankedPts = 0, believable = 0;
  let prevTotal = 0, maxTotal = 0;
  let last: LiveFrame | null = null;
  for (let i = 0; i < run.motion.length; i++) {
    while (j < gps.length && gps[j].t <= run.motion[i].t) { p.pushGps(gps[j]); j++; }
    const f = p.pushMotion(run.motion[i]);
    if (f === last) continue; // dropped sample returns previous frame
    last = f;
    frames++;
    if (f.score.counting) counting++;
    if (f.integrity.believable) believable++;
    const rise = f.score.total - prevTotal;
    if (!f.score.counting) {
      if (rise > 1e-9) { paidN++; paidPts += rise; }
      for (const c of f.score.callouts) calloutPts += c.points;
      if (f.score.banked) { bankedN++; bankedPts += f.score.bankedPoints; }
    }
    prevTotal = f.score.total;
    if (f.score.total > maxTotal) maxTotal = f.score.total;
  }
  while (j < gps.length) { p.pushGps(gps[j]); j++; }
  const session = p.finish();
  return {
    track, seed, looseness,
    frames, counting, countingPct: (100 * counting) / Math.max(1, frames),
    liveTotalEnd: prevTotal,
    finishTotal: session.score.total,
    grade: session.score.grade, trusted: session.score.trusted,
    paidWhileNotCounting: paidN, paidPoints: paidPts,
    calloutPtsWhileNotCounting: calloutPts,
    bankedWhileNotCounting: bankedN, bankedPtsWhileNotCounting: bankedPts,
    drifts: session.drifts.length,
    suppressedS: session.integrity.suppressedS,
    implausibleFraction: session.integrity.implausibleDriftFraction,
    maxTotalSeen: maxTotal,
    believableFrames: believable,
  };
}

const rows: Row[] = [];
const looseValues = [0, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1];
const tracks: TrackId[] = ['harbor', 'touge'];
const seeds = [1, 2, 3];
for (const t of tracks) for (const s of seeds) for (const L of looseValues) rows.push(drive(t, s, L));

console.log(['track','seed','loose','frames','count%','liveEnd','finish','grade','trust','paidFrames','paidPts','callPts','bankN','bankPts','drifts','suppS','implFrac','maxSeen','believ%'].join('\t'));
for (const r of rows) {
  console.log([
    r.track, r.seed, r.looseness, r.frames, r.countingPct.toFixed(1),
    r.liveTotalEnd.toFixed(1), r.finishTotal.toFixed(1), r.grade, r.trusted,
    r.paidWhileNotCounting, r.paidPoints.toFixed(2), r.calloutPtsWhileNotCounting.toFixed(2),
    r.bankedWhileNotCounting, r.bankedPtsWhileNotCounting.toFixed(2),
    r.drifts, r.suppressedS.toFixed(2), r.implausibleFraction.toFixed(3), r.maxTotalSeen.toFixed(1),
    ((100*r.believableFrames)/Math.max(1,r.frames)).toFixed(1),
  ].join('\t'));
}
