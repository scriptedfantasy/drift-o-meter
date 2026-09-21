/**
 * The top of the garage: the RPS13 standing in front of the Drift-O-Mania mark.
 *
 * NOTHING IS LAID OVER THE MARK. The render already contains it — a wordmark drawn on top of
 * the car fights it in every frame, and the one on this screen used to be a separate line of
 * type above a list, which is a masthead rather than a garage. What sits over the image is a
 * scrim at the bottom and two labels inside it, both below the car.
 *
 * The still is a frame from the turntable in `assets/brand/` (1200 × 448, camera orbit
 * `215deg 76deg 105%`). It stands in for the real thing: the GLB is 30 MB and 426,233
 * triangles, and it needs decimating and compressing to about 2–4 MB before a model belongs in
 * a bundle. The `360°` tag says which of the two this is, so the screen does not quietly
 * promise a turntable it has not got.
 *
 * The geometry is measured rather than guessed: the art is scaled so its INK — not its file
 * edges — spans the frame, and its centre sits at 48 % of the hero's height, which puts the
 * car's wheels on the top of the scrim with both ends of the mark still on screen. `onLayout`
 * supplies the width, so it holds at any screen size; the 216 dp height is fixed, so nothing
 * jumps when it arrives.
 */
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { AppText, Micro } from '../Text';
import { colors, gutter, rgba, space } from '../theme';

const HERO_H = 216;
/** The still's own aspect, from `assets/brand/README.md`. */
const ART_ASPECT = 1200 / 448;
/**
 * Where the ARTWORK is inside the file, as fractions of its width.
 *
 * Measured off `assets/brand/garage-hero.webp` rather than eyeballed: scanning the 1200x448
 * file for pixels more than 18/255 off its own corner colour puts the ink at x 27..1184, so it
 * reaches 2.25 % and 98.75 % of the width with 27 px of margin on one side and 15 on the other.
 * It is NOT centred in its own file, which is why the art is positioned by its ink rather than
 * by its edges — centring the image leaves a 12 px lean and clips the tail of "Mania" first.
 *
 * The approved mockup draws this 446 px wide on a 390 pt board, which cuts 28 px off each side
 * and therefore cuts the `D` of "Drift" and the tail of "Mania" with them. Sizing from the ink
 * box instead keeps every stroke inside at a cost of about 9 % of the car (a 152 dp tall render
 * against the mockup's 167), which is the better trade for a mark that is the product's name.
 */
const ART_INK_X0 = 0.0225;
const ART_INK_X1 = 0.9875;
/** Fraction of the art's width that is ink. Make THIS span the frame, and nothing is cut. */
const ART_INK_W = ART_INK_X1 - ART_INK_X0;
/** Where the art's centre sits down the frame, so the wheels meet the top of the scrim. */
const ART_CENTRE_Y = 0.48;
/**
 * The most of the hero's height the art may take, and the reason it is a SECOND bound.
 *
 * Width alone is right on a phone and wrong the moment the screen is turned: at 852 pt the
 * frame asks for 883 px of art, 330 px tall inside a 216 px band, so the clipped art ran to
 * every edge and the mark's green sat in the frame's top-left corner — which the harness reads,
 * correctly, as the page background no longer being the page background. Set just above what
 * the ink bound asks for at phone width, so it binds only on a wide screen.
 */
const ART_MAX_H_FRAC = 0.71;

const source = require('../../../assets/brand/garage-hero.webp') as number;

export function GarageHero({ testID }: { testID?: string }) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width)), []);

  const artW = Math.min(width / ART_INK_W, HERO_H * ART_MAX_H_FRAC * ART_ASPECT);
  const artH = artW / ART_ASPECT;
  // Anchored by its ink when the ink fills the frame, centred when it cannot — the file's
  // uneven margins mean those are two different positions, and only the first keeps both ends
  // of the mark on screen.
  const artX = artW * ART_INK_W >= width ? -artW * ART_INK_X0 : (width - artW) / 2;

  return (
    <View style={styles.hero} onLayout={onLayout} testID={testID}>
      {width > 0 ? (
        <Image
          source={source}
          alt="A Nissan 200SX RPS13 turning in front of the Drift-O-Mania mark"
          contentFit="contain"
          style={[styles.art, { width: artW, height: artH, left: artX, top: HERO_H * ART_CENTRE_Y - artH / 2 }]}
        />
      ) : null}
      {/* Bottom-weighted, so the labels sit on a dark base while the car stays lit. */}
      <LinearGradient
        colors={[rgba(colors.bg0, 0), rgba(colors.bg0, 0.88), colors.bg0]}
        locations={[0, 0.58, 1]}
        style={styles.scrim}
        pointerEvents="none"
      />
      <View style={styles.caption}>
        <Micro style={styles.kicker}>Your garage</Micro>
        <AppText variant="title" numberOfLines={1} style={styles.car} accessibilityRole="header">
          200SX <AppText variant="micro">RPS13</AppText>
        </AppText>
      </View>
      <View style={styles.tag}>
        <View style={styles.dot} />
        <Micro color="blue" numberOfLines={1} style={styles.tagText}>
          360°
        </Micro>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { height: HERO_H, backgroundColor: colors.bg0, overflow: 'hidden' },
  art: { position: 'absolute' },
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 88 },
  caption: { position: 'absolute', left: gutter, bottom: space[3] },
  kicker: { letterSpacing: 2.6 },
  car: { fontSize: 26, lineHeight: 28, marginTop: 2 },
  tag: { position: 'absolute', right: gutter, bottom: space[4], flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.blue },
  tagText: { letterSpacing: 2 },
});
