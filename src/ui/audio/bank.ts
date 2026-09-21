/**
 * The sound bank: one row per thing that matters, and everything the mixer needs to decide what
 * a driver actually hears when three of them land inside 300 ms.
 *
 * ── The taxonomy is `src/ui/callouts.ts`, in sound ────────────────────────────────────────────
 * That file decides what colour an event wears, by what the colour MEANS rather than by which
 * screen shows it. This file makes the same call for the ear, and it must agree: the tone on
 * every row here is `toneFor(kind)` for the callout kinds it comes from, and the test asserts it.
 *
 * The rule that matters most is the one `callouts.ts` states outright — "an event that fires on
 * every drift carries no news". That is why INITIATION is painted muted there, and it is why
 * INITIATION here is the quietest clip in the bank (tier D, −27.9 dBFS RMS), has the lowest
 * priority, is the first voice to be stolen, and is suppressed outright whenever the same frame
 * carries a flick or a link. Measured over a real 130 s harbour run it fires on 8 of 8 drifts.
 *
 * ── What is deliberately SILENT ───────────────────────────────────────────────────────────────
 * Two callout kinds map to no clip at all, because a second sound for the same instant is not
 * news, it is mud:
 *
 *   `initiation`  fires on exactly the same frame as the phase edge idle→active (measured offset
 *                 0.000 s across every seed tried). The phase edge is what the drive display's
 *                 bloom and haptic already use, so the sound takes the edge and the callout is
 *                 silent. The edge also exists before the scorer has an opinion.
 *   `transition`  fires 0.40–0.42 s AFTER the phase edge into `transition`. The design gives the
 *                 flick a 120 ms magenta flash, a 100 ms screen shake and a haptic ON THE EDGE.
 *                 A whip 410 ms behind the flash is worse than no whip, so TRANSITION sounds on
 *                 the edge and the callout is silent. MANJI, which fires on the same frame as
 *                 the callout, is the badge landing and keeps its own sound.
 *
 * ── Levels ────────────────────────────────────────────────────────────────────────────────────
 * Clips are rendered to an RMS tier, not peak-normalised — see `tools/audio/render.mjs`. The
 * ladder runs −27.9 dBFS (initiation) to −17.1 dBFS (banked, grade), 10.8 dB across four tiers,
 * with clips inside a tier matched to better than 0.5 dB. So this module applies NO runtime gain
 * to one-shots: the mix is in the files, where it can be measured.
 */
import type { StyleCalloutKind } from '../../engine/types';
import type { EventTone } from '../callouts';
import { CLIP_MEASUREMENTS } from './waveforms';

/** Every clip in `assets/audio/`. */
export type SoundId =
  | 'initiation'
  | 'transition'
  | 'manji'
  | 'extreme'
  | 'long'
  | 'smooth'
  | 'exit'
  | 'speed'
  | 'link'
  | 'lap'
  | 'cleanlap'
  | 'banked'
  | 'lost'
  | 'spin'
  | 'stop'
  | 'grade'
  | 'bed-low'
  | 'bed-high';

/** The two continuous layers. They are cross-faded by |β| and never take a one-shot voice. */
export const BED_LOW: SoundId = 'bed-low';
export const BED_HIGH: SoundId = 'bed-high';

/**
 * The haptic vocabulary, named for what it means rather than for the platform enum, so the pure
 * layer never imports `expo-haptics`. `src/platform/haptics.ts` maps these to
 * `ImpactFeedbackStyle` / `NotificationFeedbackType` exactly as SDK 57 declares them.
 */
export type HapticShape = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid' | 'success' | 'warning' | 'error';

/**
 * A cue family. At most ONE cue per family survives a single frame — the highest priority one —
 * because the events inside a family are the same moment described twice.
 */
export type CueFamily = 'entry' | 'flick' | 'angle' | 'accent' | 'exit' | 'chain' | 'lap' | 'lapverdict' | 'run';

