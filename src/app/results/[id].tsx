/**
 * The run review — what the driver sees the moment they stop the car.
 *
 * It is a REVIEW, not a verdict: what the car did, in the order a driver retells it. How fast it
 * went, how many slides, how long sideways, how long the run was; then the biggest slide of the
 * night; then every slide, each with the shape of its own |β| trace. There is no grade, no
 * points, no rating and no letter slamming in over letterbox bars — a number that rewards is a
 * number someone will chase, and the thing worth chasing here is the angle.
 *
 * It SCROLLS, and it is not a fixed-height screen: a review's length is however many slides the
 * driver did.
 *
 * The one judgement left on the page is the integrity monitor's, and it is a judgement of the
 * DATA. A phone waved about in a parked car produces large angles and a plausible-looking run;
 * when `SessionIntegrity.scoreTrusted` is false this screen says so first, greys every figure
 * below it and offers the recording, because the recording is real even when the verdict is not.
 *
 * URL:
 *   /results/<sessionId>                     a stored session
 *   /results/fixture-hero                    a deterministic simulated session (see ?fixture)
 *   /results/anything?fixture=sloppy         same, by query
 *   ?source=sim|pipeline                     ground-truth fixture, or the real engine pipeline
 *   ?motion=reduce|full                      override the system's reduce-motion setting
 * See tools/harness/README.md for the full list.
 */
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Session } from '@/engine/types';
import { useSession, useSettings } from '@/platform';
import { useDriftFeel } from '@/ui/audio';
import {
  AppText,
  alpha,
  colors,
  formatDate,
  formatDuration,
  formatSpeed,
  gutter,
  radii,
  space,
  speedUnitLabel,
  type SpeedUnits,
} from '@/ui';
import {
  BestDriftCard,
  buildFixtureSession,
  buildResultsModel,
  DriftList,
  RAIL_GAP,
  Stat,
  Tag,
  WhyUnscored,
  WORDMARK_ASPECT,
  faultStat,
  refusalFrom,
  resolveFixture,
  resultsLayout,
  type DriftRow,
  type ResultsModel,
} from '@/ui/results';

const WORDMARK = require('@/assets/brand/wordmark.webp');

function flatten(params: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(params)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}

export default function ResultsScreen() {
  // Makes sure the feel layer is built, and subscribes to its status. It does NOT build a port
  // of its own: the port is a module singleton that outlives every screen, so arriving here from
  // `/drive` costs no decode.
  useDriftFeel();
  const raw = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  const params = useMemo(() => flatten(raw), [raw]);
  const id = params.id;
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const { settings } = useSettings();

  const spec = useMemo(() => resolveFixture(id, params), [id, params]);
  const specKey = spec ? JSON.stringify(spec) : null;
  const stored = useSession(spec ? undefined : id);

  // Fixtures are built off the render path: the simulator (and, with ?source=pipeline, the whole
  // engine) takes a few hundred milliseconds, and a frozen first frame is worse than a stated
  // wait. The built session is stored WITH the spec it was built from, and read back only when
  // the two still match: clearing it in the effect instead meant a synchronous setState on every
  // navigation, and, for the one frame before the effect ran, the previous fixture's numbers
  // under the new fixture's name.
  const [fixture, setFixture] = useState<{ key: string; session: Session } | null>(null);
  useEffect(() => {
    if (!spec || !specKey) return;
    let alive = true;
    const handle = setTimeout(() => {
      const built = buildFixtureSession(spec);
      if (alive) setFixture({ key: specKey, session: built });
    }, 0);
    return () => {
      alive = false;
      clearTimeout(handle);
    };
    // specKey is the value identity of spec
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey]);
  const fixtureSession = spec && fixture?.key === specKey ? fixture.session : null;

  const session = spec ? fixtureSession : stored.session;
  const model = useMemo(() => (session ? buildResultsModel(session) : null), [session]);

  const [systemReduce, setSystemReduce] = useState(false);
  const forcedMotion = params.motion === 'reduce' || params.motion === 'full';
  const [motionResolved, setMotionResolved] = useState(forcedMotion);
  useEffect(() => {
    let alive = true;
    const done = () => alive && setMotionResolved(true);
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (alive) setSystemReduce(v);
        done();
      })
      .catch(done);
    // never hang the page on a query that does not answer
    const fallback = setTimeout(done, 400);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => alive && setSystemReduce(v));
    return () => {
      alive = false;
      clearTimeout(fallback);
      sub?.remove();
    };
  }, []);
  const reduceMotion = params.motion === 'reduce' ? true : params.motion === 'full' ? false : systemReduce;

  const loading = (spec ? fixtureSession === null : stored.loading) || !motionResolved;
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
        <AppText variant="micro" color="green">
          Reading the run
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
        <ReviewPage
          model={model}
          units={settings.units}
          width={width}
          height={height}
          reduceMotion={reduceMotion}
          onReplay={openReplay}
          onGarage={() => router.replace('/')}
          onDrive={() => router.replace('/drive')}
        />
      </SafeAreaView>
    </View>
  );
}

