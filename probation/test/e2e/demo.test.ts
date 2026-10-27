// End-to-end: scripts/demo.ts (the demo conductor), spawned as a human would run it, against the in-memory
// GitLab (probation/sim). Each act of RUNBOOK §5 is one command: status, dig, approve, promote, watch.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addPipeline,
  createIssue,
  createMr,
  type FakeGitLab,
  type FakePipeline,
  jobBy,
  start,
} from '../../sim/gitlab-fake.ts';
import { emptyLedger, type Ledger } from '../../src/ledger.ts';
import { SCHEDULE_DESCRIPTION } from '../../src/setup.ts';

const ROOT = process.cwd();
const TIMEOUT = { timeout: 30_000 };

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function demo(fake: FakeGitLab, ...args: string[]): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GITLAB_API_URL: fake.url,
    GITLAB_PROJECT: fake.state.project.path,
    GITLAB_TOKEN: fake.state.userToken,
  };
  return new Promise((done) => {
    execFile(
      process.execPath,
      [join(ROOT, 'scripts', 'demo.ts'), ...args],
      { cwd: ROOT, env, timeout: 25_000 },
      (error, stdout, stderr) =>
        done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
    );
  });
}

function ledger(scores: Record<string, number>, events: Ledger['events'] = []): Ledger {
  return { ...emptyLedger(), scores: { undertaker: scores }, events };
}

const setLedger = (fake: FakeGitLab, l: Ledger) =>
  fake.state.branches.set('ledger', new Map([['ledger.json', JSON.stringify(l)]]));

const RELEASE_JOBS = [
  'deploy:staging',
  'approve:production',
  'deploy:canary',
  'soak:canary',
  'soak:canary-logs',
  'soak:canary-signal',
  'promote:production',
  'rollback:soak',
  'rollback:production',
  'settle:survived',
  'settle:rolled-back',
];

/** A main pipeline whose release:run bridge triggered a child with the release jobs, all `created`. */
function release(fake: FakeGitLab, approve = 'created'): { parent: FakePipeline; child: FakePipeline } {
  const child = addPipeline(fake.state, {
    status: 'running',
    source: 'parent_pipeline',
    jobs: RELEASE_JOBS.map((name) => ({
      name,
      status: name === 'approve:production' ? approve : 'created',
    })),
  });
  const parent = addPipeline(fake.state, {
    status: 'running',
    jobs: [{ name: 'verify:check', status: 'success' }],
    trigger: { name: 'release:run', child },
  });
  return { parent, child };
}

const setJobs = (fake: FakeGitLab, child: FakePipeline, statuses: Record<string, string>) => {
  for (const [name, status] of Object.entries(statuses)) jobBy(fake.state, child.id, name).status = status;
};