export interface SoundSpec {
  id: SoundId;
  /** File under `assets/audio/`. */
  file: string;
  /** What the driver is being told, in the HUD's own words where there is one. */
  label: string;
  /** Which event in the stream fires it. Shown in the `/sound` lab. */
  trigger: string;
  /** Must equal `toneFor(kind)` for the callout kinds this comes from — see `src/ui/callouts.ts`. */
  tone: EventTone;
  /** 0..100. A cue can steal a sounding voice only from something strictly lower. */
  priority: number;
  family: CueFamily;
  /**
   * Minimum wall seconds between two plays of this clip.
   *
   * Never below the clip's own length plus a margin, and `audio.test.ts` asserts it. That is not
   * a taste decision: it is what lets the native port keep ONE `AudioPlayer` per clip. A finished
   * AVPlayer has to be seeked back to 0 before it will play again, and doing that in the cue path
   * would put an un-awaited promise between the event and the sound. With this invariant the
   * rewind is a timer scheduled for `duration + 60 ms` after each play, which always lands before
   * the next possible retrigger — so a cue never meets a player that still needs seeking, and
   * a clip can never talk over itself.
   */
  minGapS: number;
  /**
   * True when the cue is dropped while the engine does not believe the reading
   * (`LiveFrame.integrity.believable`). False for facts that are true regardless of whether the
   * run is being judged — a lap closing, a control the driver pressed.
   */
  gated: boolean;
  /** The haptic that fires with it, or null when the event is colour rather than news. */
  haptic: HapticShape | null;
  /** A second haptic this long after the first. Only the grade reveal earns one. */
  hapticThen?: { shape: HapticShape; delayS: number };
  /** Why this sound is the way it is. Shown in the lab so the design is auditable, not asserted. */
  why: string;
}

/**
 * The bank, in the order a run meets it.
 *
 * PRIORITIES, and why they are in this order. The rule for ties is that the voice already
 * sounding keeps the floor, so the ladder only has to answer "if these two land together, which
 * one does the driver need?":
 *
 *   100 grade      the results screen, alone on stage
 *    98 stop       the driver's own action ending the run
 *    95 spin       it fires on the same frame as CHAIN LOST; the spin is the cause and the lost
 *                  chain only its consequence, so the cause wins
 *    88 lost       the chain is gone: money, and bad news
 *    85 banked     money, and good news
 *    75 manji      the milestone the design names
 *    72 extreme    gold: past the angle where holding more is remarkable
 *    70 transition the move with its own flash, shake and haptic
 *    68 cleanlap   a lap driven without a spin
 *    65 exit       the verdict on how the slide ended
 *    60 link       a chain is building — and it beats INITIATION on the frame they share
 *    45 long/smooth/speed   accents: they colour the run, they do not change it
 *    40 lap        the gate, which fires every lap
 *    20 initiation fires on every drift, so it loses every argument it is in
 */