function sessionTrack(model: ResultsModel): string {
  const t = model.session.meta?.track;
  return typeof t === 'string' ? t : model.session.name;
}

function ReviewPage({
  model,
  units,
  width,
  height,
  reduceMotion,
  onReplay,
  onGarage,
  onDrive,
}: {
  model: ResultsModel;
  units: SpeedUnits;
  width: number;
  height: number;
  reduceMotion: boolean;
  onReplay(at?: DriftRow): void;
  onGarage(): void;
  onDrive(): void;
}) {
  /** The engine refuses to vouch for this run: nothing below may read as an achievement. */
  const untrusted = !model.trusted;
  // Portrait is one column. Landscape docks the summary in a rail and scrolls the slides beside
  // it, so DRIVE AGAIN stays under the thumb however long the list is — see `resultsLayout`.
  const L = resultsLayout(width, height);
  const slides = model.drifts;

  /**
   * What the driver can physically do about a refusal, in the integrity monitor's own words, and
   * separately the fraction that was not believed. The remedy leads; the reason waits behind the
   * disclosure with the rest of the notes.
   */
  const refusal = untrusted ? refusalFrom(model.judged.message, 'Too much of this run could not be believed') : null;
  /**
   * The chip beside a refusal. It is the MONITOR'S finding, not a constant: this used to read
   * "Mount · LOOSE" on every refusal, including the ones the monitor recorded as `mount: 'rigid'`
   * and refused for an unresolved forward axis.
   */
  const fault = untrusted ? faultStat(model.judged, model.session.calibration?.forwardResolved ?? false) : null;
  /** Qualifying notes on a run the monitor DID believe. Nothing to disclose when they are all ok. */
  const qualified = !untrusted && model.integrity.some((n) => n.level !== 'ok');

  const topRow = (
    <View style={styles.topRow}>
      <Pressable onPress={onGarage} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back to the garage" style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
        <AppText variant="micro" color="muted">
          ← Garage
        </AppText>
      </Pressable>
      <AppText variant="micro" color="muted" numberOfLines={1}>
        {sessionTrack(model)} · {formatDate(model.session.startedAt)}
      </AppText>
    </View>
  );

  // The mark, centred, at the width the drive display draws it: the two screens are one board.
  const wordmark = (
    <Image
      source={WORDMARK}
      style={{ width: L.wordmarkWidth, height: Math.round(L.wordmarkWidth / WORDMARK_ASPECT) }}
      contentFit="contain"
      accessibilityLabel="Drift-O-Mania"
      testID="wordmark"
    />
  );

  /**
   * The four facts, in one block of four cells with only its outer corners rounded — one card
   * divided, not four cards in a grid.
   *
   * TOP SPEED is the fastest the car went at any point of the run, not the fastest it went
   * sideways: a cell labelled TOP SPEED that only counts the drifting moments is not one.
   */
  const statGrid = (
    <View style={styles.grid} testID="stat-grid">
      <View style={[styles.cell, styles.cellTL]}>
        <Stat label="Top speed" value={formatSpeed(model.stats.topSpeedKmh / 3.6, units)} unit={speedUnitLabel(units)} color={untrusted ? colors.muted : colors.blue} size={32} />
      </View>
      <View style={[styles.cell, styles.cellTR]}>
        <Stat label="Slides" value={String(slides.length)} color={untrusted ? colors.muted : colors.text} size={32} />
      </View>
      <View style={[styles.cell, styles.cellBL]}>
        <Stat label="Time sideways" value={formatDuration(model.stats.driftTimeS)} color={untrusted ? colors.muted : colors.text} size={32} />
      </View>
      <View style={[styles.cell, styles.cellBR]}>
        <Stat label="Run length" value={formatDuration(model.session.durationS)} color={untrusted ? colors.muted : colors.text} size={32} />
      </View>
    </View>
  );

  const refusalBlock =
    untrusted && refusal ? (
      <View style={styles.refusal} testID="not-scored">
        <View style={styles.refusalHead}>
          <Tag label="NOT SCORED" color={colors.red} filled />
          {fault ? <Tag label={`${fault.label.toUpperCase()} · ${fault.value}`} color={fault.tone === 'severe' ? colors.red : colors.greenHot} /> : null}
        </View>
        <AppText variant="bodyStrong" color="red" style={styles.refusalText} testID="verdict">
          {refusal.remedy}
        </AppText>
        <AppText variant="small" color="muted">
          The recording is still here to watch, and the figures below are what it contains — only the judgement is void.
        </AppText>
        <WhyUnscored notes={model.integrity} reason={refusal.reason} run reduceMotion={reduceMotion} testID="why-panel" />
      </View>
    ) : null;

  const bestDrift = model.best ? <BestDriftCard drift={model.best} units={units} run reduceMotion={reduceMotion} unscored={untrusted} testID="best-drift" /> : null;

  const everySlide =
    slides.length > 0 ? (
      <View style={styles.section} testID="every-slide">
        <SectionRow title="Every slide" right={`${slides.length} OF ${slides.length}`} />
        <DriftList rows={slides} sparkWidth={L.sparkWidth} units={units} run reduceMotion={reduceMotion} unscored={untrusted} onSeek={onReplay} testID="drift-list" />
      </View>
    ) : (
      <View style={styles.section} testID="every-slide">
        <SectionRow title="Every slide" right="NONE" />
        <View style={styles.empty}>
          <AppText variant="small" color="muted">
            The detector needs |β| past 8° for at least 0.6 s before it calls something a slide. This run never got there, so there is nothing to list or replay.
          </AppText>
        </View>
      </View>
    );

  const qualifier = qualified ? <WhyUnscored notes={model.integrity} refused={false} run reduceMotion={reduceMotion} testID="integrity-disclosure" /> : null;

  const actions = (
    <View style={styles.actions}>
      <ActionButton label="Replay" onPress={() => onReplay()} testID="cta-replay" />
      <ActionButton label="Drive again" filled onPress={onDrive} testID="cta-drive-again" />
    </View>
  );

  const footer = (
    <AppText variant="micro" color="muted" style={styles.footer}>
      {model.simulated
        ? `Simulated session · ${String(model.session.meta?.fixtureQuery ?? model.session.meta?.trackId ?? '')} · measured by the same engine as a real run`
        : `Session ${model.session.id} · ${model.session.states.length.toLocaleString('en-US')} estimator samples · ${model.gps.fixes} GPS fixes`}
    </AppText>
  );

  // ---- landscape: the mark and the two actions dock, everything else scrolls --------------
  // THE RAIL DOES NOT SCROLL, so what is in it has to fit the frame's height — 393 dp on a
  // landscape phone, against 457 dp of mark, stats, best drift and actions. `railHoldsStats`
  // is that arithmetic (see `layout.ts`); when it is false the four stats lead the column
  // instead, which is where they are read from anyway once the thumb is on the list.
  if (L.landscape) {
    return (
      <View style={styles.frame} testID="results-wide">
        <View style={[styles.rail, { width: L.railWidth }]}>
          {topRow}
          <View style={styles.center}>{wordmark}</View>
          {L.railHoldsStats ? statGrid : null}
          <View style={styles.railFill} />
          {actions}
        </View>
        <View style={styles.railRule} />
        <ScrollView style={styles.flex} contentContainerStyle={styles.railColumn} showsVerticalScrollIndicator={false} testID="results-scroll">
          {L.railHoldsStats ? null : statGrid}
          {refusalBlock}
          {bestDrift}
          {everySlide}
          {qualifier}
          {footer}
        </ScrollView>
      </View>
    );
  }

  // ---- portrait: one column ---------------------------------------------------------------
  return (
    <ScrollView style={styles.flex} contentContainerStyle={[styles.scroll, { maxWidth: L.columnWidth }]} showsVerticalScrollIndicator={false} testID="results-scroll">
      {topRow}
      <View style={styles.center}>{wordmark}</View>
      {statGrid}
      {refusalBlock}
      {bestDrift}
      {everySlide}
      {qualifier}
      {actions}
      {footer}
    </ScrollView>
  );
}

