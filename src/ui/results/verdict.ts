/**
 * Turning the integrity monitor's own line into a sentence a screen can print.
 *
 * This module used to be the run review's prose engine: a one-sentence verdict drawn from the
 * grade and the total, and a line of explanation under each of the five score bars quoting the
 * scorer's own curves back at the driver ("the cross-lap term is 35% of your consistency
 * score"). None of that survives the move away from scoring — a review states what the car did,
 * and a sentence that grades the driving is the thing the screen no longer does.
 *
 * What is left is the one piece of wording that was never about points: the monitor writes for a
 * HUD pill, and two screens need the same pill turned into prose the same way.
 */

/**
 * The integrity monitor writes for a HUD pill: "reason — advice", no full stop, capitals
 * mid-line. Spliced into a page that reads as machine output, so the first dash becomes a
 * sentence break and the whole thing gets terminated.
 *
 * `src/ui/garage/advice.ts` imports this rather than reimplementing it, so the garage's mount
 * notice and the review's refusal say the monitor's words identically.
 */
export function sentencesFromPill(message: string): string {
  const text = message.trim();
  if (!text) return '';
  const i = text.indexOf('—');
  const out = i > 0 ? `${text.slice(0, i).trim()}. ${text.slice(i + 1).trim()}` : text;
  return /[.!?]$/.test(out) ? out : `${out}.`;
}
