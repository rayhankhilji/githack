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
