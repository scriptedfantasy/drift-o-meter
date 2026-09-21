/**
 * The Drift-O-Mania mark, at the top of the drive display.
 *
 * THE REAL ARTWORK, NOT DRAWN TYPE. `src/ui/Wordmark.tsx` sets the name in Barlow Condensed with
 * the hyphens coloured, which was a stand-in from before `assets/brand/wordmark.webp` existed —
 * it spells something close to the name in a font the brand does not use. This renders the file:
 * 2000 × 764 with an alpha channel, the same greens the dial's ramp was measured off
 * (`assets/brand/README.md`).
 *
 * WHY THE BRAND IS ON THE ONE SCREEN THAT SHOWS NOTHING ELSE. Everything else was taken off this
 * display because a driver at 60 km/h cannot read it, and that argument does not apply to a mark:
 * nobody reads it, it is recognised in the periphery or not at all, and it costs the dial no
 * height it was using — the scale is a circle in a square, and the band above the square is empty
 * in both orientations. It is also the frame every video and screenshot of a run is captured in.
 *
 * ── the size ────────────────────────────────────────────────────────────────────────────────
 * 0.80 of the width, which is what the approved mockup sets (313 pt in a 390 pt board). Capped
 * in absolute points as well, because that fraction on a tablet would put a 700 pt logo over an
 * instrument, and the mark has a size past which it stops being a signature and starts being the
 * subject.
 *
 * ── landscape ───────────────────────────────────────────────────────────────────────────────
 * The caller passes the width; there is no orientation logic here. Landscape has ~390 pt of
 * height for a dial whose numeral band already wants all of it, so the drive screen does NOT put
 * the mark above the dial there — it goes in the right-hand column that STOP already owns, where
 * the only thing it competes with is empty space.
 */
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

/** `assets/brand/wordmark.webp` is 2000 × 764. */
const ASPECT = 2000 / 764;
/** Fraction of the available width the mark spans, from the drive mockup: 313 / 390. */
export const WORDMARK_WIDTH_FRAC = 0.803;
/**
 * The most points the mark may ever be wide.
 *
 * At 0.803 of the width a 1024 pt tablet would draw an 822 pt logo, which is not a wordmark any
 * more. 340 is a fraction over the 313 the mockup uses on a 390 pt phone, so every phone in
 * portrait gets the mockup's proportions and only a very wide frame is clamped.
 */
const MAX_WIDTH = 340;

const SOURCE = require('../../../assets/brand/wordmark.webp');

/**
 * What the mark will measure, given the width it is offered.
 *
 * Exported because the drive screen has to RESERVE that height before it can work out how big
 * the dial may be, and a screen that guessed at it would be a second copy of this arithmetic —
 * the kind that stays right until one of the two numbers is tuned.
 */
export function wordmarkSize(available: number): { width: number; height: number } {
  const width = Math.max(0, Math.min(MAX_WIDTH, available * WORDMARK_WIDTH_FRAC));
  return { width, height: Math.round(width / ASPECT) };
}

export interface DriveWordmarkProps {
  /** The width available to it; the mark takes `WORDMARK_WIDTH_FRAC` of this, capped. */
  available: number;
  testID?: string;
}

export function DriveWordmark({ available, testID }: DriveWordmarkProps) {
  const { width, height } = wordmarkSize(available);
  return (
    <View style={styles.wrap} pointerEvents="none" testID={testID}>
      <Image
        source={SOURCE}
        style={{ width, height }}
        contentFit="contain"
        // No fade. The mark is chrome on a live instrument, and a logo dissolving into view while
        // the engine takes its first samples reads as the screen still loading — which it is not:
        // the run has already started (see `useDriveRun`, "opening the screen IS the arming step").
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

export default DriveWordmark;
