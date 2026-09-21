/**
 * The bundled clips, as Metro asset references.
 *
 * This is the ONLY module that `require()`s the WAVs, so every other file in the feel layer —
 * the bank, the mixer, the tests, the bench — stays plain TypeScript that runs under node. Metro
 * resolves `.wav` out of the box (it is in `metro-config`'s default `assetExts`), and on web the
 * export copies each file into `dist/assets/` and `expo-asset`'s `Asset.fromModule` hands back
 * its URL.
 *
 * `require` rather than `import`, because Metro's asset plugin only understands the former and
 * because the map has to be a literal: a computed `require('../../../assets/audio/' + id)` is
 * not statically analysable and the files would not be bundled at all.
 */
import type { ClipId } from './bank';

/** Asset module ids. A Metro asset `require` evaluates to a number. */
export const AUDIO_SOURCES: Record<ClipId, number> = {
  initiation: require('../../../assets/audio/initiation.wav'),
  transition: require('../../../assets/audio/transition.wav'),
  manji: require('../../../assets/audio/manji.wav'),
  extreme: require('../../../assets/audio/extreme.wav'),
  long: require('../../../assets/audio/long.wav'),
  smooth: require('../../../assets/audio/smooth.wav'),
  exit: require('../../../assets/audio/exit.wav'),
  speed: require('../../../assets/audio/speed.wav'),
  link: require('../../../assets/audio/link.wav'),
  lap: require('../../../assets/audio/lap.wav'),
  cleanlap: require('../../../assets/audio/cleanlap.wav'),
  banked: require('../../../assets/audio/banked.wav'),
  lost: require('../../../assets/audio/lost.wav'),
  spin: require('../../../assets/audio/spin.wav'),
  stop: require('../../../assets/audio/stop.wav'),
  grade: require('../../../assets/audio/grade.wav'),
  'grade-low': require('../../../assets/audio/grade-low.wav'),
  fault: require('../../../assets/audio/fault.wav'),
  recovered: require('../../../assets/audio/recovered.wav'),
  'bed-low': require('../../../assets/audio/bed-low.wav'),
  'bed-high': require('../../../assets/audio/bed-high.wav'),
};
