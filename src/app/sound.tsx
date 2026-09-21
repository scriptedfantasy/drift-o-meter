/**
 * `/sound` — the feel lab.
 *
 * Every clip in the bank, drawn and playable in one place, with the mixer's own decisions listed
 * underneath as they happen. It exists so the sound can be judged WITHOUT driving: a critic can
 * hear each clip, hear the sequences at their real measured timings, sweep the continuous layer
 * across |β|, flip either setting and watch the gate take effect, and read what the mixer did
 * with each cue — all of it the shipping code, not a demo re-implementation.
 *
 * Everything on this page is read from the same modules the run uses: the levels come from
 * `waveforms.ts` (measured off the committed WAVs by `tools/audio/analyse.mjs`), the priorities
 * and the haptics from `bank.ts`, the decisions from the live `DriftFeel`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Rect } from 'react-native-svg';

import { useSettings } from '@/platform';
import { AppText, alpha, colors, gutter, Micro, Panel, Segmented, Small, space, TopBar } from '@/ui';
import { toneColor } from '@/ui/callouts';
import { CLIP_MEASUREMENTS, DriftFeel, feelCue, SOUND_BANK, SOUND_SEQUENCES, TIER_TARGETS, useDriftFeel, type CueDecision, type SoundId, type SoundSpec } from '@/ui/audio';

const ANGLES = [0, 12, 25, 40, 55];

/** The two bed layers' measured brightness, so the meters can never go stale after a re-render. */
const BED_LOW_HZ = Math.round(CLIP_MEASUREMENTS['bed-low']?.centroidHz ?? 0);
const BED_HIGH_HZ = Math.round(CLIP_MEASUREMENTS['bed-high']?.centroidHz ?? 0);
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${v} Hz`);

/**
 * Everything the page draws from the live mixer, copied into a FRESH object every tick.
 *
 * Not read straight off `driftFeel` during render. The mixer's `stats` and `decisions` are
 * mutable objects on a module singleton, and this app builds with the React Compiler
 * (`app.json` → experiments.reactCompiler), which is entitled to treat a property read of a
 * stable module value as a constant and hoist it out of the render. A snapshot with a new
 * identity every tick is state, so it cannot be hoisted — and it is the difference between a
 * status panel that reports the mixer and one that reports 0/0 while the mixer works.
 */
interface LabSnapshot {
  cues: number;
  played: number;
  stolen: number;
  lastDispatchMs: number;
  worstDispatchMs: number;
  decisions: CueDecision[];
  bed: { low: number; high: number; gain: number; mix: number };
}

function snapshotOf(mixer: DriftFeel): LabSnapshot {
  const s = mixer.stats;
  return {
    cues: s.cues,
    played: s.played,
    stolen: s.stolen,
    lastDispatchMs: s.lastDispatchMs,
    worstDispatchMs: s.worstDispatchMs,
    decisions: mixer.decisions.slice(-10).reverse(),
    bed: mixer.bedState(),
  };
}

export default function SoundLabScreen() {
  const feel = useDriftFeel();
  const mixer = feel.mixer;
  const { settings, update } = useSettings();
  const [snap, setSnap] = useState<LabSnapshot>(() => snapshotOf(mixer));
  const [angle, setAngle] = useState(0);
  const [sweeping, setSweeping] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // One 20 Hz ticker drives the bed and every live readout on the page. The lab is the only
  // place in the app that re-renders for audio: a run writes to shared values instead.
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      const deg = sweeping ? sweepAngle(elapsed) : angle;
      mixer.bedFromAngle(deg, 0.05, deg > 0);
      setSnap(snapshotOf(mixer));
    }, 50);
    return () => clearInterval(id);
  }, [angle, mixer, sweeping]);

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    },
    [],
  );

  /**
   * Play one clip. `unlock()` first and IN the gesture: a browser will not start an AudioContext
   * until the page has been touched, and this press is that touch.
   */
  const play = useCallback(
    (id: SoundId) => {
      void feel.unlock().then(() => feelCue(id));
    },
    [feel],
  );

  const runSequence = useCallback(
    (steps: Array<{ id: SoundId; atS: number }>) => {
      void feel.unlock().then(() => {
        for (const t of timers.current) clearTimeout(t);
        timers.current = steps.map((s) => setTimeout(() => feelCue(s.id), s.atS * 1000));
      });
    },
    [feel],
  );

  const bed = snap.bed;
  const decisions = snap.decisions;
  const last = decisions[0] ?? null;
  const liveAngle = sweeping ? Math.round(bedAngleFromGain(bed.gain)) : angle;

  return (
    <View style={styles.root} testID="screen-sound">
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <TopBar kicker="Feel layer" title="Sound lab" />

          {/* ── what the platform is doing ─────────────────────────────────────────────── */}
          <Panel style={styles.panel} accent={feel.state === 'ready' ? colors.green : feel.state === 'locked' ? colors.gold : colors.red} testID="sound-status">
            <View style={styles.statusHead}>
              <AppText variant="heading" uppercase color={feel.state === 'ready' ? 'green' : feel.state === 'locked' ? 'gold' : 'red'}>
                {feel.state === 'ready' ? 'Audible' : feel.state === 'locked' ? 'Tap to enable' : feel.state === 'loading' ? 'Loading' : 'No audio here'}
              </AppText>
              <AppText variant="telemetry" numeric color="muted" style={styles.loaded}>
                {feel.loaded}/{feel.total}
              </AppText>
            </View>
            <Small>{feel.sound}</Small>
            <Small>{feel.haptics}</Small>
            <View style={styles.statRow}>
              <Stat label="Dispatch" value={snap.cues === 0 ? '—' : `${snap.lastDispatchMs.toFixed(3)} ms`} testID="sound-latency" />
              <Stat label="Worst" value={snap.cues === 0 ? '—' : `${snap.worstDispatchMs.toFixed(3)} ms`} />
              <Stat label="Played" value={`${snap.played}/${snap.cues}`} />
              <Stat label="Stolen" value={String(snap.stolen)} />
            </View>
            {/* The newest decision, kept at the top so the gate and the priority rules are
                visible without scrolling — the full log is further down. */}
            <View style={styles.lastRow} testID="sound-last">
              <Micro>Last cue</Micro>
              {last ? (
                <AppText variant="bodyStrong" color={OUTCOME_COLOR[last.outcome] ?? colors.muted}>
                  {last.id} · {last.outcome}
                  {last.against ? ` · ${last.against}` : ''}
                  {last.haptic ? ` · ${last.haptic}` : ''}
                </AppText>
              ) : (
                <AppText variant="bodyStrong" color="muted">
                  none yet
                </AppText>
              )}
            </View>
          </Panel>

          {/* ── the two settings, live ─────────────────────────────────────────────────── */}
          <Panel style={styles.panel}>
            <AppText variant="heading" uppercase>
              The two switches
            </AppText>
            <Small>Each channel has its own. Sound off still leaves the run felt; haptics off still leaves it heard. Both are read at the moment of play, so this takes effect on the next press.</Small>
            <View style={styles.field}>
              <Micro>Sound</Micro>
              <Segmented
                options={[
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off' },
                ]}
                value={settings.sound ? 'on' : 'off'}
                onChange={(v) => void update({ sound: v === 'on' })}
                color={colors.ember}
                testID="lab-sound"
              />
            </View>
            <View style={styles.field}>
              <Micro>Haptics</Micro>
              <Segmented
                options={[
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off' },
                ]}
                value={settings.haptics ? 'on' : 'off'}
                onChange={(v) => void update({ haptics: v === 'on' })}
                color={colors.magenta}
                testID="lab-haptics"
              />
            </View>
            {Platform.OS === 'web' ? <Micro>Haptics requested here are recorded, not delivered: {feel.recentHaptics().slice(-6).join(' · ') || 'none yet'}</Micro> : null}
          </Panel>

          {/* ── the continuous layer ───────────────────────────────────────────────────── */}
          <Panel style={styles.panel} accent={colors.ember}>
            <AppText variant="heading" uppercase>
              The slide
            </AppText>
            <Small>
              Two loops cross-faded by |β| — dark tyre scrub at small angles, a brighter one with a squeal in it at big ones. It opens and closes on the drive display&apos;s own glow envelope (90 ms up, 240 ms
              down) and shuts completely below 6°, so it can never become a drone.
            </Small>
            <View style={styles.bedHead}>
              <AppText variant="display" numeric color="ember" style={styles.bedAngle}>
                {liveAngle}
                <AppText variant="heading" color="muted">
                  °
                </AppText>
              </AppText>
              <View style={styles.bedMeters}>
                <LayerMeter label="Dark 477 Hz" value={bed.low} color={colors.ember} />
                <LayerMeter label="Bright 2.7 kHz" value={bed.high} color={colors.gold} />
              </View>
            </View>
            <View style={styles.row}>
              {ANGLES.map((deg) => (
                <LabButton
                  key={deg}
                  label={`${deg}°`}
                  active={!sweeping && angle === deg}
                  color={colors.ember}
                  testID={`bed-${deg}`}
                  onPress={() => {
                    setSweeping(false);
                    setAngle(deg);
                    void feel.unlock();
                  }}
                />
              ))}
              <LabButton
                label={sweeping ? 'Stop' : 'Sweep'}
                active={sweeping}
                color={colors.cyan}
                testID="bed-sweep"
                onPress={() => {
                  setSweeping((s) => !s);
                  setAngle(0);
                  void feel.unlock();
                }}
              />
            </View>
          </Panel>

          {/* ── the sequences ──────────────────────────────────────────────────────────── */}
          <Panel style={styles.panel} accent={colors.magenta}>
            <AppText variant="heading" uppercase>
              In sequence
            </AppText>
            <Small>Real moments from harbour seed 1, at the offsets the engine produced. The gaps are the point.</Small>
            {SEQUENCES.map((s) => (
              <View key={s.key} style={styles.sequence}>
                <LabButton label={s.label} color={colors.magenta} testID={`seq-${s.key}`} onPress={() => runSequence(s.steps)} wide />
                <Micro style={styles.sequenceNote}>{s.note}</Micro>
              </View>
            ))}
          </Panel>

          {/* ── the decision log ───────────────────────────────────────────────────────── */}
          <Panel style={styles.panel} testID="sound-decisions">
            <AppText variant="heading" uppercase>
              What the mixer did
            </AppText>
            <Small>The last ten decisions, newest first. Two voices; a cue takes one only from something strictly lower.</Small>
            {decisions.length === 0 ? (
              <Micro>Nothing yet — press a clip.</Micro>
            ) : (
              decisions.map((d, i) => (
                <View key={`${d.t}-${i}`} style={styles.decision}>
                  <AppText variant="micro" color={toneColor(SOUND_BANK.find((s) => s.id === d.id)?.tone ?? 'ember')} style={styles.decisionId}>
                    {d.id}
                  </AppText>
                  <AppText variant="micro" color={OUTCOME_COLOR[d.outcome] ?? colors.muted} style={styles.decisionOutcome}>
                    {d.outcome}
                    {d.against ? ` · ${d.against}` : ''}
                  </AppText>
                  <Micro>{d.haptic ?? '—'}</Micro>
                </View>
              ))
            )}
          </Panel>

          {/* ── the bank ───────────────────────────────────────────────────────────────── */}
          <View style={styles.bankHead}>
            <AppText variant="heading" uppercase>
              The bank
            </AppText>
            <Micro>
              {SOUND_BANK.length} one-shots · 2 beds · tiers {Object.keys(TIER_TARGETS).join('')}
            </Micro>
          </View>
          {SOUND_BANK.map((spec) => (
            <ClipRow key={spec.id} spec={spec} onPlay={() => play(spec.id)} />
          ))}

          <Micro style={styles.footer}>
            Synthesised by tools/audio/render.mjs · measured by tools/audio/analyse.mjs · scheduled by src/ui/audio/mixer.ts
          </Micro>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const OUTCOME_COLOR: Record<string, string> = {
  played: colors.green,
  stole: colors.gold,
  busy: colors.muted,
  family: colors.muted,
  flick: colors.muted,
  debounce: colors.muted,
  gated: colors.red,
  muted: colors.red,
  silent: colors.cyan,
};

/** |β| for the sweep: up to 55° and back, over eight seconds, with a dwell at the top. */
function sweepAngle(elapsedS: number): number {
  const x = (elapsedS % 8) / 8;
  const shape = x < 0.4 ? x / 0.4 : x < 0.6 ? 1 : 1 - (x - 0.6) / 0.4;
  return Math.round(shape * 55);
}

/** Invert the bed's own curve so the sweep can show the angle it is actually tracking. */
function bedAngleFromGain(gain: number): number {
  return gain <= 0 ? 0 : 6 + gain * 44;
}

function ClipRow({ spec, onPlay }: { spec: SoundSpec; onPlay: () => void }) {
  const m = CLIP_MEASUREMENTS[spec.id];
  const tone = toneColor(spec.tone);
  return (
    <Panel style={styles.clip} accent={tone} testID={`clip-${spec.id}`}>
      <View style={styles.clipHead}>
        <View style={styles.clipTitle}>
          <AppText variant="subheading" color={tone} numberOfLines={1}>
            {spec.label}
          </AppText>
          <Micro numberOfLines={2}>{spec.trigger}</Micro>
        </View>
        <Pressable onPress={onPlay} accessibilityRole="button" accessibilityLabel={`Play ${spec.label}`} testID={`play-${spec.id}`} style={({ pressed }) => [styles.play, { borderColor: tone }, pressed && styles.pressed]}>
          <AppText variant="subheading" color={tone} style={styles.playLabel}>
            Play
          </AppText>
        </Pressable>
      </View>

      <Waveform peaks={m.peaks} color={tone} />

      <View style={styles.clipStats}>
        <Micro>{m.durationS.toFixed(2)} s</Micro>
        <Micro>peak {m.peakDb.toFixed(1)} dB</Micro>
        <Micro>rms {m.rmsDb.toFixed(1)} dB</Micro>
        <Micro>tier {m.tier}</Micro>
        <Micro>{Math.round(m.centroidHz)} Hz</Micro>
        <Micro color={colors.cyan}>prio {spec.priority}</Micro>
        <Micro color={spec.haptic ? colors.magenta : colors.muted}>{spec.haptic ?? 'no haptic'}</Micro>
      </View>
      <Small style={styles.why}>{spec.why}</Small>
    </Panel>
  );
}

/**
 * The clip's envelope, on the same dBFS vertical scale as `artifacts/audio/waveforms.png`:
 * 0 dBFS at the edges, −60 dBFS on the centre line. A linear scale is useless across a bank that
 * spans 25 dB — a −27.9 dBFS clip is 4 % of full scale and draws as a hairline.
 */
function Waveform({ peaks, color }: { peaks: number[]; color: string }) {
  const H = 42;
  const W = 96;
  const mid = H / 2;
  return (
    <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={styles.wave}>
      <Rect x={0} y={mid - 0.25} width={W} height={0.5} fill={alpha(colors.line, 0.9)} />
      {peaks.map((p, i) => {
        const db = 20 * Math.log10(Math.max(1e-5, p));
        const n = Math.max(0, Math.min(1, 1 + db / 60));
        const h = Math.max(0.6, n * (H - 2));
        return <Rect key={i} x={i + 0.12} y={mid - h / 2} width={0.76} height={h} fill={color} opacity={0.92} rx={0.3} />;
      })}
    </Svg>
  );
}

function LayerMeter({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View style={styles.meter}>
      <View style={styles.meterHead}>
        <Micro>{label}</Micro>
        <AppText variant="micro" numeric color={color}>
          {(pct * 100).toFixed(0)}%
        </AppText>
      </View>
      <View style={styles.meterTrack}>
        <View style={[styles.meterFill, { width: `${pct * 100}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

