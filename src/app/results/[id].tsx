/**
 * Results — what the driver sees the moment they stop the car.
 *
 * The screen is a verdict, not a report: the grade slams in over letterbox bars, the total rolls
 * up on an odometer, the component bars fill, and only then does it settle into a page you can
 * actually read. Every number comes from the engine's own scorer (`scoreSession`) and its
 * cross-lap analysis; the words under them are derived from the same numbers, and they are not
 * kind when the driving was not.
 *
 * URL:
 *   /results/<sessionId>                     a stored session
 *   /results/fixture-hero                    a deterministic simulated session (see ?fixture)
 *   /results/anything?fixture=sloppy         same, by query
 *   ?reveal=full|off|hold|slam|settle        play the reveal, skip it, or freeze a frame
 *   ?motion=reduce|full                      override the system's reduce-motion setting
 *   ?source=sim|pipeline                     ground-truth fixture, or the real engine pipeline
 * See tools/harness/README.md for the full list.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Session } from '@/engine/types';
import { useSession } from '@/platform';
import { AppText, Button, colors, formatDate, formatDuration, formatScore, gutter, space } from '@/ui';
import {
  BestDriftCard,
  buildFixtureSession,
  buildResultsModel,
  CalloutReel,
  ComponentBars,
  DriftList,
  GradeReveal,
  GradeScale,
  GRADE_WORDS,
  IntegrityPanel,
  LapTable,
  Odometer,
  resolveFixture,
  SectionHead,
  Stat,
  Tag,
  type DriftRow,
  type ResultsModel,
  type RevealMode,
} from '@/ui/results';

const REVEAL_VALUES: RevealMode[] = ['full', 'off', 'hold', 'slam', 'settle'];

function flatten(params: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(params)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}

export default function ResultsScreen() {
  const raw = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  const params = useMemo(() => flatten(raw), [raw]);
  const id = params.id;
  const router = useRouter();
  const { width } = useWindowDimensions();

  const spec = useMemo(() => resolveFixture(id, params), [id, params]);
  const specKey = spec ? JSON.stringify(spec) : null;
  const stored = useSession(spec ? undefined : id);

  // Fixtures are built off the render path: the simulator (and, with ?source=pipeline, the whole
  // engine) takes a few hundred milliseconds, and the reveal should already be on screen.
  const [fixtureSession, setFixtureSession] = useState<Session | null>(null);
  useEffect(() => {
    if (!spec) {
      setFixtureSession(null);
      return;
    }
    let alive = true;
    setFixtureSession(null);
    const handle = setTimeout(() => {
      const built = buildFixtureSession(spec);
      if (alive) setFixtureSession(built);
    }, 0);
    return () => {
      alive = false;
      clearTimeout(handle);
    };
    // specKey is the value identity of spec
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey]);

  const session = spec ? fixtureSession : stored.session;
  const model = useMemo(() => (session ? buildResultsModel(session) : null), [session]);

  const reveal: RevealMode = REVEAL_VALUES.includes(params.reveal as RevealMode) ? (params.reveal as RevealMode) : 'full';
  const frozen = reveal === 'hold' || reveal === 'slam' || reveal === 'settle';

  const [systemReduce, setSystemReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => alive && setSystemReduce(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => alive && setSystemReduce(v));
    return () => {
      alive = false;
      sub?.remove();
    };
  }, []);
  const reduceMotion = params.motion === 'reduce' ? true : params.motion === 'full' ? false : systemReduce;

  const [revealed, setRevealed] = useState(reveal === 'off');
  const onRevealDone = useCallback(() => setRevealed(true), []);
  // a frozen reveal covers the page, but the page underneath is in its settled state
  const pageRun = revealed || frozen;

  const loading = spec ? fixtureSession === null : stored.loading;
  const missing = !loading && !session;

  const openReplay = useCallback(
    (at?: DriftRow) => {
      if (!session) return;
      router.push({
        pathname: '/replay/[id]',
        params: {
          id: session.id,
          ...(at ? { t: at.startT.toFixed(2), drift: String(at.id) } : {}),
          ...(spec ? { fixture: spec.name, source: spec.source } : {}),
        },
      });
    },
    [router, session, spec],
  );

  if (loading) {
    return (
      <View style={styles.boot} testID="screen-results-loading">
        <AppText variant="micro" color="ember">
          Scoring the run
        </AppText>
      </View>
    );
  }

  if (missing || !model) {
    return <MissingSession id={id} error={stored.error} onGarage={() => router.replace('/')} onDrive={() => router.replace('/drive')} />;
  }

  return (
    <View style={styles.root} testID="screen-results">
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <ResultsPage model={model} width={width} run={pageRun} reduceMotion={reduceMotion} onReplay={openReplay} onGarage={() => router.replace('/')} onDrive={() => router.replace('/drive')} />
      </SafeAreaView>
      {reveal === 'off' ? null : (
        <GradeReveal
          grade={model.grade}
          color={model.gradeColor}
          rating={model.rating}
          kicker={`${sessionTrack(model)} · ${formatDuration(model.session.durationS)} · ${model.drifts.length} ${model.drifts.length === 1 ? 'slide' : 'slides'}`}
          mode={reveal}
          reduceMotion={reduceMotion}
          onDone={onRevealDone}
          testID="grade-reveal"
        />
      )}
    </View>
  );
}

function sessionTrack(model: ResultsModel): string {
  const t = model.session.meta?.track;
  return typeof t === 'string' ? t : model.session.name;
}

function ResultsPage({
  model,
  width,
  run,
  reduceMotion,
  onReplay,
  onGarage,
  onDrive,
}: {
  model: ResultsModel;
  width: number;
  run: boolean;
  reduceMotion: boolean;
  onReplay(at?: DriftRow): void;
  onGarage(): void;
  onDrive(): void;
}) {
  const [shareNote, setShareNote] = useState<string | null>(null);
  const content = Math.min(width, 620) - gutter * 2;
  const letter = Math.min(168, content * 0.44);
  const hasDrifts = model.drifts.length > 0;

  const share = useCallback(async () => {
    if (Platform.OS === 'web') return;
    try {
      const [fs, sharing] = await Promise.all([import('expo-file-system'), import('expo-sharing')]);
      if (!(await sharing.isAvailableAsync())) {
        setShareNote('This device has nothing to share to.');
        return;
      }
      const file = new fs.File(fs.Paths.cache, `drift-o-meter-${model.session.id}.txt`);
      try {
        file.create({ overwrite: true });
      } catch {
        // already there: write overwrites it
      }
      file.write(shareText(model));
      await sharing.shareAsync(file.uri, { mimeType: 'text/plain', UTI: 'public.plain-text', dialogTitle: 'Share this run' });
      setShareNote(null);
    } catch (err) {
      setShareNote(`Sharing failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [model]);

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} testID="results-scroll">
      <View style={styles.topRow}>
        <Pressable onPress={onGarage} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back to the garage" style={({ pressed }) => pressed && styles.pressed}>
          <AppText variant="micro" color="muted">
            ← Garage
          </AppText>
        </Pressable>
        <AppText variant="micro" color="muted" numberOfLines={1}>
          {formatDate(model.session.startedAt)} · {formatDuration(model.session.durationS)}
        </AppText>
      </View>

      {/* ---- hero ------------------------------------------------------------------ */}
      <View style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={styles.gradeBox}>
            <AppText
              variant="hero"
              color={model.gradeColor}
              accessibilityRole="header"
              style={[styles.grade, { fontSize: letter, lineHeight: letter * 0.98, textShadowColor: model.gradeColor }]}>
              {model.grade}
            </AppText>
          </View>
          <View style={styles.heroRight}>
            <AppText variant="micro" color="muted">
              Session score
            </AppText>
            <Odometer value={model.total} run={run} reduceMotion={reduceMotion} fontSize={Math.min(56, content * 0.15)} color={colors.ember} testID="score-odometer" />
            <View style={styles.ratingRow}>
              <AppText variant="subheading" color={model.gradeColor}>
                {GRADE_WORDS[model.grade]}
              </AppText>
              <AppText variant="micro" color="muted" numeric>
                {model.rating.toFixed(1)} / 100
              </AppText>
            </View>
            <AppText variant="micro" color="muted" numberOfLines={1}>
              {sessionTrack(model)}
            </AppText>
          </View>
        </View>

        <GradeScale rating={model.rating} grade={model.grade} color={model.gradeColor} run={run} reduceMotion={reduceMotion} testID="grade-scale" />

        <View style={[styles.verdict, { borderLeftColor: model.gradeColor }]}>
          <AppText variant="bodyStrong" style={styles.verdictText} testID="verdict">
            {model.verdict}
          </AppText>
        </View>

        <View style={styles.statStrip}>
          <Stat label="Slides" value={String(model.drifts.length)} size={26} />
          <Stat label="Peak angle" value={`${Math.round(model.stats.peakDeg)}°`} color={colors.ember} size={26} />
          <Stat label="Sideways" value={formatDuration(model.stats.driftTimeS)} color={colors.cyan} size={26} />
          <Stat label="Best chain" value={formatScore(model.stats.longestChainPoints)} color={colors.magenta} size={26} />
        </View>

        <View style={styles.tags}>
          {model.stats.spins > 0 ? <Tag label={`${model.stats.spins} SPIN${model.stats.spins === 1 ? '' : 'S'}`} color={colors.red} filled /> : null}
          {model.stats.cleanLaps > 0 ? <Tag label={`${model.stats.cleanLaps} CLEAN LAP${model.stats.cleanLaps === 1 ? '' : 'S'}`} color={colors.green} /> : null}
          {model.lapCount > 0 ? <Tag label={`${model.lapCount} LAPS`} color={colors.muted} /> : <Tag label="POINT TO POINT" color={colors.muted} />}
          {model.simulated ? <Tag label={model.session.meta?.engine === 'pipeline' ? 'SIM · FULL PIPELINE' : 'SIM · FIXTURE'} color={colors.cyan} /> : null}
        </View>
      </View>

      {/* ---- components ------------------------------------------------------------ */}
      <SectionHead title="Score breakdown" right={`${model.rating.toFixed(1)} / 100`} />
      <ComponentBars rows={model.components} run={run} reduceMotion={reduceMotion} testID="component-bars" />

      {/* ---- best drift ------------------------------------------------------------ */}
      {model.best ? (
        <>
          <SectionHead title="Best drift" right={`#${model.best.index} of ${model.drifts.length}`} accent={colors.ember} />
          <BestDriftCard drift={model.best} width={content} run={run} reduceMotion={reduceMotion} onWatch={() => onReplay(model.best ?? undefined)} testID="best-drift" />
        </>
      ) : null}

      {/* ---- callouts -------------------------------------------------------------- */}
      {hasDrifts ? (
        <>
          <SectionHead title="Callouts earned" right={`+${formatScore(model.calloutPoints)}`} accent={colors.magenta} />
          <CalloutReel callouts={model.callouts} points={model.calloutPoints} lostPoints={model.lostPoints} run={run} reduceMotion={reduceMotion} testID="callout-reel" />
        </>
      ) : null}

      {/* ---- every slide ----------------------------------------------------------- */}
      {hasDrifts ? (
        <>
          <SectionHead title="Every slide" right={`${model.drifts.length} · tap to replay`} accent={colors.cyan} />
          <DriftList rows={model.drifts} sparkWidth={Math.max(80, content - 190)} run={run} reduceMotion={reduceMotion} onSeek={onReplay} testID="drift-list" />
        </>
      ) : (
        <>
          <SectionHead title="Every slide" right="none" accent={colors.muted} />
          <View style={styles.emptyPanel}>
            <AppText variant="subheading" color="muted">
              Nothing to list
            </AppText>
            <AppText variant="small" color="muted">
              The detector needs |β| past 8° for at least 0.6 s before it calls something a drift. This run never got there, so there is no drift to score, replay or brag about.
            </AppText>
          </View>
        </>
      )}

      {/* ---- lap consistency ------------------------------------------------------- */}
      {model.laps ? (
        <>
          <SectionHead title="Lap consistency" right={`${model.laps.lapsCompared} laps`} accent={colors.green} />
          <LapTable laps={model.laps} corners={model.corners} width={content} run={run} reduceMotion={reduceMotion} testID="lap-table" />
        </>
      ) : null}

      {/* ---- integrity ------------------------------------------------------------- */}
      <SectionHead title="Data integrity" right={model.integrity.some((n) => n.level === 'bad') ? 'read this' : undefined} accent={model.integrity.some((n) => n.level !== 'ok') ? colors.gold : colors.green} />
      <IntegrityPanel notes={model.integrity} run={run} reduceMotion={reduceMotion} testID="integrity" />

      {/* ---- actions --------------------------------------------------------------- */}
      <View style={styles.actions}>
        <Button label="Watch replay" size="lg" onPress={() => onReplay()} testID="cta-replay" style={styles.wide} />
        <View style={styles.actionRow}>
          <Button
            label={Platform.OS === 'web' ? 'Share · iPhone only' : 'Share'}
            variant="secondary"
            onPress={share}
            disabled={Platform.OS === 'web'}
            testID="cta-share"
            style={styles.half}
          />
          <Button label="Drive again" variant="ghost" onPress={onDrive} testID="cta-drive-again" style={styles.half} />
        </View>
        {shareNote ? (
          <AppText variant="micro" color="red">
            {shareNote}
          </AppText>
        ) : null}
        {Platform.OS === 'web' ? (
          <AppText variant="micro" color="muted">
            Sharing needs the iOS share sheet; the browser build cannot open it.
          </AppText>
        ) : null}
      </View>

      <AppText variant="micro" color="muted" style={styles.footer}>
        {model.simulated
          ? `Simulated session · ${String(model.session.meta?.fixtureQuery ?? model.session.meta?.trackId ?? '')} · scored by the same engine as a real run`
          : `Session ${model.session.id} · ${model.session.states.length.toLocaleString('en-US')} estimator samples · ${model.gps.fixes} GPS fixes`}
      </AppText>
    </ScrollView>
  );
}

