import { writeFileSync } from 'node:fs';
import { renderReplayFrame } from '../../tools/analysis/render-replay';
import type { CameraMode } from '../../src/engine/replay';
type Shot = [name: string, track: 'harbor'|'touge', seed: number, spec: string, mode: CameraMode, opts?: any];
const shots: Shot[] = [
  ['c-start-chase',     'harbor', 1, 'start',    'chase'],
  ['c-start-overview',  'harbor', 1, 'start',    'overview'],
  ['c-t5-chase',        'harbor', 1, '5',        'chase'],
  ['c-straight-chase',  'harbor', 1, '8.3',      'chase'],
  ['c-straight-cine',   'harbor', 1, '8.3',      'cinematic'],
  ['c-end-chase',       'harbor', 1, 'end',      'chase'],
  ['c-end-overview',    'harbor', 1, 'end',      'overview'],
  ['c-peak-overview',   'harbor', 1, 'peak',     'overview'],
  ['c-peak-chase',      'harbor', 1, 'peak',     'chase'],
  ['c-peak-cine',       'harbor', 1, 'peak',     'cinematic'],
  ['c-lowspeed-chase',  'harbor', 1, '129.5',    'chase'],
  ['c-exit-chase',      'harbor', 1, '47.2',     'chase'],
  ['c-ghost-best-lap',  'harbor', 1, '30',       'chase'],
  ['c-touge-overview',  'touge',  1, 'mid',      'overview'],
  ['c-touge-start',     'touge',  1, 'start',    'chase'],
  ['c-spin-chase',      'harbor', 9, 'peak',     'chase',  {consistency:0.05, aggression:1.0}],
  ['c-spin-cine',       'harbor', 9, 'peak',     'cinematic', {consistency:0.05, aggression:1.0}],
  ['c-nodrift-chase',   'harbor', 3, 'mid',      'chase',  {aggression:0.0, consistency:1.0}],
  ['c-nodrift-overview','harbor', 3, 'mid',      'overview', {aggression:0.0, consistency:1.0}],
  ['c-1lap-overview',   'harbor', 1, 'mid',      'overview', {laps:1}],
];
for (const [name, track, seed, spec, mode, opts] of shots) {
  try {
    const { svg } = renderReplayFrame(track, seed, spec, mode, opts ?? {});
    writeFileSync(`artifacts/critic-replay/${name}.svg`, svg);
    console.log('ok', name);
  } catch (e) { console.log('FAIL', name, (e as Error).message); }
}
