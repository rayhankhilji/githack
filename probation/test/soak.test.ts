import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/cli/common.ts', async (orig) => ({ ...(await orig<object>()), main: () => {} }));
const { soak } = await import('../src/cli/soak.ts');

const checks = [
  { name: 'dashboard', method: 'GET', path: '/' },
  { name: 'monthly-export', method: 'GET', path: '/api/v1/export.csv' },
];

describe('soak', () => {
  it('T-F05-AC4: a synthetic 404 on the canary fails the soak', async () => {
    const fetcher = vi.fn(
      async (url: string) => new Response('', { status: url.endsWith('.csv') ? 404 : 200 }),
    );
    const r = await soak('https://canary', checks, 0, 0, fetcher as unknown as typeof fetch);
    expect(r.failures).toEqual([expect.objectContaining({ name: 'monthly-export', status: 404 })]);
  });

  it('passes when every synthetic is healthy', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 200 }));
    const r = await soak('https://canary', checks, 0, 0, fetcher as unknown as typeof fetch);
    expect(r.failures).toEqual([]);
    expect(r.checks).toBe(2);
  });
});

const { soakSignal, signalSummary } = await import('../src/soak-signal.ts');

const line = (route: string, status = 200, method = 'GET') => ({ method, route, status });
const lines = (n: number, route = '/api/invoices', status = 200) =>
  Array.from({ length: n }, () => line(route, status));

describe('soak signal (canary Cloud Logging census lines)', () => {
  it('passes a healthy canary', () => {
    const s = soakSignal(lines(100), lines(900), 0.01);
    expect(s).toMatchObject({ requests: 100, errors5xx: 0, rate: 0, deletedRouteHits: 0, verdict: 'pass' });
    expect(signalSummary(s, 'tallybook-00042')).toContain('soak signal for tallybook-00042: PASS');
  });

  it('fails when the 5xx rate is above max_5xx_rate', () => {
    const s = soakSignal([...lines(97), ...lines(3, '/api/invoices', 502)], [], 0.01);
    expect(s).toMatchObject({ requests: 100, errors5xx: 3, rate: 0.03, verdict: 'fail' });
    expect(s.reasons[0]).toContain('above the 1.00% limit');
  });

  it('does not judge the 5xx rate on too few requests', () => {
    const s = soakSignal([...lines(5), line('/api/invoices', 500)], [], 0.01);
    expect(s.verdict).toBe('pass');
    expect(s.rate).toBeCloseTo(1 / 6);
    expect(s.reasons[0]).toContain('too few requests');
  });

  it('fails on a request to a route that no longer exists', () => {
    // The previous revision matched the partner's export; the canary answers it with an unmatched 404.
    const canary = [...lines(30), line('unmatched', 404)];
    const baseline = [...lines(270), ...lines(9, '/api/v1/export.csv')];
    const s = soakSignal(canary, baseline, 0.01);
    expect(s).toMatchObject({ unmatched: 1, unmatchedAllowed: 0, deletedRouteHits: 1, verdict: 'fail' });
    expect(s.reasons[1]).toContain('hit a route that no longer exists');
  });

  it('counts a deleted-route hit even below the minimum sample', () => {
    expect(soakSignal([line('unmatched', 404)], [], 0.01).verdict).toBe('fail');
  });

  it('excuses unmatched 404s the previous revision saw at the same rate (scanners)', () => {
    const canary = [...lines(98), ...lines(2, 'unmatched', 404)];
    const baseline = [...lines(882), ...lines(18, 'unmatched', 404)];
    const s = soakSignal(canary, baseline, 0.01);
    expect(s.unmatchedAllowed).toBe(7); // ceil(2 + 3·√2)
    expect(s).toMatchObject({ deletedRouteHits: 0, verdict: 'pass' });
    // A 404 spike well above the baseline is still caught.
    const spike = soakSignal([...lines(90), ...lines(10, 'unmatched', 404)], baseline, 0.01);
    expect(spike).toMatchObject({ deletedRouteHits: 3, verdict: 'fail' });
  });

  it('a non-404 unmatched line is not a deleted-route hit', () => {
    expect(soakSignal([...lines(30), line('unmatched', 405)], [], 0.01).deletedRouteHits).toBe(0);
  });
});
