// End-to-end: the real CLIs, spawned as CI would run them, against an in-memory GitLab (probation/sim).
// Replays the demo story: census → dig → gate → release → settle across four acts, then sweep and board.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  closeMr,
  createIssue,
  createMr,
  type FakeGitLab,
  type FakeIssue,
  fileOn,
  mergeMr,
  start,
} from '../../sim/gitlab-fake.ts';
import type { MrDiff } from '../../src/gitlab.ts';
import type { Ledger, LedgerEvent } from '../../src/ledger.ts';

const ROOT = process.cwd();
const TIMEOUT = { timeout: 30_000 };

// A scratch CI checkout: CLIs read app/ and probation/ relative to cwd and write .out/ and public/ there.
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'probation-e2e-'));
  symlinkSync(join(ROOT, 'app'), join(dir, 'app'));
  symlinkSync(join(ROOT, 'probation'), join(dir, 'probation'));
  return dir;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(
  fake: FakeGitLab,
  cwd: string,
  name: string,
  args: string[] = [],
  vars: Record<string, string> = {},
): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    CI_API_V4_URL: fake.url,
    CI_PROJECT_ID: fake.state.projectId,
    GITLAB_PROBATION_TOKEN: fake.state.projectToken,
    CI_DEFAULT_BRANCH: 'main',
    ...vars,
  };
  return new Promise((done) => {
    execFile(
      process.execPath,
      [join(ROOT, 'probation/src/cli', `${name}.ts`), ...args],
      { cwd, env, timeout: 25_000 },
      (error, stdout, stderr) =>
        done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
    );
  });
}

async function ok(run: Promise<Run>): Promise<Run> {
  const r = await run;
  if (r.code !== 0) throw new Error(`CLI exited ${r.code}\n${r.stdout}\n${r.stderr}`);
  return r;
}

const minus = (n: number) => Array.from({ length: n }, (_, i) => `-dead line ${i}`).join('\n');
const deleted = (path: string, n: number): MrDiff => ({
  old_path: path,
  new_path: path,
  deleted_file: true,
  diff: `@@ -1,${n} +0,0 @@\n${minus(n)}\n`,
});
const edited = (path: string, n: number): MrDiff => ({
  old_path: path,
  new_path: path,
  deleted_file: false,
  diff: `@@ -1,${n + 1} +1,1 @@\n context\n${minus(n)}\n`,
});

// ≥ min_requests_in_window lines, none of them to legacy routes.
function censusLog(): string {
  const live = [
    'GET /',
    'GET /api/invoices',
    'GET /api/invoices/:id',
    'POST /api/invoices',
    'POST /api/invoices/:id/pay',
    'GET /api/invoices/:id/pdf',
    'GET /healthz',
  ];
  return Array.from({ length: 210 }, (_, i) => {
    const [method, route] = live[i % live.length].split(' ');
    return JSON.stringify({ census: 1, method, route, status: 200, flags: { newTotals: true } });
  }).join('\n');
}

