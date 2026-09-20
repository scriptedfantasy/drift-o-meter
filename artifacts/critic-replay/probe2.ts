import { simulateRun, type TrackId } from '../../src/sim';
import { buildReplay, sessionFromSimulation, poseAt, ghostPoseAt, liveSmoke, smokeAt } from '../../src/engine/replay';
const deg=(r:number)=>r*180/Math.PI;
const run = simulateRun('harbor',{seed:1,laps:2});
const r = buildReplay(sessionFromSimulation(run));

// 1. is a 28 s "drift" really continuous slide?
const seg = r.segments[1];
let below8=0, below15=0, n=0, under5=0;
for(let k=seg.startIndex;k<=seg.endIndex;k++){const a=deg(Math.abs(r.trail.beta[k]));n++;if(a<8)below8++;if(a<15)below15++;if(a<5)under5++;}
console.log(`segment #2 (${seg.durationS.toFixed(1)}s): samples=${n}  |b|<5deg ${(100*under5/n).toFixed(0)}%  <8deg ${(100*below8/n).toFixed(0)}%  <15deg ${(100*below15/n).toFixed(0)}%`);
// longest continuous stretch below 8 deg inside it
let run8=0,max8=0;for(let k=seg.startIndex;k<=seg.endIndex;k++){if(deg(Math.abs(r.trail.beta[k]))<8){run8++;max8=Math.max(max8,run8);}else run8=0;}
console.log(`  longest continuous stretch with |b|<8deg inside that "drift": ${(max8/r.trail.hz).toFixed(1)}s`);
let run5=0,max5=0;for(let k=seg.startIndex;k<=seg.endIndex;k++){if(deg(Math.abs(r.trail.beta[k]))<5){run5++;max5=Math.max(max5,run5);}else run5=0;}
console.log(`  longest continuous stretch with |b|<5deg inside that "drift": ${(max5/r.trail.hz).toFixed(1)}s`);

// 2. transition marker collisions in world space (lap1 vs lap2 markers)
const trs=r.markers.filter(m=>m.kind==='transition');
for(let i=0;i<trs.length;i++)for(let j=i+1;j<trs.length;j++){
  const d=Math.hypot(trs[i].x-trs[j].x,trs[i].y-trs[j].y);
  if(d<25) console.log(`WORLD COLLISION: "${trs[i].label}"@${trs[i].t.toFixed(1)}s and "${trs[j].label}"@${trs[j].t.toFixed(1)}s are ${d.toFixed(1)}m apart`);
}
const peaks=r.markers.filter(m=>m.kind==='drift-peak');
for(let i=0;i<peaks.length;i++)for(let j=i+1;j<peaks.length;j++){
  const d=Math.hypot(peaks[i].x-peaks[j].x,peaks[i].y-peaks[j].y);
  if(d<25) console.log(`WORLD COLLISION peaks: "${peaks[i].label}"@${peaks[i].t.toFixed(1)}s and "${peaks[j].label}"@${peaks[j].t.toFixed(1)}s ${d.toFixed(1)}m apart`);
}
console.log(`markers still drawn at t=end (all m.t<=t): ${r.markers.length}`);

// 3. ghost gap: distance vs the honest time gap
console.log('\nghost gapM vs rendered "s" vs true time gap');
const g0=r.ghost!;
for(const t of [70,80,90,94.8,100.2,110,120]){
  const gp=ghostPoseAt(r,t); const p=poseAt(r,t); if(!gp) continue;
  const rendered = gp.gapM/Math.max(3,p.speed);
  // honest: time for ghost to cover carDist
  let trueS=NaN;
  const carDistIntoLap = gp.gapM + (()=> {let d=0; const fi=Math.min(g0.n-1,Math.round(gp.tau*g0.hz)); return g0.dist[fi];})();
  // find tau where ghost.dist == carDistIntoLap
  let lo=0; for(let k=0;k<g0.n;k++){ if(g0.dist[k]<=carDistIntoLap) lo=k; }
  trueS = gp.tau - g0.tau[lo];
  console.log(` t=${t.toFixed(1)}  sep=${Math.hypot(gp.x-p.x,gp.y-p.y).toFixed(1)}m gapM=${gp.gapM.toFixed(1)} speed=${(p.speed*3.6).toFixed(0)}km/h  rendered="${gp.gapM>0?'+':'-'}${Math.abs(rendered).toFixed(1)} s"  true time gap=${trueS.toFixed(1)} s  err=${(rendered-trueS).toFixed(1)}s`);
}

