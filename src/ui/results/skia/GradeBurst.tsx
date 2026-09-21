/**
 * The shockwave and embers behind the grade when it slams in.
 *
 * Imports Skia directly, so on web it must only ever be reached through `GradeBurstView`
 * (see `src/ui/skia/GlowRingView.web.tsx` for why: `@shopify/react-native-skia` binds
 * `global.CanvasKit` at module evaluation, so it cannot be in a route's import graph).
 *
 * Driven by one shared value, 0 → 1, so the reveal can play it, freeze it at a chosen frame
 * for a screenshot, or never mount it at all when the system asks for reduced motion.
 */
import { BlurMask, Canvas, Circle, Group } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

import { colors, rgba } from '../../theme';

export interface GradeBurstProps {
  /** The burst's own scale in dp: ring travel and ember reach are fractions of it. */
  size: number;
  /**
   * Canvas height, when the frame is shorter than the burst is wide. Defaults to `size`.
   *
   * The canvas is the thing that costs: every ember is two circles under a `BlurMask`, and a
   * blurred draw is paid for in pixels whether or not those pixels are on screen. At 852 x 393
   * the square canvas was 664 x 664 centred on a 393 dp stage, so 41 % of every blur was spent
   * outside the frame. Cropping it changes nothing a driver sees — the rings still run off both
   * ends, which is the point of them.
   */
  height?: number;
  /** Grade colour: gold for S, ember for A, and so on. */
  color: string;
  /** 0 → 1 across the life of the burst. */
  progress: SharedValue<number>;
  /** Ember count (fixed at mount: the hook order depends on it). */
  particles?: number;
  testID?: string;
}

interface Spec {
  angle: number;
  speed: number;
  radius: number;
  delay: number;
  color: string;
  drag: number;
}

/** Deterministic PRNG so every capture of the same frame is the same pixels. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSpecs(n: number, color: string): Spec[] {
  const rnd = mulberry32(0x5eed);
  const out: Spec[] = [];
  for (let i = 0; i < n; i++) {
    const spread = (rnd() - 0.5) * 0.46;
    out.push({
      angle: (i / n) * Math.PI * 2 + spread,
      // embers lead the shock front, the way debris does
      speed: 0.52 + rnd() * 0.42,
      radius: 1.8 + rnd() * 4.6,
      delay: rnd() * 0.1,
      color: rnd() < 0.62 ? color : rnd() < 0.5 ? colors.ember : colors.gold,
      drag: 0.7 + rnd() * 0.45,
    });
  }
  return out;
}

function easeOut(p: number): number {
  'worklet';
  return 1 - Math.pow(1 - p, 3);
}

/** Shock-front travel: fast off the mark, still moving at the end (no saturating plateau). */
function front(p: number): number {
  'worklet';
  return Math.pow(Math.max(0, Math.min(1, p)), 0.55);
}

/**
 * When the white flash comes up, and when it is gone, as fractions of the burst.
 *
 * NOT ON THE FIRST FRAME. The letter's own opacity ramp finishes 70 ms after the slam, and it is
 * at 3.4x for the first 95 ms of that — so a filled white disc on frame one sat on a
 * half-transparent, oversized glyph and the first ~200 ms read as a glossy bubble over an amber
 * smear rather than as a grade. NFS punches the letter oversize and keeps it READABLE. The flash
 * now blooms as the glyph becomes legible and is gone 230 ms in.
 */
const FLASH_IN = 0.09;
const FLASH_OUT = 0.3;