describe('the Probation story, end to end', TIMEOUT, () => {
  let fake: FakeGitLab;
  let ws: string;
  const marker = (key: string) => `<!-- undertaker:key=${key} -->`;
  const ledger = () => JSON.parse(fileOn(fake.state, 'ledger', 'ledger.json') ?? 'null') as Ledger;
  const audit = () =>
    (fileOn(fake.state, 'ledger', 'audit.jsonl') ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEvent);
  const issueFor = (key: string) => fake.state.issues.filter((i) => i.description.includes(marker(key)));
  const titled = (prefix: string) => fake.state.issues.filter((i) => i.title.startsWith(prefix));
  let fax: FakeIssue;
  let unrelated: FakeIssue;

  beforeAll(async () => {
    fake = await start();
    ws = workspace();
    mkdirSync(join(ws, '.out'));
    writeFileSync(join(ws, '.out/census-log.json'), censusLog());
  });
  afterAll(async () => {
    await fake?.close();
    if (ws) rmSync(ws, { recursive: true, force: true });
  });

  it('census files graves and creates the ledger branch with traffic.json', async () => {
    expect(fake.state.branches.has('ledger')).toBe(false);
    const r = await ok(cli(fake, ws, 'census'));
    expect(r.stdout).toContain('210 requests');

    const faxIssues = issueFor('route:POST /api/fax-invoice');
    expect(faxIssues).toHaveLength(1);
    fax = faxIssues[0];
    expect(fax.title).toBe('🪦 POST /api/fax-invoice has 0 requests in 7d');
    expect(fax.labels).toEqual(
      expect.arrayContaining(['undertaker::candidate', 'zone::legacy', 'kind::route']),
    );
    expect(issueFor('dependency:lodash')[0].labels).toEqual(
      expect.arrayContaining(['zone::deps', 'kind::dependency']),
    );
    expect(fake.state.issues.every((i) => i.title.startsWith('🪦 '))).toBe(true);

    const traffic = JSON.parse(fileOn(fake.state, 'ledger', 'traffic.json') ?? '{}') as Record<
      string,
      number
    >;
    expect(traffic['GET /api/invoices']).toBe(30);
    expect(traffic['POST /api/fax-invoice']).toBeUndefined();
    expect(fake.state.commits.at(-1)).toMatchObject({
      branch: 'ledger',
      start_branch: 'main',
      actions: [{ action: 'create', file_path: 'traffic.json' }],
    });
  });

  it('start-flow digs the next grave with the owner token', async () => {
    // RUNBOOK §5: steer the story by closing the candidates we don't want yet.
    for (const i of fake.state.issues) if (i.iid !== fax.iid) i.state = 'closed';
    unrelated = createIssue(fake.state, { iid: 99, title: 'Fax vendor contract ended' });

    await ok(
      cli(fake, ws, 'start-flow', [], {
        DUO_FLOW_TRIGGER_TOKEN: fake.state.userToken,
        UNDERTAKER_CONSUMER_ID: 'gid://gitlab/Ai::Catalog::ItemConsumer/4211',
      }),
    );
    expect(fake.state.flows).toHaveLength(1);
    const [flow] = fake.state.flows;
    expect(flow.token).toBe(fake.state.userToken);
    expect(flow.body).toMatchObject({
      project_id: '42',
      ai_catalog_item_consumer_id: 4211,
      start_workflow: true,
      issue_id: fax.iid,
    });
    expect(String(flow.body.goal)).toContain(`#${fax.iid}`);
    // Scoped label: in-progress replaces candidate, exactly as GitLab does.
    expect(fax.labels).toContain('undertaker::in-progress');
    expect(fax.labels).not.toContain('undertaker::candidate');
    expect(fake.state.notes.find((n) => n.noteable === 'issue' && n.iid === fax.iid)?.body).toContain(
      'flow #901 started',
    );
  });

  it('a second census does not re-file a grave that is in progress', async () => {
    const before = fake.state.issues.length;
    await ok(cli(fake, ws, 'census'));
    expect(fake.state.issues).toHaveLength(before);
    expect(fake.state.commits.at(-1)?.actions).toEqual([{ action: 'update', file_path: 'traffic.json' }]);
  });

  // One act: the flow's MR → gate → (merge) → release-plan → settle. Returns what each step saw.
  async function act(
    n: number,
    opts: { closes: number; diffs: MrDiff[]; outcome?: 'survived' | 'rolled_back'; mergedResults?: boolean },
  ) {
    const mr = createMr(fake.state, {
      title: `Draft: Bury act ${n}`,
      labels: ['undertaker'],
      description: `Here lies act ${n}. The vendor died with #99.\n\nCloses #${opts.closes}`,
      diffs: opts.diffs,
    });
    const gateVars: Record<string, string> = {
      CI_MERGE_REQUEST_IID: String(mr.iid),
      CI_COMMIT_SHA: opts.mergedResults ? 'f'.repeat(40) : mr.sha,
      CI_PIPELINE_ID: String(100 + n),
    };
    if (opts.mergedResults) gateVars.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA = mr.sha;
    const gate = await ok(cli(fake, ws, 'gate', [], gateVars));
    const note = fake.state.notes.filter((x) => x.noteable === 'mr' && x.iid === mr.iid).at(-1)?.body ?? '';
    const autoMerge = mr.merge_when_pipeline_succeeds;
    const labelsAfterGate = [...mr.labels];
    if (!opts.outcome) return { mr, gate, note, autoMerge, labelsAfterGate };

    // A human merges an Assisted MR; auto-merge fires for the others once the pipeline passes.
    const sha = mergeMr(fake.state, mr.iid);
    await ok(cli(fake, ws, 'release-plan', [], { CI_COMMIT_SHA: sha }));
    const plan = parse(readFileSync(join(ws, '.out/release.yml'), 'utf8')) as {
      variables: Record<string, string>;
    } & Record<string, unknown>;
    const settle = await ok(
      cli(fake, ws, 'settle', ['--outcome', opts.outcome], {
        ...plan.variables,
        CI_COMMIT_SHA: sha,
        CI_COMMIT_SHORT_SHA: sha.slice(0, 8),
        CI_PIPELINE_ID: String(200 + n),
      }),
    );
    return { mr, gate, note, autoMerge, labelsAfterGate, sha, plan, settle };
  }

  it('act 1: Assisted — the gate labels and notes but does not merge; settle promotes', async () => {
    const r = await act(1, {
      closes: fax.iid,
      diffs: [deleted('app/src/legacy/fax.ts', 8), edited('app/src/legacy/index.ts', 2)],
    });
    expect(r.note).toContain('Assisted');
    expect(r.labelsAfterGate).toEqual(
      expect.arrayContaining(['undertaker', 'probation::assisted', 'zone::legacy']),
    );
    expect(r.mr.state).toBe('opened');
    expect(fake.state.merges).toHaveLength(0);

    const sha = mergeMr(fake.state, r.mr.iid);
    await ok(cli(fake, ws, 'release-plan', [], { CI_COMMIT_SHA: sha }));
    const plan = parse(readFileSync(join(ws, '.out/release.yml'), 'utf8')) as {
      variables: Record<string, string>;
    } & Record<string, unknown>;
    expect(plan.variables).toMatchObject({
      RELEASE_LEVEL: 'assisted',
      RELEASE_ZONES: 'legacy',
      RELEASE_MR_IID: '1',
    });
    expect(plan).toHaveProperty(['settle:survived']);
    expect(plan).toHaveProperty(['settle:rolled-back']);
    expect((plan['approve:production'] as { when: string }).when).toBe('manual');

    await ok(
      cli(fake, ws, 'settle', ['--outcome', 'survived'], {
        ...plan.variables,
        CI_COMMIT_SHA: sha,
        CI_COMMIT_SHORT_SHA: sha.slice(0, 8),
        CI_PIPELINE_ID: '201',
      }),
    );
    expect(ledger().scores.undertaker.legacy).toBe(10);
    expect(ledger().graveyard).toMatchObject([{ mr: 1, zone: 'legacy', linesRemoved: 10, status: 'buried' }]);
    expect(audit()).toHaveLength(1);
    expect(titled('🎖️ Promotion')).toHaveLength(1);
    expect(titled('🎖️ Promotion')[0].title).toContain('Supervised in zone legacy');
    expect(fax.state).toBe('closed');
    expect(fax.labels).not.toContain('undertaker::in-progress');
    expect(unrelated.state).toBe('opened');
  });

  it('acts 2–3: Supervised — the gate undrafts and sets auto-merge; two survivals reach Hands-off', async () => {
    const sync = issueFor('route:POST /api/v1/sync')[0];
    const two = await act(2, {
      closes: sync.iid,
      diffs: [edited('app/src/legacy/v1.ts', 2)],
      outcome: 'survived',
      mergedResults: true,
    });
    expect(two.note).toContain('Supervised');
    expect(two.autoMerge).toBe(true);
    expect(fake.state.merges.at(-1)).toMatchObject({ iid: two.mr.iid, sha: two.mr.sha, auto_merge: true });
    expect(two.mr.title).toBe('Bury act 2');
    expect(two.plan?.variables.RELEASE_LEVEL).toBe('supervised');
    expect(ledger().scores.undertaker.legacy).toBe(20);

    const invoices = issueFor('route:GET /api/v1/invoices')[0];
    const three = await act(3, {
      closes: invoices.iid,
      diffs: [edited('app/src/legacy/v1.ts', 4)],
      outcome: 'survived',
    });
    expect(three.labelsAfterGate).toContain('probation::supervised');
    expect(three.labelsAfterGate).not.toContain('probation::assisted');
    expect(ledger().scores.undertaker.legacy).toBe(30);
    expect(titled('🎖️ Promotion').map((i) => i.title)).toContain(
      '🎖️ Promotion: undertaker is now Hands-off in zone legacy',
    );
    expect(audit()).toHaveLength(3);
  });

  it('act 4: Hands-off — the canary breaks; settle demotes, reverts and marks do-not-bury', async () => {
    const exportCsv = issueFor('route:GET /api/v1/export.csv')[0];
    exportCsv.state = 'opened';
    exportCsv.labels = ['undertaker::in-progress', 'zone::legacy', 'kind::route'];
    const four = await act(4, {
      closes: exportCsv.iid,
      diffs: [edited('app/src/legacy/v1.ts', 6), edited('app/test/server.test.ts', 6)],
      outcome: 'rolled_back',
    });
    expect(four.note).toContain('Hands-off');
    expect(four.labelsAfterGate).toContain('probation::hands_off');
    expect(four.plan?.variables.RELEASE_LEVEL).toBe('hands_off');
    expect((four.plan?.['approve:production'] as { when: string }).when).toBe('on_success');

    expect(ledger().scores.undertaker.legacy).toBe(0);
    expect(ledger().graveyard.at(-1)).toMatchObject({ mr: four.mr.iid, status: 'exhumed' });
    expect(audit().at(-1)).toMatchObject({ event: 'rolled_back', points: -40, levelAfter: 'assisted' });
    expect(titled('⬇️ Demotion')).toHaveLength(1);
    expect(titled('⬇️ Demotion')[0].title).toContain('Assisted in zone legacy');
    expect(fake.state.reverts).toEqual([{ sha: four.sha, branch: 'main', id: expect.any(String) }]);
    expect(exportCsv.labels).toContain('undertaker::do-not-bury');
    expect(exportCsv.labels).not.toContain('undertaker::in-progress');
    expect(fake.state.notes.at(-1)).toMatchObject({ noteable: 'issue', iid: exportCsv.iid });
    expect(unrelated.state).toBe('opened');
    expect(unrelated.labels).toEqual([]);

    // The census honours do-not-bury: the exhumed route is never filed again.
    await ok(cli(fake, ws, 'census'));
    expect(issueFor('route:GET /api/v1/export.csv')).toHaveLength(1);
  });

  it('sweep scores each closed-unmerged Undertaker MR exactly once', async () => {
    const gated = createMr(fake.state, {
      title: 'Bury the PDF renderer',
      labels: ['undertaker', 'probation::assisted', 'zone::legacy'],
      diffs: [edited('app/src/legacy/v1.ts', 3)],
    });
    // Never gated: zones come from the diff.
    const ungated = createMr(fake.state, {
      title: 'Inline newTotals',
      labels: ['undertaker'],
      diffs: [edited('app/src/flags/flags.ts', 2)],
    });
    const human = createMr(fake.state, {
      title: 'Human refactor',
      author: 'priya',
      diffs: [edited('app/src/flags/flags.ts', 2)],
    });
    for (const mr of [gated, ungated, human]) closeMr(fake.state, mr.iid);
    const events = () => audit().filter((e) => e.event === 'human_rejected');

    await ok(cli(fake, ws, 'sweep', [], { CI_PIPELINE_ID: '300' }));
    expect(events().map((e) => [e.ref.mr, e.zone, e.points])).toEqual(
      expect.arrayContaining([
        [gated.iid, 'legacy', -20],
        [ungated.iid, 'flags', -20],
      ]),
    );
    expect(events()).toHaveLength(2);
    const r = await ok(cli(fake, ws, 'sweep', [], { CI_PIPELINE_ID: '301' }));
    expect(r.stdout).toContain('no unscored rejections');
    expect(events()).toHaveLength(2);
    expect(fake.state.notes.filter((n) => n.noteable === 'mr' && n.iid === gated.iid)).toHaveLength(1);
    expect(fake.state.notes.some((n) => n.noteable === 'mr' && n.iid === human.iid)).toBe(false);
    expect(ledger().scores.undertaker).toMatchObject({ legacy: 0, flags: 0 });
  });

  it('board renders the graveyard from the ledger branch', async () => {
    const out = join(ws, 'public/index.html');
    await ok(cli(fake, ws, 'board', ['--out', out]));
    const html = readFileSync(out, 'utf8');
    for (const n of [1, 2, 3, 4]) expect(html).toContain(`Bury act ${n}`);
    expect(html).toContain('EXHUMED');
  });
});

