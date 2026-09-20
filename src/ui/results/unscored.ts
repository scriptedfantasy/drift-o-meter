/**
 * A refusal, split into the part the driver can act on and the part that explains it.
 *
 * `scoreSession` composes `SessionIntegrity.message` as the fraction of sliding it could not
 * believe, an em dash, and then the integrity monitor's own live line — and that second half is
 * the only sentence on the screen that names something physical to do about it ("Phone looks
 * hand-held — clip it into a rigid mount to score drifts", "Phone is moving in its mount —
 * tighten it"). See `src/engine/score/session.ts` (integrity.message) and
 * `src/engine/integrity/monitor.ts` (composeMessage).
 *
 * The screen leads with the monitor's half and keeps the fraction for the disclosure: a driver
 * who clipped their phone badly wants the remedy first, in the monitor's own words, not a
 * statistic. Nothing is dropped — `reason` is still shown, one tap away, and the full integrity
 * notes quote both halves verbatim.
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
 * @param fallback what to say when the engine left no message at all (the screen's own verdict).
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