function MissingSession({ id, error, onGarage, onDrive }: { id?: string; error: string | null; onGarage(): void; onDrive(): void }) {
  return (
    <View style={styles.root} testID="screen-results-missing">
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.missing}>
          <AppText variant="micro" color="muted">
            ← Garage
          </AppText>
          <AppText variant="title" uppercase style={styles.missingTitle}>
            No such session
          </AppText>
          <AppText variant="body" color="muted" style={styles.missingBody}>
            {error
              ? `That session could not be read: ${error}`
              : `Nothing is stored under "${id ?? 'this id'}". Runs are saved on the phone that recorded them, so a link from another device will not find one here.`}
          </AppText>
          <AppText variant="small" color="muted">
            Try a demo verdict instead: /results/fixture-hero
          </AppText>
          <View style={styles.missingActions}>
            <Button label="Back to garage" onPress={onGarage} testID="cta-garage" />
            <Button label="Drive" variant="secondary" onPress={onDrive} testID="cta-drive" />
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

/** Plain-text summary for the share sheet. */
function shareText(model: ResultsModel): string {
  const lines = [
    `DRIFT-O-METER — ${model.grade} (${model.rating.toFixed(1)}/100)`,
    `${formatScore(model.total)} points · ${model.drifts.length} slides · peak ${Math.round(model.stats.peakDeg)}° · ${formatDuration(model.stats.driftTimeS)} sideways`,
    '',
    model.verdict,
    '',
    ...model.components.map((c) => `${c.label.toUpperCase().padEnd(12)} ${String(Math.round(c.score)).padStart(3)}  ${c.explain}`),
  ];
  if (model.best) {
    lines.push('', `Best drift: ${Math.round(model.best.peakDeg)}° for ${model.best.durationS.toFixed(1)} s, ${formatScore(model.best.points)} points.`);
  }
  for (const n of model.integrity) if (n.level !== 'ok') lines.push('', `${n.title}: ${n.body}`);
  return lines.join('\n');
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  safe: { flex: 1 },
  flex: { flex: 1 },
  boot: { flex: 1, backgroundColor: colors.bg0, alignItems: 'center', justifyContent: 'center' },
  scroll: { paddingHorizontal: gutter, paddingBottom: space[16], maxWidth: 620, alignSelf: 'center', width: '100%' },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: space[2], paddingBottom: space[3] },
  pressed: { opacity: 0.6 },
  hero: { gap: space[4] },
  heroTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space[3] },
  gradeBox: { justifyContent: 'flex-start' },
  grade: {
    letterSpacing: -6,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 36,
    includeFontPadding: false,
  },
  heroRight: { flex: 1, alignItems: 'flex-end', gap: 2, paddingTop: space[2] },
  ratingRow: { flexDirection: 'row', alignItems: 'baseline', gap: space[2] },
  verdict: { borderLeftWidth: 3, paddingLeft: space[4], paddingVertical: space[1] },
  verdictText: { fontSize: 18, lineHeight: 25 },
  statStrip: { flexDirection: 'row', justifyContent: 'space-between', gap: space[2], flexWrap: 'wrap' },
  tags: { flexDirection: 'row', gap: space[2], flexWrap: 'wrap' },
  emptyPanel: { gap: space[2], borderLeftWidth: 3, borderLeftColor: colors.line, paddingLeft: space[4] },
  actions: { marginTop: space[10], gap: space[3] },
  actionRow: { flexDirection: 'row', gap: space[3] },
  wide: { alignSelf: 'stretch' },
  half: { flex: 1 },
  footer: { marginTop: space[6] },
  missing: { flex: 1, paddingHorizontal: gutter, paddingTop: space[6], gap: space[3] },
  missingTitle: { marginTop: space[4] },
  missingBody: { maxWidth: 420 },
  missingActions: { flexDirection: 'row', gap: space[3], marginTop: space[4] },
});
