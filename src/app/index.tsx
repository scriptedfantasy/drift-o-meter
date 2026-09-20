/**
 * Garage — the home screen, and the only screen most nights start on.
 *
 * DRIVE is step two of the whole app (docs/DESIGN.md, "the whole app is four steps"): tapping it
 * starts recording, and nothing on this screen is allowed to stand between a driver and that.
 * There is no calibration errand next to it — the engine calibrates itself while driving — and
 * the simulated-source bay lives at the BOTTOM, off the path.
 *
 * Under DRIVE, in descending order of how likely a driver is to want it, sits the run they just
 * did (a card twice the size of anything else), the records they are trying to beat, and then
 * the rest of the nights, one line each. Swipe a run sideways or hold it to throw it away; the
 * app asks before it does.
 *
 * Calibration appears here in exactly one case: the last run left evidence that the mount was
 * wrong. Then the garage says what was wrong (`mountAdvice`) and offers the screen that fixes
 * it. Otherwise the link is tucked away in the footer with settings.
 *
 * A run the engine refused to score is never dressed up as an achievement here — no grade
 * letter, no record, the monitor's own sentence instead (see `SessionIntegrity.scoreTrusted`).
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
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
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
import { colors, formatDate, formatDuration, gutter, Micro, Small, space, Wordmark } from '@/ui';
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
  useGarage,
  type BestRecord,
  type SessionFacts,
} from '@/ui/garage';
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

export default function GarageScreen() {
  const router = useRouter();
  const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  // expo-router gives the query on web; `currentSearch()` is the belt to that braces, because a
  // statically exported page can hydrate before the router has parsed the URL.
  const demo = first(params.demo) ?? new URLSearchParams(currentSearch() ?? '').get('demo') ?? undefined;
  const garage = useGarage(demo);
  const { settings, update } = useSettings();

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

  const openRun = useCallback(
    (entry: SessionIndexEntry, facts: SessionFacts | undefined) => {
      router.push({ pathname: '/results/[id]', params: { id: entry.id, ...queryParams(facts?.fixtureQuery ?? '') } });
    },
    [router],
  );

  const openRecord = useCallback(
    (record: BestRecord) => {
      if (!record.id) return;
      router.push({ pathname: '/results/[id]', params: { id: record.id, ...queryParams(record.query) } });
    },
    [router],
  );

  const hasRuns = garage.entries.length > 0;
  // The one thing that earns a calibration prompt: the last run said something was wrong.
  const advice = useMemo(() => mountAdvice(garage.last, garage.last ? garage.facts.get(garage.last.id) : undefined), [garage.facts, garage.last]);
  const openCalibrate = useCallback(
    (why?: string) => {
      const q = [simQuery.slice(1), why ? `why=${why}` : ''].filter(Boolean).join('&');
      router.push(`/calibrate${q ? `?${q}` : ''}`);
    },
    [router, simQuery],
  );

  return (
    <View style={styles.root} testID="screen-garage">
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} testID="garage-scroll">
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

          <DriveSlab onPress={() => router.push(`/drive${simQuery}`)} caption={captionFor(sourceLabel, simParams !== null)} testID="cta-drive" />

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

          {garage.error ? (
            <View style={styles.errorBox}>
              <Small color="red">{garage.error}</Small>
            </View>
          ) : null}

          {garage.seeding ? (
            <View style={styles.seeding} testID="garage-seeding">
              <Micro color="cyan">
                Building demo runs · {garage.seeding.done} / {garage.seeding.total}
              </Micro>
              <Small>Each one is simulated and then scored by the real engine, so the grades below are earned.</Small>
            </View>
          ) : null}

          {!hasRuns ? (
            <>
              <SectionHead title="The garage" right={garage.loading ? 'Reading' : 'Empty'} />
              {garage.loading ? <View style={styles.skeletonCard} testID="garage-loading" /> : <EmptyGarage testID="garage-empty" />}
            </>
          ) : (
            <>
              <SectionHead title="Last run" right={garage.entries.length === 1 ? '1 stored' : `${garage.entries.length} stored`} />
              {garage.last ? (
                <SwipeToDelete onDelete={() => setPending(garage.last)} enabled={pending === null} testID="last-run-swipe">
                  <LastRunCard
                    entry={garage.last}
                    facts={garage.facts.get(garage.last.id)}
                    // the notice above already carries the monitor's sentence, once
                    showReason={advice === null}
                    onOpen={() => openRun(garage.last!, garage.facts.get(garage.last!.id))}
                    onDelete={() => setPending(garage.last)}
                    testID="last-run"
                  />
                </SwipeToDelete>
              ) : null}

              <SectionHead title="Personal bests" accent={colors.gold} right={garage.bests.length === 1 ? '1 track' : `${garage.bests.length} tracks`} />
              <BestsBoard bests={garage.bests} onOpen={openRecord} />

              {garage.earlier.length > 0 ? (
                <SectionHead title="Earlier" accent={colors.cyan} right={garage.earlier.length === 1 ? '1 run' : `${garage.earlier.length} runs`} />
              ) : null}
              {garage.earlier.length === 0 ? (
                <Small style={styles.onlyRun}>That is the only run in here. The next one goes above it.</Small>
              ) : (
                <View style={styles.list}>
                  {garage.earlier.map((e) => (
                    <SwipeToDelete key={e.id} onDelete={() => setPending(e)} enabled={pending === null}>
                      <RunRow entry={e} facts={garage.facts.get(e.id)} onOpen={() => openRun(e, garage.facts.get(e.id))} onDelete={() => setPending(e)} testID={`run-${e.id}`} />
                    </SwipeToDelete>
                  ))}
                </View>
              )}
              <Micro style={styles.swipeHint}>Swipe a run left, or hold it, to delete</Micro>
            </>
          )}

          {simParams ? (
            <>
              <SectionHead title="Demo bay" accent={colors.cyan} right="Web" />
              <SimBay params={simParams} onChange={changeSim} testID="sim-bay" />
            </>
          ) : null}

          {/* Tucked away, where an errand belongs: the app calibrates itself while driving. */}
          <View style={styles.footer}>
            <Pressable onPress={() => openCalibrate()} accessibilityRole="button" testID="nav-calibrate" style={({ pressed }) => pressed && styles.pressed}>
              <Micro color="muted">Check the mount</Micro>
            </Pressable>
            <Pressable onPress={() => router.push('/settings')} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
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
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingTop: space[3], paddingBottom: space[8] },
  settings: { paddingVertical: space[1], paddingHorizontal: space[2], borderWidth: 1, borderColor: colors.line, borderRadius: 4 },
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
    paddingTop: space[4],
  },
  errorBox: { marginTop: space[4], borderLeftWidth: 3, borderLeftColor: colors.red, paddingLeft: space[3] },
  seeding: { marginTop: space[5], gap: 2, borderLeftWidth: 3, borderLeftColor: colors.cyan, paddingLeft: space[3] },
  skeletonCard: { height: 180, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg1, opacity: 0.6 },
  list: { gap: space[2] },
  onlyRun: { paddingVertical: space[2] },
  swipeHint: { marginTop: space[3], opacity: 0.7 },
  pressed: { opacity: 0.65 },
});
