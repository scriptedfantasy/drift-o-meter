# Brand assets

| File | Size | Notes |
| --- | --- | --- |
| `logo-mark.webp` | 1254 × 1254, opaque | The graffiti D. Source for the iOS icon set. |
| `wordmark.webp` | 2000 × 764, alpha | DRIFT-O-MANIA, transparent background. |
| `garage-hero.webp` | 1200 × 448 | The RPS13 rendered in front of the mark. Garage screen. |

## The greens, measured

Read off the two logo files rather than picked: 36,599 green pixels in the mark,
38,448 in the wordmark.

- `#8AF606` — body green, hue 85. The live colour: a run is happening.
- `#C4FF2E` — the highlight the artwork ramps into.
- `#17640C` — the deep keyline under every stroke.

An earlier eye estimate of `#6FE81E` was duller and bluer than the artwork; do
not reintroduce it.

## garage-hero.webp

One frame from the turntable in `09abf8ea-rps13-animation-branded.zip`, rendered
headless at 2× and cropped. Camera orbit `215deg 76deg 105%`, auto-rotate frozen,
the demo page's own chrome stripped so only the car and the backdrop remain.

It is a still standing in for a turning car. The real screen wants the model
itself, which is not a drop-in:

- The GLB is 30 MB and 426,233 triangles. It needs decimating, Draco or meshopt
  compression and KTX2 textures to land near 2–4 MB before it goes in a bundle.
- `model-viewer` is a web component; React Native has no such element. On the
  phone this is three.js on expo-gl, or a WebView over the bundled page.
- Never on the drive screen. That one runs the engine at 100 Hz with Skia on top.

The mark belongs *behind* the car, not over it — a wordmark laid on top of a
rotating model fights it every frame.

## Attribution

Nissan 180sx by autoNgraphic, https://sketchfab.com/3d-models/nissan-180sx-free-b37cea6e8a864a2aa602934ddb0e6ff0,
licensed CC BY 4.0, body paint recoloured midnight blue. The licence and the
modification both belong in the app's credits, not only in a README.
