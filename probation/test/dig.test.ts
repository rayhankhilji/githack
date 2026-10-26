import { describe, expect, it } from 'vitest';
import { goalFor, pickCandidate } from '../src/dig.ts';
import type { Issue } from '../src/gitlab.ts';
import { emptyLedger } from '../src/ledger.ts';
import { ledgerWith, policy } from './helpers.ts';

const issue = (iid: number, labels: string[]): Issue => ({
  iid,
  title: `grave ${iid}`,
  web_url: `https://gitlab.example/p/-/issues/${iid}`,
  description: '',
  labels: ['undertaker::candidate', ...labels],
  state: 'opened',
});

describe('pickCandidate', () => {
  it('T-F09-AC1: dig picks the dependency candidate before a route and skips forbidden, in-progress and do-not-bury issues', () => {
    const issues = [
      issue(1, ['zone::routes', 'kind::route']),
      issue(2, ['zone::auth', 'kind::dependency']),
      issue(3, ['zone::deps', 'kind::dependency', 'undertaker::in-progress']),
      issue(4, ['zone::deps', 'kind::dependency', 'undertaker::do-not-bury']),
      issue(5, ['kind::dependency']),
      issue(6, ['zone::deps', 'kind::dependency']),
    ];
    const next = pickCandidate(issues, ledgerWith({ deps: 0 }), policy);
    expect(next?.issue.iid).toBe(6);
    expect(next?.zone).toBe('deps');
    expect(next?.kind).toBe('dependency');
    expect(next?.level).toBe('assisted');
    expect(goalFor(next!)).toContain('issue #6');

    const routeOnly = pickCandidate(
      issues.filter((i) => i.iid !== 6),
      emptyLedger(),
      policy,
    );
    expect(routeOnly?.issue.iid).toBe(1);
    expect(routeOnly?.kind).toBe('route');
  });

  it('returns null when nothing is diggable', () => {
    expect(pickCandidate([issue(7, ['zone::probation', 'kind::flag'])], emptyLedger(), policy)).toBeNull();
  });
});
