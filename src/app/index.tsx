/**
 * Garage — the home screen, and the only screen most nights start on.
 *
 * DRIVE is step two of the whole app (docs/DESIGN.md, "the whole app is four steps"): tapping it
 * starts recording, and nothing on this screen is allowed to stand between a driver and that.
 * There is no calibration errand next to it — the engine calibrates itself while driving — and
 * the simulated-source bay lives at the BOTTOM, off the path.
 *
 * Under DRIVE, in descending order of how likely a driver is to want it, sits the run they just
 * did (a card twice the size of anything else, which says what that run did to their records),
 * the records themselves, and then the rest of the nights, one line each under the night they
 * were driven. Swipe a run sideways or hold it to throw it away; the app asks before it does.
 *
 * Calibration appears here in exactly one case: the last run left evidence that the mount was
 * wrong. Then the garage says what was wrong (`mountAdvice`) and offers the screen that fixes
 * it. Otherwise the link is tucked away in the footer with settings.
 *
 * A run the engine refused to score is never dressed up as an achievement here — no grade
 * letter, no record, no total, the monitor's own sentence instead (see
 * `SessionIntegrity.scoreTrusted`).
 *
 * Nothing on this screen reads a session body. Every number, verdict and sentence comes from
 * `SessionIndexEntry`; a body is parsed only when a demo row is TAPPED.
 *
 * URL (web / the harness):
 *   /?demo=night     fill the list with six real, deterministic runs across two tracks
 *   /?demo=harbor    four scored runs on one track — the personal-best board with something to say
 *   /?demo=first     one run
 *   /?demo=none      empty the garage
 *   /?sim=touge&looseness=1&dropouts=1   preselect the simulated source (see the demo bay)
 * See tools/harness/README.md.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  currentSearch,
  describeSimParams,
  planSource,
  simParamsToQuery,
  useSettings,
  type SimParams,
  type SessionIndexEntry,
} from '@/platform';
import { colors, formatDate, formatDuration, gutter, Micro, space, Wordmark } from '@/ui';
import {
  BestsBoard,
  ConfirmDialog,
  DriveSlab,
  EmptyGarage,
  LastRunCard,
  mountAdvice,
  MountNotice,
  RunRow,
  SimBay,
  SwipeToDelete,
  readDetail,
  useGarage,
  type BestRecord,
} from '@/ui/garage';
import { FaultNotice } from '@/ui/garage/FaultNotice';
import { groupByNight } from '@/ui/garage/groups';
import { SectionHead, Tag } from '@/ui/results';

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** `fixture=hero&seed=3` → route params the results screen understands. */
function queryParams(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query) return out;
  for (const [k, v] of new URLSearchParams(query)) out[k] = v;
  return out;
}

/**
 * Past this the screen is not a phone held upright: landscape in a cradle, or a tablet. DRIVE
 * then sits beside the last run instead of stretching into 55 % empty orange.
 */
const WIDE_PX = 700;

