/**
 * Settings. Deliberately the plainest screen in the app: a list of choices, each one a word a
 * driver already knows, and one destructive button that asks first.
 *
 * `Alert.alert` is a no-op on web, so the wipe uses the app's own confirmation (`ConfirmDialog`)
 * on every platform rather than silently deleting a night's driving in a browser.
 */
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { clearSessions, useSessionIndex, useSettings } from '@/platform';
import { listTracks } from '@/sim';
import { AppText, colors, gutter, Micro, Panel, Segmented, type SegmentOption, Small, space, TopBar } from '@/ui';
import { ConfirmDialog, forgetDetails } from '@/ui/garage';

const TRACK_OPTIONS = listTracks().map((t) => ({ value: t.id, label: t.name }));
const RATE_OPTIONS: SegmentOption<number>[] = [
  { value: 0.5, label: '0.5×' },
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
];

export default function SettingsScreen() {
  const router = useRouter();
  const { settings, update, loaded } = useSettings();
  const sessions = useSessionIndex();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const isWeb = Platform.OS === 'web';

  const wipe = useCallback(async () => {
    setBusy(true);
    try {
      await clearSessions();
      forgetDetails();
      await sessions.refresh();
    } finally {
      setBusy(false);
      setAsking(false);
    }
  }, [sessions]);

  const stored = sessions.entries.length;

  return (
    <View style={styles.root} testID="screen-settings">
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <TopBar kicker="Preferences" title="Settings" />

          <Section title="The mount" hint="The app works this out by itself while you drive — open this only if something looks wrong.">
            <Pressable
              onPress={() => router.push('/calibrate')}
              accessibilityRole="button"
              testID="setting-calibrate"
              style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
              <AppText variant="subheading" color="cyan" style={styles.linkLabel}>
                Check the mount →
              </AppText>
            </Pressable>
          </Section>

          <Section title="Sensor source" hint={isWeb ? 'A browser has no motion sensors, so everything here is simulated.' : 'Use the simulator to see how the judge scores a run without driving.'}>
            <Segmented
              options={[
                { value: 'device', label: 'Device sensors', disabled: isWeb },
                { value: 'simulated', label: 'Simulated' },
              ]}
              value={isWeb ? 'simulated' : settings.sensorMode}
              onChange={(v) => void update({ sensorMode: v })}
              testID="setting-source"
            />
          </Section>

          <Section title="Simulated run" hint="Which recording the simulator plays.">
            <Field label="Road">
              <Segmented options={TRACK_OPTIONS} value={settings.simTrack} onChange={(v) => void update({ simTrack: v })} color={colors.cyan} testID="setting-track" />
            </Field>
            <Field label="Playback speed">
              <Segmented options={RATE_OPTIONS} value={settings.simRate} onChange={(v) => void update({ simRate: v })} color={colors.cyan} testID="setting-rate" />
            </Field>
            <Field label="Seed">
              <Stepper value={settings.simSeed} min={0} max={9999} onChange={(simSeed) => void update({ simSeed })} testID="setting-seed" />
            </Field>
            <Field label="Laps">
              <Stepper value={settings.simLaps} min={1} max={10} onChange={(simLaps) => void update({ simLaps })} testID="setting-laps" />
            </Field>
            <Small>
              Mount looseness and GPS dropouts belong to a recording rather than to you, so they live on the garage&apos;s
              demo bay and travel on the link.
            </Small>
          </Section>

          <Section title="Units">
            <Field label="Speed">
              <Segmented
                options={[
                  { value: 'kmh', label: 'km/h' },
                  { value: 'mph', label: 'mph' },
                ]}
                value={settings.units}
                onChange={(v) => void update({ units: v })}
                testID="setting-units"
              />
            </Field>
          </Section>

          <Section title="Feedback" hint="What the phone does when a drift starts, flicks and banks.">
            <Field label="Haptics">
              <Segmented
                options={[
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off' },
                ]}
                value={settings.haptics ? 'on' : 'off'}
                onChange={(v) => void update({ haptics: v === 'on' })}
                color={colors.magenta}
                testID="setting-haptics"
              />
            </Field>
            <Field label="Sound">
              <Segmented
                options={[
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off' },
                ]}
                value={settings.sound ? 'on' : 'off'}
                onChange={(v) => void update({ sound: v === 'on' })}
                color={colors.magenta}
                testID="setting-sound"
              />
              {/* The other switch, the one this screen does not own. `src/platform/audio.ts`
                  sets `playsInSilentMode: false` — a deliberate non-default, since expo-audio
                  declares `@default true` — because a phone flicked to silent is a driver saying
                  "not now". That is right, and it means SOUND · ON is not the whole story on
                  most iPhones, which live on silent. Saying so here is cheaper than a driver
                  deciding the feature is broken. */}
              <Small>Off when the phone is on silent, too — this app never talks over the ringer switch. Haptics still carry the run.</Small>
            </Field>
            {/* A switch is a stronger claim than a label, so this screen has to be able to make
                good on it without a drive: the lab plays every clip in the bank and shows what
                the mixer did with each one, including what this switch does to it. */}
            <Pressable
              onPress={() => router.push('/sound')}
              accessibilityRole="button"
              testID="setting-sound-lab"
              style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
              <AppText variant="subheading" color="magenta" style={styles.linkLabel}>
                Hear every sound →
              </AppText>
            </Pressable>
          </Section>

          <Section title="Data" hint="Everything this app stores stays on this device.">
            <Small>{stored === 1 ? '1 stored run.' : `${stored} stored runs.`}</Small>
            <Pressable
              disabled={busy || stored === 0}
              onPress={() => setAsking(true)}
              accessibilityRole="button"
              testID="setting-wipe"
              style={({ pressed }) => [styles.wipe, (busy || stored === 0) && styles.wipeOff, pressed && styles.pressed]}>
              <AppText variant="subheading" color="red" style={styles.wipeLabel}>
                Delete all runs
              </AppText>
            </Pressable>
          </Section>

          <View style={styles.about}>
            <Micro numberOfLines={2}>
              Drift-O-Meter {Constants.expoConfig?.version ?? '1.0.0'} · Expo SDK {Constants.expoConfig?.sdkVersion ?? '57'} ·{' '}
              {loaded ? 'settings synced' : 'loading settings'}
            </Micro>
            <Pressable onPress={() => router.replace('/')} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
              <Micro color="cyan">← Back to the garage</Micro>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>

      {asking ? (
        <ConfirmDialog
          title="Delete every run?"
          body="Every recording, score and replay on this device goes. There is no undo and nothing is backed up anywhere."
          detail={stored === 1 ? '1 run will be deleted' : `${stored} runs will be deleted`}
          confirmLabel="Delete everything"
          busy={busy}
          onConfirm={() => void wipe()}
          onCancel={() => setAsking(false)}
          testID="confirm-wipe"
        />
      ) : null}
    </View>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Panel style={styles.section}>
      <AppText variant="heading" uppercase>
        {title}
      </AppText>
      {hint ? <Small>{hint}</Small> : null}
      <View style={styles.sectionBody}>{children}</View>
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Micro>{label}</Micro>
      {children}
    </View>
  );
}