export default function GradeBurst({ size, height, color, progress, particles = 26, testID }: GradeBurstProps) {
  const w = size;
  const h = height ?? size;
  const c = size / 2;
  const cy = h / 2;
  const specs = buildSpecs(particles, color);

  const flashOpacity = useDerivedValue(() => {
    const p = progress.value;
    const up = p < FLASH_IN ? Math.max(0, p / FLASH_IN) : 1;
    const down = Math.max(0, 1 - Math.max(0, p - FLASH_IN) / (FLASH_OUT - FLASH_IN));
    return up * down * 0.5;
  });
  const flashRadius = useDerivedValue(() => c * (0.12 + 0.5 * easeOut(Math.min(1, progress.value * 3))));

  const ring1R = useDerivedValue(() => c * (0.06 + 1.3 * front(progress.value)));
  const ring1W = useDerivedValue(() => Math.max(1, 20 * Math.pow(Math.max(0, 1 - progress.value), 1.3)));
  const ring1O = useDerivedValue(() => Math.pow(Math.max(0, 1 - progress.value), 2.2));

  // a second, thinner front chasing the first
  const ring2P = useDerivedValue(() => Math.max(0, (progress.value - 0.18) / 0.82));
  const ring2R = useDerivedValue(() => c * (0.06 + 1.05 * front(ring2P.value)));
  const ring2O = useDerivedValue(() => (progress.value <= 0.22 ? 0 : Math.pow(Math.max(0, 1 - ring2P.value), 2) * 0.5));

  return (
    <Canvas style={{ width: w, height: h }} testID={testID}>
      {/* A mask filter costs its KERNEL as well as its area, and this one is the widest draw in
          the scene: `size * 0.06` is a 40 px sigma over a 664 dp disc. 18 reads the same at
          arm's length and is the single biggest saving in the burst. */}
      <Circle cx={c} cy={cy} r={flashRadius} color={rgba('#FFFFFF', 1)} opacity={flashOpacity}>
        <BlurMask blur={Math.min(18, size * 0.06)} style="normal" />
      </Circle>

      <Circle cx={c} cy={cy} r={ring1R} color={color} style="stroke" strokeWidth={ring1W} opacity={ring1O}>
        <BlurMask blur={6} style="solid" />
      </Circle>
      <Circle cx={c} cy={cy} r={ring2R} color={color} style="stroke" strokeWidth={3} opacity={ring2O}>
        <BlurMask blur={8} style="normal" />
      </Circle>

      <Group>
        {specs.map((s, i) => (
          <Ember key={i} spec={s} cx={c} cy={cy} size={size} progress={progress} />
        ))}
      </Group>
    </Canvas>
  );
}

function Ember({ spec, cx, cy, size, progress }: { spec: Spec; cx: number; cy: number; size: number; progress: SharedValue<number> }) {
  const p = useDerivedValue(() => Math.max(0, Math.min(1, (progress.value - spec.delay) / (1 - spec.delay))));
  const travel = useDerivedValue(() => front(p.value) * spec.speed * size * spec.drag);
  const x = useDerivedValue(() => cx + Math.cos(spec.angle) * travel.value);
  // embers are hot gas and tyre smoke: they slow down and fall a little
  const y = useDerivedValue(() => cy + Math.sin(spec.angle) * travel.value + 0.16 * size * p.value * p.value);
  const r = useDerivedValue(() => spec.radius * (1 - 0.55 * p.value));
  const o = useDerivedValue(() => Math.pow(Math.max(0, 1 - p.value), 1.4));

  // head + a dimmer tail a little way back along the path: motion, without a path per frame
  const tx = useDerivedValue(() => cx + Math.cos(spec.angle) * travel.value * 0.82);
  const ty = useDerivedValue(() => cy + Math.sin(spec.angle) * travel.value * 0.82 + 0.13 * size * p.value * p.value);
  const tr = useDerivedValue(() => spec.radius * (1 - 0.55 * p.value) * 0.6);
  const to = useDerivedValue(() => Math.pow(Math.max(0, 1 - p.value), 1.6) * 0.5);

  // The HEAD carries the blur; the tail does not. Every `BlurMask` is a separate filtered draw
  // over the whole canvas, and at 34 embers that was 68 of them a frame — the measured cost of
  // this burst was 7 dropped frames of 84–284 ms across a reveal that is otherwise a clean 60 fps.
  // A 1–3 dp tail at half opacity is a spark, and a spark does not need a filter to read as one.
  return (
    <Group>
      <Circle cx={tx} cy={ty} r={tr} color={spec.color} opacity={to} />
      <Circle cx={x} cy={y} r={r} color={spec.color} opacity={o}>
        <BlurMask blur={3} style="solid" />
      </Circle>
    </Group>
  );
}
