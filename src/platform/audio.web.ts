/**
 * Web sound port — Web Audio, deliberately NOT expo-audio. (Native: `audio.ts`.)
 *
 * ── Why this file does not use expo-audio ─────────────────────────────────────────────────────
 * `node_modules/expo-audio/build/AudioPlayer.web.js` implements `play()` as:
 *
 *     play() { if (!isAudioActive) { return; } this.media.play(); ... }
 *
 * `HTMLMediaElement.play()` returns a Promise, and that one is neither awaited nor caught. Under
 * a browser's autoplay policy — which is exactly the situation the capture harness runs in, a
 * headless Chromium with no audio device and no user gesture — it rejects with `NotAllowedError`
 * and becomes an UNHANDLED REJECTION inside the library, where this app cannot catch it. The
 * harness fails the build on any page error, and rightly: an app that throws in the console
 * because it tried to make a noise is broken whether or not you can hear it.
 *
 * Web Audio has no such hole. An `AudioContext` may be constructed before a gesture (it starts
 * suspended and says nothing), `decodeAudioData` works on a suspended context, and `start()` on
 * a buffer source is synchronous and returns nothing to reject. So the web build fetches and
 * decodes the whole bank at screen mount, reports itself `locked` until a real user gesture
 * resumes the context, and plays with sample-accurate scheduling after that. On the silent path
 * it makes no sound and no noise in the console, which is the requirement.
 *
 * expo-audio's audio-MODE call is still made (`configureAudioSession`); on web
 * `AudioModule.web.js` defines `setAudioModeAsync` as an empty async function, so it is a no-op
 * that keeps the two platforms' startup identical.
 *
 * ── Latency ───────────────────────────────────────────────────────────────────────────────────
 * Every clip is a decoded `AudioBuffer` held in memory. A cue allocates one `AudioBufferSourceNode`
 * — the only object Web Audio will let you start — connects it and calls `start()`. No fetch, no
 * decode, no await, no promise in the cue path.
 */
import { Asset } from 'expo-asset';

import type { PreparedSoundPort, SoundPortSources, SoundPortState } from './audioTypes';

export type { PreparedSoundPort, SoundPort, SoundPortSources, SoundPortState } from './audioTypes';

/** Matches the native port's signature; on web the audio session has nothing to configure. */
export async function configureAudioSession(): Promise<void> {
  // `AudioModule.web.js`: `export async function setAudioModeAsync(mode) { }`.
}

type Ctx = AudioContext & { state: AudioContextState };

