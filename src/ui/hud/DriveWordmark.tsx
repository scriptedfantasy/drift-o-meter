/**
 * @deprecated Moved to `src/ui/Wordmark.tsx`.
 *
 * The mark is the same on the drive display and the run review — they are meant to read as
 * one board — so it cannot live inside one screen's kit. This re-export keeps the drive
 * screen compiling while it moves over; delete it after.
 */
export { Wordmark as DriveWordmark, wordmarkSize, WORDMARK_WIDTH_FRAC } from '../Wordmark';
export { Wordmark as default } from '../Wordmark';
