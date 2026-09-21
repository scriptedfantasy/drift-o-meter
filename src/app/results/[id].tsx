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
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Session } from '@/engine/types';
import { useSession } from '@/platform';
import { useDriftFeel } from '@/ui/audio';
import { alpha, AppText, Button, colors, formatDate, formatDuration, formatScore, gutter, space } from '@/ui';
import {
  BestDriftCard,
  buildFixtureSession,
  buildResultsModel,
  CalloutReel,
  ComponentBars,
  DriftList,
  GradeReveal,
  GradeScale,
  gradeWord,
  heroSurface,
  IntegrityPanel,
  LapTable,
  Odometer,
  RAIL_GAP,
  refusalFrom,
  resolveFixture,
  resultsLayout,
  SectionHead,
  Stat,
  Tag,
  WhyUnscored,
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
  // Loads the sound bank and configures the audio session for this screen. Without a port mounted
  // here the grade cue is a no-op, because `feelCue` has nowhere to play.
  useDriftFeel();
  const raw = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  const params = useMemo(() => flatten(raw), [raw]);
  const id = params.id;
  const router = useRouter();
  const { width, height } = useWindowDimensions();

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
  // The reveal must not start before we know whether the driver asked for less motion: the query
  // is async, and starting first meant a reduce-motion user still got the letterbox and the shake.
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
    // never hang the reveal on a query that does not answer
    const fallback = setTimeout(done, 400);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => alive && setSystemReduce(v));
    return () => {
      alive = false;
      clearTimeout(fallback);
      sub?.remove();
    };
  }, []);
  const reduceMotion = params.motion === 'reduce' ? true : params.motion === 'full' ? false : systemReduce;

  const [revealed, setRevealed] = useState(reveal === 'off');
  const onRevealDone = useCallback(() => setRevealed(true), []);
  // a frozen reveal covers the page, but the page underneath is in its settled state; an
  // untrusted run never gets a reveal, so its page starts straight away
  const pageRun = revealed || frozen || (model !== null && !model.trusted);
  // ...and a tap dismisses even a frozen one, which is how the harness proves the skip works

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
        <ResultsPage
          model={model}
          width={width}
          height={height}
          run={pageRun}
          reduceMotion={reduceMotion}
          onReplay={openReplay}
          onGarage={() => router.replace('/')}
          onDrive={() => router.replace('/drive')}
        />
      </SafeAreaView>
      {/* No grade reveal for a run the engine will not vouch for: there is no grade to slam in.
          And once it has played it is unmounted, so a finished overlay never keeps eating taps. */}
      {reveal === 'off' || revealed || !model.trusted || !motionResolved ? null : (
        <GradeReveal
          grade={model.grade}
          color={model.gradeColor}
          rating={model.rating}
          kicker={`${sessionTrack(model)} · ${formatDuration(model.session.durationS)} · ${model.drifts.length} ${model.drifts.length === 1 ? 'slide' : 'slides'}`}
          drifts={model.drifts.length}
          mode={reveal}
          reduceMotion={reduceMotion}
          onDone={onRevealDone}
          testID="grade-reveal"
        />
      )}
    </View>
  );
}

/** A 0–100 rating the scorer could not compute must read "--", never "NaN". */
function ratingText(rating: number): string {
  return Number.isFinite(rating) ? rating.toFixed(1) : '--';
}

function sessionTrack(model: ResultsModel): string {
  const t = model.session.meta?.track;
  return typeof t === 'string' ? t : model.session.name;
}

