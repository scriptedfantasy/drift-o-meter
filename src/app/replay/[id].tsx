/**
 * The replay: a full-bleed Skia stage with the HUD floating over true letterbox bars.
 *
 * The scene comes from `src/engine/replay` and is drawn by `src/ui/replay/scene.ts`; this screen
 * decides WHICH recording to play (a stored session, or the same deterministic fixture the
 * results screen uses, so a deep link from a fixture result lands on the same run), lays the
 * frame out for the orientation, and owns the transport.
 *
 * Deep links (the results screen already pushes the first two):
 *   t=<seconds>     seek there
 *   drift=<id>      seek to that drift and pick it out
 *   hl=<n>          jump to the nth-best highlight
 *   fixture / source and the usual fixture overrides — see tools/harness/README.md
 *
 * Nothing on this screen re-renders while the replay plays: the clock, the transport and the
 * scrub position are Reanimated shared values, and the frame loop lives in `ReplayCanvas`.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, Pressable, Share, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, Body, Button, colors, Micro, space } from '@/ui';
import { fixtureQuery } from '@/ui/results/fixture';
import { ReplayControls, Scrubber, WarningsOverlay } from '@/ui/replay/Controls';
import { replayLayout } from '@/ui/replay/layout';
import { parseReplayParams } from '@/ui/replay/params';
import { useReplayPlayer } from '@/ui/replay/player';
import ReplayCanvasView from '@/ui/replay/ReplayCanvasView';
import { useReplaySource } from '@/ui/replay/source';

type Query = Record<string, string | string[] | undefined>;

export default function ReplayScreen() {
  const query = useLocalSearchParams() as Query;
  const router = useRouter();
  const id = typeof query.id === 'string' ? query.id : Array.isArray(query.id) ? query.id[0] : undefined;
  const queryKey = JSON.stringify(query);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const params = useMemo(() => parseReplayParams(query), [queryKey]);
  const { view, loading, error } = useReplaySource(id, params, query);

  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const layout = useMemo(() => replayLayout(width, height, insets), [width, height, insets]);

  const [systemReduce, setSystemReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => alive && setSystemReduce(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => alive && setSystemReduce(v));
    return () => {
      alive = false;
      sub?.remove();
    };
  }, []);
  const reduceMotion = params.motion === 'reduce' ? true : params.motion === 'full' ? false : systemReduce;

  const player = useReplayPlayer(view?.replay ?? null, {
    startT: params.t ?? 0,
    startMode: params.cam ?? 'chase',
    startRate: params.rate ?? 1,
    autoplay: params.play ?? true,
  });

  // Deep links, applied once the scene exists. A drift link wins over a plain time, because it
  // says which moment mattered as well as when it was.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!view || applied.current === queryKey) return;
    applied.current = queryKey;
    const replay = view.replay;
    if (params.driftId !== null) {
      const seg = replay.segments.find((s) => s.driftId === params.driftId);
      if (seg) {
        player.focusDrift(seg.driftId);
        player.seek(Math.max(0, seg.startT - 0.8), { play: params.play ?? true });
        return;
      }
    }
    if (params.highlight !== null) {
      player.jumpToHighlight(params.highlight - 1);
      if (params.play === false) player.setPlaying(false);
      return;
    }
    if (params.scrub !== null) {
      // opens with the playhead GRABBED, which is the state a drag produces
      const t = params.scrub * replay.durationS;
      player.setPlaying(false);
      player.seek(t);
      player.sv.scrubT.value = t;
      player.sv.scrubbing.value = 1;
      return;
    }
    if (params.t !== null) player.seek(params.t, { play: params.play ?? true });
  }, [view, queryKey, params, player]);

  // The controls behave like a video player's: always up while paused, out of the way a few
  // seconds into playback, back on a tap.
  const [touchedAt, setTouchedAt] = useState(0);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (params.ui === 'pinned') {
      setHidden(false);
      return;
    }
    if (params.ui === 'hidden') {
      setHidden(true);
      return;
    }
    if (!player.playing) {
      setHidden(false);
      return;
    }
    const timer = setTimeout(() => setHidden(true), 3500);
    return () => clearTimeout(timer);
  }, [params.ui, player.playing, touchedAt]);

  const [warnOpen, setWarnOpen] = useState(false);
  const [shareState, setShareState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const onStage = useCallback(() => {
    setTouchedAt(Date.now());
    if (hidden) {
      setHidden(false);
      return;
    }
    player.toggle();
  }, [hidden, player]);

  const onClose = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const onShare = useCallback(() => {
    if (!view) return;
    const q = new URLSearchParams();
    q.set('t', player.sv.time.value.toFixed(2));
    q.set('cam', player.mode);
    if (view.fixture) for (const [k, v] of new URLSearchParams(fixtureQuery(view.fixture))) q.set(k, v);
    const path = `/replay/${encodeURIComponent(id ?? 'demo')}?${q.toString()}`;
    const url = Platform.OS === 'web' && typeof window !== 'undefined' ? new URL(path, window.location.origin).toString() : `driftometer:/${path}`;
    const done = (ok: boolean) => {
      setShareState(ok ? 'copied' : 'failed');
      setTimeout(() => setShareState('idle'), 2400);
    };
    if (Platform.OS !== 'web') {
      Share.share({ message: url }).then(
        () => done(true),
        () => done(false),
      );
      return;
    }
    copyToClipboard(url).then(done, () => done(false));
  }, [id, player.mode, player.sv.time, view]);

  if (loading) {
    return (
      <View style={styles.boot} testID="screen-replay-loading">
        <AppText variant="micro" color="ember">
          Building the replay
        </AppText>
      </View>
    );
  }

  if (!view) {
    return (
      <View style={styles.boot} testID="screen-replay-missing">
        <AppText variant="heading">No recording</AppText>
        <Body color="muted" style={styles.missingBody}>
          {error ? `That session could not be read: ${error}` : `There is no session stored as "${id ?? 'unknown'}". Drive a run and it will be here.`}
        </Body>
        <View style={styles.missingRow}>
          <Button label="Garage" variant="secondary" onPress={() => router.replace('/')} testID="cta-garage" />
          <Button label="Drive" onPress={() => router.replace('/drive')} testID="cta-drive" />
        </View>
      </View>
    );
  }

  const shareLabel = shareState === 'copied' ? 'Copied' : shareState === 'failed' ? 'Failed' : canShare() ? 'Share' : 'No share';

  return (
    <View style={styles.root} testID="screen-replay">
      <ReplayCanvasView
        replay={view.replay}
        view={view}
        layout={layout}
        sv={player.sv}
        mode={player.mode}
        focusDriftId={player.focusDriftId}
        chip={player.chip}
        reduceMotion={reduceMotion}
        controlsVisible={!hidden}
        testID="replay-canvas"
      />
      <Pressable
        style={[styles.stage, { top: layout.stage.y, height: layout.stage.h }]}
        onPress={onStage}
        accessibilityRole="button"
        accessibilityLabel={player.playing ? 'Pause' : 'Play'}
        testID="replay-stage"
      />
      <Pressable
        style={[styles.close, { left: layout.chrome.left - 10, top: layout.chrome.y - 24 }]}
        hitSlop={14}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close the replay"
        testID="replay-done">
        <AppText variant="subheading" color="muted" style={styles.closeLabel}>
          {'✕'}
        </AppText>
      </Pressable>
      <WarningsOverlay warnings={view.warnings} layout={layout} open={warnOpen} onToggle={() => setWarnOpen((v) => !v)} />
      <ReplayControls
        layout={layout}
        player={player}
        highlightCount={view.replay.highlights.length}
        onShare={onShare}
        shareLabel={shareLabel}
        shareDisabled={!canShare()}
        visible={!hidden}
      />
      <Scrubber layout={layout} durationS={view.replay.durationS} player={player} />
      {view.replay.trail.n < 4 ? (
        <View style={styles.empty} pointerEvents="none">
          <Micro color="red">This recording has no usable path to draw</Micro>
        </View>
      ) : null}
    </View>
  );
}

/** Whether this platform can hand the link anywhere at all; if not, the control says so. */
function canShare(): boolean {
  if (Platform.OS !== 'web') return true;
  if (typeof navigator === 'undefined') return false;
  return !!navigator.clipboard?.writeText || !!navigator.share || typeof document !== 'undefined';
}

/** Clipboard first, the share sheet second, the legacy copy last — one of them works everywhere. */
async function copyToClipboard(url: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      // permission denied in this context; fall through
    }
  }
  if (typeof document !== 'undefined') {
    try {
      const area = document.createElement('textarea');
      area.value = url;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      if (ok) return true;
    } catch {
      // fall through
    }
  }
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({ url });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  stage: { position: 'absolute', left: 0, right: 0 },
  close: { position: 'absolute', width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  closeLabel: { fontSize: 18, lineHeight: 20 },
  boot: { flex: 1, backgroundColor: colors.bg0, alignItems: 'center', justifyContent: 'center', gap: space[3], padding: space[6] },
  missingBody: { textAlign: 'center', maxWidth: 320 },
  missingRow: { flexDirection: 'row', gap: space[3], marginTop: space[2] },
  empty: { position: 'absolute', left: 0, right: 0, top: '50%', alignItems: 'center' },
});
