import { useKeepAwake } from 'expo-keep-awake';
import { useRouter } from 'expo-router';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { G, radToDeg } from '@/engine/types';
import { useSensorFeed, useSettings } from '@/platform';
import { AppText, Body, Button, Chip, colors, formatDuration, formatG, formatSpeed, gutter, Hero, Label, Micro, Panel, Screen, space, speedUnitLabel } from '@/ui';
import GlowRingView from '@/ui/skia/GlowRingView';

const RING_FULL_DEG_S = 90;

/**
 * Live HUD. Until the engine pipeline is wired in, this shows raw sensor truth from whichever
 * source is selected (simulated on web): gyro magnitude, GPS speed and lateral g.
 */
export default function DriveScreen() {
  useKeepAwake();
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const feed = useSensorFeed({ enabled: true, hz: 20 });
  const { settings } = useSettings();

  const m = feed.motion;
  const rotDegS = m ? radToDeg(Math.hypot(m.rotationRate.x, m.rotationRate.y, m.rotationRate.z)) : 0;
  const lateral = m ? Math.hypot(m.accel.x, m.accel.y, m.accel.z) : NaN;
  const speed = feed.gps ? feed.gps.speed : NaN;
  const ringProgress = Math.min(1, rotDegS / RING_FULL_DEG_S);

  const shortest = Math.min(width, height);
  const ringSize = Math.round(Math.max(200, Math.min(320, shortest * (landscape ? 0.72 : 0.7))));

  const live = feed.status === 'running';
  const statusColor = feed.status === 'error' ? colors.red : live ? colors.green : feed.status === 'ended' ? colors.muted : colors.cyan;
  const statusLabel = feed.status === 'starting' ? 'CONNECTING' : feed.status === 'ended' ? 'RUN COMPLETE' : feed.status === 'error' ? 'SENSOR ERROR' : (feed.label ?? 'LIVE');

  const endRun = () => {
    feed.stop();
    router.replace({ pathname: '/results/[id]', params: { id: 'demo' } });
  };

  return (
    <Screen padded={false} testID="screen-drive">
      <View style={[styles.hud, landscape && styles.hudLandscape]}>
        <View style={[styles.stage, landscape && styles.stageLandscape]}>
          <View style={styles.topRow}>
            <Chip label={statusLabel} color={statusColor} filled />
            <Micro numeric>
              {formatDuration(feed.elapsedS)} · {feed.motionCount} samples · {feed.gpsCount} fixes
            </Micro>
          </View>

          <View style={styles.dialWrap}>
            <GlowRingView size={ringSize} progress={ringProgress} testID="glow-ring" />
            <View style={styles.dialOverlay} pointerEvents="none">
              <Label>Rotation</Label>
              <Hero color="ember" style={[styles.heroNumber, { fontSize: ringSize * 0.34, lineHeight: ringSize * 0.34 }]}>
                {Math.round(rotDegS)}
              </Hero>
              <Micro>deg / s</Micro>
            </View>
          </View>
        </View>

        <View style={[styles.side, landscape && styles.sideLandscape]}>
          <View style={styles.tiles}>
            <Tile label="Speed" value={formatSpeed(speed, settings.units)} unit={speedUnitLabel(settings.units)} color={colors.cyan} />
            <Tile label="Lateral" value={formatG(lateral, 2)} unit="g" color={colors.magenta} />
            <Tile label="Slip" value="--" unit="deg" color={colors.ember} hint="Estimator pending" />
            <Tile label="Gyro Z" value={m ? radToDeg(m.rotationRate.z).toFixed(0) : '--'} unit="deg/s" color={colors.text} />
          </View>

          {feed.error ? (
            <Panel accent={colors.red} style={styles.error}>
              <Body color="red">{feed.error}</Body>
            </Panel>
          ) : null}

          <Button label="End run" variant="danger" size="lg" onPress={endRun} testID="cta-end-run" style={styles.end} />
        </View>
      </View>
    </Screen>
  );
}

function Tile({ label, value, unit, color, hint }: { label: string; value: string; unit: string; color: string; hint?: string }) {
  return (
    <View style={styles.tile}>
      <Label>{label}</Label>
      <View style={styles.tileValue}>
        <AppText variant="telemetry" color={color} numeric style={styles.tileNumber}>
          {value}
        </AppText>
        <Micro>{unit}</Micro>
      </View>
      {hint ? <Micro style={styles.tileHint}>{hint}</Micro> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hud: { flex: 1, paddingHorizontal: gutter, paddingBottom: space[4], gap: space[4] },
  hudLandscape: { flexDirection: 'row', alignItems: 'stretch', gap: space[6] },
  stage: { flex: 1, alignItems: 'stretch', gap: space[2] },
  stageLandscape: { flex: 1.1, justifyContent: 'center' },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: space[3], gap: space[3] },
  dialWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginTop: space[2] },
  dialOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 0 },
  heroNumber: { marginVertical: -4 },
  side: { justifyContent: 'flex-end', gap: space[4] },
  sideLandscape: { flex: 0.9, justifyContent: 'center', paddingTop: space[3] },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
  tile: {
    flexGrow: 1,
    flexBasis: '45%',
    backgroundColor: colors.bg1,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: space[3],
    gap: 2,
  },
  tileValue: { flexDirection: 'row', alignItems: 'baseline', gap: space[2] },
  tileNumber: { fontSize: 40, lineHeight: 42 },
  tileHint: { marginTop: 2 },
  error: {},
  end: { alignSelf: 'stretch' },
});