describe('npm run demo, end to end', TIMEOUT, () => {
  let fake: FakeGitLab;

  beforeEach(async () => {
    fake = await start();
    const s = fake.state;
    s.project.only_allow_merge_if_pipeline_succeeds = true;
    s.project.schedules.push({
      id: 11,
      description: SCHEDULE_DESCRIPTION,
      ref: 'refs/heads/main',
      cron: '17 2 * * *',
      cron_timezone: 'UTC',
      active: true,
      variables: [],
    });
    setLedger(fake, ledger({ legacy: 10 }));
    createIssue(s, {
      iid: 1,
      title: '🪦 POST /api/fax-invoice',
      labels: ['undertaker::candidate', 'zone::legacy', 'kind::route'],
    });
    createIssue(s, {
      iid: 2,
      title: '🪦 moment',
      labels: ['undertaker::candidate', 'zone::deps', 'kind::dependency'],
    });
    createIssue(s, {
      iid: 3,
      title: '🪦 GET /api/v1/export.csv',
      labels: ['undertaker::do-not-bury', 'zone::legacy', 'kind::route'],
    });
  });
  afterEach(async () => {
    await fake?.close();
  });

  it('status shows ledger, graves, Undertaker MRs, the release pipeline and the next step', async () => {
    const s = fake.state;
    const mrPipeline = addPipeline(s, {
      status: 'success',
      source: 'merge_request_event',
      ref: 'undertaker/bury-1',
    });
    const mr = createMr(s, {
      title: 'Bury POST /api/fax-invoice',
      labels: ['undertaker', 'probation::assisted', 'zone::legacy'],
      diffs: [],
    });
    mr.head_pipeline_id = mrPipeline.id;
    const { parent, child } = release(fake, 'manual');
    setJobs(fake, child, { 'deploy:staging': 'success' });
    child.status = 'manual';
    parent.status = 'manual';
    addPipeline(s, { status: 'success', source: 'schedule' });

    const r = await demo(fake, 'status');
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/legacy +10 +🟡 Supervised/);
    expect(r.stdout).toMatch(/deps +0 +🧑‍⚖️ Assisted/);
    expect(r.stdout).not.toMatch(/^ +auth /m);
    expect(r.stdout).toContain('undertaker::candidate (2)');
    expect(r.stdout).toContain('#2 [deps/dependency] 🪦 moment');
    expect(r.stdout).toContain('undertaker::do-not-bury (1)');
    expect(r.stdout).toMatch(/!1 +🧑‍⚖️ Assisted +pipeline ✅ success +Bury POST \/api\/fax-invoice/);
    // The scheduled census pipeline is newer but never releases: the release parent is the push pipeline.
    expect(r.stdout).toContain(`main #${parent.id}  ✋ manual`);
    expect(r.stdout).toContain(`release child #${child.id}  ✋ manual`);
    expect(r.stdout).toMatch(/deploy:staging +✅ success\n +approve:production +✋ manual\n +deploy:canary/);
    expect(r.stdout).toContain('👉 Next: npm run demo -- promote');
    expect(r.stdout + r.stderr).not.toContain(s.userToken);
    // Read-only.
    expect(s.requests.filter((q) => q.method !== 'GET')).toEqual([]);
  });

  it('dig explains how to steer when --issue is not next, and does not play the schedule', async () => {
    const r = await demo(fake, 'dig', '--issue', '1');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('dig would pick #2 (🪦 moment), not #1');
    expect(r.stdout).toContain('Ahead of #1 (dependency → export → flag → route): #2');
    expect(r.stdout).toContain('undertaker::in-progress');
    expect(fake.state.requests.filter((q) => q.method === 'POST')).toEqual([]);

    const never = await demo(fake, 'dig', '--issue', '3');
    expect(never.code).toBe(1);
    expect(never.stdout).toContain('dig will never pick #3: #3 is not labelled undertaker::candidate');
  });

  it('dig plays the census schedule and prints the new pipeline', async () => {
    const r = await demo(fake, 'dig', '--issue', '2', '--interval', '0.05');
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('✅ dig picks #2 next.');
    expect(r.stdout).toContain('▶️  Played schedule #11');
    const scheduled = fake.state.pipelines.filter((p) => p.source === 'schedule');
    expect(scheduled).toHaveLength(1);
    expect(r.stdout).toContain(`/-/pipelines/${scheduled[0].id}`);
    expect(fake.state.requests).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: expect.stringMatching(/pipeline_schedules\/11\/play$/),
      }),
    );
  });

  it('approve approves, but merges only once the MR pipeline succeeded', async () => {
    const s = fake.state;
    const p = addPipeline(s, { status: 'running', source: 'merge_request_event', ref: 'undertaker/bury-1' });
    const mr = createMr(s, {
      title: 'Draft: Bury POST /api/fax-invoice',
      labels: ['undertaker', 'probation::assisted', 'zone::legacy'],
      diffs: [],
    });
    mr.head_pipeline_id = p.id;
    // A newer Supervised MR is not the one to approve.
    createMr(s, { title: 'Bury moment', labels: ['undertaker', 'probation::supervised'], diffs: [] });

    const waiting = await demo(fake, 'approve');
    expect(waiting.code).toBe(1);
    expect(waiting.stdout).toContain('!1 Draft: Bury POST /api/fax-invoice');
    expect(waiting.stdout).toContain('✅ approved');
    expect(waiting.stdout).toMatch(/not merging: !1's pipeline is running/);
    expect(mr.state).toBe('opened');
    expect(s.approvals).toEqual([{ iid: 1, username: 'owner' }]);

    p.status = 'success';
    const r = await demo(fake, 'approve');
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('✅ approved (already, by you)');
    expect(r.stdout).toContain('✅ marked ready');
    expect(r.stdout).toContain('✅ merged');
    expect(r.stdout).toContain('npm run demo -- watch --new');
    expect(mr.state).toBe('merged');
    expect(s.merges).toEqual([
      expect.objectContaining({ iid: 1, sha: mr.sha, should_remove_source_branch: true }),
    ]);
    expect(s.merges[0].auto_merge).toBeUndefined();
  });

  it('approve refuses a failed (blocked) pipeline', async () => {
    const s = fake.state;
    const p = addPipeline(s, { status: 'failed', source: 'merge_request_event' });
    const mr = createMr(s, { title: 'Bury auth', labels: ['undertaker', 'probation::assisted'], diffs: [] });
    mr.head_pipeline_id = p.id;
    const r = await demo(fake, 'approve');
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/not merging: !1's pipeline failed \(gate blocked/);
    expect(mr.state).toBe('opened');
  });

  it('promote plays approve:production in the release child, once', async () => {
    const { child } = release(fake, 'manual');
    setJobs(fake, child, { 'deploy:staging': 'success' });
    const approve = jobBy(fake.state, child.id, 'approve:production');

    const r = await demo(fake, 'promote');
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`▶️  Played approve:production (⏳ pending): `);
    expect(r.stdout).toContain(`/-/jobs/${approve.id}`);
    expect(approve.status).toBe('pending');

    const again = await demo(fake, 'promote');
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('approve:production is already pending');
    expect(fake.state.requests.filter((q) => q.path.endsWith('/play'))).toHaveLength(1);
  });

  it('promote waits while deploy:staging runs', async () => {
    release(fake, 'created');
    const r = await demo(fake, 'promote');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('approve:production is created: deploy:staging has not finished');
  });

  it('watch --new follows a new release to success and prints the soak verdict and ledger delta', async () => {
    const s = fake.state;
    // An older, finished release that --new must ignore.
    const old = release(fake, 'success');
    old.parent.status = 'success';
    old.child.status = 'success';

    let lists = 0;
    let polls = 0;
    let fresh: { parent: FakePipeline; child: FakePipeline } | undefined;
    s.onRequest = (method, path) => {
      if (method !== 'GET') return;
      if (path.endsWith('/pipelines') && ++lists === 3) fresh = release(fake, 'created');
      if (!fresh || !path.endsWith(`/pipelines/${fresh.child.id}/jobs`)) return;
      const c = fresh.child;
      const step = ++polls;
      if (step === 1) setJobs(fake, c, { 'deploy:staging': 'running' });
      if (step === 2)
        setJobs(fake, c, {
          'deploy:staging': 'success',
          'approve:production': 'success',
          'deploy:canary': 'running',
        });
      if (step === 3) setJobs(fake, c, { 'deploy:canary': 'success', 'soak:canary': 'running' });
      if (step === 4) {
        setJobs(fake, c, {
          'soak:canary': 'success',
          'soak:canary-logs': 'success',
          'soak:canary-signal': 'success',
          'promote:production': 'success',
          'rollback:soak': 'skipped',
          'rollback:production': 'skipped',
          'settle:survived': 'success',
          'settle:rolled-back': 'skipped',
        });
        jobBy(s, c.id, 'soak:canary').trace =
          '\x1b[32;1m$ node probation/src/cli/soak.ts\x1b[0;m\nsoak: 4 synthetics against https://canary for 3 min\nnpm notice\nsoak: 48 checks, 0 failures\n';
        jobBy(s, c.id, 'soak:canary-signal').trace =
          'soak signal for tallybook-00042: PASS\n  canary: 812 requests, 0 5xx, 0 unmatched 404\n  baseline: 7301 requests, 3 unmatched 404\n';
        c.status = 'success';
        fresh.parent.status = 'success';
        setLedger(
          fake,
          ledger({ legacy: 20 }, [
            {
              at: '2026-10-27T10:00:00Z',
              agent: 'undertaker',
              zone: 'legacy',
              event: 'survived_soak',
              points: 10,
              scoreAfter: 20,
              levelBefore: 'supervised',
              levelAfter: 'supervised',
              ref: { mr: 2 },
            },
          ]),
        );
      }
    };

    const r = await demo(fake, 'watch', '--new', '--interval', '0.02', '--timeout', '20');
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('waiting for a new pipeline on main');
    expect(r.stdout).toContain(`release child #${fresh?.child.id}`);
    expect(r.stdout).not.toContain(`release child #${old.child.id}`);
    expect(r.stdout).toMatch(/\d deploy:staging: 🔄 running\n/);
    expect(r.stdout).toMatch(/deploy:staging: 🔄 running → ✅ success/);
    expect(r.stdout).toMatch(/promote:production: ⏳ created → ✅ success/);
    expect(r.stdout).toContain('✅ success soak:canary\n   soak: 4 synthetics');
    expect(r.stdout).toContain('soak: 48 checks, 0 failures');
    expect(r.stdout).not.toContain('npm notice');
    expect(r.stdout).toContain('soak signal for tallybook-00042: PASS');
    expect(r.stdout).toContain('legacy: +10 survived_soak → score 20, 🟡 Supervised (!2)');
    expect(r.stdout).toContain('✅ released');
  });

  it('watch reports a rollback: exit 1, the failing synthetic, signal reasons and the demotion', async () => {
    const s = fake.state;
    setLedger(fake, ledger({ legacy: 30 }));
    const { parent, child } = release(fake, 'success');
    setJobs(fake, child, {
      'deploy:staging': 'success',
      'deploy:canary': 'success',
      'soak:canary': 'running',
    });
    let polls = 0;
    s.onRequest = (method, path) => {
      if (method !== 'GET' || !path.endsWith(`/pipelines/${child.id}/jobs`) || ++polls !== 2) return;
      setJobs(fake, child, {
        'soak:canary': 'failed',
        'soak:canary-logs': 'success',
        'soak:canary-signal': 'failed',
        'promote:production': 'skipped',
        'rollback:soak': 'success',
        'rollback:production': 'success',
        'settle:survived': 'skipped',
        'settle:rolled-back': 'success',
      });
      jobBy(s, child.id, 'soak:canary').trace =
        'soak: 4 synthetics against https://canary for 3 min\r\n✖ canary failed: bookkeeping-partner-monthly-export /api/v1/export.csv → 404\nCleaning up project directory\n';
      jobBy(s, child.id, 'soak:canary-signal').trace =
        'soak signal for tallybook-00043: FAIL\n  canary: 640 requests, 0 5xx, 3 unmatched 404\n  baseline: 5120 requests, 0 unmatched 404\n  - 3 hits on deleted routes: GET /api/v1/export.csv\n✖ canary signal failed: 3 hits on deleted routes\n';
      child.status = 'failed';
      parent.status = 'failed';
      setLedger(
        fake,
        ledger({ legacy: 0 }, [
          {
            at: '2026-10-27T11:00:00Z',
            agent: 'undertaker',
            zone: 'legacy',
            event: 'rolled_back',
            points: -40,
            scoreAfter: 0, // scores floor at 0 (applyEvent)
            levelBefore: 'hands_off',
            levelAfter: 'assisted',
            ref: { mr: 4 },
          },
        ]),
      );
    };

    const r = await demo(fake, 'watch', '--interval', '0.02', '--timeout', '20');
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/soak:canary: 🔄 running → ❌ failed/);
    expect(r.stdout).toMatch(/rollback:production: ⏳ created → ✅ success/);
    expect(r.stdout).toContain('❌ failed soak:canary');
    expect(r.stdout).toContain(
      '✖ canary failed: bookkeeping-partner-monthly-export /api/v1/export.csv → 404',
    );
    expect(r.stdout).toContain('soak signal for tallybook-00043: FAIL');
    expect(r.stdout).toContain('  - 3 hits on deleted routes: GET /api/v1/export.csv');
    expect(r.stdout).toContain('legacy: -40 rolled_back → score 0, 🟢 Hands-off → 🧑‍⚖️ Assisted ⬇️ (!4)');
    expect(r.stdout).toContain('❌ release failed');
  });

  it('rejects an unknown command with usage', async () => {
    const r = await demo(fake, 'dance');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('usage: npm run demo -- <status|dig|approve|promote|watch>');
  });
});
