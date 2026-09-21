/**
 * Native sound port — expo-audio 57.0.5. (Web: `audio.web.ts`.)
 *
 * Everything here is written against the installed type declarations, not from memory:
 *   node_modules/expo-audio/build/ExpoAudio.d.ts        createAudioPlayer, setAudioModeAsync
 *   node_modules/expo-audio/build/Audio.types.d.ts      AudioMode, AudioPlayerOptions
 *   node_modules/expo-audio/build/AudioModule.types.d.ts AudioPlayer (play/pause/seekTo/volume/loop/remove)
 *
 * ── Mixing with the driver's music ────────────────────────────────────────────────────────────
 * Someone drifting is listening to their own music, so this app is a guest on the audio session.
 * Three settings do that, and each one is quoted from `Audio.types.d.ts` where it is declared:
 *
 *   interruptionMode: 'mixWithOthers'
 *     ".d.ts: 'Audio plays alongside other apps without interrupting them. On Android, this means
 *      no audio focus is requested. Best suited for sound effects, UI feedback, or short audio
 *      clips.'" — that is exactly what this bank is. The alternatives are 'doNotMix', which pauses
 *      the driver's music outright, and 'duckOthers', which pulls it down under every chirp; a
 *      HUD that ducked the stereo eight times a lap would be turned off in one drive.
 *
 *   playsInSilentMode: false
 *     ".d.ts: 'Determines if audio playback is allowed when the device is in silent mode. On
 *      Android, when false, playback is suppressed when the ringer mode is silent or vibrate.'"
 *      The DEFAULT is true — i.e. ignore the silent switch — so this has to be set explicitly.
 *      A phone flicked to silent is a driver saying "not now", and the haptics still carry the
 *      run.
 *
 *   keepAudioSessionActive: true  (per player, AudioPlayerOptions)
 *     ".d.ts: 'If set to true, the audio session will not be deactivated when this player pauses
 *      or finishes playback. This prevents interrupting other audio sources (like videos) when
 *      the audio ends.'" Without it, every one-shot ending would deactivate the session and
 *      bump whatever else is playing — sixty times a run.
 *
 * `shouldPlayInBackground: false` and `allowsRecording: false` are the defaults, set explicitly
 * so the whole session configuration is readable in one place.
 *
 * ── Latency ───────────────────────────────────────────────────────────────────────────────────
 * One `AudioPlayer` per clip, all created ONCE for the life of the app (see `useDriftFeel.ts` —
 * the port is a module singleton, not a per-screen object): ".d.ts: The player will start loading
 * the audio source immediately upon creation." `play()` is synchronous, so the cue path is one
 * property read and one call. Nothing is created, decoded or awaited in it. The rewind that a
 * finished AVPlayer needs is scheduled by a timer for `duration + REWIND_MARGIN_S` after the
 * play, which is always earlier than the clip's own `minGapS` — the bank guarantees it and
 * `audio.test.ts` asserts it against `REWIND_MARGIN_S` itself rather than against a number
 * retyped in the test, which is how the assertion came to sit 10 ms on the wrong side of it.
 */
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

import { REWIND_MARGIN_S, type PreparedSoundPort, type SoundPortSources } from './audioTypes';

export type { PreparedSoundPort, SoundPort, SoundPortSources, SoundPortState } from './audioTypes';
export { MIN_GAP_SLACK_S, REWIND_MARGIN_S } from './audioTypes';

/**
 * Configure the audio session. Safe to call more than once; it is idempotent and cheap.
 * Never called from the cue path — the hook does it once at mount.
 */
export async function configureAudioSession(): Promise<void> {
  await setAudioModeAsync({
    interruptionMode: 'mixWithOthers',
    playsInSilentMode: false,
    shouldPlayInBackground: false,
    allowsRecording: false,
    shouldRouteThroughEarpiece: false,
  });
}