export default function GarageScreen() {
  const router = useRouter();
  const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  // expo-router gives the query on web; `currentSearch()` is the belt to that braces, because a
  // statically exported page can hydrate before the router has parsed the URL.
  const demo = first(params.demo) ?? new URLSearchParams(currentSearch() ?? '').get('demo') ?? undefined;
  const garage = useGarage(demo);
  const { settings, update } = useSettings();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_PX;

  // Which source the next run will use, and — on web — the knobs a demo can turn.
  const plan = useMemo(() => planSource(Platform.OS, currentSearch(), settings), [settings]);
  const [sim, setSim] = useState<SimParams | null>(null);
  useEffect(() => {
    if (plan.kind === 'simulated') setSim((prev) => prev ?? plan.params);
  }, [plan]);
  const simParams = plan.kind === 'simulated' ? (sim ?? plan.params) : null;
  const simQuery = simParams ? `?${simParamsToQuery(simParams)}` : '';
  const sourceLabel = simParams ? describeSimParams(simParams) : 'DEVICE SENSORS';

  const changeSim = useCallback(
    (next: SimParams) => {
      setSim(next);
      // track and speed are real preferences and persist; mount looseness and GPS dropouts are
      // properties of a recording, so they travel on the link instead (see SimBay)
      if (next.track !== settings.simTrack || next.rate !== settings.simRate) {
        void update({ simTrack: next.track, simRate: next.rate });
      }
    },
    [settings.simRate, settings.simTrack, update],
  );

  // ---- delete, with a question first ------------------------------------------------------
  const [pending, setPending] = useState<SessionIndexEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmDelete = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await garage.remove(pending.id);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }, [garage, pending]);

  /**
   * Opening a run is the only place a body is read at all, and only for a demo run: a stored
   * `fixture-<name>` id is rebuilt from the simulator by the results screen, so any seed
   * override has to travel with it (`Session.meta.fixtureQuery`). A real recording loads by id
   * and needs nothing. One parse, on a tap, memoised.
   */
  const openRun = useCallback(
    (entry: SessionIndexEntry) => {
      const go = (query: string) => router.push({ pathname: '/results/[id]', params: { id: entry.id, ...queryParams(query) } });
      if (!entry.id.startsWith('fixture-')) {
        go('');
        return;
      }
      void readDetail(entry.id).then((d) => go(d.fixtureQuery));
    },
    [router],
  );

  const openRecord = useCallback((record: BestRecord) => openRun({ id: record.id } as SessionIndexEntry), [openRun]);

  const hasRuns = garage.entries.length > 0;
  /**
   * The storage fault, and where it goes. In landscape with nothing in the list, the right
   * column held two words ("THE GARAGE · UNREADABLE") in an otherwise empty half-screen while
   * YOUR RUN LIST COULD NOT BE READ started at 70 % viewport height under DRIVE and REBUILD THE
   * LIST was clipped off the bottom edge — the app's most urgent state, below the fold, beside
   * a void. When there is no list to show, the fault takes the column the list would have had.
   */
  const faultNotice = garage.fault ? <FaultNotice fault={garage.fault} busy={garage.rebuilding} onAct={() => void garage.rebuild()} /> : null;
  const faultInColumn = wide && !hasRuns && faultNotice !== null;
  // The one thing that earns a calibration prompt: the last run said something was wrong.
  const advice = useMemo(() => mountAdvice(garage.last), [garage.last]);
  const nights = useMemo(() => groupByNight(garage.earlier), [garage.earlier]);
  const openCalibrate = useCallback(
    (why?: string) => {
      const q = [simQuery.slice(1), why ? `why=${why}` : ''].filter(Boolean).join('&');
      router.push(`/calibrate${q ? `?${q}` : ''}`);
    },
    [router, simQuery],
  );

  const cta = (
    <>
      <DriveSlab
        onPress={() => router.push(`/drive${simQuery}`)}
        caption={captionFor(sourceLabel, simParams !== null)}
        inline={wide}
        testID="cta-drive"
      />
      <View style={styles.underCta}>
        <Micro numberOfLines={1} style={styles.ctaNote}>
          Starts recording at once
        </Micro>
        <Tag label={sourceLabel} color={simParams ? colors.cyan : colors.green} filled />
      </View>
      {advice ? (
        <View style={styles.notice}>
          <MountNotice advice={advice} onPress={() => openCalibrate(advice.concern)} testID="mount-notice" />
        </View>
      ) : null}
      {faultNotice && !faultInColumn ? <View style={styles.notice}>{faultNotice}</View> : null}
      {garage.seeding ? (
        <View style={styles.seeding} testID="garage-seeding">
          <Micro color="cyan">
            Building demo runs · {garage.seeding.done} / {garage.seeding.total}
          </Micro>
          <Micro style={styles.seedingNote}>Each one is simulated and then scored by the real engine, so the grades below are earned.</Micro>
        </View>
      ) : null}
    </>
  );

  // An unreadable list is not an empty garage, and the screen must not say both at once: the
  // notice above already says what is wrong and offers the repair, so nothing claims "NOTHING TO
  // BEAT YET" over a disk that still has the recordings on it.
  const unreadable = garage.fault?.kind === 'unreadable-index';
  const lastRun = !hasRuns ? (
    <>
      <SectionHead title="The garage" right={unreadable ? 'Unreadable' : garage.loading ? 'Reading' : 'Empty'} />
      {faultInColumn ? faultNotice : unreadable ? null : garage.loading ? <View style={styles.skeletonCard} testID="garage-loading" /> : <EmptyGarage testID="garage-empty" />}
    </>
  ) : (
    <>
      <SectionHead title="Last run" right={garage.entries.length === 1 ? '1 stored' : `${garage.entries.length} stored`} />
      {garage.last ? (
        <SwipeToDelete onDelete={() => setPending(garage.last)} enabled={pending === null} testID="last-run-swipe">
          <LastRunCard
            entry={garage.last}
            standing={garage.standing?.line ?? null}
            // the notice above already carries the monitor's sentence, once
            showReason={advice === null}
            onOpen={() => openRun(garage.last!)}
            onDelete={() => setPending(garage.last)}
            testID="last-run"
          />
        </SwipeToDelete>
      ) : null}
    </>
  );

  return (
    <View style={styles.root} testID="screen-garage">
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.scroll, wide && styles.scrollWide]}
          showsVerticalScrollIndicator={false}
          testID="garage-scroll">
          <View style={styles.header}>
            <Wordmark />
            <Pressable
              onPress={() => router.push('/settings')}
              hitSlop={14}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              testID="nav-settings"
              style={({ pressed }) => [styles.settings, pressed && styles.pressed]}>
              <Micro>Settings</Micro>
            </Pressable>
          </View>

          {wide ? (
            <View style={styles.top}>
              <View style={styles.topLeft}>{cta}</View>
              <View style={styles.topRight}>{lastRun}</View>
            </View>
          ) : (
            <>
              {cta}
              {lastRun}
            </>
          )}

          {hasRuns ? (
            <>
              <SectionHead title="Personal bests" accent={colors.gold} right={garage.bests.length === 1 ? '1 track' : `${garage.bests.length} tracks`} />
              <BestsBoard bests={garage.bests} lastId={garage.last?.id ?? null} onOpen={openRecord} wide={wide} />

              {garage.earlier.length > 0 ? (
                <SectionHead title="Earlier" accent={colors.cyan} right={garage.earlier.length === 1 ? '1 run' : `${garage.earlier.length} runs`} />
              ) : null}
              {garage.earlier.length === 0 ? (
                <Micro style={styles.onlyRun}>That is the only run in here. The next one goes above it.</Micro>
              ) : (
                nights.map((night) => (
                  <View key={night.key} style={styles.night}>
                    <View style={styles.nightHead}>
                      <Micro color="cyan" numberOfLines={1}>
                        {night.label}
                      </Micro>
                      <View style={styles.nightRule} />
                      {/* The section head already carries the total; repeat it only when the
                          nights actually divide it up. */}
                      {nights.length > 1 ? <Micro numberOfLines={1}>{night.runs.length === 1 ? '1 run' : `${night.runs.length} runs`}</Micro> : null}
                    </View>
                    <View style={[styles.list, wide && styles.listWide]}>
                      {night.runs.map((e) => (
                        <SwipeToDelete key={e.id} onDelete={() => setPending(e)} enabled={pending === null} style={wide ? styles.rowHalf : undefined}>
                          <RunRow entry={e} onOpen={() => openRun(e)} onDelete={() => setPending(e)} testID={`run-${e.id}`} />
                        </SwipeToDelete>
                      ))}
                    </View>
                  </View>
                ))
              )}
              <Micro style={styles.swipeHint}>Swipe a run left, or hold it, to delete</Micro>
            </>
          ) : null}

          {simParams ? (
            <>
              <SectionHead title="Demo bay" accent={colors.cyan} right="Web" />
              <SimBay params={simParams} onChange={changeSim} testID="sim-bay" />
            </>
          ) : null}

          {/* Tucked away, where an errand belongs: the app calibrates itself while driving. */}
          <View style={styles.footer}>
            <Pressable
              onPress={() => openCalibrate()}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Check the mount"
              testID="nav-calibrate"
              style={({ pressed }) => [styles.footLink, pressed && styles.pressed]}>
              <Micro color="muted">Check the mount</Micro>
            </Pressable>
            <Pressable
              onPress={() => router.push('/settings')}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              style={({ pressed }) => [styles.footLink, styles.footLinkEnd, pressed && styles.pressed]}>
              <Micro color="muted">Settings</Micro>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>

      {pending ? (
        <ConfirmDialog
          title="Delete this run?"
          body="The recording, the score and the replay all go. There is no undo."
          detail={`${pending.track ?? pending.name} · ${formatDate(pending.startedAt)} · ${formatDuration(pending.durationS)}`}
          confirmLabel="Delete"
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPending(null)}
          testID="confirm-delete-run"
        />
      ) : null}
    </View>
  );
}

