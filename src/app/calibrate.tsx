/**
 * Calibrate — the screen you land on when something is wrong with the mount.
 *
 * Calibration is not a step in this app (docs/DESIGN.md, "the whole app is four steps"): the
 * calibrator takes the vertical out of gravity by itself and the forward axis out of the car
 * accelerating, while driving. So nothing sends a driver here unless the last run left evidence,
 * or they went looking. That decides the layout: what is wrong and what to do about it are
 * above the fold, and the instrument is beside them rather than instead of them.
 *
 * Three rules it keeps:
 *   • nothing is claimed before there is evidence for it — see `phaseOf`;
 *   • a loose mount is `IntegrityMonitor`'s own sentence, said once, under the biggest words on
 *     the screen, which name the condition the HUD's own heading names;
 *   • leaving is allowed. The calibration finishes while you drive, so the screen says so
 *     instead of trapping anyone here.
 *
 * URL (web / the harness): `?at=<s>` warps the simulated recording, `?hold=1` freezes it there,
 * `?mount=flat-console` regenerates it with the phone sitting somewhere else, `?why=` says what
 * sent the driver here, `?fault=` shows one of the four faults, and the usual
 * `?sim=/rate=/seed=/laps=/looseness=/dropouts=` pick the recording. See tools/harness/README.md.
 */
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, Button, colors, gutter, Micro, Small, space, TopBar } from '@/ui';
import {
  arrivalOf,
  attitudeWords,
  Banner,
  Cautions,
  cautionsOf,
  EngineStrip,
  headlineOf,
  isFlat,
  Lights,
  lightsOf,
  mountVerdict,
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
  const { reading, params, retry } = useCalibration();

  const landscape = width > height;
  const phase = phaseOf(reading);
  const head = headlineOf(reading);
  const band = qualityBand(reading);
  const lights = useMemo(() => lightsOf(reading), [reading]);
  const steps = useMemo(() => stepsOf(reading), [reading]);
  const cautions = useMemo(() => cautionsOf(reading), [reading]);
  const flat = isFlat(reading);
  const arrival = arrivalOf(params.why);
  // The instrument sits BESIDE the readout, not above it: what to do has to be on screen
  // without scrolling, in both orientations, and a 264 pt dial ate that room.
  const dialSize = landscape ? 156 : Math.min(Math.round(width * 0.46), 184);

  const drive = () => router.replace('/drive');

  // No source pill while the sensors are refusing to start: "STARTING" over a fault is a lie.
  const source =
    phase === 'failed' ? null : <Tag label={reading.sourceLabel ?? 'STARTING'} color={reading.sourceKind === 'device' ? colors.green : colors.cyan} filled />;

  // ---- the fault states: the whole reason this screen exists ------------------------------
  if (phase === 'failed' && reading.fault) {
    return (
      <View style={styles.root} testID="screen-calibrate">
        <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
          <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            <TopBar kicker="Mount calibration" right={source} />
            <View style={styles.fault} testID="calibrate-fault">
              <Micro color="red">Cannot calibrate</Micro>
              <AppText variant="title" color="red" style={styles.title} accessibilityRole="header">
                {reading.fault.title}
              </AppText>
              <Small color={colors.text} style={styles.faultBody}>
                {reading.fault.body}
              </Small>
            </View>
            <View style={styles.faultActions}>
              {reading.fault.retryable ? <Button label="Try again" size="lg" onPress={retry} testID="cta-retry" /> : null}
              <Button label="Open settings" variant="secondary" onPress={() => router.push('/settings')} testID="cta-settings" />
              <Button label="Back to the garage" variant="ghost" onPress={() => router.replace('/')} testID="cta-garage" />
            </View>
            <Small style={styles.faultNote}>
              None of this stops you driving. The run records either way — the judge simply holds back a score it cannot
              stand behind.
            </Small>
          </ScrollView>
        </SafeAreaView>
      </View>
    );
  }

  const instrument = (
    <View style={styles.instrument}>
      <MountDialView
        size={dialSize}
        // lying flat, the in-plane direction of gravity is noise: hold the glyph level instead
        // of spinning it, because a flat phone genuinely has no readable roll
        rollDeg={flat ? 0 : reading.rollDeg}
        reclineDeg={reading.reclineDeg}
        quality={reading.quality}
        threshold={TRUST_QUALITY}
        sharp={SHARP_QUALITY}
        tone={band.color}
        settled={lights[0].state === 'on'}
        resolved={reading.forwardResolved}
        loose={mountVerdict(reading) === 'loose'}
        ready={phase === 'ready'}
        idle={reading.samples === 0}
        testID="mount-dial"
      />
      {/* The one honest number, and what it has to clear. Beside the glyph, never over it. */}
      <View style={styles.readout}>
        <AppText variant="hero" color={band.color} numeric style={styles.percent} testID="confidence">
          {band.display}
        </AppText>
        <Micro color={band.color === 'red' ? 'red' : 'muted'}>Confidence in this mount</Micro>
        <Micro style={styles.legend} numberOfLines={2}>
          {Math.round(TRUST_QUALITY * 100)}% the judge&apos;s bar · {Math.round(SHARP_QUALITY * 100)}% no caveats
        </Micro>
        <Tag label={attitudeWords(reading)} color={colors.cyan} style={styles.attitude} />
      </View>
    </View>
  );

  const verdict = (
    <View style={styles.verdict}>
      <Micro color={head.color}>{head.kicker}</Micro>
      <AppText variant="title" color={head.color} numberOfLines={2} style={styles.title} accessibilityRole="header">
        {head.title}
      </AppText>
      {head.because ? (
        <Small color={phase === 'blocked' ? colors.text : colors.muted} numberOfLines={3} style={styles.because} testID="calibrate-because">
          {head.because}
        </Small>
      ) : null}
      {phase === 'blocked' ? null : (
        <Micro numberOfLines={2} style={styles.bandLabel}>
          {band.label}
        </Micro>
      )}
    </View>
  );

  const actions = (
    <View style={styles.actions}>
      {phase === 'ready' ? (
        <Button label="Done — drive" size={landscape ? 'md' : 'lg'} onPress={drive} testID="cta-drive" />
      ) : (
        // `md`, not `lg`: at 30 pt the sentence truncates to "FINISH IT WHILE DRIVI…", and this
        // is the secondary action anyway — the driver has not finished what they came to do.
        <Button label="Finish it while driving" size="md" variant="secondary" onPress={drive} testID="cta-drive" />
      )}
      <Small numberOfLines={3} style={styles.leaveNote}>
        {phase === 'ready'
          ? 'The calibration keeps sharpening during the run — nothing here is final.'
          : 'You do not have to sit here. The run calibrates itself on the way to the first corner; the judge holds back its score until it has.'}
      </Small>
    </View>
  );

  return (
    <View style={styles.root} testID="screen-calibrate">
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} testID="calibrate-scroll">
          {/* No 44 pt slab in either orientation: the kicker names the screen, and the room it
              saves is room for the instructions. */}
          <TopBar kicker="Mount calibration" right={source} />

          {arrival ? <Banner title={arrival.title} body={arrival.body} tone={arrival.tone} testID="calibrate-arrival" /> : null}

          {landscape ? (
            <View style={styles.row}>
              <View style={styles.left}>
                {instrument}
                {actions}
              </View>
              <View style={styles.right}>
                {verdict}
                <Cautions cautions={cautions} />
                <Steps steps={steps} compact />
                <Lights lights={lights} compact />
              </View>
            </View>
          ) : (
            <>
              {instrument}
              {verdict}
              <Cautions cautions={cautions} />
              <Steps steps={steps} />
              <Lights lights={lights} />
              {actions}
            </>
          )}

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
  scroll: { paddingHorizontal: gutter, paddingBottom: space[10], gap: space[4], width: '100%', maxWidth: 820, alignSelf: 'center' },

  row: { flexDirection: 'row', gap: space[5], alignItems: 'flex-start' },
  left: { gap: space[3] },
  right: { flex: 1, minWidth: 0, gap: space[3] },

  instrument: { flexDirection: 'row', alignItems: 'center', gap: space[4] },
  readout: { flex: 1, minWidth: 0, gap: 0 },
  percent: { fontSize: 56, lineHeight: 54, letterSpacing: -3, includeFontPadding: false },
  legend: { marginTop: space[2], opacity: 0.75, textTransform: 'none', letterSpacing: 0.3 },
  attitude: { marginTop: space[2] },

  verdict: { gap: space[1], alignSelf: 'stretch' },
  title: { fontSize: 34, lineHeight: 35 },
  because: { maxWidth: 460 },
  bandLabel: { marginTop: space[1] },

  actions: { gap: space[2] },
  leaveNote: { maxWidth: 420 },

  fault: { gap: space[1], marginTop: space[2] },
  faultBody: { maxWidth: 460 },
  faultActions: { gap: space[3], marginTop: space[2] },
  faultNote: { maxWidth: 460, marginTop: space[2] },
});