export const SOUND_BANK: readonly SoundSpec[] = [
  {
    id: 'initiation',
    file: 'initiation.wav',
    label: 'INITIATION',
    trigger: 'phase edge idle → entry/drifting (not on a flick frame)',
    tone: 'muted',
    priority: 20,
    family: 'entry',
    minGapS: 0.6,
    gated: true,
    haptic: 'heavy',
    why: 'The tyres letting go. It fires on every single drift, so by the rule in callouts.ts it carries no news: quietest clip, lowest priority, first to be stolen. The haptic stays HEAVY because the design gives drift entry a heavy impact and a driver feels one buzz far better than they hear one chirp.',
  },
  {
    id: 'transition',
    file: 'transition.wav',
    label: 'TRANSITION',
    trigger: 'phase edge → transition (0.41 s BEFORE the transition callout)',
    tone: 'magenta',
    priority: 70,
    family: 'flick',
    minGapS: 0.42,
    gated: true,
    haptic: 'medium',
    why: 'The flick: a whip, a crack and a magenta stab. It rides the phase edge, with the 120 ms flash, the 2 px shake and the medium haptic — the callout that names it arrives 410 ms later and is deliberately silent.',
  },
  {
    id: 'manji',
    file: 'manji.wav',
    label: 'MANJI',
    trigger: "callout 'manji'",
    tone: 'magenta',
    priority: 75,
    family: 'flick',
    minGapS: 0.6,
    gated: true,
    haptic: 'rigid',
    why: 'Three whips in a triplet — the same magenta timbre as TRANSITION so the family is obvious. Rigid rather than Medium: a tight, crisp tick on top of the flick that is already being felt, not a second thump.',
  },
  {
    id: 'extreme',
    file: 'extreme.wav',
    label: 'EXTREME ANGLE',
    trigger: "callout 'extreme-angle'",
    tone: 'gold',
    priority: 72,
    family: 'angle',
    minGapS: 0.75,
    gated: true,
    haptic: 'rigid',
    why: 'Gold. A resonant sweep climbing with a detuned fifth under it and one metallic glint — hot rather than congratulatory, because the driver is at 48 degrees and busy. Rigid haptic: a hard edge, the feeling of a limit.',
  },
  {
    id: 'long',
    file: 'long.wav',
    label: 'LONG DRIFT',
    trigger: "callout 'long-drift'",
    tone: 'ember',
    priority: 45,
    family: 'accent',
    minGapS: 0.55,
    gated: true,
    haptic: null,
    why: 'A warm ember swell with a 45 ms attack and no transient at all, so it reads as held rather than happened. No haptic: an accent that buzzed the phone would make the three accents into a stutter.',
  },
  {
    id: 'smooth',
    file: 'smooth.wav',
    label: 'SMOOTH',
    trigger: "callout 'smooth'",
    tone: 'green',
    priority: 45,
    family: 'accent',
    minGapS: 0.5,
    gated: true,
    haptic: null,
    why: 'Green is cleanliness, and cleanliness is the absence of drama: breath and two quiet notes a fifth apart, no attack worth the name. No haptic, for the same reason as LONG DRIFT.',
  },
  {
    id: 'speed',
    file: 'speed.wav',
    label: 'HIGH SPEED',
    trigger: "callout 'high-speed'",
    tone: 'cyan',
    priority: 45,
    family: 'accent',
    minGapS: 0.5,
    gated: true,
    haptic: null,
    why: 'Cyan, matching the telemetry it is read beside: cold air climbing, one thin sine on top, the brightest clip in the bank at 5.2 kHz. Nothing warm, nothing low, no haptic.',
  },
  {
    id: 'link',
    file: 'link.wav',
    label: 'LINK',
    trigger: "callout 'link' (same frame as the entry edge)",
    tone: 'ember',
    priority: 60,
    family: 'entry',
    minGapS: 0.55,
    gated: true,
    haptic: 'heavy',
    why: 'Two ember stabs a fourth apart — the only rising two-note figure in the bank, because a chain building is the one thing in a run that promises more. It shares the `entry` family with INITIATION and outranks it, so on the frame they both fire the driver hears the news and not the routine.',
  },
  {
    id: 'exit',
    file: 'exit.wav',
    label: 'PERFECT EXIT',
    trigger: "callout 'perfect-exit' (0.60 s after the exit edge)",
    tone: 'green',
    priority: 65,
    family: 'exit',
    minGapS: 0.65,
    gated: true,
    haptic: 'soft',
    why: 'The only figure in the bank that resolves downward: tyres hooking up, then a two-note settle. It is the scorer\'s verdict, not the moment the car straightened — the bed\'s own 240 ms release covers that. Soft haptic: a cushioned landing, the physical opposite of SPIN.',
  },
  {
    id: 'lap',
    file: 'lap.wav',
    label: 'LAP',
    trigger: 'lap.completed',
    tone: 'cyan',
    priority: 40,
    family: 'lap',
    minGapS: 1,
    gated: false,
    haptic: null,
    why: 'Two cold pings, a fifth apart, gone in a third of a second. It fires on every lap, so it carries no verdict and gets no haptic — the verdict is CLEAN LAP. Ungated: a lap is a fact about the track, true whether or not the engine believes the slides.',
  },
  {
    id: 'cleanlap',
    file: 'cleanlap.wav',
    label: 'CLEAN LAP',
    trigger: "callout 'clean-lap' (about 10 ms after lap.completed)",
    tone: 'green',
    priority: 68,
    family: 'lapverdict',
    minGapS: 1,
    gated: true,
    haptic: 'success',
    why: 'Designed to LAYER over the gate pings rather than replace them — a soft triad with no transient, arriving 10 ms behind them, so a clean lap sounds like ping-ping-settle and a dirty one just like ping-ping. Success notification: a lap driven clean is literally a task completed.',
  },
  {
    id: 'banked',
    file: 'banked.wav',
    label: 'BANKED',
    trigger: 'score.banked',
    tone: 'ember',
    priority: 85,
    family: 'chain',
    minGapS: 1.0,
    gated: true,
    haptic: 'success',
    why: 'A riser pulling up for 300 ms, a thunk on the beat, a gold shimmer paying out. Tier A and the loudest thing in a run, because it is the only moment where points stop being at risk.',
  },
  {
    id: 'lost',
    file: 'lost.wav',
    label: 'CHAIN LOST',
    trigger: 'score.lost',
    tone: 'red',
    priority: 88,
    family: 'chain',
    minGapS: 0.85,
    gated: true,
    haptic: 'warning',
    why: 'Two saws detuned enough to beat against each other, sliding down a minor third into a closing filter, and never resolving. Nothing metallic, nothing bright: a loss should not sparkle. Warning rather than Error — the chain is gone, the run is not.',
  },
  {
    id: 'spin',
    file: 'spin.wav',
    label: 'SPIN',
    trigger: 'completed.spin (same frame as score.lost)',
    tone: 'red',
    priority: 95,
    family: 'chain',
    minGapS: 1.05,
    gated: true,
    haptic: 'error',
    why: 'The only genuinely unpleasant sound in the bank: a long scrub with the wheel juddering through it at 23 Hz, a squeal falling away, a crunch. It outranks CHAIN LOST on the frame they share because the spin is the cause and the lost chain only its consequence. Error notification, the strongest negative the API has.',
  },
  {
    id: 'stop',
    file: 'stop.wav',
    label: 'STOP',
    trigger: 'the STOP control',
    tone: 'muted',
    priority: 98,
    family: 'run',
    minGapS: 1,
    gated: false,
    haptic: 'medium',
    why: 'Not a UI beep: the run ending the way an engine stops — a click under the thumb, a band of noise falling away, a sub sliding to nothing. Ungated, because the driver pressed it and a control that sometimes answers is worse than one that never does.',
  },
  {
    id: 'grade',
    file: 'grade.wav',
    label: 'GRADE',
    trigger: 'the grade reveal on /results',
    tone: 'gold',
    priority: 100,
    family: 'run',
    minGapS: 2,
    gated: false,
    haptic: 'heavy',
    hapticThen: { shape: 'success', delayS: 0.14 },
    why: 'The most cinematic 1.6 s in the app: an impact, a shockwave sweeping 7 kHz down to the floor, an ember chord blooming behind it with one gold bell — the letterbox slam, the shockwave ring and the ember particles, in sound. Two haptics 140 ms apart because the API has no "boom": Heavy is the letter landing, Success is the ring going out.',
  },
];

