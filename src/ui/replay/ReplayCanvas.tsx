/**
 * The replay stage: one full-bleed Skia canvas, one frame loop, no React in the hot path.
 *
 * WHY A LOOP AND NOT A WORKLET. Everything that moves is read straight out of the engine at the
 * displayed time — `poseAt`, `ghostPoseAt`, `activeEvents`, `shakeAt`, `liveSmoke` and
 * `ReplayCamera.update`. Those are ordinary modules, not worklets, and the rule for this screen is
 * that it DRAWS the scene model rather than reimplementing it, so the frame is produced here, on
 * the JS thread (which has nothing else to do during a replay: no sensors, no pipeline), and
 * handed to Skia as a picture through a shared value. React never re-renders for a frame: the
 * clock, the transport state and the scrub position are all shared values, so a drag moves the
 * picture on the very next frame.
 *
 * Skia objects have no finaliser. The static geometry, the paints and the shaders are built once
 * and released on unmount, and each frame's picture is released two frames after it is replaced.
 *
 * Imports Skia directly, so on web it must only ever be loaded through `ReplayCanvasView`.
 */
import { Canvas, createPicture, Picture, Skia, useTypeface, type SkFont, type SkPicture, type SkTypeface } from '@shopify/react-native-skia';
import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import {
  activeEvents,
  CAMERA_LIMITS,
  ghostPoseAt,
  poseAt,
  ReplayCamera,
  shakeAt,
  type CameraMode,
  type CameraState,
  type Replay,
} from '../../engine/replay';
import { clamp } from '../../engine/types';
import { buildSceneGeometry } from './geometry';
import type { ReplayLayout } from './layout';
import { TYPE } from './palette';
import type { HighlightChip, PlayerSignals } from './player';
import { createSceneResources } from './resources';
import { drawReplayFrame, type SceneFonts } from './scene';
import type { ReplayView } from './source';

const BC_800 = require('@expo-google-fonts/barlow-condensed/800ExtraBold/BarlowCondensed_800ExtraBold.ttf');
const BC_800_ITALIC = require('@expo-google-fonts/barlow-condensed/800ExtraBold_Italic/BarlowCondensed_800ExtraBold_Italic.ttf');
const BC_700 = require('@expo-google-fonts/barlow-condensed/700Bold/BarlowCondensed_700Bold.ttf');
const ORBITRON_700 = require('@expo-google-fonts/orbitron/700Bold/Orbitron_700Bold.ttf');

export interface ReplayCanvasProps {
  replay: Replay;
  view: ReplayView;
  layout: ReplayLayout;
  sv: PlayerSignals;
  mode: CameraMode;
  focusDriftId: number | null;
  chip: { current: HighlightChip | null };
  reduceMotion: boolean;
  /** The transport is on screen (the canvas puts a scrim behind it). */
  controlsVisible: boolean;
  testID?: string;
}

function makeFonts(bc800: SkTypeface | null, bcItalic: SkTypeface | null, bc700: SkTypeface | null, orbitron: SkTypeface | null): { fonts: SceneFonts; dispose(): void } {
  const made: SkFont[] = [];
  const font = (tf: SkTypeface | null, size: number): SkFont | null => {
    if (!tf) return null;
    const f = Skia.Font(tf, size);
    made.push(f);
    return f;
  };
  const fonts: SceneFonts = {
    hero: font(bc800, TYPE.hero),
    callout: font(bc800, TYPE.callout),
    mid: font(bc800, 17),
    peak: font(bc800, 16),
    grade: font(bc800, 18),
    value: font(bcItalic, TYPE.value),
    label: font(bc700, TYPE.label),
    clock: font(orbitron, TYPE.clock),
  };
  return {
    fonts,
    dispose() {
      for (const f of made) {
        try {
          f.dispose();
        } catch {
          // already released
        }
      }
      made.length = 0;
    },
  };
}

/**
 * What the camera frames. The follow cameras keep the car above the floating transport; the
 * track camera uses the whole stage, because there the car is a marker on a map the viewer
 * already knows and the shape of the circuit is the subject.
 */
function actionRect(layout: ReplayLayout, mode: CameraMode) {
  return mode === 'overview' ? layout.stage : layout.action;
}

