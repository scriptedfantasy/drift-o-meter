/**
 * The Drift-O-Mania mark.
 *
 * THE REAL ARTWORK, NOT DRAWN TYPE. This used to set the name in Barlow Condensed with the
 * hyphens coloured — a stand-in from before `assets/brand/wordmark.webp` existed, which by
 * the end was spelling the old name in a font the brand does not use. It now renders the
 * file: 2000 x 764 with an alpha channel, carrying the same greens the dial's ramp was
 * measured off (`assets/brand/README.md`).
 *
 * ONE RULE, EVERY SCREEN. The drive display and the run review are meant to read as one
 * board, so the mark is the same size on both — and it was not, briefly: two screens each
 * grew their own constant, 313 flat against 0.803 of the width, and on a 393 pt phone that
 * is a 3 pt disagreement between two things a person sees one after the other. The fraction
 * wins because it survives a narrow phone; the cap is what keeps it from winning on a tablet.
 *
 * WHY THE MARK IS ON THE DRIVE SCREEN AT ALL. Everything else was taken off it because a
 * driver at 60 km/h cannot read it, and that argument does not apply to a mark: nobody reads
 * it, it is recognised in the periphery or not at all, and it costs the dial no height it was
 * using — the scale is a circle in a square, and the band above the square is empty in both
 * orientations. It is also the frame every video and screenshot of a run is captured in.
 */
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

/** `assets/brand/wordmark.webp` is 2000 x 764. */
export const WORDMARK_ASPECT = 2000 / 764;

/** Fraction of the offered width the mark spans, from the approved mockups: 313 / 390. */
export const WORDMARK_WIDTH_FRAC = 0.803;

/**
 * The most points the mark may ever be wide.
 *
 * At 0.803 of the width a 1024 pt tablet would draw an 822 pt logo, which is not a wordmark
 * any more. 340 is a fraction over the 313 the mockups use on a 390 pt phone, so every phone
 * in portrait gets the mockup's proportions and only a very wide frame is clamped.
 */
export const WORDMARK_MAX_WIDTH = 340;

const SOURCE = require('../../assets/brand/wordmark.webp');

/**
 * What the mark will measure, given the width it is offered.
 *
 * Exported because a screen has to RESERVE that height before it can work out how much is
 * left for everything else — the drive display sizes its dial against it. A screen that
 * guessed instead would be a second copy of this arithmetic, the kind that stays right until
 * one of the two numbers is tuned.
 */
export function wordmarkSize(available: number): { width: number; height: number } {
  const width = Math.max(0, Math.min(WORDMARK_MAX_WIDTH, available * WORDMARK_WIDTH_FRAC));
  return { width, height: Math.round(width / WORDMARK_ASPECT) };
}

export interface WordmarkProps {
  /** The width available to it; the mark takes `WORDMARK_WIDTH_FRAC` of this, capped. */
  available: number;
  testID?: string;
}

export function Wordmark({ available, testID }: WordmarkProps) {
  const { width, height } = wordmarkSize(available);
  return (
    <View style={styles.wrap} pointerEvents="none" testID={testID}>
      <Image
        source={SOURCE}
        style={{ width, height }}
        contentFit="contain"
        // No fade. The mark is chrome on a live instrument, and a logo dissolving into view
        // while the engine takes its first samples reads as the screen still loading — which
        // it is not: the run has already started (see `useDriveRun`, "opening the screen IS
        // the arming step").
        transition={0}
        priority="low"
        accessible
        accessibilityRole="image"
        accessibilityLabel="Drift-O-Mania"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', alignSelf: 'stretch' },
});

export default Wordmark;
