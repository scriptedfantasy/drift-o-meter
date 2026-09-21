/**
 * The census's headline is an ABSENCE — drawing the garage reads no session body — and an
 * absence printed by a tool nobody runs is a claim waiting to stop being true. This is the
 * maximum that keeps it honest on every run of the suite (docs/CRITIC.md, rule 15).
 *
 * Small on purpose: six real runs is enough to exercise every branch of the render path (a
 * spin, a scruffy run, a second track, a grip lap) and costs about a second. The full picture —
 * bytes, the parse curve, the orphan case — is `npx tsx tools/analysis/storage-census.ts`.
 */
import { describe, expect, it } from 'vitest';

import { measureOrphans, measureReads } from './storage-census';

describe('drawing the garage', () => {
  it('reads the index once and not one recording', async () => {
    const { counts, drawn, entries } = await measureReads(6);
    expect(entries).toHaveLength(6);
    expect(drawn.rows).toBe(6);
    // The whole point: every row, every record, every slide mark, from one index read.
    expect(counts.bodyReads).toBe(0);
    expect(counts.indexReads).toBe(1);
    expect(drawn.marks).toBeGreaterThan(0);
    expect(counts.bytesRead).toBeLessThan(64 * 1024);
  }, 30_000);

  it('draws every row whose recording is GONE, still without reaching for one', async () => {
    // What a browser that has evicted site data leaves behind, and what the list must survive.
    const { counts, drawn, entries, diagnosis, kept, withAngle } = await measureOrphans(8);
    expect(diagnosis.recordings).toBe(kept);
    expect(kept).toBeLessThan(entries.length);
    expect(drawn.rows).toBe(entries.length);
    expect(drawn.marks).toBeGreaterThan(0);
    // Angles, grades and traces all come from the index, so losing the body loses none of them.
    expect(withAngle).toBeGreaterThan(kept);
    expect(counts.bodyReads).toBe(0);
  }, 30_000);
});
