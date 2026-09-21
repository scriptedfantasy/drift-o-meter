/**
 * Garage — the home screen, and the only screen most nights start on.
 *
 * Top to bottom it answers four questions in the order a driver asks them: whose car is this,
 * who is driving, who is winning, and what did I do last time. Then DRIVE, pinned to the
 * bottom edge where a thumb already is.
 *
 * DRIVE is step two of the whole app (docs/DESIGN.md, "the whole app is four steps"): tapping it
 * starts recording, and nothing on this screen is allowed to stand between a driver and that.
 * There is no calibration errand next to it — the engine calibrates itself while driving — and
 * the simulated-source bay lives at the BOTTOM of the scroll, off the path.
 *
 * WHO IS DRIVING is picked here, before the run, because it is the only moment it can be picked
 * honestly: the drive screen stamps whoever is active onto the session at the instant it starts
 * recording and never waits on this. Nobody is a real answer — the roster starts empty, the
 * first run happens before anyone has typed a name, and a run recorded that way is listed as
 * unassigned rather than hidden.
 *
 * Calibration appears here in exactly one case: the newest run left evidence that the mount was
 * wrong. Then the garage says what was wrong (`mountAdvice`) and offers the screen that fixes
 * it. Otherwise the link is tucked away in the footer with settings.
 *
 * A run the engine refused to judge is never dressed up as an achievement here — no angle, no
 * place on the board, the monitor's own sentence instead, in red (see
 * `SessionIntegrity.scoreTrusted`).
 *
 * Nothing on this screen reads a session body. Every number, verdict and sentence comes from
 * `SessionIndexEntry`, including who drove the run; a body is parsed only when a demo row is
 * TAPPED.
 *
 * URL (web / the harness):
 *   /?demo=night     six real, deterministic runs across two tracks, three drivers, one unclaimed
 *   /?demo=harbor    four judged runs on one track — the board with something to argue about
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
import { driverById, NO_DRIVER_LABEL, type Driver } from '@/platform/drivers';
import { colors, formatDate, formatDuration, gutter, Micro, SectionHead, space, Tag } from '@/ui';
import {
  BestsBoard,
  ConfirmDialog,
  DriveSlab,
  DriverBar,
  DriverSheet,
  EmptyGarage,
  GarageHero,
  LastRunCard,
  mountAdvice,
  MountNotice,
  removeDriverCopy,
  RunRow,
  SimBay,
  SwipeToDelete,
  readDetail,
  runsOf,
  useGarage,
  type DriverStanding,
} from '@/ui/garage';
import { FaultNotice } from '@/ui/garage/FaultNotice';
import { groupByNight } from '@/ui/garage/groups';

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
 * Past this the screen is not a phone held upright: landscape in a cradle, or a tablet. The
 * board and the run list then go two abreast instead of stretching a 56 dp row across 1040 px.
 */
const WIDE_PX = 700;

