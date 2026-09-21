/**
 * A refusal, split into the part the driver can act on and the part that explains it.
 *
 * The engine composes `SessionIntegrity.message` as the fraction of sliding it could not
 * believe, an em dash, and then the integrity monitor's own live line — and that second half is
 * the only sentence on the screen that names something physical to do about it ("Phone looks
 * hand-held — clip it into a rigid mount to score drifts", "Phone is moving in its mount —
 * tighten it"). See `src/engine/integrity/verdict.ts` (sessionIntegrity) and
 * `src/engine/integrity/monitor.ts` (composeMessage).
 *
 * The screen leads with the monitor's half and keeps the fraction for the disclosure: a driver
 * who clipped their phone badly wants the remedy first, in the monitor's own words, not a
 * statistic. Nothing is dropped — `reason` is still shown, one tap away, and the full integrity
 * notes quote both halves verbatim.
 *
 * THE WORDING BELOW IS THE ENGINE'S, NOT THIS FILE'S. `results-layout.test.ts` pins the exact
 * strings the monitor can compose, so a rewrite here that "tidied" a message would be caught
 * rather than shipped.
 */

/** The em dash the scorer joins the two halves with. */
const JOIN = ' — ';

export interface Refusal {
  /** One line, the monitor's own words, naming the thing to change. Always a full sentence. */
  remedy: string;
  /** Why the run was thrown out, when the message carried it. Null when it did not. */
  reason: string | null;
}

function endSentence(text: string): string {
  const t = text.trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * @param message `SessionIntegrity.message` — empty on a run the engine stands behind.
 * @param fallback what to say when the engine left no message at all.
 */
export function refusalFrom(message: string | undefined | null, fallback = ''): Refusal {
  const text = (message ?? '').trim();
  if (!text) return { remedy: capitalize(endSentence(fallback)), reason: null };

  const at = text.indexOf(JOIN);
  // No join: the whole message is the monitor's, so all of it is the remedy.
  if (at < 0) return { remedy: capitalize(endSentence(text)), reason: null };

  const reason = text.slice(0, at).trim();
  // The monitor's half keeps its own em dashes ("Phone looks hand-held — clip it into…"): only
  // the FIRST join is the scorer's.
  const remedy = text.slice(at + JOIN.length).trim();
  if (!remedy) return { remedy: capitalize(endSentence(reason)), reason: null };
  return { remedy: capitalize(endSentence(remedy)), reason: reason ? capitalize(endSentence(reason)) : null };
}

/** The one chip beside a refusal: what the monitor actually found. */
export interface FaultStat {
  label: string;
  value: string;
  /** 'severe' when the fault is the reason the run was thrown out; 'warn' when it qualifies it. */
  tone: 'severe' | 'warn';
}

/**
 * The fault the monitor names, in its own order of severity.
 *
 * It used to be `<Stat label="Mount" value="LOOSE" />`, unconditional — a fact about the
 * hardware, stated on every refused run, including the ones where the monitor's verdict is
 * `mount: 'rigid'`. The monitor can and does refuse a rigidly mounted phone: it vetoes on the
 * calibration bar alone and says "Can't tell which way the car points", which is the failure
 * `docs/ARCHITECTURE.md` names as the expected one on real roads (a street of long sweepers
 * never offers the longitudinal acceleration the forward axis is resolved from). On that run
 * the cell asserted a defect in the cradle that nothing had measured.
 *
 * The simulator does not reach it — 18 refusals in a row came back `loose` — which is exactly
 * why it is worth fixing from the code rather than from a screenshot.
 */
export function faultStat(judged: { mount: 'rigid' | 'suspect' | 'loose'; physics: 'ok' | 'implausible'; gps: 'good' | 'poor' | 'none' }, forwardResolved: boolean): FaultStat {
  if (judged.mount === 'loose') return { label: 'Mount', value: 'LOOSE', tone: 'severe' };
  if (judged.physics === 'implausible') return { label: 'Motion', value: 'IMPOSSIBLE', tone: 'severe' };
  if (judged.mount === 'suspect') return { label: 'Mount', value: 'SHAKING', tone: 'warn' };
  // A rigid phone the monitor still would not believe: the fact it is missing is which way the
  // car points, not how tight the cradle is.
  if (!forwardResolved) return { label: 'Car axis', value: 'UNKNOWN', tone: 'severe' };
  if (judged.gps === 'none') return { label: 'GPS', value: 'NONE', tone: 'severe' };
  if (judged.gps === 'poor') return { label: 'GPS', value: 'POOR', tone: 'warn' };
  return { label: 'Mount', value: 'CALIBRATING', tone: 'warn' };
}
