import { describe, expect, it } from 'vitest';
import { computeSci, loadCoefficients, pctChange, sciMarkdown } from '../src/sci.ts';

const c = loadCoefficients();
const m = {
  requests: 10000,
  cpuSeconds: 4,
  avgRssMb: 80,
  durationSeconds: 10,
  deployableMb: 40,
  coldStartMs: 300,
};

describe('sci', () => {
  it('T-F06-AC1: computes SCI per 1k requests from its parts', () => {
    const r = computeSci(c, m);
    const sum = Object.values(r.breakdown).reduce((a, b) => a + b, 0);
    expect(r.gramsPer1kRequests).toBeCloseTo(sum, 10);
    expect(r.gramsPer1kRequests).toBeGreaterThan(0);
  });

  it('T-F06-AC2: a smaller image and faster cold start lowers SCI', () => {
    const before = computeSci(c, m);
    const after = computeSci(c, { ...m, deployableMb: 20, coldStartMs: 200 });
    expect(after.gramsPer1kRequests).toBeLessThan(before.gramsPer1kRequests);
    expect(sciMarkdown(before, after)).toContain('Total SCI');
    expect(pctChange(before.gramsPer1kRequests, after.gramsPer1kRequests)).toBeLessThan(0);
  });

  it('is per request, not per run', () => {
    const one = computeSci(c, m);
    const twice = computeSci(c, { ...m, requests: 20000, cpuSeconds: 8, durationSeconds: 20 });
    expect(twice.breakdown.computeG).toBeCloseTo(one.breakdown.computeG, 10);
  });
});
