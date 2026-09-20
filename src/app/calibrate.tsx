/**
 * Calibrate — phone in hand to "this app can measure my car", without a word of physics.
 *
 * The calibrator needs no gesture: it takes the vertical out of gravity by itself and the
 * forward axis out of the car accelerating. So this screen is guidance, not ceremony — it
 * starts listening the moment it opens, shows how the phone is really hanging (the dial is
 * drawn from the live gravity vector), what the engine has and has not worked out yet, and one
 * honest confidence number against the bar the judge actually uses.
 *
 * Two rules it keeps:
 *   • a loose mount is described in `IntegrityMonitor`'s own words, never in new copy for the
 *     same condition;
 *   • leaving is allowed. The calibration finishes while you drive — that is what the engine
 *     supports, so the screen says so instead of trapping anyone here.
 *
 * URL (web / the harness): `?at=<s>` warps the simulated recording, `?hold=1` freezes it there,
 * `?mount=flat-console` regenerates it with the phone sitting somewhere else, and the usual
 * `?sim=/rate=/seed=/laps=/looseness=/dropouts=` pick the recording. See tools/harness/README.md.
 */
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, Button, colors, gutter, Micro, Small, space, TopBar } from '@/ui';
import {
  attitudeWords,
  Banner,
  Cautions,
  cautionsOf,
  EngineStrip,
  headlineOf,
  Lights,
  lightsOf,
  phaseOf,
  qualityBand,
  SHARP_QUALITY,
  Steps,
  stepsOf,
  TRUST_QUALITY,
  useCalibration,
  type CalibrationReading,
} from '@/ui/calibrate';
import MountDialView from '@/ui/calibrate/MountDialView';
import { Tag } from '@/ui/results';

