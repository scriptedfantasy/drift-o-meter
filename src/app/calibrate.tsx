import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { G } from '@/engine/types';
import { useSensorFeed } from '@/platform';
import { AppText, Body, Button, Chip, colors, Divider, Label, Meter, Panel, Row, Screen, Small, space, TopBar } from '@/ui';

const STEPS = [
  ['01', 'Mount the phone firmly.', 'Any orientation works: vent clip, dash pad, console. It must not move relative to the car.'],
  ['02', 'Sit still for two seconds.', 'Gravity fixes which way is UP in the phone frame.'],
  ['03', 'Drive straight, then brake once.', 'Braking reveals the FORWARD axis; the rest of the frame follows.'],
] as const;

export default function CalibrateScreen() {
  const router = useRouter();
  const [listening, setListening] = useState(false);
  const feed = useSensorFeed({ enabled: listening, hz: 12 });

  const g = feed.motion ? Math.hypot(feed.motion.gravity.x, feed.motion.gravity.y, feed.motion.gravity.z) : NaN;
  const upQuality = Number.isFinite(g) ? Math.max(0, 1 - Math.abs(g - G) / 1.5) : 0;
  const running = feed.status === 'running';

  return (
    <Screen scroll testID="screen-calibrate">
      <TopBar kicker="Mount calibration" title="Calibrate" />

      <Panel accent={colors.cyan} style={styles.steps}>
        {STEPS.map(([n, title, body], i) => (
          <View key={n} style={[styles.step, i < STEPS.length - 1 && styles.stepBorder]}>
            <AppText variant="heading" color="cyan" style={styles.stepNo}>
              {n}
            </AppText>
            <View style={styles.stepText}>
              <AppText variant="bodyStrong">{title}</AppText>
              <Small>{body}</Small>
            </View>
          </View>
        ))}
      </Panel>

      <Panel style={styles.meters}>
        <View style={styles.metersHead}>
          <Label>Live frame</Label>
          <Chip label={running ? (feed.label ?? 'LIVE') : feed.status === 'error' ? 'ERROR' : 'STANDBY'} color={running ? colors.green : feed.status === 'error' ? colors.red : colors.muted} filled={running} />
        </View>
        <Meter label="Up axis (gravity)" value={upQuality} display={Number.isFinite(g) ? `${g.toFixed(2)} m/s²` : 'Waiting'} color={colors.cyan} />
        <Meter label="Forward axis (braking)" value={0} display="Drive to resolve" color={colors.ember} />
        <Divider style={styles.divider} />
        <Row label="Gravity X / Y / Z" value={feed.motion ? `${feed.motion.gravity.x.toFixed(1)} / ${feed.motion.gravity.y.toFixed(1)} / ${feed.motion.gravity.z.toFixed(1)}` : '-- / -- / --'} valueColor={colors.muted} />
        <Row label="Samples" value={String(feed.motionCount)} last />
      </Panel>

      {feed.error ? (
        <Panel accent={colors.red} style={styles.error}>
          <Body color="red">{feed.error}</Body>
        </Panel>
      ) : null}

      <View style={styles.actions}>
        <Button label={listening ? 'Stop listening' : 'Start calibration'} variant={listening ? 'secondary' : 'primary'} size="lg" onPress={() => setListening((v) => !v)} testID="cta-calibrate-start" />
        <Button label="Skip to drive" variant="ghost" onPress={() => router.push('/drive')} testID="cta-skip" />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  steps: { gap: 0, paddingVertical: space[1] },
  step: { flexDirection: 'row', gap: space[4], paddingVertical: space[3] },
  stepBorder: { borderBottomWidth: 1, borderBottomColor: colors.line },
  stepNo: { width: 36, fontStyle: 'italic' },
  stepText: { flex: 1, gap: 2 },
  meters: { marginTop: space[4], gap: space[4] },
  metersHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  divider: { marginVertical: space[1] },
  error: { marginTop: space[4] },
  actions: { marginTop: space[6], gap: space[3] },
});
