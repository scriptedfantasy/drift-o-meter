import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { useSession } from '@/platform';
import { buildPath, TRACKS } from '@/sim';
import { AppText, Button, Chip, colors, formatDuration, gutter, Label, Micro, Panel, Screen, Segmented, type SegmentOption, space, TopBar } from '@/ui';

const RATES: SegmentOption<number>[] = [
  { value: 0.5, label: '0.5×' },
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
];

export default function ReplayScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useSession(id);
  const { width } = useWindowDimensions();
  const [rate, setRate] = useState<number>(1);
  const [playing, setPlaying] = useState(false);

  const stageW = Math.min(width - gutter * 2, 720);
  const stageH = Math.round(stageW * 9 / 16);

  const points = useMemo(() => {
    const src = session?.track?.refPath ?? buildPath(TRACKS.harbor).samples;
    return fitPoints(src, stageW, stageH, 28);
  }, [session, stageW, stageH]);

  const durationS = session?.durationS ?? 134;
  const name = session?.name ?? 'Harbor · demo lap';

  return (
    <Screen scroll testID="screen-replay">
      <TopBar kicker="Cinematic replay" title="Replay" />

      <View style={[styles.stage, { width: stageW, height: stageH }]}>
        <Svg width={stageW} height={stageH}>
          <Polyline points={points.svg} fill="none" stroke={colors.line} strokeWidth={10} strokeLinejoin="round" strokeLinecap="round" />
          <Polyline points={points.svg} fill="none" stroke={colors.bg2} strokeWidth={6} strokeLinejoin="round" strokeLinecap="round" />
          <Polyline points={points.svgPartial} fill="none" stroke={colors.ember} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
          <Circle cx={points.head.x} cy={points.head.y} r={9} fill={colors.ember} opacity={0.35} />
          <Circle cx={points.head.x} cy={points.head.y} r={4} fill={colors.text} />
        </Svg>
        <View style={styles.stageHud} pointerEvents="none">
          <Label color="ember">Cam 01 · Chase</Label>
          <View style={styles.stageFoot}>
            <Chip label={playing ? 'PLAYING' : 'PAUSED'} color={playing ? colors.green : colors.muted} filled={playing} />
            <Micro numeric>0:00 / {formatDuration(durationS)}</Micro>
          </View>
        </View>
      </View>

      <View style={styles.timeline}>
        <View style={styles.track}>
          <View style={[styles.trackFill, { width: '8%' }]} />
          <View style={[styles.knob, { left: '8%' }]} />
        </View>
      </View>

      <View style={styles.controls}>
        <Button label={playing ? 'Pause' : 'Play'} variant={playing ? 'secondary' : 'primary'} onPress={() => setPlaying((v) => !v)} testID="cta-play" />
        <Segmented options={RATES} value={rate} onChange={(v) => setRate(v)} color={colors.cyan} />
      </View>

      <Panel style={styles.meta}>
        <AppText variant="subheading">{name}</AppText>
        <Micro>Camera cuts, drift callouts and the score ticker are staged from the session timeline once the replay engine lands.</Micro>
      </Panel>
    </Screen>
  );
}

/** Scale a track path into the stage with padding; also returns a leading segment for the "played" part. */
function fitPoints(src: ReadonlyArray<{ x: number; y: number }>, w: number, h: number, pad: number) {
  if (src.length === 0) return { svg: '', svgPartial: '', head: { x: w / 2, y: h / 2 } };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of src) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const sx = (w - pad * 2) / Math.max(1e-6, maxX - minX);
  const sy = (h - pad * 2) / Math.max(1e-6, maxY - minY);
  const s = Math.min(sx, sy);
  const ox = (w - (maxX - minX) * s) / 2;
  const oy = (h - (maxY - minY) * s) / 2;
  const step = Math.max(1, Math.floor(src.length / 400));
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < src.length; i += step) pts.push({ x: ox + (src[i].x - minX) * s, y: h - (oy + (src[i].y - minY) * s) });
  pts.push({ x: ox + (src[src.length - 1].x - minX) * s, y: h - (oy + (src[src.length - 1].y - minY) * s) });
  const toSvg = (arr: Array<{ x: number; y: number }>) => arr.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const partial = pts.slice(0, Math.max(2, Math.floor(pts.length * 0.08)));
  return { svg: toSvg(pts), svgPartial: toSvg(partial), head: partial[partial.length - 1] };
}

const styles = StyleSheet.create({
  stage: {
    alignSelf: 'center',
    backgroundColor: colors.bg1,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    overflow: 'hidden',
  },
  stageHud: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, padding: space[3], justifyContent: 'space-between' },
  stageFoot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  timeline: { marginTop: space[4], paddingVertical: space[2] },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.bg2 },
  trackFill: { height: 4, borderRadius: 2, backgroundColor: colors.ember },
  knob: { position: 'absolute', top: -6, marginLeft: -8, width: 16, height: 16, borderRadius: 8, backgroundColor: colors.ember, borderWidth: 2, borderColor: colors.bg0 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[3], marginTop: space[3], flexWrap: 'wrap' },
  meta: { marginTop: space[5], gap: space[2] },
});