export async function createSoundPort(sources: SoundPortSources): Promise<PreparedSoundPort> {
  try {
    await configureAudioSession();
  } catch (err) {
    console.warn('[audio] could not configure the audio session; sound will still try to play', err);
  }

  const players = new Map<string, AudioPlayer>();
  const rewinds = new Map<string, ReturnType<typeof setTimeout>>();
  let bedLow: AudioPlayer | null = null;
  let bedHigh: AudioPlayer | null = null;
  let bedRunning = false;
  let failed = 0;

  for (const [id, mod] of Object.entries(sources.modules)) {
    try {
      const player = createAudioPlayer(mod, { keepAudioSessionActive: true });
      if (id === sources.bedLow || id === sources.bedHigh) {
        player.loop = true;
        player.volume = 0;
        if (id === sources.bedLow) bedLow = player;
        else bedHigh = player;
      } else {
        player.volume = 1;
        players.set(id, player);
      }
    } catch (err) {
      failed++;
      console.warn(`[audio] could not create a player for ${id}`, err);
    }
  }

  const scheduleRewind = (id: string, player: AudioPlayer) => {
    const existing = rewinds.get(id);
    if (existing) clearTimeout(existing);
    const ms = ((sources.durations[id] ?? 0.6) + REWIND_MARGIN_S) * 1000;
    rewinds.set(
      id,
      setTimeout(() => {
        rewinds.delete(id);
        // An AVPlayer parked at the end needs a seek before it will play again. Doing it here,
        // once the clip is over, keeps it out of the cue path entirely.
        player.seekTo(0).catch(() => {});
      }, ms),
    );
  };

  const port: PreparedSoundPort = {
    // Native is never gated on a gesture; if a player failed to build, that one clip is silent
    // and the rest of the bank still works, which is why `state` is not derived from `failed`.
    state: players.size > 0 || bedLow !== null ? 'ready' : 'unavailable',
    get loaded() {
      let n = 0;
      for (const p of players.values()) if (p.isLoaded) n++;
      if (bedLow?.isLoaded) n++;
      if (bedHigh?.isLoaded) n++;
      return n;
    },
    total: Object.keys(sources.modules).length,

    play(id) {
      const player = players.get(id);
      if (!player) return false;
      try {
        player.play();
        scheduleRewind(id, player);
        return true;
      } catch {
        return false;
      }
    },

    stop(id) {
      const player = players.get(id);
      if (!player) return;
      try {
        player.pause();
        player.seekTo(0).catch(() => {});
        const pending = rewinds.get(id);
        if (pending) {
          clearTimeout(pending);
          rewinds.delete(id);
        }
      } catch {
        // a stolen voice that will not stop is a cosmetic problem, never a crash
      }
    },

    setBed(low, high) {
      if (!bedLow || !bedHigh) return;
      try {
        const wanted = low > 0.001 || high > 0.001;
        if (wanted && !bedRunning) {
          bedRunning = true;
          bedLow.play();
          bedHigh.play();
        }
        bedLow.volume = clamp01(low);
        bedHigh.volume = clamp01(high);
        if (!wanted && bedRunning) {
          bedRunning = false;
          bedLow.pause();
          bedHigh.pause();
        }
      } catch {
        // ignore
      }
    },

    async unlock() {
      return port.state;
    },

    release() {
      for (const t of rewinds.values()) clearTimeout(t);
      rewinds.clear();
      for (const p of players.values()) {
        try {
          p.remove();
        } catch {
          // ignore
        }
      }
      players.clear();
      for (const p of [bedLow, bedHigh]) {
        try {
          p?.pause();
          p?.remove();
        } catch {
          // ignore
        }
      }
      bedLow = null;
      bedHigh = null;
      bedRunning = false;
    },

    describe() {
      return `expo-audio · mixWithOthers · silent switch respected${failed > 0 ? ` · ${failed} clips failed to load` : ''}`;
    },
  };

  return port;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
