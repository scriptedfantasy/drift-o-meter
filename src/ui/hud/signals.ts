/**
 * The HUD's animated state.
 *
 * Frames arrive at ~100 Hz. React is NOT allowed to re-render at that rate, so every value that
 * moves continuously lives here as a Reanimated shared value, written straight from the sample
 * callback and read by the UI thread (Reanimated styles) and by Skia. React only re-renders for
 * the things that genuinely change slowly — see `useDriveRun`'s snapshot (≈10 Hz) — and for
 * discrete events (callouts, banners, integrity verdicts), which arrive a handful of times a
 * minute.
 */
import { useMemo } from 'react';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

export interface HudSignals {
  /** Signed slip angle in degrees (β > 0 = right-hand drift). */
  betaDeg: SharedValue<number>;
  /** |β| in degrees — the hero numeral. */
  absDeg: SharedValue<number>;
  /** −1 left slide / +1 right slide, held through zero crossings so the chevron does not flicker. */
  side: SharedValue<number>;
  /** Signed peak |β| of the drift in progress, degrees (0 when idle) — the ghost tick. */
  peakDeg: SharedValue<number>;
  speedKmh: SharedValue<number>;
  /** Lateral acceleration in g (+ = left). */
  ayG: SharedValue<number>;
  /** 0..1 drift intensity: drives the glow, the edge bloom and the arc colour. */
  intensity: SharedValue<number>;
  /** 0..1, 1 while the detector reports a drift (entry/drifting/transition). */
  active: SharedValue<number>;
  /** Running score (banked + at risk). */
  total: SharedValue<number>;
  /** Un-banked points. */
  chainPoints: SharedValue<number>;
  multiplier: SharedValue<number>;
  /** 0..1 fill of the chain bar. */
  chainRatio: SharedValue<number>;
  /** Seconds of recording time since the run started. */
  elapsedS: SharedValue<number>;
  /** 0..1 impulse fired at a transition: 100 ms screen shake. */
  shake: SharedValue<number>;
  /** 0..1 impulse fired at a transition: 120 ms magenta flash. */
  flash: SharedValue<number>;
  /** 1 on the frame a drift is confirmed — punches the numeral to 1.08×. */
  punch: SharedValue<number>;
  /** Car position in local ENU metres and heading in radians (mini-map head). */
  carX: SharedValue<number>;
  carY: SharedValue<number>;
  carHeading: SharedValue<number>;
  /** 1 while the estimator has a usable fix. */
  valid: SharedValue<number>;
  /**
   * How much of what the gauge is showing the engine is willing to stand behind: 1 rigid and
   * locked, 0.65 shaking or weak GPS, 0 when the run is not scoreable at all (loose mount,
   * implausible physics, no fix). The gauge dims and stops blooming with it — a HUD that
   * celebrates 82° on a hand-held phone is lying about a number the scorer already threw away.
   */
  trust: SharedValue<number>;
}

export function useHudSignals(): HudSignals {
  const betaDeg = useSharedValue(0);
  const absDeg = useSharedValue(0);
  const side = useSharedValue(1);
  const peakDeg = useSharedValue(0);
  const speedKmh = useSharedValue(0);
  const ayG = useSharedValue(0);
  const intensity = useSharedValue(0);
  const active = useSharedValue(0);
  const total = useSharedValue(0);
  const chainPoints = useSharedValue(0);
  const multiplier = useSharedValue(1);
  const chainRatio = useSharedValue(0);
  const elapsedS = useSharedValue(0);
  const shake = useSharedValue(0);
  const flash = useSharedValue(0);
  const punch = useSharedValue(0);
  const carX = useSharedValue(0);
  const carY = useSharedValue(0);
  const carHeading = useSharedValue(0);
  const valid = useSharedValue(0);
  const trust = useSharedValue(0);

  return useMemo(
    () => ({
      betaDeg,
      absDeg,
      side,
      peakDeg,
      speedKmh,
      ayG,
      intensity,
      active,
      total,
      chainPoints,
      multiplier,
      chainRatio,
      elapsedS,
      shake,
      flash,
      punch,
      carX,
      carY,
      carHeading,
      valid,
      trust,
    }),
    [
      betaDeg,
      absDeg,
      side,
      peakDeg,
      speedKmh,
      ayG,
      intensity,
      active,
      total,
      chainPoints,
      multiplier,
      chainRatio,
      elapsedS,
      shake,
      flash,
      punch,
      carX,
      carY,
      carHeading,
      valid,
      trust,
    ],
  );
}

/** Reset every signal to its idle value (a new run must not inherit the last one's glow). */
export function resetSignals(s: HudSignals): void {
  s.betaDeg.value = 0;
  s.absDeg.value = 0;
  s.side.value = 1;
  s.peakDeg.value = 0;
  s.speedKmh.value = 0;
  s.ayG.value = 0;
  s.intensity.value = 0;
  s.active.value = 0;
  s.total.value = 0;
  s.chainPoints.value = 0;
  s.multiplier.value = 1;
  s.chainRatio.value = 0;
  s.elapsedS.value = 0;
  s.shake.value = 0;
  s.flash.value = 0;
  s.punch.value = 0;
  s.carX.value = 0;
  s.carY.value = 0;
  s.carHeading.value = 0;
  s.valid.value = 0;
  s.trust.value = 0;
}
