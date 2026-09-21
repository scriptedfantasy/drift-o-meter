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
 * carries a flick or a link.
 *
 * It applies to LOUDNESS as much as to colour, and for two rounds it was applied to one event
 * and broken on another. Measured through the real pipeline (`npx tsx tools/audio/coverage.ts`),
 * harbour seeds 1/2/3 over two laps: BANKED fired 7, 6 and 7 times across 8 drifts — 0.75 to
 * 0.88 per drift, one every 18.6–21.7 s — while INITIATION fired 0.75 to 1.00 per drift. The
 * same cadence. One of them was tier A, the loudest clip in the bank, and the other tier D
 * because of that cadence. BANKED is now tier B with the rest of the drift beats, and tier A
 * holds only what happens once in a run or not at all: SPIN and the GRADE reveal.
 *
 * INITIATION, precisely. It rides the PHASE EDGE, not the callout, and harbour seed 1 over two
 * laps has 14 of those: 8 drifts plus 6 re-entries after a flick. Seven are played, six are
 * swallowed by the flick rule and one loses its family to LINK. "8 of 8 drifts" was the old
 * wording and it was measuring the wrong thing.
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
 *                 flick a magenta flash, a 100 ms screen shake and a haptic ON THE EDGE.
 *                 A whip 410 ms behind the flash is worse than no whip, so TRANSITION sounds on
 *                 the edge and the callout is silent. MANJI, which fires on the same frame as
 *                 the callout, is the badge landing and keeps its own sound.
 *
 *                 NO DURATION IS QUOTED FOR THAT FLASH, deliberately. This row used to say "the
 *                 120 ms flash", taken from docs/DESIGN.md; the flash `useDriveRun.ts` actually
 *                 runs is `withTiming(1, 40)` then `withTiming(0, 140)`, i.e. 180 ms. The number
 *                 lives in a file this module must not import (it is React), so rather than keep
 *                 a third copy of it in prose that nothing can fail on, the sentence says what is
 *                 true without it. What matters here is the ORDER — sound, flash, shake and
 *                 haptic all on the edge — not how long the flash lasts.
 *
 * ── What is deliberately FELT and never heard ─────────────────────────────────────────────────
 * One row — EXIT EDGE — has no file at all. docs/DESIGN.md § Motion language gives the exit a
 * "haptic light" and no sound of its own: the bed's 240 ms release IS the sound of the car
 * straightening. But the haptic was missing, and with it the only beat a driver gets at the end
 * of a slide without looking. Measured over 18 runs on both tracks, 102 slides really ended and
 * the exit family spoke for 5 of 14 of them on harbour seed 1 and 0 of 6 on touge seed 7,
 * because the only exit-family row was bound to the `perfect-exit` callout, which the scorer
 * withholds on most slides. So the edge gets a beat of its own, felt and silent.
 *
 * IT WAITS `EXIT_SETTLE_S`, and that is a measurement too. The phase edge fires on the dip in
 * the middle of a flick as well as at the end of a slide: across those 18 runs, 95 of 197 exit
 * edges were followed by a re-entry inside a second, 82 of them inside 150 ms. A beat on each
 * would turn a manji into a stutter of light-medium-light-medium. Holding the beat for 200 ms
 * and cancelling it if the car goes again drops 84 of those 95 and keeps all 102 real endings —
 * and the 11 that survive are slides that really did straighten before going again, which is
 * worth a beat. The detector's own verdict is no help here: `completed` arrives 0.99–1.01 s
 * after the edge, far too late to be the feeling of a landing.
 *
 * ── Levels ────────────────────────────────────────────────────────────────────────────────────
 * Clips are rendered to an RMS tier, not peak-normalised — see `tools/audio/render.mjs`. The
 * ladder runs −27.9 dBFS (initiation) to −17.1 dBFS (grade), 10.8 dB across four tiers, with
 * clips inside a tier matched to 0.55 dB or better (tier B is the widest: manji −21.04 to
 * exit/cleanlap −20.49). So this module applies NO runtime gain to one-shots: the mix is in the
 * files, where it can be measured.
 */
import type { StyleCalloutKind } from '../../engine/types';
import type { EventTone } from '../callouts';
import { CLIP_MEASUREMENTS } from './waveforms';

/**
 * Every cue the bank can fire. All but one name a clip in `assets/audio/`; `exit-edge` is felt
 * and never heard — see "What is deliberately FELT" above.
 */
export type SoundId =
  | 'initiation'
  | 'transition'
  | 'manji'
  | 'extreme'
  | 'long'
  | 'smooth'
  | 'exit'
  | 'exit-edge'
  | 'speed'
  | 'link'
  | 'lap'
  | 'cleanlap'
  | 'banked'
  | 'lost'
  | 'spin'
  | 'fault'
  | 'recovered'
  | 'stop'
  | 'grade'
  | 'grade-low'
  | 'bed-low'
  | 'bed-high';

/** The ids that name a file, which is every id but the one that is only felt. */
export type ClipId = Exclude<SoundId, 'exit-edge'>;

