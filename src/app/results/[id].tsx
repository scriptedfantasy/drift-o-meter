import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import type { SessionScore } from '@/engine/types';
import { useSession } from '@/platform';
import { AppText, Body, Button, colors, Display, formatDate, formatDuration, formatScore, gradeColors, Hero, Label, Meter, Micro, Panel, Row, Screen, space, TopBar } from '@/ui';

/** Shown when the id is not a stored session (e.g. `/results/demo` from the placeholder HUD). */
const DEMO_SCORE: SessionScore = {
  total: 48210,
  grade: 'A',
  angle: 78,
  consistency: 64,
  quality: 71,
  speed: 58,
  style: 82,
  bestDriftId: 3,
  longestChainPoints: 12850,
  perDrift: {},
};

export default function ResultsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session, loading, error } = useSession(id);

  const isDemo = !session;
  const score = session?.score ?? DEMO_SCORE;
  const gradeColor = gradeColors[score.grade] ?? colors.muted;
  const kicker = session ? `${formatDate(session.startedAt)} · ${formatDuration(session.durationS)}` : loading ? 'Loading' : 'Demo data';

  return (
    <Screen scroll testID="screen-results">
      <TopBar kicker={kicker} title="Results" />

      <View style={styles.hero}>
        <View>
          <Label>Grade</Label>
          <Hero color={gradeColor} style={styles.grade}>
            {score.grade}
          </Hero>
        </View>
        <View style={styles.scoreCol}>
          <Label>Total</Label>
          <Display color="ember" style={styles.total}>
            {formatScore(score.total)}
          </Display>
          <Micro>{session?.name ?? (isDemo ? 'Demo session' : '')}</Micro>
        </View>
      </View>

      <Panel style={styles.breakdown}>
        <Meter label="Angle" value={score.angle / 100} color={colors.ember} />
        <Meter label="Consistency" value={score.consistency / 100} color={colors.green} />
        <Meter label="Quality" value={score.quality / 100} color={colors.cyan} />
        <Meter label="Speed" value={score.speed / 100} color={colors.magenta} />
        <Meter label="Style" value={score.style / 100} color={colors.gold} />
      </Panel>

      <Panel style={styles.facts}>
        <Row label="Drifts" value={String(session?.drifts.length ?? 7)} />
        <Row label="Longest chain" value={formatScore(score.longestChainPoints)} valueColor={colors.magenta} />
        <Row label="Best drift" value={score.bestDriftId === null ? '--' : `#${score.bestDriftId}`} />
        <Row label="Laps" value={String(session?.track?.laps.length ?? 2)} last />
      </Panel>

      {error ? (
        <Panel accent={colors.red} style={styles.error}>
          <Body color="red">{error}</Body>
        </Panel>
      ) : null}

      <View style={styles.actions}>
        <Button label="Watch replay" size="lg" onPress={() => router.push({ pathname: '/replay/[id]', params: { id: id ?? 'demo' } })} testID="cta-replay" />
        <Button label="Back to garage" variant="ghost" onPress={() => router.replace('/')} testID="cta-garage" />
      </View>
      {isDemo && !loading ? (
        <AppText variant="micro" color="muted" style={styles.note}>
          Demo numbers. Real sessions are scored by the engine and stored on the device.
        </AppText>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space[4], marginBottom: space[5] },
  grade: { fontSize: 150, lineHeight: 140, marginLeft: -6 },
  scoreCol: { alignItems: 'flex-end', gap: 2, paddingBottom: space[3] },
  total: { fontSize: 60, lineHeight: 60 },
  breakdown: { gap: space[4] },
  facts: { marginTop: space[3], paddingVertical: space[1] },
  error: { marginTop: space[3] },
  actions: { marginTop: space[6], gap: space[3] },
  note: { marginTop: space[4] },
});