export default function ReplayCanvas({ replay, view, layout, sv, mode, focusDriftId, chip, reduceMotion, controlsVisible, testID }: ReplayCanvasProps) {
  const res = useMemo(() => createSceneResources(), []);
  const geo = useMemo(() => buildSceneGeometry(replay, view.dead), [replay, view.dead]);
  const tfHero = useTypeface(BC_800);
  const tfItalic = useTypeface(BC_800_ITALIC);
  const tfLabel = useTypeface(BC_700);
  const tfClock = useTypeface(ORBITRON_700);
  const fontBook = useMemo(() => makeFonts(tfHero, tfItalic, tfLabel, tfClock), [tfHero, tfItalic, tfLabel, tfClock]);
  const camera = useMemo(() => new ReplayCamera(mode, actionRect(layout, mode)), [replay]); // eslint-disable-line react-hooks/exhaustive-deps
  const empty = useMemo(() => createPicture(() => {}, { x: 0, y: 0, width: 1, height: 1 }), []);
  const picture = useSharedValue<SkPicture>(empty);

  // Everything the loop reads, refreshed on every render so the loop itself never restarts.
  const stateRef = useRef({ replay, view, geo, layout, mode, focusDriftId, chip, reduceMotion, controlsVisible, fonts: fontBook.fonts });
  stateRef.current = { replay, view, geo, layout, mode, focusDriftId, chip, reduceMotion, controlsVisible, fonts: fontBook.fonts };
  /** Wall-clock ms until which the frame must keep being redrawn even when paused. */
  const dirtyUntil = useRef(0);
  const markDirty = (ms = 400) => {
    dirtyUntil.current = Math.max(dirtyUntil.current, (typeof performance !== 'undefined' ? performance.now() : Date.now()) + ms);
  };

  useEffect(() => () => res.dispose(), [res]);
  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => () => fontBook.dispose(), [fontBook]);
  useEffect(() => () => empty.dispose(), [empty]);
  useEffect(() => {
    camera.setViewport(actionRect(layout, mode));
    markDirty();
  }, [camera, layout, mode]);
  // A mode switch is a CUT with a 120 ms cross-fade, which is the engine's own film language.
  useEffect(() => {
    camera.setMode(mode);
    camera.setViewport(actionRect(layout, mode));
    markDirty(600);
  }, [camera, layout, mode]);
  useEffect(() => {
    markDirty(600);
  }, [fontBook, geo, view, focusDriftId, controlsVisible]);

  useEffect(() => {
    let raf = 0;
    let last = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let cutWall = -Infinity;
    let lastDrawnT = NaN;
    /** What the last drawn frame was made of. A paused replay stops drawing, so anything that
     *  arrives late — the Skia typefaces above all — has to force one more frame. */
    let lastInputs = '';
    const retired: SkPicture[] = [];

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const s = stateRef.current;
      const dur = s.replay.durationS;
      const dt = clamp((now - last) / 1000, 0, 0.25);
      last = now;

      const scrubbing = sv.scrubbing.value === 1;
      let t = clamp(sv.time.value, 0, dur);
      let cut = false;
      const pending = sv.seekT.value;
      if (scrubbing) {
        t = clamp(sv.scrubT.value, 0, dur);
        sv.time.value = t;
        sv.seekT.value = NaN;
      } else if (Number.isFinite(pending)) {
        t = clamp(pending, 0, dur);
        sv.time.value = t;
        sv.seekT.value = NaN;
        cut = true;
      } else if (sv.playing.value === 1) {
        t = t + dt * sv.rate.value;
        if (t >= dur) {
          t = dur;
          sv.playing.value = 0;
        }
        sv.time.value = t;
      }

      // The camera SNAPS while scrubbing (the engine's `jumpTo`) so it never sweeps across the
      // map chasing the finger; it only cross-fades for a deliberate cut.
      let cam: CameraState;
      if (cut) {
        cam = camera.jumpTo(s.replay, t);
        cutWall = now;
      } else if (scrubbing) {
        cam = camera.jumpTo(s.replay, t);
      } else {
        cam = camera.update(s.replay, t, dt);
        // a mode switch cuts inside the camera itself
        if (cam.cut) cutWall = now;
      }
      // The engine measures the 120 ms cross-fade in REPLAY time, which is right while the run
      // is playing (at half speed the cut is half as fast, like everything else) but never
      // advances while paused — so a cut made on a paused frame fades on the wall clock instead.
      const wallFade = clamp(1 - (now - cutWall) / 1000 / CAMERA_LIMITS.cutFadeS, 0, 1);
      const cutFade = Math.max(sv.playing.value === 1 ? cam.cutFade : 0, wallFade);

      // The camera frames the ACTION rectangle, which in portrait stops above the floating
      // transport. `worldToScreen` puts the centre at (w/2, h/2), so hand the renderer a state
      // whose half-extents ARE that rectangle's centre on screen: the mapping stays exact and the
      // engine's camera never has to know about the chrome.
      const act = actionRect(s.layout, camera.getMode());
      let cxs = act.x + act.w / 2;
      let cys = act.y + act.h / 2;
      // Safe frame. The engine's look-ahead is a distance in metres and its zoom is fitted to the
      // SHORTER side of the viewport, so on a tall portrait stage — and especially in cinematic,
      // which zooms in by up to 1.6x — the car can be pushed past the bottom of the band. This
      // slides the frame (not the camera) back along the same line until the car is inside it
      // again: the camera's own motion is untouched, and a car is never half off the screen.
      const pose = poseAt(s.replay, t);
      {
        const dx = pose.x - cam.cx;
        const dy = pose.y - cam.cy;
        const c = Math.cos(cam.rotation);
        const sn = Math.sin(cam.rotation);
        const offX = cam.zoom * (c * dx - sn * dy);
        const offY = -cam.zoom * (sn * dx + c * dy);
        const maxY = act.h * 0.32;
        const maxX = act.w * 0.34;
        if (offY > maxY) cys -= offY - maxY;
        else if (offY < -maxY) cys += -maxY - offY;
        if (offX > maxX) cxs -= offX - maxX;
        else if (offX < -maxX) cxs += -maxX - offX;
      }
      const camScreen: CameraState = { ...cam, w: 2 * cxs, h: 2 * cys };

      const chipNow = s.chip.current;
      // A paused frame is a poster frame: the chip that names the moment stays up until the run
      // is playing again, and only then fades.
      if (chipNow && sv.playing.value !== 1 && sv.scrubbing.value !== 1) chipNow.until = Math.max(chipNow.until, Date.now() + 200);
      const chipAlpha = chipNow ? clamp((chipNow.until - Date.now()) / 400, 0, 1) : 0;
      const moving = sv.playing.value === 1 || scrubbing || cutFade > 0 || chipAlpha > 0 || now < dirtyUntil.current;
      const inputs = `${s.fonts.hero ? 1 : 0}${s.fonts.label ? 1 : 0}${s.fonts.value ? 1 : 0}${s.fonts.clock ? 1 : 0}|${camera.getMode()}|${s.layout.w}x${s.layout.h}|${s.focusDriftId}|${s.view.replay.durationS}|${s.geo.segments.length}|${s.controlsVisible ? 1 : 0}`;
      if (!moving && t === lastDrawnT && inputs === lastInputs) return;
      lastDrawnT = t;
      lastInputs = inputs;

      const pic = createPicture(
        (canvas) => {
          drawReplayFrame(canvas, {
            replay: s.replay,
            view: s.view,
            geo: s.geo,
            layout: s.layout,
            fonts: s.fonts,
            res,
            t,
            mode: camera.getMode(),
            cam: camScreen,
            pose,
            ghost: ghostPoseAt(s.replay, t),
            events: activeEvents(s.replay, t),
            shake: shakeAt(s.replay, t),
            cutFade,
            ui: {
              playing: sv.playing.value === 1,
              rate: sv.rate.value,
              scrubbing,
              focusDriftId: s.focusDriftId,
              highlight: chipNow && chipAlpha > 0 ? { index: chipNow.index, total: chipNow.total, label: chipNow.label, alpha: chipAlpha } : null,
              warningsOpen: false,
              controlsVisible: s.controlsVisible,
              reduceMotion: s.reduceMotion,
            },
          });
        },
        { x: 0, y: 0, width: s.layout.w, height: s.layout.h },
      );
      picture.value = pic;
      // release the picture from two frames ago: by now it has been superseded and drawn past
      retired.push(pic);
      while (retired.length > 2) {
        const old = retired.shift();
        try {
          old?.dispose();
        } catch {
          // already released
        }
      }
    };

    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      for (const p of retired) {
        try {
          p.dispose();
        } catch {
          // already released
        }
      }
      retired.length = 0;
    };
  }, [camera, picture, res, sv]);

  return (
    <Canvas style={StyleSheet.absoluteFill} testID={testID}>
      <Picture picture={picture} />
    </Canvas>
  );
}