export default function CalibrateScreen() {
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const { reading, retry } = useCalibration();

  const landscape = width > height;
  const phase = phaseOf(reading);
  const head = headlineOf(reading);
  const band = qualityBand(reading);
  const lights = useMemo(() => lightsOf(reading), [reading]);
  const steps = useMemo(() => stepsOf(reading), [reading]);
  const cautions = useMemo(() => cautionsOf(reading), [reading]);
  const dialSize = landscape ? Math.min(height - 140, 252) : Math.min(width - gutter * 2, 300);

  const drive = () => router.replace('/drive');

  if (phase === 'failed' && reading.fault) {
    return (
      <View style={styles.root} testID="screen-calibrate">
        <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
          <View style={styles.padded}>
            <TopBar kicker="Mount calibration" title="Calibrate" />
            <Banner title={reading.fault.title} body={reading.fault.body} tone="red" testID="calibrate-fault" />
            <View style={styles.faultActions}>
              {reading.fault.retryable ? <Button label="Try again" size="lg" onPress={retry} testID="cta-retry" /> : null}
              <Button label="Open settings" variant="secondary" onPress={() => router.push('/settings')} testID="cta-settings" />
              <Button label="Back to the garage" variant="ghost" onPress={() => router.replace('/')} />
            </View>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  const dial = (
    <View style={styles.dialWrap}>
      <MountDialView
        size={dialSize}
        rollDeg={reading.rollDeg}
        reclineDeg={reading.reclineDeg}
        quality={reading.quality}
        threshold={TRUST_QUALITY}
        sharp={SHARP_QUALITY}
        settled={lights[0].state === 'on'}
        resolved={reading.forwardResolved}
        loose={reading.mount === 'loose'}
        ready={phase === 'ready'}
        idle={reading.samples === 0}
        testID="mount-dial"
      />
      <View style={styles.readout} pointerEvents="none">
        <AppText variant="hero" color={band.color} numeric numberOfLines={1} style={[styles.percent, { fontSize: dialSize * 0.3, lineHeight: dialSize * 0.29 }]}>
          {band.display}
        </AppText>
        <Micro color={band.color === 'red' ? 'red' : 'muted'}>Confidence</Micro>
      </View>
    </View>
  );

  const verdict = (
    <View style={styles.verdict}>
      <Micro color={head.color}>{head.kicker}</Micro>
      <AppText variant="title" color={head.color} numberOfLines={2} style={styles.title} accessibilityRole="header">
        {head.title}
      </AppText>
      <Small numberOfLines={3} style={styles.because}>
        {head.because}
      </Small>
      <View style={styles.attitudeRow}>
        <Tag label={attitudeWords(reading)} color={colors.cyan} />
        <Micro numberOfLines={1}>{band.label}</Micro>
      </View>
    </View>
  );

  return (
    <View style={styles.root} testID="screen-calibrate">
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} testID="calibrate-scroll">
          <TopBar
            kicker="Mount calibration"
            title="Calibrate"
            right={<Tag label={reading.sourceLabel ?? 'STARTING'} color={reading.sourceKind === 'device' ? colors.green : colors.cyan} filled />}
          />

          <View style={landscape ? styles.heroRow : styles.heroCol}>
            {dial}
            <View style={landscape ? styles.heroSide : undefined}>{verdict}</View>
          </View>

          {phase === 'blocked' ? <Banner title="The phone is moving" body={reading.message} tone="red" testID="calibrate-loose" /> : null}
          <Cautions cautions={cautions} />

          <Lights lights={lights} style={styles.lights} />
          <Steps steps={steps} style={styles.steps} />

          <View style={styles.actions}>
            {phase === 'ready' ? (
              <Button label="Done — drive" size="lg" onPress={drive} testID="cta-drive" />
            ) : (
              <Button label="Finish it while driving" size="lg" variant="secondary" onPress={drive} testID="cta-drive" />
            )}
            <Small numberOfLines={2} style={styles.leaveNote}>
              {phase === 'ready'
                ? 'The calibration keeps sharpening during the run — nothing here is final.'
                : 'You do not have to sit here. The run calibrates itself on the way to the first corner; the judge holds back its score until it has.'}
            </Small>
          </View>

          <EngineStrip rows={engineRows(reading)} testID="calibrate-engine" />
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

/** The engine's own working, for anyone who wants to check it. */
function engineRows(r: CalibrationReading): Array<[string, string]> {
  return [
    ['Up axis', r.samples ? `${Math.round(r.upQuality * 100)}%` : '--'],
    ['Straight-line', `${r.lineEvidenceS.toFixed(1)} s`],
    ['Axis fit', `${Math.round(r.lineAnisotropy * 100)}%`],
    ['Fore/aft', r.forwardResolved ? `${r.signScore > 0 ? '+' : ''}${r.signScore.toFixed(2)}` : 'unset'],
    ['Sway', `${Math.round(r.looseScore * 100)}%`],
    ['GPS', r.gps],
    ['Speed', `${Math.round(r.speedKmh)} km/h`],
    ['Samples', String(r.samples)],
  ];
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  safe: { flex: 1 },
  flex: { flex: 1 },
  padded: { paddingHorizontal: gutter, gap: space[4] },
  scroll: { paddingHorizontal: gutter, paddingBottom: space[12], gap: space[4] },

  heroCol: { alignItems: 'center', gap: space[4] },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: space[6] },
  heroSide: { flex: 1, minWidth: 0 },

  dialWrap: { alignItems: 'center', justifyContent: 'center' },
  readout: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  percent: { letterSpacing: -3, includeFontPadding: false },

  verdict: { gap: space[1], alignSelf: 'stretch' },
  title: { fontSize: 38, lineHeight: 38 },
  because: { maxWidth: 420 },
  attitudeRow: { flexDirection: 'row', alignItems: 'center', gap: space[3], flexWrap: 'wrap', marginTop: space[2] },

  lights: { marginTop: space[1] },
  steps: {},
  actions: { gap: space[2] },
  leaveNote: { maxWidth: 420 },
  faultActions: { gap: space[3], marginTop: space[4] },
});
