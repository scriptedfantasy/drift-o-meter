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
  const dialSize = landscape ? Math.min(height - 168, 214) : Math.min(width - gutter * 2, 264);

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
    </View>
  );

  /* The one honest number, and what it has to clear. Never over the glyph — the glyph is the
     other half of the answer — so it sits under the dial in portrait and beside it in
     landscape, where there is no room underneath. */
  const readout = (
    <View style={[styles.readout, landscape && styles.readoutSide]}>
      <AppText variant="hero" color={band.color} numeric style={[styles.percent, landscape && styles.percentSide]} testID="confidence">
        {band.display}
      </AppText>
      <Micro color={band.color === 'red' ? 'red' : 'muted'}>Confidence in this mount</Micro>
      <Micro style={styles.legend} numberOfLines={1}>
        {Math.round(TRUST_QUALITY * 100)}% the judge&apos;s bar · {Math.round(SHARP_QUALITY * 100)}% no caveats
      </Micro>
    </View>
  );

  const verdict = (
    <View style={styles.verdict}>
      <Micro color={head.color}>{head.kicker}</Micro>
      <AppText variant="title" color={head.color} numberOfLines={2} style={styles.title} accessibilityRole="header">
        {head.title}
      </AppText>
      {head.because ? (
        <Small numberOfLines={3} style={styles.because}>
          {head.because}
        </Small>
      ) : null}
      <View style={styles.attitudeRow}>
        <Tag label={attitudeWords(reading)} color={colors.cyan} />
        {/* the band label would only repeat the banner while the mount is moving */}
        {phase === 'blocked' ? null : <Micro numberOfLines={2} style={styles.bandLabel}>{band.label}</Micro>}
      </View>
    </View>
  );

  return (
    <View style={styles.root} testID="screen-calibrate">
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} testID="calibrate-scroll">
          {/* Landscape is 393 px tall: the 44 pt title would push the dial — the whole point of
              the screen — below the fold, so it keeps the kicker and drops the slab. */}
          <TopBar
            kicker="Mount calibration"
            title={landscape ? undefined : 'Calibrate'}
            right={<Tag label={reading.sourceLabel ?? 'STARTING'} color={reading.sourceKind === 'device' ? colors.green : colors.cyan} filled />}
          />

          {arrival ? <Banner title={arrival.title} body={arrival.body} tone={arrival.tone} testID="calibrate-arrival" /> : null}

          <View style={landscape ? styles.heroRow : styles.heroCol}>
            <View style={styles.dialCol}>
              {dial}
              {landscape ? null : readout}
            </View>
            <View style={landscape ? styles.heroSide : styles.heroFull}>
              {landscape ? readout : null}
              {verdict}
            </View>
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
  scroll: { paddingHorizontal: gutter, paddingBottom: space[12], gap: space[4], width: '100%', maxWidth: 820, alignSelf: 'center' },

  heroCol: { alignItems: 'center', gap: space[4] },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: space[6] },
  heroSide: { flex: 1, minWidth: 0, gap: space[4] },
  heroFull: { alignSelf: 'stretch' },
  dialCol: { alignItems: 'center' },

  dialWrap: { alignItems: 'center', justifyContent: 'center' },
  readout: { alignItems: 'center', gap: 0, marginTop: -space[2] },
  readoutSide: { alignItems: 'flex-start', marginTop: 0 },
  percent: { fontSize: 64, lineHeight: 62, letterSpacing: -3, includeFontPadding: false },
  percentSide: { fontSize: 52, lineHeight: 50 },
  legend: { marginTop: space[2], opacity: 0.75 },

  verdict: { gap: space[1], alignSelf: 'stretch' },
  title: { fontSize: 38, lineHeight: 38 },
  because: { maxWidth: 420 },
  attitudeRow: { flexDirection: 'row', alignItems: 'center', gap: space[3], flexWrap: 'wrap', marginTop: space[2] },
  bandLabel: { flexShrink: 1 },

  lights: { marginTop: space[1] },
  steps: {},
  actions: { gap: space[2] },
  leaveNote: { maxWidth: 420 },
  faultActions: { gap: space[3], marginTop: space[4] },
});
