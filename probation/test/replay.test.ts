import { describe, expect, it } from 'vitest';
import { renderBoard } from '../src/board.ts';
import { applyEvent, emptyLedger, type Ledger } from '../src/ledger.ts';
import type { ScoringEvent } from '../src/policy.ts';
import { captionText, renderReplay, replayStory, scriptJson } from '../src/replay.ts';
import { policy } from './helpers.ts';

// The mock story (scripts/mock-flow.ts): three soaks to Hands-off, one rollback, one more soak.
function story(): Ledger {
  let ledger = emptyLedger();
  const acts: [number, ScoringEvent, string][] = [
    [1, 'survived_soak', 'Bury the fax gateway'],
    [2, 'survived_soak', 'Bury POST /api/v1/sync'],
    [3, 'survived_soak', 'Bury GET /api/v1/invoices'],
    [4, 'rolled_back', 'Bury GET /api/v1/export.csv </script><script>alert(1)</script><!--'],
    [5, 'survived_soak', 'Bury the v1 deprecation shim'],
  ];
  for (const [mr, event, title] of acts) {
    const at = `2026-10-27T0${mr}:00:00.000Z`;
    const r = applyEvent(ledger, policy, { agent: 'undertaker', zones: ['legacy'], event, ref: { mr }, at });
    ledger = r.ledger;
    ledger.graveyard.push({
      at,
      mr,
      title,
      zone: 'legacy',
      linesRemoved: mr * 2,
      status: event === 'rolled_back' ? 'exhumed' : 'buried',
    });
  }
  return ledger;
}

const payload = (html: string) =>
  JSON.parse(html.match(/<script type="application\/json" id="replay-data">([\s\S]*?)<\/script>/)![1]);

describe('replay', () => {
  it('narrates each step from the ledger: climb, Hands-off, rollback, recovery', () => {
    const s = replayStory(story(), policy);
    expect(s.steps.map((x) => x.kind)).toEqual(['start', 'event', 'event', 'event', 'event', 'event', 'end']);
    expect(captionText(s.steps[3].caption)).toBe('!3 survived the soak · legacy +10 → 30 · up to Hands-off');
    expect(captionText(s.steps[4].caption)).toBe('!4 rolled back · legacy −40 → 0 · down to Assisted');
    expect(captionText(s.steps[2].caption)).toBe('!2 survived the soak · legacy +10 → 20 · Supervised');
    expect(s.steps[4].changes[0]).toMatchObject({ scoreBefore: 30, scoreAfter: 0, points: -40 });
    expect(s.steps.map((x) => x.graves)).toEqual([0, 1, 2, 3, 4, 5, 5]);
    expect(s.steps[3].next.legacy).toBe('top level');
    expect(captionText(s.steps[6].caption)).toBe('4 graves buried · 1 exhumed · −22 lines');
  });

  it('groups a change that touched several zones into one step', () => {
    const { ledger } = applyEvent(emptyLedger(), policy, {
      agent: 'undertaker',
      zones: ['legacy', 'flags'],
      event: 'survived_soak',
      ref: { mr: 9 },
      at: '2026-10-27T01:00:00.000Z',
    });
    const s = replayStory(ledger, policy);
    expect(s.zones).toEqual(['legacy', 'flags']);
    expect(s.steps).toHaveLength(3);
    expect(captionText(s.steps[1].caption)).toBe(
      '!9 survived the soak · legacy +10 → 10 · up to Supervised · flags +10 → 10 · up to Supervised',
    );
  });

  it('embeds the story as JSON that a grave title cannot break out of', () => {
    const html = renderReplay(story(), policy, '2026-10-27T06:00:00Z');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<!--');
    // Exactly the two script blocks close: the data and the player.
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(scriptJson({ t: '</script><!--&' })).toBe('{"t":"\\u003c/script\\u003e\\u003c!--\\u0026"}');
    const data = payload(html);
    expect(data.graves[3].title).toContain('</script><script>alert(1)</script><!--');
    expect(data.events).toHaveLength(5);
    expect(data.steps).toHaveLength(7);
  });

  it('has the controls, keyboard and URL hooks, and respects reduced motion', () => {
    const html = renderReplay(story(), policy);
    for (const id of ['restart', 'back', 'play', 'fwd', 'speed', 'ticks'])
      expect(html).toContain(`id="${id}"`);
    expect(html).toContain("q.get('autoplay')");
    expect(html).toContain("q.get('speed')");
    expect(html).toContain("e.key === 'ArrowLeft'");
    expect(html).toContain("e.key === ' '");
    expect(html).toContain('@media (prefers-reduced-motion:no-preference)');
    expect(html).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    // Text reaches the page through textContent only.
    expect(html).not.toContain('innerHTML');
  });

  it('carries light and dark tokens with data-theme overrides', () => {
    const html = renderReplay(story(), policy);
    expect(html).toContain('@media (prefers-color-scheme:dark){:root:not([data-theme="light"])');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toContain('--hands:#15803d');
    expect(html).toContain('--hands:#4ade80');
  });

  it('shows a friendly empty state with no events and no player', () => {
    const html = renderReplay(emptyLedger(), policy);
    expect(html).toContain('Nothing to replay yet');
    expect(html).not.toContain('<script');
  });

  it('is linked from the board', () => {
    expect(renderBoard(emptyLedger(), policy)).toContain('href="replay.html"');
  });
});
