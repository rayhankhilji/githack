import { describe, expect, it } from 'vitest';
import { applyEvent, emptyLedger, levelChanges } from '../src/ledger.ts';
import { policy } from './helpers.ts';

const ref = { mr: 1 };

describe('ledger', () => {
  it('T-F04-AC1: a survived soak promotes Assisted to Supervised', () => {
    const { ledger: next, written } = applyEvent(emptyLedger(), policy, {
      agent: 'undertaker',
      zones: ['legacy'],
      event: 'survived_soak',
      ref,
    });
    expect(next.scores.undertaker.legacy).toBe(10);
    expect(levelChanges(written)).toHaveLength(1);
    expect(written[0]).toMatchObject({ levelBefore: 'assisted', levelAfter: 'supervised' });
  });

  it('T-F04-AC2: a rollback demotes Hands-off back to Assisted', () => {
    const ledger = emptyLedger();
    ledger.scores.undertaker = { routes: 30 };
    const { ledger: next, written } = applyEvent(ledger, policy, {
      agent: 'undertaker',
      zones: ['routes'],
      event: 'rolled_back',
      ref,
    });
    expect(next.scores.undertaker.routes).toBe(0);
    expect(written[0].scoreAfter).toBe(0);
    expect(written[0]).toMatchObject({ levelBefore: 'hands_off', levelAfter: 'assisted', points: -40 });
  });

  it('T-F04-AC3: scores never go negative', () => {
    const { ledger } = applyEvent(emptyLedger(), policy, {
      agent: 'undertaker',
      zones: ['flags'],
      event: 'human_rejected',
      ref,
    });
    expect(ledger.scores.undertaker.flags).toBe(0);
  });

  it('T-F04-AC4: one event scores every touched zone and is append-only', () => {
    const before = emptyLedger();
    const { ledger } = applyEvent(before, policy, {
      agent: 'undertaker',
      zones: ['legacy', 'routes'],
      event: 'survived_soak',
      ref,
    });
    expect(ledger.events).toHaveLength(2);
    expect(before.events).toHaveLength(0);
  });
});