describe('the GitLab ledger store, through the CLIs', TIMEOUT, () => {
  let fake: FakeGitLab;
  let ws: string;

  beforeAll(async () => {
    fake = await start();
    ws = workspace();
  });
  afterAll(async () => {
    await fake?.close();
    if (ws) rmSync(ws, { recursive: true, force: true });
  });

  it('creates the ledger branch on the first write, then updates after an empty-audit baseline', async () => {
    await ok(
      cli(fake, ws, 'baseline', [], { CI_COMMIT_SHA: 'a'.repeat(40), CI_COMMIT_SHORT_SHA: 'aaaaaaaa' }),
    );
    expect(fake.state.commits.at(-1)).toMatchObject({
      branch: 'ledger',
      start_branch: 'main',
      actions: [
        { action: 'create', file_path: 'ledger.json' },
        { action: 'create', file_path: 'audit.jsonl' },
      ],
    });
    expect(fileOn(fake.state, 'ledger', 'audit.jsonl')).toBe('');

    await ok(
      cli(fake, ws, 'baseline', [], { CI_COMMIT_SHA: 'b'.repeat(40), CI_COMMIT_SHORT_SHA: 'bbbbbbbb' }),
    );
    expect(fake.state.commits.at(-1)).toMatchObject({
      branch: 'ledger',
      start_branch: undefined,
      actions: [
        { action: 'update', file_path: 'ledger.json' },
        { action: 'update', file_path: 'audit.jsonl' },
      ],
    });
    const saved = JSON.parse(fileOn(fake.state, 'ledger', 'ledger.json') ?? '{}') as Ledger;
    expect(saved.security?.sha).toBe('b'.repeat(40));
  });

  it('fails the job on a GitLab 500 loading the ledger instead of writing an empty one', async () => {
    const commits = fake.state.commits.length;
    fake.state.fail = (method, path) =>
      method === 'GET' && path.includes('/repository/files/ledger.json') ? 500 : undefined;
    const r = await cli(fake, ws, 'baseline');
    fake.state.fail = undefined;
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('→ 500');
    expect(fake.state.commits).toHaveLength(commits);
    // Retried 3 times after the first failure (Retry-After: 0 keeps it fast).
    expect(fake.state.requests.filter((q) => q.status === 500)).toHaveLength(4);
  });

  it('rejects a bad token with the API error', async () => {
    const r = await cli(fake, ws, 'board', ['--out', join(ws, 'board.html')], {
      GITLAB_PROBATION_TOKEN: 'nope',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('→ 401');
  });
});
