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
 *
 * THE RAMP IS NOW THE DIAL'S. `heatColor` was a private ember → gold → red escalation built out
 * of the severity edges; it is `angleColor` from `src/ui/theme.ts`, the same function and the
 * same `ANGLE_STOPS` the live dial sweeps and the review's slide list prints, so a 56° on the
 * replay is the colour a 56° was on the gauge while it was happening and the colour it is in the
 * list afterwards. Three screens, one ramp, and it is the one the car is painted in.
 */
import { severityOf, type DriftSeverity, type Replay, type ReplayEventKind } from '../../engine/replay';
import { clamp, degToRad, radToDeg } from '../../engine/types';
import { MAX_ANGLE_DEG, angleColor, colors } from '../theme';

/** Ground plane: night asphalt with a blue bias — deliberately NOT the letterbox black. */
export const GROUND = '#0E141D';
export const ASPHALT_HI = '#2B3644';
export const ASPHALT_LO = '#1B232E';
export const VERGE = '#11171F';
export const RUNOFF = '#0C1118';
export const EDGE_LINE = '#56677D';
export const CENTRE_LINE = '#222B36';
export const KERB_PALE = '#8E9AA8';
/**
 * White-hot core of a fresh smoke puff / the hottest part of the trail.
 *
 * NOT a palette token and deliberately so: this is burning rubber, which is white where it
 * leaves the tyre whatever colour the app is. It is mixed INTO a ramp colour rather than drawn
 * on its own, so it goes through the same trust gate as the colour it lightens.
 */
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
 * |β| in radians → the colour of that angle, the same in every session and both renderers.
 *
 * It is `angleColor` with the units changed, and nothing else: the ramp, its knots and the angle
 * each knot sits at belong to `ANGLE_STOPS` in `src/ui/theme.ts`. This wrapper exists because
 * the replay works in radians end to end (the engine's convention) and the ramp is stated in
 * degrees, which is how a driver reads an angle.
 */
export function heatColor(beta: number): string {
  return angleColor(radToDeg(Math.abs(Number.isFinite(beta) ? beta : 0)));
}

/** How much drama a severity band carries, 0..1 — drives ribbon width, bloom and label size. */
export function severityWeight(s: DriftSeverity): number {
  return s === 'spin' ? 1 : s === 'extreme' ? 0.75 : s === 'big' ? 0.5 : s === 'hold' ? 0.28 : 0;
}

/** What a ramp colour becomes when the gate below refuses it: the screen's neutral. */
export const NO_HEAT = colors.muted;

/**
 * THE GHOST: the reference lap, its tail, its badge and its off-screen chevron.
 *
 * It is the palette's green because it is the same car being measured on another lap, and it is
 * NAMED rather than spelled `colors.green` at ten draw sites because green is also the bottom of
 * the angle ramp. `replay-ui.test.ts` sweeps the text of both renderers for a ramp colour spent
 * outside the trust gate, and without this constant every one of those ten lines would have to
 * be excused by name — which turns a guard that catches one real defect into a list nobody
 * reads. One name, one exemption, and the sweep still fails on a raw `colors.green` anywhere
 * else in either renderer.
 *
 * IT GOES THROUGH THE TRUST HALF OF THE GATE (`tint`), and not because of an angle — there is
 * none in it — but because the frame must not say two things at once. A hand-held recording is
 * stamped NOT SCORED and has every angle on it greyed out; a lit green ghost with a
 * "FASTEST LAP +3.9 S" badge beside it is the same frame handing that recording a lap record.
 * Greying it also keeps the harness's strongest check measurable: `replay-untrusted` and its
 * three siblings assert ZERO lit pixels inside the stage, which only means something if nothing
 * on the stage is exempt from the refusal.
 */
export const GHOST = colors.green;

/**
 * THE GATE. Every colour either renderer spends off the angle ramp goes through here.
 *
 * `heatColor` answers "what colour is this |β|". This answers the question before it: may this
 * frame spend a slide colour at all? Two refusals, both of them the engine's own assertions:
 *
 *  • `trusted` is `SessionIntegrity.scoreTrusted`. A recording the engine refuses to vouch for
 *    plays, and shows what it measured, but its slip angles are not a measurement anyone should
 *    dress up — a phone waved in a parked car produces large angles and a plausible run, and the
 *    ramp is what makes one look like driving.
 *  • Below the 8° `hold` edge the engine says the car is NOT SLIDING (`severityOf` returns
 *    'none'), and the ramp is the colour of a slide. `angleColor` is flat green from 0° to 40°,
 *    so without this the same 4.2° drew a grey hero numeral (which keys off `severity`) beside a
 *    fully lit L/R chevron, slip label, slip arc and playhead — one frame saying both "not
 *    sliding" and "sliding" about the same angle, under a footer reading 0 DRIFTS.
 *
 * It lives out here, exported and swept by `replay-ui.test.ts`, because it was a module-private
 * pair of one-liners in `scene.ts` that nothing executed: the round it was written, it was
 * applied at sixteen draw sites and missed four, and both the suite and the screenshot harness
 * stayed green while a run stamped NOT SCORED drew an orange streak under the words.
 *
 * A colour that belongs to a drift THE DETECTOR HAS ALREADY DECLARED is floored at the hold edge
 * before it gets here (`driftHeat` in scene.ts): a slide's running peak is a degree or two for
 * its first tenth of a second, and greying the head of every ribbon would take the colour off
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
 * Widest |β| the scrubber ribbon is scaled to: `MAX_ANGLE_DEG`, on every run, with no exception.
 *
 * ONE CEILING FOR EVERY ANGLE IN THE APP. It was the 65° spin edge, chosen here on its own, while
 * the dial swept to 70° and the garage's run trace topped out at 60 — so the same 64° hold drew
 * at three different heights on three screens. `MAX_ANGLE_DEG` is read off the last knot of
 * `ANGLE_STOPS`, so the top of this band is exactly where the ramp finishes turning red and
 * cannot drift apart from it.
 *
 * A slide past the ceiling saturates at the top, which is the honest picture of one: the strip is
 * a severity scale, not a log of the peak.
 *
 * IT WAS `Math.max(spin, maxAngle * 1.05)`, AND THAT IS NOT A SCALE. The exception for a clean
 * lap was removed a round ago — 4.18° filling 80 % of the band drew a lap with nothing in it in
 * the top of the ramp — but the `max` it was removed in favour of kept the same defect for every
 * run ABOVE the spin edge, where the doc comment had already started claiming otherwise. Measured
 * on the eight fixtures: clean/good/touge 65.0°, hero 67.0°, rough 73.5°, handheld 87.9°, sloppy
 * and spin 123.9°. So a 40° slide sat at 61.5 % of the band on `good` and 32.3 % on `sloppy`, and
 * on `sloppy` the 65° spin edge itself sat at 52.5 % of the band. One frame painted a 70° slide
 * red in the world and green on the strip under it, which is the colour that means a slide still
 * held.
 */
export function ribbonScale(_replay: Replay): number {
  return degToRad(MAX_ANGLE_DEG);
}

/**
 * Callout colour by BEAT, which is not the same question as the angle ramp: a beat says what
 * KIND of moment this is, and a transition is not more severe than an exit, it is a different
 * thing happening.
 *
 *   spin        red    — the limit, and the one moment the car got away
 *   refused     red    — what went wrong with the RECORDING: the seconds the monitor would not
 *                        believe. The same colour the marker over the road takes at that instant,
 *                        and the same colour as the NOT SCORED plate that would carry the
 *                        session's own verdict; a driver reading one has already read the others.
 *   peak        the angle ramp at that angle, so the word and the world agree (the renderers
 *                        substitute `driftHeat(seg.peakAngle)` for this beat)
 *   transition  blue   — structure: the car swapping which way it is sideways
 *   exit        blue   — structure: how long it was held
 *   entry/lap/finish  blue — the shape of the run
 *
 * `peak` is the only beat whose colour depends on the number it is saying, so it is the only one
 * that has to go through the trust gate; everything here is a fixed token and does not.
 */
export function eventColor(kind: ReplayEventKind): string {
  return kind === 'spin' || kind === 'refused' ? colors.red : colors.blue;
}

/**
 * The type tiers the replay uses — nothing in between (DESIGN.md).
 *
 * `hero` is the live |β|, the biggest thing on the frame. `value` is the moving numbers: the
 * speed, and the callouts, which used to have a `callout` tier of their own set at exactly the
 * same 34 pt. `body` is the one place this screen sets a SENTENCE rather than a label, in Barlow
 * instead of Barlow Condensed. The 132 pt `slam` went with the grade it existed to land.
 */
export const TYPE = { hero: 56, value: 34, label: 13, body: 14, clock: 12 } as const;

/**
 * What a run the engine will not vouch for is called, everywhere.
 *
 * It read NOT SCORED on the replay, the run review and the drive display, and NOT JUDGED in
 * the garage — one refusal with two names, on screens a driver sees one after the other.
 * Scoring is deleted, so SCORED was the wrong half of the pair to keep: the run WAS measured,
 * at a hundred samples a second, and what the engine declines to do is judge it.
 */
export const REFUSED_PLATE = 'NOT JUDGED';