// 4. first / last frame state, spin search, low speed, straight line
console.log('\nkey moments');
for(const t of [0,0.5,2,5,r.durationS-0.1,r.durationS]){
  const p=poseAt(r,t); console.log(` t=${t.toFixed(1)} beta=${deg(p.beta).toFixed(1)}° v=${(p.speed*3.6).toFixed(0)}km/h phase=${p.phase} pts=${p.points.toFixed(0)} smoke=${liveSmoke(r.smoke,t).length}`);
}
let maxB=0,maxBT=0,minV=1e9,minVT=0;
for(let k=0;k<r.trail.n;k++){const a=Math.abs(r.trail.beta[k]); if(a>maxB){maxB=a;maxBT=r.trail.t[k];} if(r.trail.speed[k]<minV){minV=r.trail.speed[k];minVT=r.trail.t[k];}}
console.log(` max |beta| = ${deg(maxB).toFixed(1)}° at t=${maxBT.toFixed(1)}  (spin >90°? ${deg(maxB)>90})`);
console.log(` min speed = ${(minV*3.6).toFixed(1)} km/h at t=${minVT.toFixed(1)}`);
// straightest moment with nonzero speed
let bestT=0,bestScore=1e9;
for(let k=0;k<r.trail.n;k++){ if(r.trail.speed[k]<15) continue; const sc=Math.abs(r.trail.beta[k]); if(sc<bestScore){bestScore=sc;bestT=r.trail.t[k];} }
console.log(` straightest fast moment: t=${bestT.toFixed(1)} beta=${deg(bestScore).toFixed(2)}°`);
// slowest moment above 0
let slowT=0,slow=1e9; for(let k=0;k<r.trail.n;k++){ if(r.trail.speed[k]>0.3 && r.trail.speed[k]<slow){slow=r.trail.speed[k];slowT=r.trail.t[k];}}
console.log(` slowest moving moment: t=${slowT.toFixed(1)} v=${(slow*3.6).toFixed(1)} km/h`);

// 5. smoke: how many alive & their screen size at chase zoom (6.5 px/m logical)
let maxAlive=0, maxAliveT=0; const Z=6.5;
for(let t=0;t<r.durationS;t+=0.25){const L=liveSmoke(r.smoke,t); if(L.length>maxAlive){maxAlive=L.length;maxAliveT=t;}}
console.log(`\nsmoke: max alive = ${maxAlive} at t=${maxAliveT.toFixed(1)}`);
{const L=liveSmoke(r.smoke,maxAliveT); const rs=L.map(p=>smokeAt(p,maxAliveT)!).filter(Boolean);
 console.log(` radii m: ${rs.map(s=>s.radius.toFixed(1)).join(',')}`);
 console.log(` opacities: ${rs.map(s=>s.opacity.toFixed(2)).join(',')}`);
 console.log(` max radius on chase screen = ${(Math.max(...rs.map(s=>s.radius))*Z).toFixed(0)} logical pt (${(Math.max(...rs.map(s=>s.radius))*Z*3).toFixed(0)} device px)`);}

// 6. empty session + no-drift session
import type { Session } from '../../src/engine/types';
const empty: Session = { id:'e', name:'empty', startedAt:0, states:[], drifts:[], truth:[], track:null, score:null } as any;
const re = buildReplay(empty);
console.log(`\nempty session: duration=${re.durationS} trail.n=${re.trail.n} bounds=${JSON.stringify(re.bounds)} grade=${re.info.grade} telemetry.maxPoints=${re.telemetry.maxPoints}`);
