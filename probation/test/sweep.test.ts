import { describe, expect, it } from 'vitest';
import type { Issue, MergeRequest } from '../src/gitlab.ts';
import { applyEvent, emptyLedger, type Ledger } from '../src/ledger.ts';
import {
  rejectionNote,
  rejectionsToScore,
  staleHours,
  staleInProgress,
  staleNote,
  zonesFromLabels,
  zonesFromPaths,
} from '../src/sweep.ts';
import { ledgerWith, policy } from './helpers.ts';

const agent = policy.agents.undertaker;

const mr = (iid: number, over: Partial<MergeRequest> = {}): MergeRequest => ({
  iid,
  title: `Bury thing ${iid}`,
  web_url: `https://gitlab.example/mr/${iid}`,
  draft: false,
  state: 'closed',
  labels: ['undertaker', 'zone::legacy+routes'],
  author: { username: 'ai-undertaker-transcend' },
  description: '',
  merged_at: null,
  ...over,
});

// Mirrors the CLI loop: score every pending rejection against the ledger.
function sweep(ledger: Ledger, mrs: MergeRequest[]): Ledger {
  let next = ledger;
  for (const m of rejectionsToScore(mrs, next, agent)) {
    const zones = zonesFromLabels(m.labels) ?? [];
    next = applyEvent(next, policy, {
      agent: 'undertaker',
      zones,
      event: 'human_rejected',
      ref: { mr: m.iid },
    }).ledger;
  }
  return next;
}

describe('human-rejection sweep', () => {
  it('T-F10-AC1: a closed, unmerged Undertaker MR scores −20 once per zone', () => {
    const before = ledgerWith({ legacy: 30, routes: 10 });
    const after = sweep(before, [mr(7)]);
    expect(after.scores.undertaker).toEqual({ legacy: 10, routes: 0 });
    expect(after.events.map((e) => [e.zone, e.event, e.ref.mr])).toEqual([
      ['legacy', 'human_rejected', 7],
      ['routes', 'human_rejected', 7],
    ]);
    expect(after.events[0]).toMatchObject({ levelBefore: 'hands_off', levelAfter: 'supervised' });
    expect(before.events).toHaveLength(0);
  });

  it('T-F10-AC1: a second sweep does not score the same MR again', () => {
    const once = sweep(ledgerWith({ legacy: 30 }), [mr(7)]);
    expect(rejectionsToScore([mr(7)], once, agent)).toEqual([]);
    const twice = sweep(once, [mr(7)]);
    expect(twice.events).toHaveLength(once.events.length);
    expect(twice.scores).toEqual(once.scores);
  });

  it('T-F10-AC1: a duplicate MR in one listing is scored once', () => {
    expect(rejectionsToScore([mr(7), mr(7)], emptyLedger(), agent)).toHaveLength(1);
  });

  it('T-F10-AC1: merged and still-open MRs are ignored', () => {
    const merged = mr(8, { state: 'merged', merged_at: '2026-10-26T10:00:00Z' });
    const closedAfterMerge = mr(9, { merged_at: '2026-10-26T10:00:00Z' });
    const open = mr(10, { state: 'opened' });
    expect(rejectionsToScore([merged, closedAfterMerge, open], emptyLedger(), agent)).toEqual([]);
  });

  it('T-F10-AC1: non-Undertaker MRs are ignored', () => {
    const human = mr(11, { labels: ['zone::legacy'], author: { username: 'priya' } });
    expect(rejectionsToScore([human], emptyLedger(), agent)).toEqual([]);
  });

  it('T-F10-AC1: other events for the same MR do not count as already scored', () => {
    const ledger = applyEvent(emptyLedger(), policy, {
      agent: 'undertaker',
      zones: ['legacy'],
      event: 'survived_soak',
      ref: { mr: 7 },
    }).ledger;
    expect(rejectionsToScore([mr(7)], ledger, agent).map((m) => m.iid)).toEqual([7]);
  });

  it('T-F10-AC1: zones fall back to the diff when the gate left no zone label', () => {
    expect(zonesFromLabels(['undertaker'])).toBeUndefined();
    expect(zonesFromLabels(['undertaker', 'zone::none'])).toBeUndefined();
    expect(zonesFromLabels(['zone::flags'])).toEqual(['flags']);
    expect(
      zonesFromPaths(policy, ['app/src/legacy/fax.ts', 'app/test/fax.test.ts', 'app/src/flags/index.ts']),
    ).toEqual(['flags', 'legacy']);
  });

  it('T-F10-AC1: the MR note names the penalty and zones', () => {
    expect(rejectionNote(['legacy', 'routes'], policy.scoring.human_rejected)).toBe(
      '⚖️ Closed without merge: −20 in zone(s) `legacy`, `routes`.',
    );
  });
});

describe('stale in-progress graves', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const issue = (iid: number, updatedHoursAgo: number | undefined, over: Partial<Issue> = {}) =>
    ({
      iid,
      title: `🪦 grave ${iid}`,
      web_url: `https://gitlab.example/issues/${iid}`,
      description: '',
      labels: ['undertaker::in-progress', 'zone::legacy'],
      state: 'opened',
      ...over,
      ...(updatedHoursAgo === undefined ? {} : { updated_at: hoursAgo(updatedHoursAgo) }),
    }) as Issue;
  const closing = (iid: number, state: string) =>
    mr(50 + iid, { state, description: `Here lies it.\n\nCloses #${iid}` });

  it('returns in-progress issues with no open or merged MR after staleHours', () => {
    const issues = [issue(1, 7), issue(2, 5), issue(3, 30), issue(4, 30), issue(5, 30)];
    const mrs = [closing(3, 'opened'), closing(4, 'merged'), closing(5, 'closed')];
    expect(staleInProgress(issues, mrs, now, 6).map((i) => i.iid)).toEqual([1, 5]);
  });

  it('only counts the closing keyword, not other mentions', () => {
    const cites = mr(60, { state: 'opened', description: 'The vendor died with #1.' });
    expect(staleInProgress([issue(1, 7)], [cites], now, 6).map((i) => i.iid)).toEqual([1]);
  });

  it('ignores other lifecycle labels, closed issues and issues without updated_at', () => {
    const issues = [
      issue(1, 30, { labels: ['undertaker::candidate'] }),
      issue(2, 30, { labels: ['undertaker::do-not-bury'] }),
      issue(3, 30, { state: 'closed' }),
      issue(4, undefined),
      { ...issue(5, undefined), updated_at: 'not a date' } as Issue,
    ];
    expect(staleInProgress(issues, [], now, 6)).toEqual([]);
  });

  it('reads stale hours from STALE_HOURS, then policy census.stale_hours, then 6', () => {
    expect(staleHours(policy)).toBe(6);
    expect(staleHours({ ...policy, census: { ...policy.census, stale_hours: 12 } } as typeof policy)).toBe(
      12,
    );
    expect(staleHours(policy, '2')).toBe(2);
    expect(staleHours(policy, 'nope')).toBe(6);
    expect(staleNote(6)).toBe('♻️ No Undertaker MR after 6 h; returned to the candidate pool.');
  });
});