function audioContextClass(): typeof AudioContext | null {
  const g = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function uriFor(mod: number): string | null {
  try {
    const asset = Asset.fromModule(mod);
    return asset.localUri ?? asset.uri ?? null;
  } catch {
    return null;
  }
}

export async function createSoundPort(sources: SoundPortSources): Promise<PreparedSoundPort> {
  await configureAudioSession();

  const Ctor = audioContextClass();
  const buffers = new Map<string, AudioBuffer>();
  const sounding = new Map<string, AudioBufferSourceNode>();
  let ctx: Ctx | null = null;
  let master: GainNode | null = null;
  let bedLowGain: GainNode | null = null;
  let bedHighGain: GainNode | null = null;
  let bedLowSrc: AudioBufferSourceNode | null = null;
  let bedHighSrc: AudioBufferSourceNode | null = null;
  let note = '';
  let released = false;

  if (!Ctor) {
    return unavailablePort(Object.keys(sources.modules).length, 'no AudioContext in this browser');
  }

  try {
    ctx = new Ctor() as Ctx;
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    bedLowGain = ctx.createGain();
    bedHighGain = ctx.createGain();
    bedLowGain.gain.value = 0;
    bedHighGain.gain.value = 0;
    bedLowGain.connect(master);
    bedHighGain.connect(master);
  } catch (err) {
    return unavailablePort(Object.keys(sources.modules).length, `AudioContext could not be created (${String(err)})`);
  }

  // Fetch and decode the whole bank up front. A failure on one clip leaves the rest playable;
  // nothing here throws outward, because a screen must not fail to mount over a sound.
  const ids = Object.keys(sources.modules);
  await Promise.all(
    ids.map(async (id) => {
      const uri = uriFor(sources.modules[id]);
      if (!uri) return;
      try {
        const res = await fetch(uri);
        if (!res.ok) return;
        const bytes = await res.arrayBuffer();
        const decoded = await ctx!.decodeAudioData(bytes);
        if (!released) buffers.set(id, decoded);
      } catch {
        // one clip short is a quieter app, not a broken one
      }
    }),
  );

  const startBed = () => {
    if (!ctx || ctx.state !== 'running' || bedLowSrc || released) return;
    const low = buffers.get(sources.bedLow);
    const high = buffers.get(sources.bedHigh);
    if (!low || !high || !bedLowGain || !bedHighGain) return;
    bedLowSrc = ctx.createBufferSource();
    bedLowSrc.buffer = low;
    bedLowSrc.loop = true;
    bedLowSrc.connect(bedLowGain);
    bedHighSrc = ctx.createBufferSource();
    bedHighSrc.buffer = high;
    bedHighSrc.loop = true;
    bedHighSrc.connect(bedHighGain);
    // Both layers start on the same instant so the two loops stay phase-locked for the whole run.
    const at = ctx.currentTime + 0.02;
    bedLowSrc.start(at);
    bedHighSrc.start(at);
  };

  const stopBed = () => {
    for (const src of [bedLowSrc, bedHighSrc]) {
      try {
        src?.stop();
        src?.disconnect();
      } catch {
        // already stopped
      }
    }
    bedLowSrc = null;
    bedHighSrc = null;
  };

  const port: PreparedSoundPort = {
    get state(): SoundPortState {
      if (!ctx || buffers.size === 0) return 'unavailable';
      return ctx.state === 'running' ? 'ready' : 'locked';
    },
    get loaded() {
      return buffers.size;
    },
    total: ids.length,

    play(id) {
      if (!ctx || ctx.state !== 'running' || !master) return false;
      const buffer = buffers.get(id);
      if (!buffer) return false;
      try {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(master);
        src.onended = () => {
          if (sounding.get(id) === src) sounding.delete(id);
          try {
            src.disconnect();
          } catch {
            // ignore
          }
        };
        src.start();
        sounding.set(id, src);
        return true;
      } catch {
        return false;
      }
    },

    stop(id) {
      const src = sounding.get(id);
      if (!src) return;
      sounding.delete(id);
      try {
        src.stop();
      } catch {
        // already finished
      }
    },

    setBed(low, high) {
      if (!ctx || !bedLowGain || !bedHighGain) return;
      const wanted = low > 0.001 || high > 0.001;
      if (wanted) startBed();
      // A 40 ms ramp rather than a step: the bed is updated 20 times a second, and stepping a
      // gain node produces a click at every step.
      const t = ctx.currentTime;
      try {
        bedLowGain.gain.setTargetAtTime(clamp01(low), t, 0.04);
        bedHighGain.gain.setTargetAtTime(clamp01(high), t, 0.04);
      } catch {
        bedLowGain.gain.value = clamp01(low);
        bedHighGain.gain.value = clamp01(high);
      }
      if (!wanted) stopBed();
    },

    /**
     * Resume the context. MUST be called from inside a user gesture — the `/sound` lab's play
     * buttons and a one-shot document listener both do. A rejection is caught and reported as
     * `locked`, never thrown, so a blocked resume can never reach the console.
     */
    async unlock() {
      if (!ctx) return 'unavailable';
      if (ctx.state === 'running') return 'ready';
      try {
        await ctx.resume();
      } catch (err) {
        note = `context could not resume (${String(err)})`;
        return 'locked';
      }
      // `String(...)`: `resume()` is what changes `state`, so the compiler's flow narrowing from
      // the early return above is wrong about it by the time we get here.
      return String(ctx.state) === 'running' ? 'ready' : 'locked';
    },

    release() {
      released = true;
      stopBed();
      for (const src of sounding.values()) {
        try {
          src.stop();
        } catch {
          // ignore
        }
      }
      sounding.clear();
      buffers.clear();
      try {
        void ctx?.close();
      } catch {
        // ignore
      }
      ctx = null;
    },

    describe() {
      if (!ctx) return `web audio unavailable${note ? ` · ${note}` : ''}`;
      const s = ctx.state === 'running' ? 'running' : 'suspended — waiting for a tap';
      return `Web Audio · ${buffers.size}/${ids.length} decoded · context ${s}${note ? ` · ${note}` : ''}`;
    },
  };

  return port;
}

function unavailablePort(total: number, why: string): PreparedSoundPort {
  return {
    state: 'unavailable',
    loaded: 0,
    total,
    play: () => false,
    stop: () => {},
    setBed: () => {},
    unlock: async () => 'unavailable',
    release: () => {},
    describe: () => `web audio unavailable · ${why}`,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