/**
 * A section head: the name on the left, the count on the right, nothing between them.
 *
 * Deliberately not `SectionHead` from `src/ui/parts.tsx`, which draws a hairline rule across the
 * gap and sets its title at 24 dp. Here the panel below the head already has an edge, and a rule
 * on top of it is a second one.
 */
function SectionRow({ title, right }: { title: string; right: string }) {
  return (
    <View style={styles.sectionHead}>
      <AppText variant="subheading" color="text" style={styles.sectionTitle}>
        {title}
      </AppText>
      <AppText variant="micro" color="muted" numeric>
        {right}
      </AppText>
    </View>
  );
}

/**
 * The two things to do next.
 *
 * Local to this screen rather than `src/ui/Button.tsx`, which skews its slab -8° and puts a glow
 * behind the primary. The approved review is square-edged and quiet: the page's loudest thing is
 * the biggest angle of the night, and it is not a button.
 */
function ActionButton({ label, filled = false, onPress, testID }: { label: string; filled?: boolean; onPress(): void; testID?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => [styles.action, filled ? styles.actionFilled : styles.actionOutline, pressed && styles.pressed]}>
      <AppText variant="subheading" color={filled ? colors.bg0 : colors.text} uppercase style={styles.actionLabel} numberOfLines={1}>
        {label}
      </AppText>
    </Pressable>
  );
}

