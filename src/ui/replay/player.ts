/**
 * Playback state for the replay screen.
 *
 * The clock is a Reanimated shared value, not React state: the frame loop in `ReplayCanvas`
 * advances it and the scrub gesture writes it straight from the gesture handler, so the picture
 * follows the finger on the very next frame without a single re-render. React only ever sees the
 * things that are words on a button — play/pause, the speed, the camera mode, which highlight is
 * selected — and those change when a human taps, not sixty times a second.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

import type { CameraMode, Replay } from '../../engine/replay';
import { clamp } from '../../engine/types';
import { nearestRate } from './params';

export interface PlayerSignals {
  /** Current replay time, seconds. Written by the loop, the gesture and every seek. */
  time: SharedValue<number>;
  playing: SharedValue<number>;
  rate: SharedValue<number>;
  /** 1 while the scrubber is held. */
  scrubbing: SharedValue<number>;
  /** Where the finger is, in replay seconds (only meaningful while scrubbing). */
  scrubT: SharedValue<number>;
  /** A pending discrete seek, or NaN. The loop consumes it and CUTS the camera there. */
  seekT: SharedValue<number>;
}

export interface HighlightChip {
  /** 1-based rank, or 0 for a chip that is not a highlight (a deep-linked drift). */
  index: number;
  total: number;
  label: string;
  /** Wall-clock ms after which the chip is gone. */
  until: number;
}

export interface ReplayPlayer {
  sv: PlayerSignals;
  playing: boolean;
  rate: number;
  mode: CameraMode;
  /** Which highlight the transport is sitting on, or -1. */
  highlightIndex: number;
  /** The drift the screen was deep-linked to, if any. */
  focusDriftId: number | null;
  chip: React.RefObject<HighlightChip | null>;
  toggle(): void;
  setPlaying(v: boolean): void;
  setRate(r: number): void;
  setMode(m: CameraMode): void;
  /** Seek, cutting the camera (deep link, highlight jump, tap on the timeline). */
  seek(t: number, opts?: { play?: boolean }): void;
  jumpToHighlight(index: number): void;
  nextHighlight(): void;
  prevHighlight(): void;
  focusDrift(id: number): void;
}

export interface PlayerOptions {
  startT: number;
  startMode: CameraMode;
  startRate: number;
  autoplay: boolean;
}

/** How long the chip that names a jumped-to moment stays up, ms. */
export const CHIP_MS = 2600;

export function useReplayPlayer(replay: Replay | null, opts: PlayerOptions): ReplayPlayer {
  const time = useSharedValue(opts.startT);
  const playing = useSharedValue(opts.autoplay ? 1 : 0);
  const rate = useSharedValue(opts.startRate);
  const scrubbing = useSharedValue(0);
  const scrubT = useSharedValue(opts.startT);
  const seekT = useSharedValue(NaN);
  const [playingState, setPlayingState] = useState(opts.autoplay);
  const [rateState, setRateState] = useState(opts.startRate);
  const [mode, setModeState] = useState<CameraMode>(opts.startMode);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [focusDriftId, setFocusDriftId] = useState<number | null>(null);
  const chip = useRef<HighlightChip | null>(null);

  const sv = useMemo<PlayerSignals>(() => ({ time, playing, rate, scrubbing, scrubT, seekT }), [time, playing, rate, scrubbing, scrubT, seekT]);

  const setPlaying = useCallback(
    (v: boolean) => {
      // restarting from the end plays the run again rather than sitting on the last frame
      if (v && replay && time.value >= replay.durationS - 0.02) {
        time.value = 0;
        seekT.value = 0;
      }
      playing.value = v ? 1 : 0;
      setPlayingState(v);
    },
    [playing, replay, seekT, time],
  );

  const toggle = useCallback(() => setPlaying(playing.value !== 1), [playing, setPlaying]);

  const setRate = useCallback(
    (r: number) => {
      const v = nearestRate(r);
      rate.value = v;
      setRateState(v);
    },
    [rate],
  );

  const setMode = useCallback((m: CameraMode) => setModeState(m), []);

  const seek = useCallback(
    (t: number, o: { play?: boolean } = {}) => {
      if (!replay) return;
      const v = clamp(t, 0, replay.durationS);
      time.value = v;
      scrubT.value = v;
      seekT.value = v;
      if (o.play !== undefined) setPlaying(o.play);
    },
    [replay, scrubT, seekT, setPlaying, time],
  );

  const jumpToHighlight = useCallback(
    (index: number) => {
      if (!replay || replay.highlights.length === 0) return;
      const i = ((index % replay.highlights.length) + replay.highlights.length) % replay.highlights.length;
      const h = replay.highlights[i];
      setHighlightIndex(i);
      setFocusDriftId(h.driftId ?? null);
      chip.current = { index: i + 1, total: replay.highlights.length, label: h.label, until: Date.now() + CHIP_MS };
      // start a little before the moment so the jump lands on the run-up, not the aftermath
      seek(h.inT + Math.min(0.6, Math.max(0, h.t - h.inT) * 0.25), { play: true });
    },
    [replay, seek],
  );

  const nextHighlight = useCallback(() => jumpToHighlight(highlightIndex + 1), [highlightIndex, jumpToHighlight]);
  const prevHighlight = useCallback(() => jumpToHighlight(highlightIndex - 1), [highlightIndex, jumpToHighlight]);

  const focusDrift = useCallback(
    (id: number) => {
      if (!replay) return;
      const seg = replay.segments.find((s) => s.driftId === id);
      if (!seg) return;
      setFocusDriftId(id);
      const hi = replay.highlights.findIndex((h) => h.driftId === id);
      setHighlightIndex(hi);
      const angle = Math.round((seg.peakAngle * 180) / Math.PI);
      chip.current = { index: 0, total: 0, label: `${angle}° · ${seg.durationS.toFixed(1)}S`, until: Date.now() + CHIP_MS };
    },
    [replay],
  );

  return {
    sv,
    playing: playingState,
    rate: rateState,
    mode,
    highlightIndex,
    focusDriftId,
    chip,
    toggle,
    setPlaying,
    setRate,
    setMode,
    seek,
    jumpToHighlight,
    nextHighlight,
    prevHighlight,
    focusDrift,
  };
}
