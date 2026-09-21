/**
 * The feel layer: sound and haptics for the run, from one taxonomy.
 *
 * The directory is called `audio` because that is the larger half, but the haptics live here
 * too, deliberately. A drift entry is one EVENT; it has a colour (`src/ui/callouts.ts`), a clip
 * and a haptic, and the three have to agree about what matters. Splitting the haptic into its
 * own module would mean a second copy of the event taxonomy, the priority rules and the settings
 * gate — and the two copies would drift, the way the callout colours already did once.
 *
 * The two settings stay independent: a driver who turns sound off still feels the run, and a
 * driver who turns haptics off still hears it.
 *
 *   src/ui/audio/bank.ts         what every event sounds like, feels like and outranks
 *   src/ui/audio/mixer.ts        the scheduler: families, voice stealing, the bed, the gates
 *   src/ui/audio/useDriftFeel.ts the screen lifecycle and the one-line call sites
 *   src/ui/audio/sources.ts      the `require()`d WAVs (Metro only)
 *   src/ui/audio/waveforms.ts    generated: measured levels + peak envelopes
 *   src/ui/audio/sequences.ts    generated: real moments the lab replays, and where they happened
 *   src/platform/audio.ts|.web   expo-audio / Web Audio
 *   src/platform/haptics.ts|.web expo-haptics / a recorder
 *   tools/audio/render.mjs       the synthesiser that produces assets/audio/*.wav
 *   tools/audio/trace-grade.mjs  does the grade reveal still sound when the bank is slow?
 */
export * from './bank';
export {
  BED_ATTACK_TAU,
  BED_FLOOR_DEG,
  BED_RELEASE_TAU,
  BED_SPAN_DEG,
  DriftFeel,
  sequenceInstants,
  trustIn,
  type CueDecision,
  type CueOutcome,
  type FeelOptions,
  type FeelStats,
  type HapticPort,
  type SoundPort,
} from './mixer';
export { driftFeel, feelCue, feelCues, feelCueWhenReady, feelFrame, feelReset, useDriftFeel, type FeelStatus } from './useDriftFeel';
export { CLIP_MEASUREMENTS, TIER_TARGETS, type ClipMeasurement } from './waveforms';
export { SOUND_SEQUENCES, type SoundSequence } from './sequences';
