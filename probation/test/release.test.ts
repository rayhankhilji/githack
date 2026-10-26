import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/cli/common.ts', async (orig) => ({ ...(await orig<object>()), main: () => {} }));
const { releasePipeline } = await import('../src/cli/release-plan.ts');

describe('release plan', () => {
  it('T-F05-AC1: Hands-off ships to production without a manual gate', () => {
    const p = releasePipeline(
      { level: 'hands_off', agent: 'undertaker', mrIid: 7, zones: ['legacy'] },
      3,
      10,
    ) as Record<string, { when?: string }>;
    expect(p['approve:production'].when).toBe('on_success');
    expect(p['settle:survived']).toBeDefined();
  });

  it('T-F05-AC2: Supervised waits for a human before production', () => {
    const p = releasePipeline(
      { level: 'supervised', agent: 'undertaker', mrIid: 7, zones: ['legacy'] },
      3,
      10,
    ) as Record<string, { when?: string }>;
    expect(p['approve:production'].when).toBe('manual');
  });

  it('T-F05-AC3: human commits deploy but are never scored', () => {
    const p = releasePipeline({ level: 'human', zones: [] }, 3, 10) as Record<string, unknown>;
    expect(p['settle:survived']).toBeUndefined();
    expect(p['rollback:production']).toBeDefined();
  });
});