function ResultsPage({
  model,
  width,
  height,
  run,
  reduceMotion,
  onReplay,
  onGarage,
  onDrive,
}: {
  model: ResultsModel;
  width: number;
  height: number;
  run: boolean;
  reduceMotion: boolean;
  onReplay(at?: DriftRow): void;
  onGarage(): void;
  onDrive(): void;
}) {
  const [shareNote, setShareNote] = useState<string | null>(null);
  const hasDrifts = model.drifts.length > 0;
  /** The engine refused to publish a score: no grade, no points presented as an achievement. */
  const untrusted = !model.trusted;
  // Portrait is one column. Landscape is a fixed verdict rail plus a scrolling report — see
  // `resultsLayout`, which the grade reveal reads too so it can hand its letter to the hero's.
  const L = resultsLayout(width, height, untrusted);
  const content = L.contentWidth;
  /**
   * What the driver can physically do about a refusal, in the integrity monitor's own words, and
   * separately the fraction that was not believed. The remedy leads; the reason waits behind the
   * disclosure with the rest of the notes.
   */
  const refusal = untrusted ? refusalFrom(model.judged.message, model.verdict) : null;

  const share = useCallback(async () => {
    // an untrusted run has no score to publish — see the contract on SessionIntegrity.scoreTrusted
    if (Platform.OS === 'web' || !model.trusted) return;
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

  // ---- the pieces of the page ---------------------------------------------------------
  // Both layouts draw the same blocks; only where they go changes. Portrait stacks them in one
  // column. Landscape docks the verdict — grade, total, scale and the three actions — in a rail
  // on the left and scrolls the report beside it.

  const topRow = (
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
  );

  const wash = (
    <LinearGradient
      // no grade, no grade colour: an unpublished run gets the warning wash, not a laurel
      colors={[alpha(untrusted ? colors.red : model.gradeColor, untrusted ? 0.16 : 0.2), alpha(untrusted ? colors.red : model.gradeColor, 0.04), 'transparent']}
      locations={[0, 0.5, 1]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.heroWash, { left: -L.washInset, right: -L.washInset, height: L.washHeight }]}
      pointerEvents="none"
    />
  );

  const heroTop = (
    <View style={styles.heroTop}>
      {untrusted ? (
        <View style={styles.gradeBox}>
          <AppText variant="micro" color="muted" style={styles.gradeLabel}>
            Verdict
          </AppText>
          <View style={styles.voidPlate} testID="not-scored">
            <AppText variant="display" color="red" accessibilityRole="header" style={styles.voidWord}>
              NOT
            </AppText>
            <AppText variant="display" color="red" style={styles.voidWord}>
              SCORED
            </AppText>
          </View>
        </View>
      ) : (
        <View style={styles.gradeBox}>
          <AppText variant="micro" color="muted" style={styles.gradeLabel}>
            Grade
          </AppText>
          <AppText
            variant="hero"
            color={model.gradeColor}
            accessibilityRole="header"
            style={[styles.grade, { fontSize: L.letterSize, lineHeight: L.letterSize * 0.98, textShadowColor: model.gradeColor }]}>
            {model.grade}
          </AppText>
        </View>
      )}
      <View style={styles.heroRight}>
        <AppText variant="micro" color="muted">
          {untrusted ? 'Points' : 'Session score'}
        </AppText>
        {untrusted ? (
          // NO NUMBER. `SessionIntegrity.scoreTrusted` says a consumer must not present the total
          // as an achievement, and a residual total shown with "a floor, not a measurement" does
          // exactly that: it tells the driver they earned AT LEAST that much, which is the one
          // claim the engine refuses to make. The garage stopped saying it; this screen was still
          // saying it one screen over. The dash is the honest figure.
          <AppText
            variant="hero"
            color="muted"
            numeric
            style={[styles.grade, { fontSize: L.scoreSize, lineHeight: L.scoreSize * 1.02 }]}
            testID="score-odometer">
            --
          </AppText>
        ) : (
          <Odometer
            value={model.total}
            run={run}
            reduceMotion={reduceMotion}
            fontSize={L.scoreSize}
            color={colors.ember}
            background={heroSurface(model.gradeColor)}
            testID="score-odometer"
          />
        )}
        {untrusted ? (
          <AppText variant="micro" color="red" style={styles.floorNote} align="right">
            Nothing the engine counted
          </AppText>
        ) : (
          <View style={styles.ratingRow}>
            <AppText variant="subheading" color={model.gradeColor}>
              {gradeWord(model.grade, model.drifts.length)}
            </AppText>
            <AppText variant="micro" color="muted" numeric>
              {ratingText(model.rating)} / 100
            </AppText>
          </View>
        )}
        <AppText variant="micro" color="muted" numberOfLines={1}>
          {sessionTrack(model)}
        </AppText>
      </View>
    </View>
  );

  /**
   * The first thing the report says. On a scored run that is the judgement. On a refused one it
   * is the REMEDY — one line, the monitor's own words, naming the thing the driver can physically
   * do — and never the paragraph of reasoning that used to lead here. The reasoning is two lines
   * below it, behind a disclosure, with nothing taken out of it.
   */
  const headline =
    untrusted && refusal ? (
      <View style={[styles.verdict, { borderLeftColor: colors.red }]}>
        <AppText variant="bodyStrong" color="red" style={[styles.verdictText, L.landscape && styles.verdictWide]} testID="verdict">
          {refusal.remedy}
        </AppText>
        <AppText variant="small" color="muted">
          The recording is still here to watch — only the judgement is void.
        </AppText>
      </View>
    ) : (
      <View style={[styles.verdict, { borderLeftColor: model.gradeColor }]}>
        <AppText variant="bodyStrong" color="text" style={[styles.verdictText, L.landscape && styles.verdictWide]} testID="verdict">
          {model.verdict}
        </AppText>
      </View>
    );

  const statStrip = (
    <View style={styles.statStrip}>
      <Stat label={untrusted ? 'Slides recorded' : 'Slides'} value={String(model.drifts.length)} color={untrusted ? colors.muted : colors.text} size={26} />
      <Stat label="Peak angle" value={`${Math.round(model.stats.peakDeg)}°`} color={untrusted || model.stats.peakDeg === 0 ? colors.muted : colors.ember} size={26} />
      <Stat
        label="Sideways"
        value={formatDuration(untrusted ? model.stats.recordedDriftTimeS : model.stats.driftTimeS)}
        color={untrusted ? colors.muted : colors.text}
        size={26}
      />
      {untrusted ? (
        <Stat label="Mount" value="LOOSE" color={colors.red} size={20} />
      ) : (
        <Stat label="Best chain" value={formatScore(model.stats.longestChainPoints)} color={model.stats.longestChainPoints > 0 ? colors.magenta : colors.muted} size={26} />
      )}
    </View>
  );

  const asRecorded = untrusted ? (
    <AppText variant="micro" color="muted">
      As recorded, not as judged — no spin count, no points, no grade
    </AppText>
  ) : null;

  // Every integrity note, verbatim, one tap away — and on a refused run this is the ONLY place
  // they live, so the page says them once instead of three times over.
  const why =
    untrusted && refusal ? <WhyUnscored notes={model.integrity} reason={refusal.reason} run={run} reduceMotion={reduceMotion} testID="why-panel" /> : null;

  const tags = (
    <View style={styles.tags}>
      {untrusted ? <Tag label="SCORE WITHHELD" color={colors.red} filled /> : null}
      {!untrusted && model.stats.spins > 0 ? <Tag label={`${model.stats.spins} SPIN${model.stats.spins === 1 ? '' : 'S'}`} color={colors.red} filled /> : null}
      {!untrusted && model.stats.cleanLaps > 0 ? <Tag label={`${model.stats.cleanLaps} CLEAN LAP${model.stats.cleanLaps === 1 ? '' : 'S'}`} color={colors.green} /> : null}
      {model.lapCount > 0 ? <Tag label={`${model.lapCount} LAPS`} color={colors.muted} /> : <Tag label="POINT TO POINT" color={colors.muted} />}
      {model.simulated ? <Tag label={model.session.meta?.engine === 'pipeline' ? 'SIM · FULL PIPELINE' : 'SIM · FIXTURE'} color={colors.muted} /> : null}
    </View>
  );

  const sections = (
    <>
      {/* ---- components ------------------------------------------------------------ */}
      <SectionHead title="Score breakdown" right={untrusted ? 'not published' : `${ratingText(model.rating)} / 100`} accent={untrusted ? colors.red : colors.ember} />
      <ComponentBars rows={model.components} run={run} reduceMotion={reduceMotion} unmeasured={untrusted} testID="component-bars" />

      {/* ---- best drift ------------------------------------------------------------ */}
      {model.best ? (
        <>
          <SectionHead title={untrusted ? 'Biggest slide' : 'Best drift'} right={`#${model.best.index} of ${model.drifts.length}`} accent={untrusted ? colors.muted : colors.ember} />
          <BestDriftCard drift={model.best} width={content} run={run} reduceMotion={reduceMotion} unscored={untrusted} onWatch={() => onReplay(model.best ?? undefined)} testID="best-drift" />
        </>
      ) : null}

      {/* ---- callouts -------------------------------------------------------------- */}
      {hasDrifts && !untrusted ? (
        <>
          <SectionHead title="Callouts earned" right={`+${formatScore(model.calloutPoints)}`} />
          <CalloutReel callouts={model.callouts} points={model.calloutPoints} lostPoints={model.lostPoints} run={run} reduceMotion={reduceMotion} testID="callout-reel" />
        </>
      ) : null}

      {/* ---- every slide ----------------------------------------------------------- */}
      {hasDrifts ? (
        <>
          {/* short enough to keep its hairline rule and its count on one line at 353 dp */}
          <SectionHead title={untrusted ? 'What was recorded' : 'Every slide'} right={`${model.drifts.length} · tap to replay`} accent={untrusted ? colors.muted : colors.ember} />
          <DriftList rows={model.drifts} sparkWidth={L.sparkWidth} run={run} reduceMotion={reduceMotion} unscored={untrusted} onSeek={onReplay} testID="drift-list" />
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
      {/* repeatability is a judgement of driving: an unpublished run does not get one */}
      {model.laps && !untrusted ? (
        <>
          <SectionHead title="Lap consistency" right={`${model.laps.lapsCompared} laps`} />
          <LapTable laps={model.laps} corners={model.corners} width={content} run={run} reduceMotion={reduceMotion} testID="lap-table" />
        </>
      ) : null}

      {/* ---- integrity ------------------------------------------------------------- */}
      {/* on a refused run these same notes are the disclosure up in the hero, not a second copy */}
      {untrusted ? null : (
        <>
          <SectionHead
            title="Data integrity"
            right={model.integrity.some((n) => n.level === 'bad') ? 'read this' : undefined}
            accent={model.integrity.some((n) => n.level !== 'ok') ? colors.gold : colors.green}
          />
          <IntegrityPanel notes={model.integrity} run={run} reduceMotion={reduceMotion} testID="integrity" />
        </>
      )}
    </>
  );

  // The recording plays whatever the monitor thought of it, so on a refused run it is offered at
  // the top of the page in portrait — the rail already holds it in landscape.
  const recordingCta =
    untrusted && !L.landscape ? (
      <Button label="Watch the recording" onPress={() => onReplay()} testID="cta-recording" style={styles.wide} />
    ) : null;

  /** Lead with the replay everywhere except the foot of a refused portrait page, which already
   *  offered it at the top: down there the next thing is to drive it again, mounted properly. */
  const leadReplay = !untrusted || L.landscape;
  const replayButton = (
    <Button
      label={untrusted ? 'Watch the recording' : 'Watch replay'}
      size={leadReplay && !L.landscape ? 'lg' : 'md'}
      variant={leadReplay ? 'primary' : 'secondary'}
      onPress={() => onReplay()}
      testID="cta-replay"
      style={styles.wide}
    />
  );
  const driveButton = (
    <Button
      label="Drive again"
      size={!leadReplay && !L.landscape ? 'lg' : 'md'}
      variant={leadReplay ? 'ghost' : 'primary'}
      onPress={onDrive}
      testID="cta-drive-again"
      style={leadReplay ? [styles.half, L.landscape && styles.tightHalf] : styles.wide}
    />
  );
  const shareButton = (
    <Button
      label="Share"
      variant="secondary"
      onPress={share}
      disabled={Platform.OS === 'web' || untrusted}
      testID="cta-share"
      style={[styles.half, L.landscape && styles.tightHalf]}
    />
  );

  const actions = (
    <View style={[styles.actions, L.landscape && styles.actionsRail]}>
      {leadReplay ? (
        <>
          {replayButton}
          <View style={styles.actionRow}>
            {shareButton}
            {driveButton}
          </View>
        </>
      ) : (
        <>
          {driveButton}
          <View style={styles.actionRow}>
            {replayButton}
            {shareButton}
          </View>
        </>
      )}
      {shareNote ? (
        <AppText variant="micro" color="red">
          {shareNote}
        </AppText>
      ) : null}
      {untrusted ? (
        <AppText variant="micro" color="red">
          There is nothing to share: the engine would not publish a score for this run.
        </AppText>
      ) : Platform.OS === 'web' ? (
        <AppText variant="micro" color="muted">
          Sharing needs the iOS share sheet; the browser build cannot open it.
        </AppText>
      ) : null}
    </View>
  );

  const footer = (
    <AppText variant="micro" color="muted" style={styles.footer}>
      {model.simulated
        ? `Simulated session · ${String(model.session.meta?.fixtureQuery ?? model.session.meta?.trackId ?? '')} · ${untrusted ? 'judged by the same engine as a real run, and refused for the same reasons' : 'scored by the same engine as a real run'}`
        : `Session ${model.session.id} · ${model.session.states.length.toLocaleString('en-US')} estimator samples · ${model.gps.fixes} GPS fixes`}
    </AppText>
  );

  // ---- landscape: the verdict is docked, the report scrolls beside it ------------------
  if (L.landscape) {
    return (
      <View style={styles.frame} testID="results-wide">
        <View style={[styles.rail, { width: L.railWidth }]}>
          {topRow}
          {/* The wash belongs to the rail, not to the block inside it: anchored under the top row
              it lights the whole verdict panel, and its top edge never lands mid-rail. */}
          <View style={styles.railBody}>
            {wash}
            <View style={styles.railLead} />
            <View style={styles.hero}>
              {heroTop}
              {untrusted ? null : <GradeScale rating={model.rating} grade={model.grade} color={model.gradeColor} run={run} reduceMotion={reduceMotion} testID="grade-scale" />}
            </View>
            <View style={styles.railFill} />
          </View>
          {actions}
        </View>
        <View style={styles.railRule} />
        <ScrollView style={styles.flex} contentContainerStyle={styles.column} showsVerticalScrollIndicator={false} testID="results-scroll">
          <View style={styles.hero}>
            {headline}
            {statStrip}
            {asRecorded}
            {why}
            {tags}
          </View>
          {sections}
          {footer}
        </ScrollView>
      </View>
    );
  }

  // ---- portrait: one column ------------------------------------------------------------
  return (
    <ScrollView style={styles.flex} contentContainerStyle={[styles.scroll, { maxWidth: L.columnWidth }]} showsVerticalScrollIndicator={false} testID="results-scroll">
      {topRow}
      <View style={styles.hero}>
        {wash}
        {heroTop}
        {untrusted ? null : <GradeScale rating={model.rating} grade={model.grade} color={model.gradeColor} run={run} reduceMotion={reduceMotion} testID="grade-scale" />}
        {headline}
        {recordingCta}
        {statStrip}
        {asRecorded}
        {why}
        {tags}
      </View>
      {sections}
      {actions}
      {footer}
    </ScrollView>
  );
}

function MissingSession({ id, error, onGarage, onDrive }: { id?: string; error: string | null; onGarage(): void; onDrive(): void }) {
  const { width, height } = useWindowDimensions();
  // wide and short: a block of text pinned to the top left leaves two thirds of the frame empty,
  // so the message sits on the frame's own centre line instead
  const wide = resultsLayout(width, height).landscape;
  return (
    <View style={styles.root} testID="screen-results-missing">
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <View style={[styles.missing, wide && styles.missingWide]}>
          <Pressable onPress={onGarage} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back to the garage" style={({ pressed }) => pressed && styles.pressed}>
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
  scroll: { paddingHorizontal: gutter, paddingBottom: space[16], alignSelf: 'center', width: '100%' },
  // landscape: the frame is a row — verdict rail, hairline, report column
  frame: { flex: 1, flexDirection: 'row', paddingHorizontal: gutter },
  rail: { paddingBottom: space[4] },
  railBody: { flex: 1 },
  /** On a tall frame the verdict sits a third of the way down rather than clinging to the top. */
  railLead: { flex: 0.55 },
  /** Pushes the rail's actions to the bottom edge, where a thumb finds them without looking. */
  railFill: { flex: 1, minHeight: space[4] },
  railRule: { width: 1, backgroundColor: colors.line, marginHorizontal: RAIL_GAP / 2, marginVertical: space[4] },
  column: { paddingTop: space[2], paddingBottom: space[12] },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: space[2], paddingBottom: space[3] },
  pressed: { opacity: 0.6 },
  hero: { gap: space[4] },
  // stops short of the very top of the viewport on purpose: the harness checks that the
  // page's corner pixels are still bg0
  heroWash: { position: 'absolute', top: 0 },
  gradeLabel: { marginBottom: -space[2] },
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
  verdict: { borderLeftWidth: 3, paddingLeft: space[4], paddingVertical: space[1], gap: space[2] },
  voidPlate: { borderWidth: 2, borderColor: colors.red, paddingHorizontal: space[3], paddingVertical: space[2], alignSelf: 'flex-start', marginTop: space[2] },
  voidWord: { fontSize: 40, lineHeight: 38, letterSpacing: -1 },
  floorNote: { marginTop: 2 },
  verdictText: { fontSize: 18, lineHeight: 25 },
  // the report column is wider than a portrait page: the sentence gets the measure it earns
  verdictWide: { fontSize: 21, lineHeight: 28 },
  statStrip: { flexDirection: 'row', justifyContent: 'space-between', gap: space[2], flexWrap: 'wrap' },
  tags: { flexDirection: 'row', gap: space[2], flexWrap: 'wrap' },
  emptyPanel: { gap: space[2], borderLeftWidth: 3, borderLeftColor: colors.line, paddingLeft: space[4] },
  actions: { marginTop: space[10], gap: space[3] },
  // in the rail the actions are already docked at the bottom; the portrait page's air is not needed
  actionsRail: { marginTop: 0, gap: space[2] },
  actionRow: { flexDirection: 'row', gap: space[3] },
  wide: { alignSelf: 'stretch' },
  half: { flex: 1 },
  // two buttons side by side in a 280 dp rail: the label gets the padding's width back rather
  // than eliding into "DRIVE AG…"
  tightHalf: { paddingHorizontal: space[2] },
  footer: { marginTop: space[6] },
  missing: { flex: 1, paddingHorizontal: gutter, paddingTop: space[6], gap: space[3] },
  missingWide: { justifyContent: 'center', paddingTop: 0, paddingBottom: space[6] },
  missingTitle: { marginTop: space[4] },
  missingBody: { maxWidth: 420 },
  missingActions: { flexDirection: 'row', gap: space[3], marginTop: space[4] },
});
