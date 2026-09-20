/**
 * The transport: everything on this screen a finger touches.
 *
 * The scrubber is a video scrubber, not a slider — the touch down grabs the playhead, the frame
 * follows the finger immediately (the gesture writes the clock's shared value, and the camera
 * jumps rather than sweeping across the map), and the run carries on from wherever it is let go.
 *
 * The chips are a tighter variant of `src/ui/Segmented` — same colours, same type, sized for a
 * transport bar that has to hold a play control, three speeds, three cameras and the highlight
 * stepper across 361 points of phone.
 *
 * Nothing here re-renders while the replay plays: the controls only change when a human taps.
 */
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { runOnJS, useSharedValue } from 'react-native-reanimated';

import type { CameraMode } from '../../engine/replay';
import { AppText, Button, Micro } from '../index';
import { alpha, colors, radii, space } from '../theme';
import type { ReplayLayout } from './layout';
import { RATES } from './params';
import type { ReplayPlayer } from './player';

interface ChipOption<T extends string | number> {
  value: T;
  label: string;
}

interface ChipsProps<T extends string | number> {
  options: ReadonlyArray<ChipOption<T>>;
  value: T;
  onChange(v: T): void;
  color: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

function Chips<T extends string | number>({ options, value, onChange, color, testID, style }: ChipsProps<T>) {
  return (
    <View style={[styles.chips, style]} testID={testID} accessibilityRole="radiogroup">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            testID={`${testID}-${o.value}`}
            style={({ pressed }) => [styles.chip, active && { backgroundColor: alpha(color, 0.18), borderColor: color }, pressed && styles.pressed]}>
            <AppText variant="subheading" color={active ? color : 'muted'} style={styles.chipLabel} numberOfLines={1}>
              {o.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const RATE_OPTIONS: ReadonlyArray<ChipOption<number>> = RATES.map((r) => ({ value: r, label: `${r}×` }));
const CAM_OPTIONS: ReadonlyArray<ChipOption<CameraMode>> = [
  { value: 'overview', label: 'Track' },
  { value: 'chase', label: 'Chase' },
  { value: 'cinematic', label: 'Cine' },
];

export interface ScrubberProps {
  layout: ReplayLayout;
  durationS: number;
  player: ReplayPlayer;
}

/**
 * The touch target over the drawn scrubber. It is deliberately taller than the 34 pt band it
 * covers: a thumb is 44 pt wide and this is the one control used while watching.
 */
export function Scrubber({ layout, durationS, player }: ScrubberProps) {
  const wasPlaying = useSharedValue(0);
  const { scrubbing, scrubT, playing, seekT, time } = player.sv;
  const x0 = layout.insets.left + 18;
  const x1 = layout.w - layout.insets.right - 18;
  const span = Math.max(1, x1 - x0);
  const dur = Math.max(1e-6, durationS);
  const height = Math.max(layout.scrub.h, 44);
  const top = layout.scrub.y + layout.scrub.h / 2 - height / 2;
  const setPlaying = player.setPlaying;

  const pan = Gesture.Pan()
    .minDistance(0)
    .shouldCancelWhenOutside(false)
    .onBegin((e) => {
      'worklet';
      wasPlaying.value = playing.value;
      playing.value = 0;
      scrubbing.value = 1;
      scrubT.value = Math.min(dur, Math.max(0, ((e.x - x0) / span) * dur));
      seekT.value = NaN;
      runOnJS(setPlaying)(false);
    })
    .onUpdate((e) => {
      'worklet';
      scrubT.value = Math.min(dur, Math.max(0, ((e.x - x0) / span) * dur));
    })
    .onFinalize(() => {
      'worklet';
      time.value = scrubT.value;
      scrubbing.value = 0;
      if (wasPlaying.value === 1) {
        playing.value = 1;
        runOnJS(setPlaying)(true);
      }
    });

  return (
    <GestureDetector gesture={pan}>
      <View style={[styles.scrub, { top, height }]} testID="replay-scrubber" accessibilityRole="adjustable" accessibilityLabel="Replay timeline" />
    </GestureDetector>
  );
}

export interface ControlsProps {
  layout: ReplayLayout;
  player: ReplayPlayer;
  highlightCount: number;
  onShare(): void;
  shareLabel: string;
  shareDisabled: boolean;
  visible: boolean;
}

export function ReplayControls({ layout, player, highlightCount, onShare, shareLabel, shareDisabled, visible }: ControlsProps) {
  const { controls, landscape } = layout;
  return (
    <View
      style={[styles.controls, { left: controls.x, top: controls.y, width: controls.w }, landscape && styles.controlsLandscape, !visible && styles.hidden]}
      pointerEvents={visible ? 'box-none' : 'none'}
      testID="replay-controls">
      <View style={styles.group}>
        <Button
          label={player.playing ? 'Pause' : 'Play'}
          size="sm"
          variant={player.playing ? 'secondary' : 'primary'}
          onPress={player.toggle}
          style={styles.play}
          testID="replay-play"
        />
        <Chips options={RATE_OPTIONS} value={player.rate} onChange={player.setRate} color={colors.cyan} testID="replay-rate" />
        <Button label={shareLabel} size="sm" variant="secondary" onPress={onShare} disabled={shareDisabled} style={styles.share} testID="replay-share" />
      </View>
      <View style={styles.group}>
        <Chips options={CAM_OPTIONS} value={player.mode} onChange={player.setMode} color={colors.ember} testID="replay-cam" />
        {highlightCount > 0 ? (
          <>
            <Button label="Best bits" size="sm" variant="secondary" onPress={player.nextHighlight} style={styles.best} testID="replay-highlight" />
            <Pressable onPress={player.prevHighlight} style={({ pressed }) => [styles.step, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Previous highlight" testID="replay-prev">
              <AppText variant="subheading" color="muted" style={styles.stepLabel}>
                {'\u2039'}
              </AppText>
            </Pressable>
            <Pressable onPress={player.nextHighlight} style={({ pressed }) => [styles.step, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Next highlight" testID="replay-next">
              <AppText variant="subheading" color="muted" style={styles.stepLabel}>
                {'\u203A'}
              </AppText>
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

export interface WarningsProps {
  warnings: string[];
  layout: ReplayLayout;
  open: boolean;
  onToggle(): void;
}

/** The red plate the canvas draws is the alarm; this is the sentence behind it. */
export function WarningsOverlay({ warnings, layout, open, onToggle }: WarningsProps) {
  if (warnings.length === 0) return null;
  return (
    <View
      style={[styles.warnWrap, { left: layout.insets.left + 18, top: layout.stage.y + 4, maxWidth: Math.min(320, layout.w - layout.insets.left - layout.insets.right - 36) }]}
      testID="replay-warnings">
      <Pressable onPress={onToggle} style={styles.warnHit} accessibilityRole="button" accessibilityLabel={`${warnings.length} problems with this recording`} testID="replay-warn-toggle" />
      {open ? (
        <View style={styles.warnPanel}>
          <AppText variant="label" color="red">
            {warnings.length === 1 ? 'One problem with this recording' : `${warnings.length} problems with this recording`}
          </AppText>
          {warnings.slice(0, 4).map((w) => (
            <Micro key={w} style={styles.warnLine}>
              {w}
            </Micro>
          ))}
          <Micro>Dashed stretches are dead reckoning, not measured positions.</Micro>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scrub: { position: 'absolute', left: 0, right: 0 },
  controls: { position: 'absolute', gap: space[2] },
  controlsLandscape: { flexDirection: 'row', alignItems: 'center', gap: space[4] },
  hidden: { opacity: 0 },
  group: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chip: {
    // 44 pt is the smallest thing a thumb hits reliably, and this screen is used one-handed
    minHeight: 44,
    paddingHorizontal: 11,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipLabel: { fontSize: 14, lineHeight: 17, letterSpacing: 0.4 },
  pressed: { opacity: 0.7 },
  play: { width: 78, minHeight: 44, paddingHorizontal: 0 },
  best: { width: 88, minHeight: 44, paddingHorizontal: 0 },
  share: { width: 86, minHeight: 44, paddingHorizontal: 0 },
  step: {
    width: 36,
    height: 44,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLabel: { fontSize: 20, lineHeight: 22 },
  warnWrap: { position: 'absolute' },
  warnHit: { width: 140, height: 26 },
  warnPanel: {
    marginTop: space[1],
    padding: space[3],
    borderRadius: radii.md,
    backgroundColor: alpha(colors.bg1, 0.94),
    borderWidth: 1,
    borderColor: alpha(colors.red, 0.5),
    gap: space[1],
  },
  warnLine: { color: colors.text },
});
