import { describe, expect, it } from 'vitest';
import { decide } from '../src/gate.ts';
import { del, edit, ledgerWith, policy } from './helpers.ts';

const base = { agent: 'undertaker', introducedFindings: [], checksPassed: true };

describe('probation gate', () => {
  it('T-F03-AC1: a new agent on Assisted needs a human', () => {
    const d = decide(policy, ledgerWith({}), {
      ...base,
      files: [del('app/src/legacy/fax.ts'), edit('app/src/legacy/index.ts', 0, 2)],
    });
    expect(d.verdict).toBe('needs_human');
    expect(d.level).toBe('assisted');
    expect(d.zones.map((z) => z.zone)).toEqual(['legacy']);
  });

  it('T-F03-AC2: Supervised score auto-merges with prod approval pending', () => {
    const d = decide(policy, ledgerWith({ legacy: 10 }), { ...base, files: [del('app/src/legacy/fax.ts')] });
    expect(d.verdict).toBe('merge_supervised');
  });

  it('T-F03-AC3: Hands-off score in every touched zone merges and ships alone', () => {
    const d = decide(policy, ledgerWith({ legacy: 30, routes: 50 }), {
      ...base,
      files: [del('app/src/legacy/fax.ts'), edit('app/src/server.ts', 0, 2)],
    });
    expect(d.verdict).toBe('merge_hands_off');
  });

  it('T-F03-AC4: the least-trusted zone decides', () => {
    const d = decide(policy, ledgerWith({ legacy: 30, routes: 0 }), {
      ...base,
      files: [del('app/src/legacy/fax.ts'), edit('app/src/server.ts', 0, 2)],
    });
    expect(d.verdict).toBe('needs_human');
  });

  it('T-F03-AC5: forbidden zones block regardless of score', () => {
    const d = decide(policy, ledgerWith({ legacy: 100 }), {
      ...base,
      files: [edit('app/src/auth/apiKey.ts', 0, 5)],
    });
    expect(d.verdict).toBe('block');
    expect(d.reasons[0]).toContain('forbidden zone **auth**');
  });

  it('T-F03-AC6: the agent cannot edit its own probation rules', () => {
    const d = decide(policy, ledgerWith({ legacy: 100 }), {
      ...base,
      files: [edit('probation/policy.yml', 1, 1)],
    });
    expect(d.verdict).toBe('block');
  });

  it('T-F03-AC7: a change that grows the codebase is blocked', () => {
    const d = decide(policy, ledgerWith({ legacy: 100 }), {
      ...base,
      files: [edit('app/src/legacy/v1.ts', 30, 2)],
    });
    expect(d.verdict).toBe('block');
    expect(d.reasons.join()).toContain('adds more lines');
  });

  it('T-F03-AC8: new security findings block', () => {
    const d = decide(policy, ledgerWith({ legacy: 100 }), {
      ...base,
      files: [del('app/src/legacy/fax.ts')],
      introducedFindings: [{ fingerprint: 'x', severity: 'High', name: 'Prototype pollution' }],
    });
    expect(d.verdict).toBe('block');
  });

  it('T-F03-AC9: deleting tests of buried code is neutral; editing tests is blocked', () => {
    const ok = decide(policy, ledgerWith({ legacy: 30 }), {
      ...base,
      files: [edit('app/src/legacy/v1.ts', 0, 6), edit('app/test/server.test.ts', 0, 6)],
    });
    expect(ok.verdict).toBe('merge_hands_off');
    const weakened = decide(policy, ledgerWith({ legacy: 30 }), {
      ...base,
      files: [edit('app/src/legacy/v1.ts', 0, 6), edit('app/test/server.test.ts', 1, 6)],
    });
    expect(weakened.verdict).toBe('block');
  });

  it('blocks files outside every zone', () => {
    const d = decide(policy, ledgerWith({}), { ...base, files: [edit('README.md', 0, 3)] });
    expect(d.verdict).toBe('block');
  });
});
