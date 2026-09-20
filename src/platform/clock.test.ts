import { describe, expect, it } from 'vitest';

import { now, nowMs } from './clock';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('clock', () => {
  it('is monotonic and measured in seconds', async () => {
    const a = now();
    await sleep(30);
    const b = now();
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeGreaterThanOrEqual(0.02);
    expect(b - a).toBeLessThan(1);
    expect(nowMs() / 1000).toBeCloseTo(now(), 1);
  });
});
