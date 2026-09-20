/**
 * Skia objects the frame loop reuses.
 *
 * Every paint, shader and colour here is allocated ONCE and mutated per draw. Skia objects are
 * wasm handles with no finaliser, so allocating them inside the 60 Hz loop would leak the heap in
 * seconds; `dispose()` releases them when the screen goes away.
 *
 * The gradients are all defined on a UNIT shape (a circle of radius 1, or a 0..1 strip) and
 * positioned by transforming the canvas before drawing, so one shader serves every smoke puff,
 * the light pool, the vignette, the letterbox feet and the scrubber ribbon.
 */
import { BlurStyle, FilterMode, PaintStyle, Skia, StrokeCap, StrokeJoin, TileMode, type SkColor, type SkFont, type SkPaint, type SkPathEffect, type SkShader } from '@shopify/react-native-skia';

import { colors } from '../theme';

export interface SceneResources {
  fill: SkPaint;
  stroke: SkPaint;
  /** Stroke paint reserved for dashed work, so a dash never leaks into another draw. */
  dashed: SkPaint;
  shaded: SkPaint;
  text: SkPaint;
  /** Fill paint carrying a blur mask, for glows. */
  glow: SkPaint;
  smoke: SkShader;
  smokeHot: SkShader;
  pool: SkShader;
  vignette: SkShader;
  ribbon: SkShader;
  topFade: SkShader;
  bottomFade: SkShader;
  grain: SkShader;
  /** `#RRGGBB` → SkColor, parsed once. */
  color(hex: string): SkColor;
  /** A dash effect for this on/off length, cached (they are wasm objects too). */
  dash(on: number, off: number): SkPathEffect;
  /** Advance width of one string in this font, cached per font+string. */
  width(font: SkFont, key: string, s: string): number;
  setGlowBlur(sigma: number): void;
  dispose(): void;
}

function gradient(stops: Array<[number, string, number]>, radial: boolean): SkShader {
  const cols = stops.map(([, hex, a]) => Skia.Color(withAlpha(hex, a)));
  const pos = stops.map(([p]) => p);
  return radial
    ? Skia.Shader.MakeRadialGradient({ x: 0, y: 0 }, 1, cols, pos, TileMode.Clamp)
    : Skia.Shader.MakeLinearGradient({ x: 0, y: 0 }, { x: 0, y: 1 }, cols, pos, TileMode.Clamp);
}

function withAlpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a))})`;
}

/** A 100 × 100 tile of hashed dots — the film grain, drawn as a repeating shader. */
function grainShader(): SkShader {
  const rec = Skia.PictureRecorder();
  const canvas = rec.beginRecording({ x: 0, y: 0, width: 100, height: 100 });
  const paint = Skia.Paint();
  paint.setAntiAlias(false);
  let h = 12345;
  for (let i = 0; i < 260; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const x = ((h >>> 8) % 1000) / 10;
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const y = ((h >>> 8) % 1000) / 10;
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const o = 0.25 + ((h >>> 8) % 100) / 133;
    paint.setColor(Skia.Color(`rgba(255, 255, 255, ${Math.min(1, o)})`));
    canvas.drawRect({ x, y, width: 1, height: 1 }, paint);
  }
  const picture = rec.finishRecordingAsPicture();
  rec.dispose();
  const shader = picture.makeShader(TileMode.Repeat, TileMode.Repeat, FilterMode.Nearest, undefined, { x: 0, y: 0, width: 100, height: 100 });
  picture.dispose();
  paint.dispose();
  return shader;
}

export function createSceneResources(): SceneResources {
  const fill = Skia.Paint();
  fill.setAntiAlias(true);
  const stroke = Skia.Paint();
  stroke.setAntiAlias(true);
  stroke.setStyle(PaintStyle.Stroke);
  stroke.setStrokeCap(StrokeCap.Round);
  stroke.setStrokeJoin(StrokeJoin.Round);
  const dashed = Skia.Paint();
  dashed.setAntiAlias(true);
  dashed.setStyle(PaintStyle.Stroke);
  dashed.setStrokeCap(StrokeCap.Butt);
  const shaded = Skia.Paint();
  shaded.setAntiAlias(true);
  const text = Skia.Paint();
  text.setAntiAlias(true);
  const glow = Skia.Paint();
  glow.setAntiAlias(true);

  const smoke = gradient(
    [
      [0, '#C9D0DA', 0.8],
      [0.5, '#AEB6C2', 0.38],
      [1, '#8F98A6', 0],
    ],
    true,
  );
  const smokeHot = gradient(
    [
      [0, '#FFF6EE', 0.95],
      [1, '#FFD9BE', 0],
    ],
    true,
  );
  const pool = gradient(
    [
      [0, '#2C3A4C', 0.5],
      [0.55, '#1B2532', 0.28],
      [1, '#0D131B', 0],
    ],
    true,
  );
  const vignette = gradient(
    [
      [0.45, '#000000', 0],
      [0.8, '#000000', 0.16],
      [1, '#000000', 0.5],
    ],
    true,
  );
  // bottom (y = 1) is the calm end of the ribbon, the top (y = 0) is a spin
  const ribbon = gradient(
    [
      [0, colors.red, 0.95],
      [0.2, colors.gold, 0.9],
      [0.45, colors.ember, 0.8],
      [1, colors.ember, 0.25],
    ],
    false,
  );
  const topFade = gradient(
    [
      [0, '#000000', 1],
      [1, '#000000', 0],
    ],
    false,
  );
  const bottomFade = gradient(
    [
      [0, '#000000', 0],
      [1, '#000000', 1],
    ],
    false,
  );
  const grain = grainShader();

  const colorCache = new Map<string, SkColor>();
  const dashCache = new Map<string, SkPathEffect>();
  const widthCache = new Map<string, number>();
  let blurSigma = -1;

  return {
    fill,
    stroke,
    dashed,
    shaded,
    text,
    glow,
    smoke,
    smokeHot,
    pool,
    vignette,
    ribbon,
    topFade,
    bottomFade,
    grain,
    color(hex: string): SkColor {
      let c = colorCache.get(hex);
      if (!c) {
        c = Skia.Color(hex);
        colorCache.set(hex, c);
      }
      return c;
    },
    dash(on: number, off: number): SkPathEffect {
      const key = `${on.toFixed(2)}:${off.toFixed(2)}`;
      let e = dashCache.get(key);
      if (!e) {
        e = Skia.PathEffect.MakeDash([on, off]);
        dashCache.set(key, e);
      }
      return e;
    },
    width(font: SkFont, key: string, s: string): number {
      const k = `${key}\u0000${s}`;
      let w = widthCache.get(k);
      if (w === undefined) {
        try {
          // getTextWidth, not measureText: CanvasKit's RN-Web shim does not implement the latter
          w = font.getTextWidth(s);
        } catch {
          w = s.length * 8;
        }
        if (!Number.isFinite(w)) w = s.length * 8;
        widthCache.set(k, w);
      }
      return w;
    },
    setGlowBlur(sigma: number): void {
      if (Math.abs(sigma - blurSigma) < 0.05) return;
      blurSigma = sigma;
      glow.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, sigma, true));
    },
    dispose(): void {
      for (const o of [fill, stroke, dashed, shaded, text, glow, smoke, smokeHot, pool, vignette, ribbon, topFade, bottomFade, grain]) {
        try {
          o.dispose();
        } catch {
          // already released
        }
      }
      for (const e of dashCache.values()) {
        try {
          e.dispose();
        } catch {
          // already released
        }
      }
      dashCache.clear();
      colorCache.clear();
      widthCache.clear();
    },
  };
}
