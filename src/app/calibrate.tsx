/**
 * Calibrate — the screen you land on when something is wrong with the mount.
 *
 * Calibration is not a step in this app (docs/DESIGN.md, "the whole app is four steps"): the
 * calibrator takes the vertical out of gravity by itself and the forward axis out of the car
 * accelerating, while driving. So nothing sends a driver here unless the last run left evidence,
 * or they went looking. That decides the layout: what is wrong and what to do about it are
 * above the fold, and the instrument is beside them rather than instead of them.
 *
 * Four rules it keeps:
 *   • nothing is claimed before there is evidence for it — see `phaseOf`;
 *   • a loose or shaking mount is `IntegrityMonitor`'s own sentence, said once, under the
 *     biggest words on the screen, which name the condition the HUD's own heading names;
 *   • every word about leaving is a measured claim about what leaving costs — `leaveOf`;
 *   • the words live in `model.ts`, not here. This file decides where they sit and how loud
 *     they are, and renders the strings that a test can read.
 *
 * URL (web / the harness): `?at=<s>` warps the simulated recording, `?hold=1` freezes it there,
 * `?mount=flat-console` regenerates it with the phone sitting somewhere else, `?why=` says what
 * sent the driver here, `?fault=` shows one of the five faults, and the usual
 * `?sim=/rate=/seed=/laps=/looseness=/dropouts=` pick the recording. See tools/harness/README.md.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { openSettings } from 'expo-linking';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { alpha, AppText, Button, colors, glow, gutter, Micro, Small, space, TopBar } from '@/ui';
import {
  arrivalOf,
  attitudeWords,
  Banner,
  Cautions,
  cautionsOf,
  EngineStrip,
  headlineOf,
  isFlat,
  leaveOf,
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
  const leave = leaveOf(reading);
  const lights = useMemo(() => lightsOf(reading), [reading]);
  const steps = useMemo(() => stepsOf(reading), [reading]);
  const cautions = useMemo(() => cautionsOf(reading), [reading]);
  const flat = isFlat(reading);
  const arrival = arrivalOf(params.why);
  // The instrument sits BESIDE the readout, not above it: what to do has to be on screen
  // without scrolling, in both orientations, and a 264 pt dial ate that room. It shrank again
  // when the arrival banner (the normal way in) pushed the call to action off the bottom.
  const dialSize = landscape ? 112 : Math.min(Math.round(width * 0.31), 132);

  const drive = () => router.replace('/drive');

  // No source pill while the sensors are refusing to start: "STARTING" over a fault is a lie.
  const source =
    phase === 'failed' ? null : <Tag label={reading.sourceLabel ?? 'STARTING'} color={reading.sourceKind === 'device' ? colors.green : colors.blue} filled />;

  // ---- the fault states: the whole reason this screen exists ------------------------------
  if (phase === 'failed' && reading.fault) {
    const fault = reading.fault;
    // OPEN SETTINGS meant two different places. The body names one of them, so the button says
    // which one it is and goes there: the phone's own Settings for a permission or a service,
    // this app's settings for "there is nothing here to calibrate, use the simulator".
    const openAction =
      fault.destination === 'phone-settings'
        ? () => {
            // web (the harness) has no Settings app; expo-linking rejects rather than no-ops.
            openSettings().catch((err: unknown) => console.warn('[calibrate] openSettings', err));
          }
        : () => router.push('/settings');
    return (
      <View style={styles.root} testID="screen-calibrate">
        <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
          {/* BOTTOM-WEIGHTED, not centred. Centring put a void above the statement AND another
              between it and the buttons — a third of the frame on `unsupported`, which has the
              least to say and no Try again. A fault has one statement and one action, so they
              sit together in the lower half and the space above them is a single band of
              asphalt with the red wash rising through it, which is composition rather than
              what is left over. With no room — 393 pt of landscape — it scrolls instead of
              laying the body underneath the buttons. */}
          <ScrollView style={styles.flex} contentContainerStyle={[styles.faultPage, landscape && styles.faultPageLandscape]} showsVerticalScrollIndicator={false}>
            <TopBar kicker="Mount calibration" right={source} />
            {/* Landscape is a ROW, the same rail-and-column this screen uses everywhere else.
                Stacked, a fault ran to 515 px of a 393 px frame and both buttons sat under the
                fold; side by side the whole thing ends at ~350 px and nothing scrolls. */}
            <View style={landscape ? styles.faultRow : styles.flexNone}>
              <View style={[styles.faultCentre, landscape && styles.faultCentreLandscape]}>
                {/* Atmosphere, not an object: a solid box with a box-shadow drew a lit pill
                    behind the title. A wash that is transparent at both ends has no edge. */}
                <LinearGradient
                  colors={['transparent', alpha(colors.red, 0.2), 'transparent']}
                  locations={[0, 0.55, 1]}
                  start={{ x: 0.5, y: 0 }}
                  end={{ x: 0.5, y: 1 }}
                  // Two things change in landscape. The wash is shorter, because 393 pt is shorter
                  // than a 460 pt bloom and the page corners stay asphalt (docs/DESIGN.md). And it
                  // reaches past the action rail on its right, because a gradient that fades only
                  // vertically meets its own left and right edges at full strength — clipped to
                  // this column it drew a vertical seam down the middle of the page.
                  style={[styles.bloom, landscape && styles.bloomLandscape]}
                  pointerEvents="none"
                />
                <View style={styles.kickerRow}>
                  <View style={[styles.slab, { backgroundColor: colors.red }]} />
                  <Micro color="red">Cannot calibrate</Micro>
                </View>
                <AppText variant="title" color="red" style={styles.faultTitle} accessibilityRole="header">
                  {fault.title}
                </AppText>
                {/* `body`, not `small`: on every other screen a paragraph is a caption under a
                    number, and here it is the only thing the page has to say. */}
                <AppText variant="body" color={colors.text} style={styles.faultBody}>
                  {fault.body}
                </AppText>
              </View>
              {/* The consequence, the rule and the buttons are ONE group at the foot.
                  They used to be three: the body and its consequence sat in a centred block and
                  the buttons were pinned to the bottom, so a fault with nothing else to say left
                  a third of the frame empty between them — worst on `unsupported`, which has no
                  Try again. Composed, the flexible space is breathing room around a centred
                  statement with a footer under it, which is what the rest of the app does. */}
              <View style={[styles.faultFoot, landscape && styles.faultFootLandscape]}>
                <View style={styles.rule} />
                {/* The old note said "none of this stops you driving — the run records either
                    way". It does not: /drive opens the same sensors and stops on the same error.
                    A reassurance that is false is worse than no reassurance. */}
                <Small style={styles.faultBody} testID="calibrate-fault-consequence">
                  {fault.kind === 'unsupported'
                    ? 'Driving will stop here too — it opens these same sensors. The simulated source runs a full recording through the real judge in the meantime.'
                    : 'Driving will stop here too: DRIVE opens these same sensors and ends on this same message. Nothing is recorded until it is fixed.'}
                </Small>
                <View style={styles.faultActions}>
                  {/* One action gets the slab. On a retryable fault that is Try again; on
                      `unsupported`, where retrying cannot work, it is the one thing that can. */}
                  {fault.retryable ? <Button label="Try again" size="lg" onPress={retry} testID="cta-retry" /> : null}
                  <Button
                    label={fault.actionLabel}
                    size={fault.retryable ? 'md' : 'lg'}
                    variant={fault.retryable ? 'secondary' : 'primary'}
                    onPress={openAction}
                    testID="cta-settings"
                  />
                  <Button label="Back to the garage" variant="ghost" onPress={() => router.replace('/')} testID="cta-garage" />
                </View>
              </View>
            </View>
          </ScrollView>
        </SafeAreaView>
      </View>
    );
  }

  const instrument = (
    <View style={styles.instrument}>
      <View>
        {/* the dial earns the only bloom on the screen: it is the live instrument */}
        <View style={[styles.dialBloom, { backgroundColor: alpha(colors[band.color], reading.samples === 0 ? 0.04 : 0.1) }, glow(colors[band.color], 1.1)]} pointerEvents="none" />
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
      {/* The one honest number, and what it has to clear. Beside the glyph, never over it. */}
      <View style={styles.readout}>
        {/* `--` is the absence of a number, not a number: muted and smaller, so it reads as
            nothing-to-report rather than as a bright cyan bar where a figure should be. */}
        <AppText
          variant="hero"
          color={band.display === '--' ? colors.muted : colors[band.color]}
          numeric
          style={[styles.percent, band.display === '--' && styles.percentEmpty]}
          testID="confidence">
          {band.display}
        </AppText>
        <Micro color={band.color === 'red' ? 'red' : 'muted'} numberOfLines={1}>
          {/* the landscape rail is 296 pt wide and `CONFIDENCE IN THIS MOUNT` truncated in it */}
          {landscape ? 'Confidence' : 'Confidence in this mount'}
        </Micro>
        <Micro style={styles.legend} numberOfLines={1}>
          Bar {Math.round(TRUST_QUALITY * 100)}% · no caveats {Math.round(SHARP_QUALITY * 100)}%
        </Micro>
        <Tag label={attitudeWords(reading)} color={colors.blue} style={styles.attitude} />
      </View>
    </View>
  );

  const verdict = (
    <View style={styles.verdict}>
      <View style={styles.kickerRow}>
        <View style={[styles.slab, { backgroundColor: colors[head.color] }]} />
        <Micro color={head.color}>{head.kicker}</Micro>
      </View>
      <AppText variant="title" color={head.color} numberOfLines={2} style={styles.title} accessibilityRole="header">
        {head.title}
      </AppText>
      {head.because ? (
        <Small color={phase === 'blocked' || phase === 'unsteady' ? colors.text : colors.muted} numberOfLines={3} style={styles.because} testID="calibrate-because">
          {head.because}
        </Small>
      ) : null}
      {phase === 'blocked' ? null : (
        <Micro color={band.color === 'gold' ? 'gold' : 'muted'} numberOfLines={2} style={styles.bandLabel} testID="calibrate-band">
          {band.label}
        </Micro>
      )}
    </View>
  );

  const actions = (
    <View style={styles.actions}>
      <Button
        label={leave.label}
        // `md` unless this is the finished action: at 30 pt a sentence-long label truncates,
        // and the driver who has not finished should not be handed the biggest button either.
        size={leave.primary && !landscape ? 'lg' : 'md'}
        variant={leave.primary ? 'primary' : 'secondary'}
        onPress={drive}
        testID="cta-drive"
      />
      <Small numberOfLines={landscape ? 2 : 3} style={styles.leaveNote} color={phase === 'blocked' ? colors.text : colors.muted} testID="calibrate-leave-note">
        {leave.note}
      </Small>
    </View>
  );

  return (
    <View style={styles.root} testID="screen-calibrate">
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <ScrollView style={styles.flex} contentContainerStyle={[styles.scroll, landscape && styles.scrollLandscape]} showsVerticalScrollIndicator={false} testID="calibrate-scroll">
          {/* One wash of the phase's own colour behind the instrument, so the frame reads as
              the same night-street app as the HUD instead of a dark settings form. Inset from
              the edges: the page corners stay asphalt. */}
          <LinearGradient
            // transparent at BOTH ends: a wash that starts at full strength draws its own
            // rounded edge across the page and reads as a panel nobody asked for.
            colors={['transparent', alpha(colors[band.color], phase === 'blocked' ? 0.2 : 0.14), 'transparent']}
            // straight down, not diagonal: a diagonal axis leaves tint on the box's own top
            // and bottom edges, and those edges draw a line across the page.
            locations={[0, 0.45, 1]}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={[styles.wash, landscape && styles.washLandscape]}
            pointerEvents="none"
          />
          {/* No 44 pt slab in either orientation: the kicker names the screen, and the room it
              saves is room for the instructions. */}
          <TopBar kicker="Mount calibration" right={source} />

          {arrival ? <Banner title={arrival.title} body={arrival.body} tone={arrival.tone} testID="calibrate-arrival" /> : null}
          {/* In landscape a caution spans, like the arrival banner above it: the right column is
              508 px and wraps a caution body onto two or three lines, which costs more height
              than the banner saves by sitting in a column. Measured on the flat-phone frame,
              820 px puts it on one line and the whole column ends 19 px higher. */}
          {landscape ? <Cautions cautions={cautions} /> : null}

          {landscape ? (
            <View style={styles.row}>
              {/* The rail carries the instrument and the way out; the column carries what is
                  wrong and what to do. Both have to end above 393 px of height, which is what
                  pushed step 02 and all three lights off the bottom before. */}
              <View style={styles.left}>
                {instrument}
                {actions}
              </View>
              {/* THE LIGHTS COME BEFORE THE STEPS HERE. They were last, and on the arrival-banner
                  frames — the way DESIGN and the README say drivers normally reach this screen —
                  all three fell below 393 px of landscape: measured, the row sat at 401–443 px.
                  Above the steps it sits at 243–285 px and the way out still ends at 382 px.
                  Putting them in the left rail instead cleared them but pushed the leave note
                  (the measured claim about what leaving costs) off the bottom in its place. */}
              <View style={styles.right}>
                {verdict}
                <Lights lights={lights} compact />
                <Steps steps={steps} compact />
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
    ['Line', `${r.lineEvidenceS.toFixed(1)} s`],
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
  scroll: { paddingHorizontal: gutter, paddingBottom: space[6], gap: 10, width: '100%', maxWidth: 820, alignSelf: 'center' },
  scrollLandscape: { gap: space[2] },
  // Wider than the page on both sides: a gradient that fades vertically still meets its own
  // left and right edges at full strength, and those edges read as a panel nobody drew.
  wash: { position: 'absolute', left: -gutter - 24, right: -gutter - 24, top: 92, height: 300 },
  washLandscape: { top: 68, height: 210 },

  row: { flexDirection: 'row', gap: space[4], alignItems: 'flex-start' },
  left: { gap: space[2], width: 296 },
  right: { flex: 1, minWidth: 0, gap: space[2] },

  instrument: { flexDirection: 'row', alignItems: 'center', gap: space[4] },
  dialBloom: { position: 'absolute', left: '14%', right: '14%', top: '14%', bottom: '14%', borderRadius: 999 },
  readout: { flex: 1, minWidth: 0, gap: 0 },
  percent: { fontSize: 52, lineHeight: 50, letterSpacing: -2.5, includeFontPadding: false },
  percentEmpty: { fontSize: 36, lineHeight: 42, opacity: 0.6 },
  legend: { marginTop: 2, opacity: 0.75, textTransform: 'none', letterSpacing: 0.3 },
  attitude: { marginTop: space[2], flexShrink: 1, maxWidth: '100%', alignSelf: 'flex-start' },

  verdict: { gap: 2, alignSelf: 'stretch' },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  slab: { width: 5, height: 14, transform: [{ skewX: '-8deg' }] },
  title: { fontSize: 33, lineHeight: 34 },
  because: { maxWidth: 460 },
  bandLabel: { marginTop: 2 },

  actions: { gap: space[2] },
  leaveNote: { maxWidth: 460 },

  flexNone: { flexGrow: 1, flexShrink: 0 },
  faultPage: { flexGrow: 1, paddingHorizontal: gutter, paddingBottom: space[4], width: '100%', maxWidth: 820, alignSelf: 'center' },
  faultPageLandscape: { maxWidth: 1100 },
  faultRow: { flexGrow: 1, flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: space[5] },
  faultCentreLandscape: { flex: 1, minWidth: 0, paddingBottom: 0, paddingTop: 0, justifyContent: 'center' },
  faultFootLandscape: { width: 300, paddingBottom: 0 },
  faultCentre: { flexGrow: 1, flexShrink: 0, justifyContent: 'flex-end', gap: space[2], paddingBottom: space[4], paddingTop: space[3] },
  // rises behind the headline, which now sits low: anchored to the block's own bottom
  bloom: { position: 'absolute', left: -gutter - 24, right: -gutter - 24, bottom: -40, height: 460 },
  // right: past the 300 pt rail, its gap and the page gutter, so the wash has no edge on screen
  bloomLandscape: { bottom: -20, height: 230, right: -(300 + space[5] + gutter + 24) },
  faultTitle: { fontSize: 46, lineHeight: 47 },
  faultBody: { maxWidth: 520 },
  rule: { height: 1, backgroundColor: colors.line, marginBottom: space[3], maxWidth: 520 },
  faultFoot: { flexShrink: 0, gap: space[2], paddingBottom: space[3] },
  faultActions: { gap: space[3], paddingTop: space[2] },
});
