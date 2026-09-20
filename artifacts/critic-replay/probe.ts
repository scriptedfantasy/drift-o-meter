import { simulateRun, type TrackId } from '../../src/sim';
import { buildReplay, sessionFromSimulation, poseAt, ghostPoseAt, ReplayCamera, liveSmoke, worldToScreen, type CameraMode } from '../../src/engine/replay';
const deg = (r:number)=>r*180/Math.PI;
const W=390, H=844, TOP=110, BOTTOM=154, WORLD_H=H-TOP-BOTTOM;

function stats(track: TrackId, seed: number, laps=2) {
  const run = simulateRun(track, { seed, laps });
  const s = sessionFromSimulation(run);
  const r = buildReplay(s);
  console.log(`\n===== ${track} seed=${seed} laps=${laps} =====`);
  console.log(`duration=${r.durationS.toFixed(1)}s trail.n=${r.trail.n} segments=${r.segments.length} markers=${r.markers.length} laps=${r.laps.length} ghost=${r.ghost? 'lap'+(r.ghost.lapIndex+1) : 'none'}`);
  console.log(`bounds  x[${r.bounds.minX.toFixed(0)},${r.bounds.maxX.toFixed(0)}] y[${r.bounds.minY.toFixed(0)},${r.bounds.maxY.toFixed(0)}]  extent ${(r.bounds.maxX-r.bounds.minX).toFixed(0)} x ${(r.bounds.maxY-r.bounds.minY).toFixed(0)} m`);
  console.log(`info: ${JSON.stringify({...r.info, peakAngle: +deg(r.info.peakAngle).toFixed(1), maxSpeed:+(r.info.maxSpeed*3.6).toFixed(0)})}`);
  let driftT=0;
  for (const g of r.segments) driftT += g.durationS;
  console.log(`segments: ${r.segments.map(g=>`#${g.driftId}[${g.startT.toFixed(1)}-${g.endT.toFixed(1)}s ${g.durationS.toFixed(1)}s peak${deg(g.peakAngle).toFixed(0)}° tr=${g.transitions} pts=${g.points}]`).join('  ')}`);
  console.log(`drifting time = ${driftT.toFixed(1)}s of ${r.durationS.toFixed(1)}s = ${(100*driftT/r.durationS).toFixed(0)}%`);
  let dr=0; for (let i=0;i<r.telemetry.n;i++) dr += r.telemetry.drifting[i];
  console.log(`telemetry drifting fraction = ${(100*dr/r.telemetry.n).toFixed(0)}%   maxAngle=${deg(r.telemetry.maxAngle).toFixed(1)}° maxSpeed=${(r.telemetry.maxSpeed*3.6).toFixed(0)}km/h maxPoints=${r.telemetry.maxPoints.toFixed(0)}`);
  const byKind: Record<string,number> = {};
  for (const m of r.markers) byKind[m.kind]=(byKind[m.kind]||0)+1;
  console.log(`markers by kind: ${JSON.stringify(byKind)}`);
  const trs = r.markers.filter(m=>m.kind==='transition');
  console.log(`transitions: ${trs.map(m=>`${m.t.toFixed(2)}s "${m.label}"`).join(', ')}`);
  // transition spacing
  for (let i=1;i<trs.length;i++){ const d=trs[i].t-trs[i-1].t; const dist=Math.hypot(trs[i].x-trs[i-1].x, trs[i].y-trs[i-1].y);
    if (d<2.0) console.log(`  !! transitions ${i-1}/${i} only ${d.toFixed(2)}s and ${dist.toFixed(1)}m apart: "${trs[i-1].label}" / "${trs[i].label}"`); }
  if (r.laps.length) console.log(`laps: ${r.laps.map(l=>`#${l.index+1} ${l.startT.toFixed(1)}-${l.endT.toFixed(1)} (${l.durationS.toFixed(1)}s) pts=${l.points.toFixed(0)}${l.best?' BEST':''}`).join('  ')}`);
  // ghost gap over time
  if (r.ghost){
    let maxAbs=0, sum=0, n=0, off=0;
    for (let t=0;t<r.durationS;t+=0.25){ const g=ghostPoseAt(r,t); if(!g) continue; const p=poseAt(r,t);
      const d=Math.hypot(g.x-p.x,g.y-p.y); maxAbs=Math.max(maxAbs,d); sum+=d; n++;
      if (d>45) off++;
    }
    console.log(`ghost separation: mean=${(sum/n).toFixed(1)}m max=${maxAbs.toFixed(1)}m  >45m (off chase screen) ${(100*off/n).toFixed(0)}% of in-lap time; in-lap samples ${n} of ${Math.round(r.durationS/0.25)}`);
  }
  console.log(`smoke particles total=${r.smoke.length}`);
  return r;
}

const r1 = stats('harbor', 1, 2);
const r2 = stats('touge', 1, 2);

// ---- camera per-frame deltas
function camProbe(r: any, mode: CameraMode, label: string){
  const cam = new ReplayCamera(mode, {w:W,h:WORLD_H});
  const dt=1/60; let prev = cam.update(r,0,dt); let t=dt;
  let maxPan=0,maxRot=0,maxZoom=0, maxPanPx=0; let tPan=0,tRot=0;
  let rotSpikes=0, panSpikes=0;
  const carScreen: number[] = [];
  for(; t<=r.durationS; t+=dt){
    const st = cam.update(r,t,dt);
    const d = Math.hypot(st.cx-prev.cx, st.cy-prev.cy);
    const dr = Math.abs(((st.rotation-prev.rotation+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI);
    const dz = Math.abs(Math.log(st.zoom/prev.zoom));
    if (d>maxPan){maxPan=d;tPan=t;} if(dr>maxRot){maxRot=dr;tRot=t;} if(dz>maxZoom)maxZoom=dz;
    const dpx = d*st.zoom; if (dpx>maxPanPx) maxPanPx=dpx;
    if (dr > 0.5*Math.PI/180) rotSpikes++;
    if (dpx > 6) panSpikes++;
    const p = poseAt(r,t); const sp = worldToScreen(st,p.x,p.y); carScreen.push(sp.x, sp.y);
    prev=st;
  }
  const n = carScreen.length/2;
  console.log(`[${label} ${mode}] frames=${n} max per-frame: pan=${maxPan.toFixed(3)}m (${maxPanPx.toFixed(1)}px) @${tPan.toFixed(1)}s, rot=${(maxRot*180/Math.PI).toFixed(2)}° @${tRot.toFixed(1)}s, zoom=${(100*(Math.exp(maxZoom)-1)).toFixed(2)}%; frames with rot>0.5°/f: ${rotSpikes} (${(100*rotSpikes/n).toFixed(1)}%), pan>6px/f: ${panSpikes} (${(100*panSpikes/n).toFixed(1)}%)`);
}
console.log('\n--- camera ---');
for (const m of ['overview','chase','cinematic'] as CameraMode[]) camProbe(r1,m,'harbor');
for (const m of ['chase','cinematic'] as CameraMode[]) camProbe(r2,m,'touge');
