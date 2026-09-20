import Constants from 'expo-constants';
import { useState } from 'react';
import { Alert, Platform, StyleSheet, View } from 'react-native';

import { clearSessions, useSessionIndex, useSettings } from '@/platform';
import { listTracks } from '@/sim';
import { AppText, Body, Button, colors, Divider, Label, Micro, Panel, Screen, Segmented, type SegmentOption, Small, space, TopBar } from '@/ui';

const TRACK_OPTIONS = listTracks().map((t) => ({ value: t.id, label: t.name }));
const RATE_OPTIONS: SegmentOption<number>[] = [
  { value: 0.5, label: '0.5×' },
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
];

export default function SettingsScreen() {
  const { settings, update, loaded } = useSettings();
  const sessions = useSessionIndex();
  const [busy, setBusy] = useState(false);
  const isWeb = Platform.OS === 'web';

  const wipe = async () => {
    setBusy(true);
    try {
      await clearSessions();
      await sessions.refresh();
    } finally {
      setBusy(false);
    }
  };

  const confirmWipe = () => {
    if (sessions.entries.length === 0) return;
    if (isWeb) {
      void wipe();
      return;
    }
    Alert.alert('Delete all sessions?', 'This removes every stored run and replay. There is no undo.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void wipe() },
    ]);
  };

  return (
    <Screen scroll testID="screen-settings">
      <TopBar kicker="Preferences" title="Settings" />

      <Section title="Sensor source" hint={isWeb ? 'Web has no motion sensors; the simulator is always used here.' : 'Use the simulator to try the judge without driving.'}>
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

      <Section title="Simulator">
        <Label>Track</Label>
        <Segmented options={TRACK_OPTIONS} value={settings.simTrack} onChange={(v) => void update({ simTrack: v })} color={colors.cyan} testID="setting-track" />
        <Label style={styles.gap}>Playback speed</Label>
        <Segmented options={RATE_OPTIONS} value={settings.simRate} onChange={(v) => void update({ simRate: v })} color={colors.cyan} testID="setting-rate" />
      </Section>

      <Section title="Display">
        <Label>Speed units</Label>
        <Segmented
          options={[
            { value: 'kmh', label: 'km/h' },
            { value: 'mph', label: 'mph' },
          ]}
          value={settings.units}
          onChange={(v) => void update({ units: v })}
          testID="setting-units"
        />
      </Section>

      <Section title="Feedback">
        <Label>Haptics</Label>
        <Segmented
          options={[
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
          value={settings.haptics ? 'on' : 'off'}
          onChange={(v) => void update({ haptics: v === 'on' })}
          color={colors.magenta}
        />
        <Label style={styles.gap}>Sound</Label>
        <Segmented
          options={[
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
          value={settings.sound ? 'on' : 'off'}
          onChange={(v) => void update({ sound: v === 'on' })}
          color={colors.magenta}
        />
      </Section>

      <Section title="Data">
        <Body color="muted">{sessions.entries.length === 1 ? '1 stored session.' : `${sessions.entries.length} stored sessions.`}</Body>
        <Button label="Delete all sessions" variant="danger" size="sm" disabled={busy || sessions.entries.length === 0} onPress={confirmWipe} style={styles.gap} testID="setting-wipe" />
      </Section>

      <Divider style={styles.about} />
      <Micro>
        Drift-O-Meter {Constants.expoConfig?.version ?? '1.0.0'} · Expo SDK {Constants.expoConfig?.sdkVersion ?? '57'} · {loaded ? 'settings synced' : 'loading settings'}
      </Micro>
    </Screen>
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

const styles = StyleSheet.create({
  section: { marginBottom: space[3], gap: space[2] },
  sectionBody: { gap: space[2], marginTop: space[1] },
  gap: { marginTop: space[3] },
  about: { marginTop: space[4], marginBottom: space[3] },
});