function Stat({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View style={styles.stat} testID={testID}>
      <Micro>{label}</Micro>
      <AppText variant="bodyStrong" numeric color="text">
        {value}
      </AppText>
    </View>
  );
}

function LabButton({ label, onPress, color, active, testID, wide }: { label: string; onPress(): void; color: string; active?: boolean; testID?: string; wide?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      testID={testID}
      style={({ pressed }) => [styles.labButton, wide && styles.labButtonWide, { borderColor: active ? color : colors.line, backgroundColor: active ? alpha(color, 0.18) : colors.bg2 }, pressed && styles.pressed]}>
      <AppText variant="subheading" color={active ? color : 'text'} style={styles.labButtonLabel} numberOfLines={1}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  safe: { flex: 1 },
  flex: { flex: 1 },
  scroll: { paddingHorizontal: gutter, paddingBottom: space[10], width: '100%', maxWidth: 660, alignSelf: 'center' },
  panel: { marginBottom: space[3], gap: space[2] },
  statusHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  loaded: { fontSize: 26, lineHeight: 28 },
  statRow: { flexDirection: 'row', gap: space[3], marginTop: space[1] },
  stat: { flex: 1, minWidth: 62, gap: 2 },
  lastRow: { gap: 2, marginTop: space[2], borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space[2] },
  field: { gap: space[2], marginTop: space[1] },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], marginTop: space[1] },
  bedHead: { flexDirection: 'row', alignItems: 'center', gap: space[4], marginTop: space[1] },
  bedAngle: { fontSize: 58, lineHeight: 56, minWidth: 110 },
  bedMeters: { flex: 1, gap: space[2] },
  meter: { gap: 4 },
  meterHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  meterTrack: { height: 5, borderRadius: 3, backgroundColor: colors.bg2, overflow: 'hidden' },
  meterFill: { height: '100%', borderRadius: 3 },
  sequence: { gap: 4, marginTop: space[2] },
  sequenceNote: { lineHeight: 15 },
  decision: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: colors.line },
  decisionId: { width: 88 },
  decisionOutcome: { flex: 1 },
  bankHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space[3], marginTop: space[5], marginBottom: space[3] },
  clip: { marginBottom: space[3], gap: space[2] },
  clipHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space[3] },
  clipTitle: { flex: 1, gap: 2 },
  play: { minWidth: 70, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 8, backgroundColor: colors.bg2 },
  playLabel: { fontSize: 15, lineHeight: 18 },
  wave: { marginTop: space[1] },
  clipStats: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
  why: { lineHeight: 19 },
  labButton: { minHeight: 40, paddingHorizontal: space[4], borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  labButtonWide: { alignSelf: 'flex-start', paddingHorizontal: space[5] },
  labButtonLabel: { fontSize: 16, lineHeight: 19 },
  pressed: { opacity: 0.7 },
  footer: { marginTop: space[4], lineHeight: 16 },
});
