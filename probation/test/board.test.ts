import { describe, expect, it } from 'vitest';
import { renderBoard } from '../src/board.ts';
import { applyEvent, emptyLedger } from '../src/ledger.ts';
import { policy } from './helpers.ts';

describe('board', () => {
  it('T-F07-AC1: renders zones, events and graves, escaping titles', () => {
    let { ledger } = applyEvent(emptyLedger(), policy, {
      agent: 'undertaker',
      zones: ['legacy'],
      event: 'survived_soak',
      ref: { mr: 3 },
    });
    ledger = {
      ...ledger,
      graveyard: [
        {
          at: '2026-10-27T01:00:00Z',
          mr: 3,
          title: 'Bury <fax>',
          zone: 'legacy',
          linesRemoved: 12,
          status: 'buried',
        },
      ],
    };
    const html = renderBoard(ledger, policy, '2026-10-27T02:00:00Z');
    expect(html).toContain('Probation Board');
    expect(html).toContain('Bury &#60;fax&#62;');
    expect(html).toContain('−12');
    expect(html).toContain('Forbidden');
  });

  it('renders an empty ledger without errors', () => {
    expect(renderBoard(emptyLedger(), policy)).toContain('No graves yet');
  });
});
