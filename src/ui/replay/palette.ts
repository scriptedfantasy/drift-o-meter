/**
 * The replay's colour and wording rules, shared by the Skia renderer and the screen chrome.
 *
 * Every rule here is a copy of the one the SVG reference renderer uses
 * (`tools/analysis/render-replay.ts`), so the app and the harness frame the critic judged agree
 * on what a given |β| looks like. The escalation ramp in particular is absolute: the same slip
 * angle is the same colour in every session, on both renderers.
 */
import { SEVERITY_EDGES, formatPoints, type DriftSeverity, type Replay, type ReplayEventKind } from '../../engine/replay';
import { clamp } from '../../engine/types';
import { colors } from '../theme';

/** Ground plane: night asphalt with a blue bias — deliberately NOT the letterbox black. */
export const GROUND = '#0E141D';
export const ASPHALT_HI = '#2B3644';
export const ASPHALT_LO = '#1B232E';
export const VERGE = '#11171F';
export const RUNOFF = '#0C1118';
export const EDGE_LINE = '#56677D';
export const CENTRE_LINE = '#222B36';
export const KERB_PALE = '#8E9AA8';
export const GRID_LINE = '#18202B';
/** White-hot core of a fresh smoke puff / the hottest part of the trail. */
export const HOT = '#FFE9D6';

export const deg = (r: number): number => (r * 180) / Math.PI;
export const kmh = (v: number): number => Math.round((Number.isFinite(v) ? v : 0) * 3.6);

/** `01:37.3` — the replay clock, always mm:ss.d. */
export function fmtTime(s: number): string {
  const v = Number.isFinite(s) ? Math.max(0, s) : 0;
  const m = Math.floor(v / 60);
  const r = v - m * 60;
  return `${String(m).padStart(2, '0')}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

export function mix(a: string, b: string, f: number): string {
  const t = clamp(f, 0, 1);
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The escalation ramp: ember up to 40°, ember → gold to 65°, gold → red beyond.
 * The same |β| always produces the same colour, in every session and both renderers.
 */
export function heatColor(beta: number): string {
  const a = Math.abs(Number.isFinite(beta) ? beta : 0);
  if (a <= SEVERITY_EDGES.extreme) return colors.ember;
  if (a <= SEVERITY_EDGES.spin) return mix(colors.ember, colors.gold, (a - SEVERITY_EDGES.extreme) / (SEVERITY_EDGES.spin - SEVERITY_EDGES.extreme));
  return mix(colors.gold, colors.red, clamp((a - SEVERITY_EDGES.spin) / ((Math.PI / 2) * 1.0 - SEVERITY_EDGES.spin), 0, 1));
}

/** How much drama a severity band carries, 0..1 — drives ribbon width, bloom and label size. */
export function severityWeight(s: DriftSeverity): number {
  return s === 'spin' ? 1 : s === 'extreme' ? 0.75 : s === 'big' ? 0.5 : s === 'hold' ? 0.28 : 0;
}

/**
 * Does this label put a SCORE on the run?
 *
 * A run the engine refuses to vouch for may show what it measured — angles, transitions, laps,
 * "LOST IT 118°" — and must show no points at all, anywhere, including inside a sentence: a
 * residual number tells the driver they earned at least that much, which is exactly what
 * `scoreTrusted: false` withholds. The test is a SIGNED number, which is the shape every points
 * label has ("+1250", "CHAIN LOST −8981", "AT RISK +1380") and no measurement label does.
 */
export function isPointsClaim(label: string): boolean {
  return /[+−-]\s*\d/.test(label);
}

/**
 * The POINTS the top HUD prints, as the string it prints — or null when it prints none.
 *
 * This lives out here, away from Skia, because it is the one decision on this screen that has
 * been wrong twice and cannot be seen from a test that only reads the replay model. The round
 * before last, `Replay.info.totalPoints` was computed correctly, trust-gated correctly, and the
 * renderer drew `pose.points` beside it — a different number on the last frame from the one the
 * results screen printed. The test that was supposed to catch it asserted the two model fields
 * against each other and stated the renderer's behaviour IN A COMMENT; nothing executed the
 * choice. Now the choice is a function, and `replay-ui.test.ts` runs it.
 *
 * The rules, in order:
 *  • an untrusted recording prints no points at all, ever (`SessionScore.trusted`);
 *  • once the grade has fully landed the reveal owns the number and the HUD prints none;
 *  • while it is landing, and afterwards, the number is the SESSION TOTAL — the same figure the
 *    results screen prints — not the trail's running sum, which is a hair short of it until the
 *    last sample;
 *  • before the reveal starts it is the running total at the playhead, which is the whole point
 *    of watching.
 */
export function headlinePoints(opts: { trusted: boolean; reveal: number; totalPoints: number | null; posePoints: number }): string | null {
  if (!opts.trusted || opts.reveal >= 1) return null;
  const finished = opts.reveal > 0 && opts.totalPoints !== null;
  return formatPoints(finished ? (opts.totalPoints as number) : opts.posePoints);
}

/**
 * Widest |β| the scrubber ribbon is scaled to.
 *
 * ABSOLUTE, with no exception: never less than the spin edge, so a given |β| is the same height
 * in every run and two runs are comparable at a glance.
 *
 * There used to be an exception for a run with no drift in it — scale to its own maximum, "so
 * the shape of the few degrees is visible" — and it made the band lie. The ribbon is a gradient
 * in NORMALISED band space: red at the top means a spin. A clean lap peaking at 4.18° filled
 * 80 % of the band, which put a clean lap's telemetry strip in full gold and red under a footer
 * reading 0 DRIFTS, a hair below where `good`'s genuine 55.54° sits at 85 %. A clean lap draws a
 * flat line now, which is the honest picture of one.
 */
export function ribbonScale(replay: Replay): number {
  return Math.max(SEVERITY_EDGES.spin, replay.telemetry.maxAngle * 1.05);
}

/** Callout colour by beat, as the reference renderer assigns it. */
export function eventColor(kind: ReplayEventKind): string {
  switch (kind) {
    case 'transition':
      return colors.magenta;
    case 'spin':
      return colors.red;
    case 'peak':
      return colors.gold;
    case 'exit':
      return colors.ember;
    default:
      return colors.cyan;
  }
}

/**
 * The type tiers the replay uses — nothing in between (DESIGN.md).
 * `slam` is the grade on the final frame: the verdict is the biggest thing on that frame, the
 * way the results screen's reveal is the biggest thing on its own. `body` is the one place this
 * screen sets a SENTENCE rather than a label, in Barlow instead of Barlow Condensed.
 */
export const TYPE = { hero: 56, slam: 132, value: 34, label: 13, body: 14, callout: 34, clock: 12 } as const;