function MissingSession({ id, error, onGarage, onDrive }: { id?: string; error: string | null; onGarage(): void; onDrive(): void }) {
  const { width, height } = useWindowDimensions();
  // wide and short: a block of text pinned to the top left leaves two thirds of the frame empty,
  // so the message sits on the frame's own centre line instead
  const wide = resultsLayout(width, height).landscape;
  return (
    <View style={styles.root} testID="screen-results-missing">
      <SafeAreaView style={[styles.safe, wide && styles.missingFrame]} edges={['top', 'bottom', 'left', 'right']}>
        <View style={[styles.missing, wide && styles.missingWide]}>
          <Pressable onPress={onGarage} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back to the garage" style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
            <AppText variant="micro" color="muted">
              ← Garage
            </AppText>
          </Pressable>
          <AppText variant="title" uppercase style={styles.missingTitle}>
            No such session
          </AppText>
          <AppText variant="body" color="muted" style={styles.missingBody}>
            {error
              ? `That session could not be read: ${error}`
              : `Nothing is stored under "${id ?? 'this id'}". Runs are saved on the phone that recorded them, so a link from another device will not find one here.`}
          </AppText>
          <View style={styles.missingActions}>
            <ActionButton label="Drive a run" filled onPress={onDrive} testID="cta-drive" />
            <ActionButton label="Back to garage" onPress={onGarage} testID="cta-garage" />
          </View>
        </View>
        {/* Wide: the message keeps a reading measure on the left and the frame's other half
            carries the thing to do about it, instead of 55 % black. */}
        {wide ? (
          <View style={styles.missingAside}>
            <AppText variant="micro" color="muted">
              Where runs live
            </AppText>
            <AppText variant="body" color="muted" style={styles.missingBody}>
              Every session is stored on the phone that recorded it. Nothing is uploaded, so there is no copy to fetch — the garage lists the ones this phone has.
            </AppText>
          </View>
        ) : null}
      </SafeAreaView>
    </View>
  );
}