function captionFor(sourceLabel: string, simulated: boolean): string {
  return simulated ? `Simulated · ${sourceLabel.replace(/^SIM · /, '')}` : 'Live sensors · mount it first';
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  safe: { flex: 1 },
  flex: { flex: 1 },
  scroll: { paddingHorizontal: gutter, paddingBottom: space[16], width: '100%', maxWidth: 660, alignSelf: 'center' },
  scrollWide: { maxWidth: 1040 },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingTop: space[3], paddingBottom: space[8] },
  settings: { paddingVertical: space[1], paddingHorizontal: space[2], borderWidth: 1, borderColor: colors.line, borderRadius: 4 },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: space[6] },
  topLeft: { flex: 1.05, minWidth: 0 },
  topRight: { flex: 1, minWidth: 0 },
  underCta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[3], marginTop: space[4] },
  ctaNote: { flexShrink: 1 },
  notice: { marginTop: space[4] },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space[4],
    marginTop: space[10],
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: space[2],
  },
  // 44 dp is the floor for anything a driver reaches for at arm's length in a moving car; this
  // was 110 × 14 with no hitSlop, on the one control someone uses when something feels wrong.
  footLink: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space[1] },
  footLinkEnd: { alignItems: 'flex-end' },
  seeding: { marginTop: space[5], gap: 2, borderLeftWidth: 3, borderLeftColor: colors.cyan, paddingLeft: space[3] },
  seedingNote: { textTransform: 'none', letterSpacing: 0.2 },
  skeletonCard: { height: 180, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg1, opacity: 0.6 },
  night: { marginTop: space[3] },
  nightHead: { flexDirection: 'row', alignItems: 'center', gap: space[3], paddingBottom: space[2] },
  nightRule: { flex: 1, height: 1, backgroundColor: colors.line },
  list: { gap: space[2] },
  listWide: { flexDirection: 'row', flexWrap: 'wrap' },
  rowHalf: { flexBasis: '48.5%', flexGrow: 1, minWidth: 280 },
  onlyRun: { paddingVertical: space[2], textTransform: 'none', letterSpacing: 0.2 },
  swipeHint: { marginTop: space[3], opacity: 0.7 },
  pressed: { opacity: 0.65 },
});
