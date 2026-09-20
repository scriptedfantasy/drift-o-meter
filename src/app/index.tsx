import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { currentSearch, describeSimParams, loadSettings, planSource, useSessionIndex, type SessionIndexEntry } from '@/platform';
import { AppText, Body, Button, Chip, colors, EmptyState, formatDate, formatDuration, formatScore, gradeColors, Label, Micro, Panel, Screen, SectionHeader, Small, space, Wordmark } from '@/ui';

export default function GarageScreen() {
  const router = useRouter();
  const { entries, loading, error } = useSessionIndex();
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadSettings().then((s) => {
      if (!alive) return;
      const plan = planSource(Platform.OS, currentSearch(), s);
      setSourceLabel(plan.kind === 'device' ? 'DEVICE SENSORS' : describeSimParams(plan.params));
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Screen scroll testID="screen-garage">
      <View style={styles.header}>
        <Wordmark />
        <Pressable onPress={() => router.push('/settings')} hitSlop={12} accessibilityRole="button" testID="nav-settings" style={({ pressed }) => pressed && styles.pressed}>
          <Label>Settings</Label>
        </Pressable>
      </View>

      <View style={styles.hero}>
        <Label color="ember">Tonight</Label>
        <AppText variant="display" style={styles.heroTitle} accessibilityRole="header">
          GET{'\n'}SIDEWAYS
        </AppText>
        <Body color="muted" style={styles.heroBody}>
          Mount the phone, calibrate once, then drive. The judge scores angle, speed, transitions and consistency, and cuts the replay.
        </Body>
        <Button label="Drive" size="lg" onPress={() => router.push('/drive')} testID="cta-drive" style={styles.cta} />
        <View style={styles.secondary}>
          <Button label="Calibrate mount" variant="secondary" size="sm" onPress={() => router.push('/calibrate')} testID="cta-calibrate" />
          <Chip label={sourceLabel ?? 'SOURCE'} color={colors.cyan} filled />
        </View>
      </View>

      <SectionHeader title="Sessions" right={<Micro>{entries.length === 1 ? '1 saved' : `${entries.length} saved`}</Micro>} />
      {error ? (
        <Panel accent={colors.red}>
          <Body color="red">{error}</Body>
        </Panel>
      ) : entries.length === 0 ? (
        <EmptyState title={loading ? 'Loading' : 'No runs yet'} body={loading ? undefined : 'Your sessions land here with a grade, a score and a replay. The first one is always the roughest.'} />
      ) : (
        <View style={styles.list}>
          {entries.map((e) => (
            <SessionRow key={e.id} entry={e} onPress={() => router.push({ pathname: '/results/[id]', params: { id: e.id } })} />
          ))}
        </View>
      )}
    </Screen>
  );
}

function SessionRow({ entry, onPress }: { entry: SessionIndexEntry; onPress: () => void }) {
  const color = gradeColors[entry.grade] ?? colors.muted;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
      <Panel style={styles.row} accent={color}>
        <AppText variant="display" color={color} style={styles.grade}>
          {entry.grade}
        </AppText>
        <View style={styles.rowText}>
          <AppText variant="subheading" numberOfLines={1}>
            {entry.name}
          </AppText>
          <Small>
            {formatDate(entry.startedAt)} · {formatDuration(entry.durationS)}
            {entry.track ? ` · ${entry.track}` : ''}
          </Small>
        </View>
        <View style={styles.rowScore}>
          <AppText variant="telemetry" color="ember" numeric>
            {formatScore(entry.total)}
          </AppText>
          <Micro>{entry.drifts === 1 ? '1 drift' : `${entry.drifts} drifts`}</Micro>
        </View>
      </Panel>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingTop: space[3], paddingBottom: space[6] },
  hero: { gap: space[3], paddingTop: space[4] },
  heroTitle: { marginTop: space[1] },
  heroBody: { maxWidth: 360 },
  cta: { alignSelf: 'stretch', marginTop: space[5] },
  secondary: { flexDirection: 'row', alignItems: 'center', gap: space[3], marginTop: space[2] },
  list: { gap: space[3] },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[4], paddingVertical: space[3] },
  grade: { width: 44, textAlign: 'center', fontSize: 48, lineHeight: 50 },
  rowText: { flex: 1, gap: 2 },
  rowScore: { alignItems: 'flex-end', gap: 2 },
  pressed: { opacity: 0.7 },
});
