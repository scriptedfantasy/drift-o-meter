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
 * The geometry is measured rather than guessed: the image is 1.144 × the hero's width and its
 * centre sits at 48 % of the hero's height, which is what puts the car's wheels just above the
 * scrim and the mark's shoulders inside the frame at 390 pt. `onLayout` supplies the width, so
 * it holds at any screen size; the 216 dp height is fixed, so nothing jumps when it arrives.
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
 * How much wider than the frame the car is drawn, and where its centre sits down the frame.
 *
 * The overscan is what crops the mark's first and last letters at the screen edges, which is
 * the approved framing — the mark is a backdrop, not a wordmark to be read.
 */
const ART_OVERSCAN = 1.144;
const ART_CENTRE_Y = 0.48;
/**
 * The most of the hero's height the art may take, and the reason it is a SECOND bound.
 *
 * Width alone is right on a phone and wrong the moment the screen is turned: at 852 pt the
 * overscan asks for 975 px of art, 364 px tall inside a 216 px band, so the clipped art ran to
 * every edge and the mark's green sat in the frame's top-left corner — which the harness reads,
 * correctly, as the page background no longer being the page background. Taking the smaller of
 * the two bounds keeps the portrait framing exactly (they agree to the pixel at phone width)
 * and lets the art letterbox in the middle of a wide one instead of bursting out of it.
 */
const ART_MAX_H_FRAC = 0.777;

const source = require('../../../assets/brand/garage-hero.webp') as number;

export function GarageHero({ testID }: { testID?: string }) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width)), []);

  const artW = Math.min(width * ART_OVERSCAN, HERO_H * ART_MAX_H_FRAC * ART_ASPECT);
  const artH = artW / ART_ASPECT;

  return (
    <View style={styles.hero} onLayout={onLayout} testID={testID}>
      {width > 0 ? (
        <Image
          source={source}
          alt="A Nissan 200SX RPS13 turning in front of the Drift-O-Mania mark"
          contentFit="contain"
          style={[styles.art, { width: artW, height: artH, left: (width - artW) / 2, top: HERO_H * ART_CENTRE_Y - artH / 2 }]}
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
