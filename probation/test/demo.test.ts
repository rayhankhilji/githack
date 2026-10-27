import { describe, expect, it } from 'vitest';
import {
  digSteer,
  formatJobs,
  ledgerDelta,
  mergePlan,
  nextStep,
  pickAssistedMr,
  promotePlan,
  releaseChild,
  releaseParent,
  steerMessage,
  transitions,
  verdictLines,
} from '../src/demo.ts';
import type { Issue, Job, MergeRequestDetail, Pipeline, TriggerJob } from '../src/gitlab.ts';
import { emptyLedger } from '../src/ledger.ts';
import { ledgerWith, policy } from './helpers.ts';

const pipeline = (id: number, status = 'success', source = 'push'): Pipeline => ({
  id,
  status,
  source,
  ref: 'main',
  sha: `sha${id}`,
  web_url: `https://gl/p/-/pipelines/${id}`,
  created_at: '2026-10-27T00:00:00Z',
});

const job = (name: string, status: string, id = 1): Job => ({
  id,
  name,
  stage: name.split(':')[0],
  status,
  web_url: `https://gl/p/-/jobs/${id}`,
  pipeline: { id: 9 },
});

const mr = (iid: number, labels: string[], head?: Pipeline | null): MergeRequestDetail => ({
  iid,
  title: `MR ${iid}`,
  web_url: `https://gl/p/-/merge_requests/${iid}`,
  draft: false,
  state: 'opened',
  labels,
  author: { username: 'ai-undertaker-bot' },
  description: '',
  sha: `head${iid}`,
  head_pipeline: head,
});

const issue = (iid: number, labels: string[], state = 'opened'): Issue => ({
  iid,
  title: `grave ${iid}`,
  web_url: `https://gl/p/-/issues/${iid}`,
  description: '',
  labels,
  state,
});