/** A number you nudge, for the two simulator values that are not a short list of choices. */
function Stepper({ value, min, max, onChange, testID }: { value: number; min: number; max: number; onChange(v: number): void; testID?: string }) {
  const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v)));
  return (
    <View style={styles.stepper} testID={testID}>
      <StepButton label="−" onPress={() => onChange(clamp(value - 1))} disabled={value <= min} />
      <AppText variant="telemetry" numeric style={styles.stepValue}>
        {value}
      </AppText>
      <StepButton label="+" onPress={() => onChange(clamp(value + 1))} disabled={value >= max} />
    </View>
  );
}

function StepButton({ label, onPress, disabled }: { label: string; onPress(): void; disabled: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label === '+' ? 'Increase' : 'Decrease'}
      style={({ pressed }) => [styles.stepButton, disabled && styles.stepOff, pressed && styles.pressed]}>
      <AppText variant="subheading" color={disabled ? 'muted' : 'cyan'} style={styles.stepButtonLabel}>
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
  section: { marginBottom: space[3], gap: space[2] },
  sectionBody: { gap: space[4], marginTop: space[1] },
  field: { gap: space[2] },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  stepButton: {
    width: 44,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg2,
    borderRadius: 8,
  },
  stepButtonLabel: { fontSize: 20, lineHeight: 22 },
  stepOff: { opacity: 0.35 },
  stepValue: { minWidth: 56, textAlign: 'center', fontSize: 26, lineHeight: 28 },
  link: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space[4],
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg2,
    borderRadius: 8,
  },
  linkLabel: { fontSize: 16, lineHeight: 19 },
  wipe: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space[5],
    borderWidth: 1,
    borderColor: colors.red,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 59, 59, 0.12)',
  },
  wipeOff: { opacity: 0.35 },
  wipeLabel: { fontSize: 16, lineHeight: 19 },
  about: { marginTop: space[4], gap: space[2], borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space[4] },
  pressed: { opacity: 0.7 },
});