export default function GarageScreen() {
  const router = useRouter();
  const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  // expo-router gives the query on web; `currentSearch()` is the belt to that braces, because a
  // statically exported page can hydrate before the router has parsed the URL.
  const demo = first(params.demo) ?? new URLSearchParams(currentSearch() ?? '').get('demo') ?? undefined;
  const garage = useGarage(demo);
  const drivers = garage.drivers;
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

  // ---- delete a run, with a question first -------------------------------------------------
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

  // ---- edit a driver, and forget one with a question first ---------------------------------
  const [editing, setEditing] = useState<Driver | null>(null);
  const [forgetting, setForgetting] = useState<Driver | null>(null);
  // Counted from the index, which is where `driverId` lives — so asking how much a removal
  // costs reads no recordings either.
  const forgettingRuns = useMemo(
    () => (forgetting ? runsOf(garage.entries, drivers.roster, forgetting.id).length : 0),
    [forgetting, garage.entries, drivers.roster],
  );
  const confirmForget = useCallback(async () => {
    if (!forgetting) return;
    setBusy(true);
    try {
      await drivers.remove(forgetting.id);
    } finally {
      setBusy(false);
      setForgetting(null);
      setEditing(null);
    }
  }, [drivers, forgetting]);

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

  const openStanding = useCallback((s: DriverStanding) => openRun({ id: s.id } as SessionIndexEntry), [openRun]);

  const hasRuns = garage.entries.length > 0;
  const unreadable = garage.fault?.kind === 'unreadable-index';
  const faultNotice = garage.fault ? <FaultNotice fault={garage.fault} busy={garage.rebuilding} onAct={() => void garage.rebuild()} /> : null;
  // The one thing that earns a calibration prompt: the drive that just happened said something
  // was wrong. `newest`, not `last` — `last` is whoever's list is on screen.
  const advice = useMemo(() => mountAdvice(garage.newest), [garage.newest]);
  const nights = useMemo(() => groupByNight(garage.earlier), [garage.earlier]);

  const openCalibrate = useCallback(
    (why?: string) => {
      const q = [simQuery.slice(1), why ? `why=${why}` : ''].filter(Boolean).join('&');
      router.push(`/calibrate${q ? `?${q}` : ''}`);
    },
    [router, simQuery],
  );

  const active = drivers.active;
  const listTitle = active ? active.name : hasRuns ? 'Every run' : 'The garage';
  const listCount = garage.shown.length === 1 ? '1 run' : `${garage.shown.length} runs`;
  /**
   * Whose run a row should name, or null.
   *
   * Only when the list is NOT already one person's: with a driver selected the heading says
   * whose runs these are and repeating it down every row is noise, but with nobody at the wheel
   * the list mixes everyone's and the name is the only thing that says which is which.
   */
  const whoFor = useCallback(
    (entry: SessionIndexEntry) => (active ? null : (driverById(drivers.roster, entry.driverId)?.name ?? NO_DRIVER_LABEL)),
    [active, drivers.roster],
  );

  return (
    <View style={styles.root} testID="screen-garage">
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.scroll, wide && styles.scrollWide]}
          showsVerticalScrollIndicator={false}
          testID="garage-scroll">
          <View style={styles.heroWrap}>
            <GarageHero testID="garage-hero" />
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

          <View style={styles.pad}>
            <DriverBar
              drivers={drivers.drivers}
              activeId={drivers.roster.activeId}
              error={drivers.error}
              onSelect={(id) => void drivers.select(id)}
              onEdit={setEditing}
              onAdd={drivers.add}
              testID="driver-bar"
            />

            {advice ? (
              <View style={styles.notice}>
                <MountNotice advice={advice} onPress={() => openCalibrate(advice.concern)} testID="mount-notice" />
              </View>
            ) : null}
            {faultNotice ? <View style={styles.notice}>{faultNotice}</View> : null}
            {garage.seeding ? (
              <View style={styles.seeding} testID="garage-seeding">
                <Micro color="green">
                  Building demo runs · {garage.seeding.done} / {garage.seeding.total}
                </Micro>
                <Micro style={styles.seedingNote}>
                  Each one is simulated and then measured by the real engine, so the angles below are earned.
                </Micro>
              </View>
            ) : null}

            {hasRuns ? (
              <>
                <SectionHead title="Biggest angle" right={garage.track ?? undefined} />
                <BestsBoard standings={garage.standings} activeId={drivers.roster.activeId} wide={wide} onOpen={openStanding} />
              </>
            ) : null}

            <SectionHead
              title={listTitle}
              right={hasRuns ? listCount : unreadable ? 'Unreadable' : garage.loading ? 'Reading' : 'Empty'}
            />

            {!hasRuns ? (
              unreadable ? null : garage.loading ? (
                <View style={styles.skeletonCard} testID="garage-loading" />
              ) : (
                <EmptyGarage testID="garage-empty" />
              )
            ) : garage.shown.length === 0 ? (
              <Micro style={styles.onlyRun}>
                {active ? `Nothing stored under ${active.name} yet. Their next run lands here.` : 'Nothing stored yet.'}
              </Micro>
            ) : (
              <>
                {garage.last ? (
                  <SwipeToDelete onDelete={() => setPending(garage.last)} enabled={pending === null} testID="last-run-swipe">
                    <LastRunCard
                      entry={garage.last}
                      standing={garage.standing?.line ?? null}
                      who={whoFor(garage.last)}
                      // the notice above already carries the monitor's sentence, once
                      showReason={advice === null}
                      onOpen={() => openRun(garage.last!)}
                      onDelete={() => setPending(garage.last)}
                      testID="last-run"
                    />
                  </SwipeToDelete>
                ) : null}

                {garage.earlier.length === 0 ? (
                  <Micro style={styles.onlyRun}>That is the only run in here. The next one goes above it.</Micro>
                ) : (
                  nights.map((night) => (
                    <View key={night.key} style={styles.night}>
                      <View style={styles.nightHead}>
                        <Micro color="blue" numberOfLines={1}>
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
                            <RunRow entry={e} who={whoFor(e)} onOpen={() => openRun(e)} onDelete={() => setPending(e)} testID={`run-${e.id}`} />
                          </SwipeToDelete>
                        ))}
                      </View>
                    </View>
                  ))
                )}
                <Micro style={styles.swipeHint}>Swipe a run left, or hold it, to delete</Micro>
              </>
            )}

            {simParams ? (
              <>
                <SectionHead title="Demo bay" right="Web" />
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
          </View>
        </ScrollView>
      </SafeAreaView>

      {/* Outside the scroll: DRIVE is never more than a thumb's reach away, whatever is above it. */}
      <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.dock}>
        <View style={styles.dockInner}>
          <View style={styles.underCta}>
            <Micro numberOfLines={1} style={styles.ctaNote}>
              {/* "Unassigned" is a state a run can be IN, and it only reads as a choice once
                  there are names to choose between. With an empty roster it reads as a fault. */}
              {active ? `Recording as ${active.name}` : drivers.drivers.length === 0 ? 'No driver yet' : `Recording as ${NO_DRIVER_LABEL.toLowerCase()}`}
            </Micro>
            <Tag label={sourceLabel} color={simParams ? colors.blue : colors.green} filled />
          </View>
          <DriveSlab
            onPress={() => router.push(`/drive${simQuery}`)}
            caption={captionFor(sourceLabel, simParams !== null)}
            inline={wide}
            testID="cta-drive"
          />
        </View>
      </SafeAreaView>

      {editing ? (
        <DriverSheet
          key={editing.id}
          driver={editing}
          runs={runsOf(garage.entries, drivers.roster, editing.id).length}
          error={drivers.error}
          busy={busy}
          onRename={(name) => {
            void drivers.rename(editing.id, name).then((ok) => {
              if (ok) setEditing(null);
            });
          }}
          onRemove={() => setForgetting(editing)}
          onClose={() => setEditing(null)}
          testID="driver-sheet"
        />
      ) : null}

      {forgetting ? (
        <ForgetDialog driver={forgetting} runs={forgettingRuns} busy={busy} onConfirm={() => void confirmForget()} onCancel={() => setForgetting(null)} />
      ) : null}

      {pending ? (
        <ConfirmDialog
          title="Delete this run?"
          body="The recording and the replay both go. There is no undo."
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

/**
 * The question asked before a driver is forgotten.
 *
 * The wording is in `driverCopy.ts` and not here, because what a removal costs is a rule about
 * the data rather than a sentence on a screen: the runs stay and become unassigned, and adding
 * the same name back mints a new id that does not reclaim them.
 */
function ForgetDialog({ driver, runs, busy, onConfirm, onCancel }: { driver: Driver; runs: number; busy: boolean; onConfirm(): void; onCancel(): void }) {
  const copy = removeDriverCopy(driver.name, runs);
  return (
    <ConfirmDialog
      title={copy.title}
      body={copy.body}
      detail={copy.detail}
      confirmLabel="Forget"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
      testID="confirm-forget-driver"
    />
  );
}

function captionFor(sourceLabel: string, simulated: boolean): string {
  return simulated ? `Simulated · ${sourceLabel.replace(/^SIM · /, '')}` : 'Live sensors · mount it first';
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  safe: { flex: 1 },
  flex: { flex: 1 },
  // No horizontal padding here: the hero bleeds to both edges and every section below it is
  // wrapped in `pad` instead.
  scroll: { paddingBottom: space[6], width: '100%', maxWidth: 660, alignSelf: 'center' },
  scrollWide: { maxWidth: 1040 },
  pad: { paddingHorizontal: gutter },
  heroWrap: { position: 'relative' },
  settings: { position: 'absolute', top: space[2], right: gutter, paddingVertical: space[1], paddingHorizontal: space[2], borderWidth: 1, borderColor: colors.line, borderRadius: 4 },
  notice: { marginTop: space[4] },
  seeding: { marginTop: space[5], gap: 2 },
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
  dock: { borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.bg0 },
  dockInner: { paddingHorizontal: gutter, paddingTop: space[3], paddingBottom: space[3], gap: space[2], width: '100%', maxWidth: 660, alignSelf: 'center' },
  underCta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[3] },
  ctaNote: { flexShrink: 1 },
  pressed: { opacity: 0.65 },
});