describe('demo conductor decisions', () => {
  it('the release parent is the newest non-scheduled pipeline, optionally newer than a given id', () => {
    const list = [pipeline(5, 'success', 'schedule'), pipeline(4), pipeline(3, 'running', 'web')];
    expect(releaseParent(list)?.id).toBe(4);
    expect(releaseParent(list, 4)).toBeUndefined();
    expect(releaseParent([pipeline(6, 'running', 'parent_pipeline')])).toBeUndefined();
  });

  it('the release child is release:run’s downstream pipeline, once created', () => {
    const bridge = (downstream: Pipeline | null): TriggerJob => ({
      ...job('release:run', 'success'),
      downstream_pipeline: downstream,
    });
    expect(releaseChild([bridge(pipeline(8))])?.id).toBe(8);
    expect(releaseChild([bridge(null)])).toBeUndefined();
    expect(releaseChild([])).toBeUndefined();
  });

  it('promote plays only a manual approve:production', () => {
    expect(promotePlan([job('approve:production', 'manual')]).action).toBe('play');
    expect(promotePlan([job('approve:production', 'success')]).action).toBe('done');
    expect(promotePlan([job('approve:production', 'created')]).action).toBe('wait');
    expect(promotePlan([job('approve:production', 'skipped')]).action).toBe('none');
    expect(promotePlan([job('deploy:staging', 'success')])).toMatchObject({ action: 'none' });
  });

  it('approve picks the newest open Assisted MR and merges only after a green pipeline', () => {
    const picked = pickAssistedMr([
      mr(1, ['undertaker', 'probation::assisted']),
      mr(3, ['undertaker', 'probation::assisted']),
      mr(4, ['undertaker', 'probation::supervised']),
    ]);
    expect(picked.mr?.iid).toBe(3);
    expect(pickAssistedMr([mr(4, ['probation::hands_off'])]).message).toContain('!4 is Hands-off');
    expect(pickAssistedMr([mr(5, ['undertaker'])]).message).toContain('probation:gate has not run');
    expect(pickAssistedMr([]).message).toBe('no open Undertaker MR');

    expect(mergePlan(mr(1, [], pipeline(2, 'success')))).toEqual({ merge: true });
    expect(mergePlan(mr(1, [], pipeline(2, 'running')))).toMatchObject({ merge: false });
    expect(mergePlan(mr(1, [], pipeline(2, 'failed')))).toMatchObject({
      merge: false,
      reason: expect.stringContaining('gate blocked'),
    });
    expect(mergePlan(mr(1, [], null))).toMatchObject({ merge: false });
  });

  it('dig steering lists the candidates ahead of the wanted one, in dig order', () => {
    const candidates = [
      issue(1, ['undertaker::candidate', 'zone::legacy', 'kind::route']),
      issue(2, ['undertaker::candidate', 'zone::legacy', 'kind::flag']),
      issue(3, ['undertaker::candidate', 'zone::deps', 'kind::dependency']),
    ];
    const s = digSteer(candidates, candidates[0], emptyLedger(), policy);
    expect(s.pick?.iid).toBe(3);
    expect(s.ahead.map((i) => i.iid)).toEqual([3, 2]);
    expect(steerMessage(s, 1).join('\n')).toContain(
      'Ahead of #1 (dependency → export → flag → route): #3, #2',
    );

    expect(digSteer(candidates, candidates[2], emptyLedger(), policy).ahead).toEqual([]);
    expect(steerMessage({ ahead: [] }, 3)).toEqual(['✅ dig picks #3 next.']);

    const forbidden = issue(9, ['undertaker::candidate', 'zone::auth']);
    expect(digSteer(candidates, forbidden, emptyLedger(), policy).blocked).toContain('forbidden');
    const closed = issue(8, ['undertaker::buried'], 'closed');
    expect(digSteer(candidates, closed, emptyLedger(), policy).blocked).toBe('#8 is closed');
  });

  it('verdict lines keep the soak verdict and drop ANSI, section markers and noise', () => {
    const trace = [
      'section_start:1730000000:step_script\r\x1b[0K\x1b[32;1m$ node probation/src/cli/soak.ts\x1b[0;m',
      'npm warn deprecated',
      'soak signal for rev-2: FAIL',
      '  canary: 10 requests, 2 5xx, 0 unmatched 404',
      '  - 5xx rate 20.0% > 1.0%',
      '✖ canary signal failed: 5xx rate',
      'section_end:1730000001:step_script\r\x1b[0K',
    ].join('\n');
    expect(verdictLines(trace)).toEqual([
      'soak signal for rev-2: FAIL',
      '  canary: 10 requests, 2 5xx, 0 unmatched 404',
      '  - 5xx rate 20.0% > 1.0%',
      '✖ canary signal failed: 5xx rate',
    ]);
  });

  it('ledger delta prints only the new events, with promotions and demotions', () => {
    const before = ledgerWith({ legacy: 20 });
    const after = ledgerWith({ legacy: 30 });
    after.events = [
      {
        at: 'x',
        agent: 'undertaker',
        zone: 'legacy',
        event: 'survived_soak',
        points: 10,
        scoreAfter: 30,
        levelBefore: 'supervised',
        levelAfter: 'hands_off',
        ref: { mr: 3 },
      },
    ];
    expect(ledgerDelta(before, after)).toEqual([
      'legacy: +10 survived_soak → score 30, 🟡 Supervised → 🟢 Hands-off 🎖️ (!3)',
    ]);
    expect(ledgerDelta(after, after)).toEqual([]);
  });

  it('formats jobs in release order and reports transitions once', () => {
    const jobs = [job('promote:production', 'created'), job('deploy:staging', 'running')];
    expect(formatJobs(jobs, '')).toEqual([
      'deploy:staging      🔄 running',
      'promote:production  ⏳ created',
    ]);
    const seen = new Map<string, string>();
    expect(transitions(seen, jobs)).toEqual(['deploy:staging: 🔄 running', 'promote:production: ⏳ created']);
    expect(transitions(seen, jobs)).toEqual([]);
    expect(transitions(seen, [job('deploy:staging', 'success')])).toEqual([
      'deploy:staging: 🔄 running → ✅ success',
    ]);
  });

  it('next step follows the act in flight', () => {
    const issues = { candidate: [], 'in-progress': [], buried: [], 'do-not-bury': [] };
    const base = { issues, mrs: [], childJobs: [] };
    expect(nextStep(base)).toContain('npm run demo -- dig');
    expect(nextStep({ ...base, mrs: [mr(1, ['probation::assisted'])] })).toContain('npm run demo -- approve');
    expect(
      nextStep({ ...base, child: pipeline(9, 'manual'), childJobs: [job('approve:production', 'manual')] }),
    ).toContain('npm run demo -- promote');
    expect(nextStep({ ...base, child: pipeline(9, 'running') })).toContain('npm run demo -- watch');
    expect(nextStep({ ...base, issues: { ...issues, 'in-progress': [issue(4, [])] } })).toContain(
      'Undertaker is digging #4',
    );
  });
});
