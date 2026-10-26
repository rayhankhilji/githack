import { describe, expect, it } from 'vitest';
import { nextPromotion, renderBoard, STAGES, sciSparkline } from '../src/board.ts';
import { applyEvent, emptyLedger } from '../src/ledger.ts';
import { ledgerWith, policy } from './helpers.ts';

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

  it('T-F07-AC2: draws the SCI trend from ledger history with a first → last label', () => {
    const ledger = emptyLedger();
    ledger.sci = {
      history: [
        { at: '2026-10-27T00:00:00Z', sha: 'aaaaaaaa1', gramsPer1kRequests: 0.04 },
        { at: '2026-10-27T01:00:00Z', sha: 'bbbbbbbb2', gramsPer1kRequests: 0.039 },
        { at: '2026-10-27T02:00:00Z', sha: 'cccccccc3', gramsPer1kRequests: 0.036 },
      ],
    };
    const html = renderBoard(ledger, policy, '2026-10-27T03:00:00Z');
    expect(html).toContain('class="spark-line"');
    expect(html).toContain('0.0400 → 0.0360 g · −10.0%');
    expect(html).toContain('<b>−10.0%</b>');
    expect(sciSparkline([])).toContain('no measurements yet');
    expect(sciSparkline([{ at: '2026-10-27T00:00:00Z', sha: 'a', gramsPer1kRequests: 0.04 }])).toContain(
      '1 measurement',
    );
    expect(renderBoard(emptyLedger(), policy)).toContain('no measurements yet');
  });

  it('T-F07-AC3: each zone card shows the distance to its next promotion', () => {
    expect(nextPromotion(policy, 0).text).toBe('next promotion in 10 pts');
    expect(nextPromotion(policy, 0).next).toBe('supervised');
    expect(nextPromotion(policy, 20)).toMatchObject({ text: 'next promotion in 10 pts', next: 'hands_off' });
    expect(nextPromotion(policy, 20).progress).toBeCloseTo(0.5);
    expect(nextPromotion(policy, 35)).toEqual({ text: 'top level', progress: 1 });
    const html = renderBoard(ledgerWith({ legacy: 30, flags: 4 }), policy, '2026-10-27T03:00:00Z');
    expect(html).toContain('top level');
    expect(html).toContain('next promotion in 6 pts → Supervised');
    expect(html).toContain('forbidden · humans only');
  });

  it('T-F07-AC4: shows all nine DevSecOps stages with what runs in each', () => {
    const html = renderBoard(emptyLedger(), policy);
    expect(STAGES.map((s) => s.stage)).toEqual([
      'Plan',
      'Create',
      'Verify',
      'Package',
      'Secure',
      'Release',
      'Configure',
      'Monitor',
      'Govern',
    ]);
    for (const s of STAGES) expect(html).toContain(`<b>${s.stage}</b>`);
    expect(html).toContain('npm audit gate');
  });

  it('T-F07-AC5: head carries description, Open Graph, theme colors and an inline favicon', () => {
    const html = renderBoard(emptyLedger(), policy);
    expect(html).toMatch(/<meta name="description" content="[^"]+">/);
    expect(html).toContain('<meta property="og:title" content="Probation Board">');
    expect(html).toContain('<meta name="theme-color" content="#f4f1ea"');
    expect(html).toContain('<meta name="theme-color" content="#12110f"');
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toContain('prefers-reduced-motion:no-preference');
  });
});