/** The two continuous layers. They are cross-faded by |β| and never take a one-shot voice. */
export const BED_LOW: ClipId = 'bed-low';
export const BED_HIGH: ClipId = 'bed-high';

/**
 * How long the exit beat waits on the phase edge before it is felt, and the window in which a
 * re-entry cancels it. 200 ms: see the header — it drops 84 of the 95 measured flick dips and
 * keeps every one of the 102 measured slide endings.
 */
export const EXIT_SETTLE_S = 0.2;

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
export type CueFamily = 'entry' | 'flick' | 'angle' | 'accent' | 'exit' | 'chain' | 'lap' | 'lapverdict' | 'fault' | 'run';

export interface SoundSpec {
  id: SoundId;
  /** File under `assets/audio/`, or `null` for a cue that is only ever felt. */
  file: string | null;
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
   * Never below the clip's own length plus the port's rewind margin plus slack, and
   * `audio.test.ts` asserts it against `REWIND_MARGIN_S` itself. That is not a taste decision: it
   * is what lets the native port keep ONE `AudioPlayer` per clip. A finished AVPlayer has to be
   * seeked back to 0 before it will play again, and doing that in the cue path would put an
   * un-awaited promise between the event and the sound. With this invariant the rewind is a timer
   * scheduled for `duration + REWIND_MARGIN_S` after each play, which always lands before the next
   * possible retrigger — so a cue never meets a player that still needs seeking, and a clip can
   * never talk over itself.
   *
   * THE TEST USED TO ASSERT THE WRONG NUMBER. It required `durationS + 0.05`, which is 10 ms
   * BEFORE the rewind timer fires, so it would have passed a bank entry that breaks the port's
   * own guarantee — and the tightest row, `transition`, left 20 ms between an issued async
   * `seekTo(0)` and the next possible `play()`. Every row now clears `durationS +
   * REWIND_MARGIN_S + MIN_GAP_SLACK_S`, and the numbers below were widened to do it.
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
 *   100 grade/grade-low  the results screen, alone on stage
 *    98 stop       the driver's own action ending the run
 *    95 spin       it fires on the same frame as CHAIN LOST; the spin is the cause and the lost
 *                  chain only its consequence, so the cause wins
 *    90 fault/recovered  the instrument, not the drive: the one thing the driver cannot work out
 *                  from the silence itself is WHY it is silent
 *    88 lost       the chain is gone: money, and bad news
 *    85 banked     money, and good news
 *    75 manji      the milestone the design names
 *    72 extreme    gold: past the angle where holding more is remarkable
 *    70 transition the move with its own flash, shake and haptic
 *    68 cleanlap   a lap driven without a spin
 *    65 exit       the verdict on how the slide ended
 *    64 exit-edge  the landing itself, 600 ms earlier and felt rather than heard
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
    minGapS: 0.46,
    gated: true,
    haptic: 'medium',
    why: 'The flick: a whip, a crack and a magenta stab. It rides the phase edge, with the magenta flash, the 2 px shake and the medium haptic — the callout that names it arrives 410 ms later and is deliberately silent.',
  },
  {
    id: 'manji',
    file: 'manji.wav',
    label: 'MANJI',
    trigger: "callout 'manji'",
    tone: 'magenta',
    priority: 75,
    family: 'flick',
    minGapS: 0.62,
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
    minGapS: 0.76,
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
    minGapS: 0.58,
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
    minGapS: 0.54,
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
    minGapS: 0.54,
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
    minGapS: 0.56,
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
    minGapS: 0.68,
    gated: true,
    haptic: 'soft',
    why: 'The only figure in the bank that resolves downward: tyres hooking up, then a two-note settle. It is the scorer\'s verdict, not the moment the car straightened — the bed\'s own 240 ms release covers that. Soft haptic: a cushioned landing, the physical opposite of SPIN.',
  },
  {
    id: 'exit-edge',
    file: null,
    label: 'EXIT',
    trigger: `phase edge active → idle, held ${EXIT_SETTLE_S.toFixed(2)} s in case the car goes again`,
    tone: 'green',
    priority: 64,
    family: 'exit',
    minGapS: 0.45,
    gated: true,
    haptic: 'light',
    why: `The landing, felt. docs/DESIGN.md gives the exit a light haptic and no sound of its own — the bed's 240 ms release is the sound — and this is the row that finally delivers it. It has no clip on purpose: a driver with the phone on silent, or with sound off, still gets a beat at the end of every slide, which is the one moment of a drift that has no visual event either. It waits ${Math.round(EXIT_SETTLE_S * 1000)} ms so the dip in the middle of a flick cannot turn a manji into a stutter.`,
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
    minGapS: 1.02,
    gated: true,
    haptic: 'success',
    why: 'A riser pulling up for 300 ms, a thunk on the beat, a gold shimmer paying out. Tier B, with the rest of the drift beats: measured through the real pipeline it fires 0.50 to 1.11 times per drift (npx tsx tools/audio/coverage.ts, eight runs over both tracks), and by the rule in callouts.ts an event on every drift carries no news however good the news is. The loudest tier is kept for SPIN and the grade reveal, which happen once in a run or not at all.',
  },
  {
    id: 'lost',
    file: 'lost.wav',
    label: 'CHAIN LOST',
    trigger: 'score.lost',
    tone: 'red',
    priority: 88,
    family: 'chain',
    minGapS: 0.86,
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
    minGapS: 1.06,
    gated: true,
    haptic: 'error',
    why: 'The only genuinely unpleasant sound in the bank: a long scrub with the wheel juddering through it at 23 Hz, a squeal falling away, a crunch. It outranks CHAIN LOST on the frame they share because the spin is the cause and the lost chain only its consequence. Error notification, the strongest negative the API has.',
  },
  {
    id: 'fault',
    file: 'fault.wav',
    label: 'NOT BELIEVED',
    trigger: 'the belief gate drops a cue for the first time',
    tone: 'red',
    priority: 90,
    family: 'fault',
    minGapS: 0.56,
    gated: false,
    haptic: 'warning',
    why: 'The one thing a driver cannot work out from silence is why it is silent. Before this row existed, a hand-held recording (harbour seed 1, 2 laps, looseness 1, GPS dropouts) offered the mixer 56 cues, played none of them and fired no haptic for two whole laps, while the detector was finding 44 entry edges. Exactly one sound now comes out of that run, and this is it. It fires when the gate actually COSTS a cue, not on the belief flag itself: every clean run is unbelievable for its first five seconds while the calibrator finds forward, offers nothing in that time, and so is never told off for it. Ungated by definition, and latched — once per fault, never a nag. Both halves are printed by tools/audio/coverage.ts.',
  },
  {
    id: 'recovered',
    file: 'recovered.wav',
    label: 'BELIEVED AGAIN',
    trigger: 'the engine believes the reading again, after a FAULT',
    tone: 'green',
    priority: 90,
    family: 'fault',
    minGapS: 0.56,
    gated: false,
    haptic: 'success',
    why: 'FAULT\'s inverse, and the reason FAULT is allowed to be a latch: the same two pulses rising instead of falling, so the driver knows the channel is back without having to test it. It can only fire after a FAULT, so a run that was believed all along never hears it.',
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
    why: 'The most cinematic 1.6 s in the app: an impact, a shockwave sweeping 7 kHz down to the floor, an ember chord blooming behind it with one gold bell — the letterbox slam, the shockwave ring and the ember particles, in sound. Two haptics 140 ms apart because the API has no "boom": Heavy is the letter landing, Success is the ring going out. S, A and B only; below that the reveal is GRADE (C/D).',
  },
  {
    id: 'grade-low',
    file: 'grade-low.wav',
    label: 'GRADE (C/D)',
    trigger: 'the grade reveal on /results, below the B threshold',
    tone: 'muted',
    priority: 100,
    family: 'run',
    minGapS: 2,
    gated: false,
    haptic: 'heavy',
    why: 'The same 1.65 s figure with the gold taken out of it: same impact, same sub drop, same shockwave (swept from 3.4 kHz instead of 7), same chord bloom an octave lower with a minor third where the octave was — and no bell, no shimmer, no Success notification. src/ui/theme.ts paints a D muted and a C plain text, and the results screen draws the letter in that colour; a gold fanfare and a Success buzz under the word "Rough" is the screen and the feel layer telling the driver two different things. Heavy alone: the letter still lands.',
  },
];

