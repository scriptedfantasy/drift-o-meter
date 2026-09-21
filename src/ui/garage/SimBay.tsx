/**
 * The simulated source, made selectable — and made obvious.
 *
 * A browser has no gyroscope, so on web every run is a simulation. That is not a detail to bury
 * in a settings screen: the bay says outright that there is no car, then lets a demo choose the
 * road, the playback speed and — the two that matter for showing the app catching a bad mount —
 * how badly the phone moves in its cradle (`looseness`) and whether GPS drops out (`dropouts`).
 *
 * Those two are not app settings and are not stored: they are properties of a recording, so
 * they travel as query parameters on the DRIVE / CALIBRATE link (`simParamsToQuery`), exactly
 * the way the harness passes them.
 */
import { StyleSheet, View } from 'react-native';

import { simParamsToQuery, type SimParams } from '../../platform';
import { listTracks } from '../../sim';
import { Segmented, type SegmentOption } from '../Segmented';
import { AppText, Micro, Small } from '../Text';
import { alpha, colors, radii, space } from '../theme';

// The simulator's own names, so the bay, the settings screen and the HUD all call a road the
// same thing.
const TRACKS: SegmentOption<SimParams['track']>[] = listTracks().map((t) => ({ value: t.id, label: t.name }));

const RATES: SegmentOption<number>[] = [
  { value: 0.5, label: '0.5×' },
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
];

/** The three mounts the simulator actually models, in a driver's words. */
export const MOUNT_LEVELS: { value: number; label: string; blurb: string }[] = [
  { value: 0, label: 'Bolted down', blurb: 'A rigid cradle. The phone only moves when the car does.' },
  { value: 0.25, label: 'Rattling', blurb: 'A cheap cradle with play in it — the monitor should get suspicious.' },
  { value: 1, label: 'In your hand', blurb: 'Not mounted at all. The engine should refuse to score the run.' },
];

const GPS: SegmentOption<string>[] = [
  { value: 'clean', label: 'Clean GPS' },
  { value: 'gaps', label: 'Dropouts' },
];

export interface SimBayProps {
  params: SimParams;
  onChange(next: SimParams): void;
  testID?: string;
}

function mountLevel(looseness: number): number {
  let best = MOUNT_LEVELS[0];
  for (const m of MOUNT_LEVELS) if (Math.abs(m.value - looseness) < Math.abs(best.value - looseness)) best = m;
  return best.value;
}

export function SimBay({ params, onChange, testID }: SimBayProps) {
  const level = mountLevel(params.looseness);
  const mount = MOUNT_LEVELS.find((m) => m.value === level) ?? MOUNT_LEVELS[0];
  const warn = level > 0 || params.gpsDropouts;

  return (
    <View style={[styles.bay, warn && styles.bayWarn]} testID={testID}>
      <View style={styles.head}>
        <AppText variant="subheading" color="blue">
          Simulated drive
        </AppText>
        <Micro color="blue">No car involved</Micro>
      </View>
      <Small style={styles.blurb}>
        This browser has no motion sensors, so nothing here is measured — a recorded drive is replayed through the real
        engine. The angles are real; the driving is not.
      </Small>

      <Field label="Road">
        <Segmented options={TRACKS} value={params.track} onChange={(track) => onChange({ ...params, track })} color={colors.blue} testID="sim-track" />
      </Field>
      <Field label="Playback">
        <Segmented options={RATES} value={params.rate} onChange={(rate) => onChange({ ...params, rate })} color={colors.blue} testID="sim-rate" />
      </Field>
      <Field label="Phone mount" hint={mount.blurb}>
        <Segmented
          options={MOUNT_LEVELS.map((m) => ({ value: m.value, label: m.label }))}
          value={level}
          onChange={(looseness) => onChange({ ...params, looseness })}
          color={level > 0 ? colors.red : colors.green}
          testID="sim-mount"
        />
      </Field>
      <Field label="GPS">
        <Segmented
          options={GPS}
          value={params.gpsDropouts ? 'gaps' : 'clean'}
          onChange={(v) => onChange({ ...params, gpsDropouts: v === 'gaps' })}
          color={params.gpsDropouts ? colors.greenHot : colors.green}
          testID="sim-gps"
        />
      </Field>

      <View style={styles.query}>
        <Micro numberOfLines={1} style={styles.queryText}>
          ?{simParamsToQuery(params)}
        </Micro>
      </View>
    </View>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Micro>{label}</Micro>
      {children}
      {hint ? (
        <Micro numberOfLines={2} style={styles.hint}>
          {hint}
        </Micro>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bay: {
    backgroundColor: colors.bg1,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: alpha(colors.blue, 0.4),
    padding: space[4],
    gap: space[3],
  },
  bayWarn: { borderColor: alpha(colors.greenHot, 0.4) },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space[2] },
  blurb: { maxWidth: 420 },
  field: { gap: space[2] },
  hint: { textTransform: 'none', letterSpacing: 0.2 },
  query: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space[2] },
  queryText: { textTransform: 'none', letterSpacing: 0.4, opacity: 0.7 },
});