const GRID_RADIUS = 12;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  safe: { flex: 1 },
  flex: { flex: 1 },
  boot: { flex: 1, backgroundColor: colors.bg0, alignItems: 'center', justifyContent: 'center' },
  scroll: { paddingHorizontal: gutter, paddingBottom: space[16], alignSelf: 'center', width: '100%', gap: space[4] },
  center: { alignItems: 'center' },
  // landscape: the frame is a row — summary rail, hairline, slide column
  frame: { flex: 1, flexDirection: 'row', paddingHorizontal: gutter },
  rail: { paddingBottom: space[4], gap: space[4] },
  /** Pushes the rail's actions to the bottom edge, where a thumb finds them without looking. */
  railFill: { flex: 1, minHeight: space[4] },
  railRule: { width: 1, backgroundColor: colors.line, marginHorizontal: RAIL_GAP / 2, marginVertical: space[4] },
  railColumn: { paddingTop: space[2], paddingBottom: space[12], gap: space[4] },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: space[2] },
  // a text link is still a target: 44 dp of height around eleven point type
  back: { minHeight: 44, justifyContent: 'center' },
  pressed: { opacity: 0.7 },

  // The four cells are one block: only the outer corners are rounded, so the 10 dp gaps read as
  // divisions of a single card rather than as four cards that happen to line up.
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  cell: {
    flexGrow: 1,
    flexBasis: '45%',
    minWidth: 0,
    backgroundColor: colors.bg1,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 13,
    paddingHorizontal: 15,
  },
  cellTL: { borderTopLeftRadius: GRID_RADIUS },
  cellTR: { borderTopRightRadius: GRID_RADIUS },
  cellBL: { borderBottomLeftRadius: GRID_RADIUS },
  cellBR: { borderBottomRightRadius: GRID_RADIUS },

  refusal: { backgroundColor: alpha(colors.red, 0.07), borderWidth: 1, borderColor: alpha(colors.red, 0.45), borderRadius: radii.sm, padding: space[4], gap: space[3] },
  refusalHead: { flexDirection: 'row', gap: space[2], flexWrap: 'wrap' },
  refusalText: { fontSize: 18, lineHeight: 25 },

  section: { gap: space[2] },
  sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space[2] },
  sectionTitle: { fontSize: 20, lineHeight: 22 },
  empty: { backgroundColor: colors.bg1, borderRadius: radii.md, padding: space[4] },

  actions: { flexDirection: 'row', gap: 10, marginTop: space[2] },
  action: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingHorizontal: space[3] },
  actionOutline: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.line },
  actionFilled: { backgroundColor: colors.green },
  actionLabel: { fontSize: 18, lineHeight: 22, letterSpacing: 1 },

  footer: { marginTop: space[4] },
  missingFrame: { flexDirection: 'row', alignItems: 'center' },
  missing: { flex: 1, paddingHorizontal: gutter, paddingTop: space[6], gap: space[3] },
  missingWide: { justifyContent: 'center', paddingTop: 0, paddingBottom: space[6] },
  missingAside: { flex: 1, paddingRight: gutter, gap: space[2], paddingLeft: RAIL_GAP },
  missingTitle: { marginTop: space[4] },
  missingBody: { maxWidth: 420 },
  missingActions: { flexDirection: 'row', gap: space[3], marginTop: space[4] },
});
