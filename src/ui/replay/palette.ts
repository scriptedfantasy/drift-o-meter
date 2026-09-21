/**
 * The replay's colour and wording rules, shared by the Skia renderer and the screen chrome.
 *
 * The SVG reference renderer (`tools/analysis/render-replay.ts`) IMPORTS these rules rather than
 * carrying its own copies, so the app and the harness frame the critic judged cannot disagree
 * about what a given |β| looks like. It used to say "every rule here is a copy of the one the
 * reference renderer uses", which is a claim a reader cannot check and which stopped being true
 * the moment the app's ramp was trust-gated and the copy was not: the tool took `--untrusted`
 * specifically to check that presentation and drew the trail, the markers, the slip label and the
 * band ticks in full ember anyway. A copy is not a shared rule. This is the one file.
 */
import { SEVERITY_EDGES, formatPoints, severityOf, type DriftSeverity, type Replay, type ReplayEventKind } from '../../engine/replay';
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

/** What a ramp colour becomes when the gate below refuses it: the screen's neutral. */
export const NO_HEAT = colors.muted;

/**
 * THE GATE. Every colour either renderer spends off the escalation ramp goes through here.
 *
 * `heatColor` answers "what colour is this |β|". This answers the question before it: may this
 * frame spend a slide colour at all? Two refusals, both of them the engine's own assertions:
 *
 *  • `trusted` is `SessionScore.trusted`. A recording the engine refuses to vouch for plays, and
 *    shows what it measured, but its slip angles are not a measurement anyone should dress up —
 *    the points and the grade are already withheld, and the ember goes with them.
 *  • Below the 8° `hold` edge the engine says the car is NOT SLIDING (`severityOf` returns
 *    'none'), and ember is the colour of a slide. `heatColor` is flat ember from 0° to 40°, so
 *    without this the same 4.2° drew a grey hero numeral (which keys off `severity`) beside a
 *    full-ember L/R chevron, a full-ember slip label, a full-ember slip arc and a full-ember
 *    playhead — one frame saying both "not sliding" and "sliding" about the same angle, under a
 *    footer reading 0 DRIFTS.
 *
 * It lives out here, exported and swept by `replay-ui.test.ts`, because it was a module-private
 * pair of one-liners in `scene.ts` that nothing executed: the round it was written, it was
 * applied at sixteen draw sites and missed four, and both the suite and the screenshot harness
 * stayed green while a run stamped NOT SCORED drew an orange streak under the words.
 *
 * A colour that belongs to a drift THE DETECTOR HAS ALREADY DECLARED is floored at the hold edge
 * before it gets here (`driftHeat` in scene.ts): a slide's running peak is a degree or two for
 * its first tenth of a second, and greying the head of every ribbon would take the ember off
 * drift entry, which is the one beat DESIGN.md spends it on.
 */
export function heatOf(beta: number, trusted: boolean): string {
  if (!trusted) return NO_HEAT;
  return severityOf(beta) === 'none' ? NO_HEAT : heatColor(beta);
}

/**
 * The same gate for a ramp colour something else already worked out — the trail's core chunks
 * (coloured in `geometry.ts`, once, off the same ramp), the mini-map, the halo.
 *
 * Only the trust half: a hex has no angle left in it to test, and every caller's hex belongs to
 * a drift the detector declared, which is the case the hold edge does not apply to.
 */
export function tintOf(hex: string, trusted: boolean): string {
  return trusted ? hex : NO_HEAT;
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
 * Widest |β| the scrubber ribbon is scaled to: the spin edge, on every run, with no exception.
 *
 * The band is a gradient in NORMALISED space — ember to 55 % of its height, gold at 80 %, red at
 * the top — so the scale is the whole of what those colours mean. Fixing it at 65° puts the
 * spin edge exactly where the shader already says a spin is, and a given |β| the same number of
 * pixels up the strip in every run, which is the only way two runs are comparable at a glance.
 * A slide past 65° saturates at the top, which is the honest picture of one: the strip is a
 * severity scale, not a log of the peak.
 *
 * IT WAS `Math.max(spin, maxAngle * 1.05)`, AND THAT IS NOT A SCALE. The exception for a clean
 * lap was removed a round ago — 4.18° filling 80 % of the band drew a lap with nothing in it in
 * gold and red — but the `max` it was removed in favour of kept the same defect for every run
 * ABOVE the spin edge, where the doc comment had already started claiming otherwise. Measured on
 * the eight fixtures: clean/good/touge 65.0°, hero 67.0°, rough 73.5°, handheld 87.9°, sloppy
 * and spin 123.9°. So a 40° slide sat at 61.5 % of the band on `good` and 32.3 % on `sloppy`,
 * and on `sloppy` the 65° spin edge itself sat at 52.5 % — below the gradient's first ember
 * stop. One frame painted a 70° slide gold-to-red in the world and ember on the strip under it,
 * which is the colour that means a controlled drift.
 */
export function ribbonScale(_replay: Replay): number {
  return SEVERITY_EDGES.spin;
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