const BY_ID = new Map<SoundId, SoundSpec>(SOUND_BANK.map((s) => [s.id, s]));

export function specFor(id: SoundId): SoundSpec | undefined {
  return BY_ID.get(id);
}

/** Every file the bank needs, one-shots and beds. `exit-edge` has none: it is only felt. */
export const AUDIO_FILES: readonly string[] = [
  ...SOUND_BANK.map((s) => s.file).filter((f): f is string => f !== null),
  'bed-low.wav',
  'bed-high.wav',
];

/**
 * How long a clip holds its voice, in seconds — the last instant it is above −40 dB relative to
 * its own peak, measured off the rendered WAV. Not the file length: an exponential tail means
 * `extreme` is a 0.640 s file whose last 0.124 s is inaudible, and holding a voice for silence
 * drops cues that should have played.
 *
 * A cue with no file takes no voice at all, so its lifetime is zero.
 */
export function voiceLifetimeS(id: SoundId): number {
  if (specFor(id)?.file === null) return 0;
  return CLIP_MEASUREMENTS[id]?.activeS ?? 0.5;
}

/**
 * Which reveal a grade gets, and the one place the feel layer is allowed to know about letters.
 *
 * `src/ui/theme.ts` paints S gold, A ember, B cyan, C plain text and D muted, and the results
 * screen draws the letter in that colour. The bank has two renders of the same 1.65 s figure so
 * the ear can agree with it: the gold one above the B threshold, the unlit one below. This is a
 * mapping, not a threshold copied from somewhere else — the letters are the engine's own
 * (`Grade` in `src/engine/types.ts`) and the split is the same one `gradeColors` makes when it
 * stops using an accent colour.
 */
export function gradeCueFor(grade: 'S' | 'A' | 'B' | 'C' | 'D'): SoundId {
  return grade === 'C' || grade === 'D' ? 'grade-low' : 'grade';
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