const BY_ID = new Map<SoundId, SoundSpec>(SOUND_BANK.map((s) => [s.id, s]));

export function specFor(id: SoundId): SoundSpec | undefined {
  return BY_ID.get(id);
}

/** Every file the bank needs, one-shots and beds. */
export const AUDIO_FILES: readonly string[] = [...SOUND_BANK.map((s) => s.file), 'bed-low.wav', 'bed-high.wav'];

/**
 * How long a clip holds its voice, in seconds — the last instant it is above −40 dB relative to
 * its own peak, measured off the rendered WAV. Not the file length: an exponential tail means
 * `extreme` is a 0.640 s file whose last 0.124 s is inaudible, and holding a voice for silence
 * drops cues that should have played.
 */
export function voiceLifetimeS(id: SoundId): number {
  return CLIP_MEASUREMENTS[id]?.activeS ?? 0.5;
}

/**
 * Callout kind → clip. `null` is a deliberate silence, not a gap — see the header.
 *
 * Every non-null entry's tone must equal `toneFor(kind)`; `audio.test.ts` checks it, so a future
 * change to the colour taxonomy cannot silently leave the sound taxonomy behind.
 */
export const CALLOUT_SOUND: Record<StyleCalloutKind, SoundId | null> = {
  initiation: null,
  transition: null,
  'extreme-angle': 'extreme',
  'long-drift': 'long',
  smooth: 'smooth',
  'high-speed': 'speed',
  manji: 'manji',
  link: 'link',
  'perfect-exit': 'exit',
  'clean-lap': 'cleanlap',
};
