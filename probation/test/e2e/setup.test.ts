// End-to-end: scripts/gitlab-setup.ts and scripts/doctor.ts, spawned as a human would run them, against the
// in-memory GitLab (probation/sim). Setup must be idempotent; doctor must fail loudly, then pass once configured.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeGitLab, start } from '../../sim/gitlab-fake.ts';
import type { CiVariable } from '../../src/gitlab.ts';
import { loadPolicy } from '../../src/policy.ts';
import { labelCatalogue, SCHEDULE_DESCRIPTION } from '../../src/setup.ts';

const ROOT = process.cwd();
const TIMEOUT = { timeout: 30_000 };

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function script(fake: FakeGitLab, name: string, vars: Record<string, string> = {}): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GITLAB_API_URL: fake.url,
    // The URL-encoded path form, as a human would pass it.
    GITLAB_PROJECT: fake.state.project.path,
    GITLAB_TOKEN: fake.state.userToken,
    ...vars,
  };
  return new Promise((done) => {
    execFile(
      process.execPath,
      [join(ROOT, 'scripts', `${name}.ts`)],
      { cwd: ROOT, env, timeout: 25_000 },
      (error, stdout, stderr) =>
        done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
    );
  });
}

const variable = (key: string, value: string, flags: Partial<CiVariable> = {}): CiVariable => ({
  key,
  value,
  protected: false,
  masked: false,
  hidden: false,
  environment_scope: '*',
  variable_type: 'env_var',
  ...flags,
});

describe('gitlab:setup and doctor, end to end', TIMEOUT, () => {
  let fake: FakeGitLab;
  const labels = labelCatalogue(loadPolicy());
  const writes = (from: number) => fake.state.requests.slice(from).filter((r) => r.method !== 'GET');

  beforeAll(async () => {
    fake = await start();
  });
  afterAll(async () => {
    await fake?.close();
  });

  it('doctor fails on an unconfigured project, with a fix per problem', async () => {
    const r = await script(fake, 'doctor');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('✅ GITLAB_TOKEN');
    expect(r.stdout).toMatch(/❌ visibility: private/);
    expect(r.stdout).toMatch(/❌ license: none detected/);
    expect(r.stdout).toMatch(/❌ variable GITLAB_PROBATION_TOKEN: missing/);
    expect(r.stdout).toMatch(/❌ variable DUO_FLOW_TRIGGER_TOKEN: missing/);
    expect(r.stdout).toMatch(/❌ GCP auth: missing/);
    expect(r.stdout).toMatch(/❌ labels: \d+ missing/);
    expect(r.stdout).toMatch(/❌ pipeline schedule/);
    expect(r.stdout).toMatch(/❌ Undertaker flow: not enabled/);
    expect(r.stdout).toContain('→ Settings → CI/CD → Variables');
    // Read-only: nothing but GETs and the GraphQL query.
    expect(writes(0).filter((w) => w.path !== '/api/graphql')).toEqual([]);
  });

  it('doctor stops early with a fix when the token is rejected', async () => {
    const r = await script(fake, 'doctor', { GITLAB_TOKEN: 'glpat-wrong' });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/❌ GITLAB_TOKEN: rejected \(.*401/);
  });

  it('gitlab:setup creates labels, schedule, protected tag and MR settings', async () => {
    const r = await script(fake, 'gitlab-setup');
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const p = fake.state.project;

    expect(p.labels.map((l) => l.name).sort()).toEqual(labels.map((l) => l.name).sort());
    expect(p.labels.find((l) => l.name === 'probation::hands_off')?.color).toBe('#15803d');
    expect(p.labels.find((l) => l.name === 'undertaker::do-not-bury')?.color).toBe('#b91c1c');
    for (const zone of loadPolicy().zones) expect(r.stdout).toContain(`✅ label zone::${zone.name}: created`);

    expect(p.schedules).toHaveLength(1);
    expect(p.schedules[0]).toMatchObject({
      description: SCHEDULE_DESCRIPTION,
      ref: 'refs/heads/main',
      cron: '17 2 * * *',
      variables: [{ key: 'CENSUS_FRESHNESS', value: '7d' }],
    });
    expect(p.protectedTags).toEqual([
      expect.objectContaining({
        name: 'catalog-*',
        create_access_levels: [expect.objectContaining({ access_level: 40 })],
      }),
    ]);
    expect(p.only_allow_merge_if_pipeline_succeeds).toBe(true);
    expect(p.remove_source_branch_after_merge).toBe(true);

    // Variables are listed as missing, never created.
    expect(p.variables).toEqual([]);
    expect(r.stdout).toMatch(/⚠️ +variable GITLAB_PROBATION_TOKEN: missing/);
    expect(r.stdout).toContain('GCP_DEPLOY_SA + GCP_WIF_PROVIDER + GCP_WIF_AUDIENCE (or GCP_SA_KEY');
  });

  it('a second gitlab:setup run reports everything as existing and writes nothing', async () => {
    const before = fake.state.requests.length;
    const r = await script(fake, 'gitlab-setup');
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(writes(before)).toEqual([]);
    expect(r.stdout).not.toContain('created');
    expect(r.stdout).toContain('✅ pipeline schedule: exists');
    expect(r.stdout).toContain('✅ protected tag catalog-*: exists');
    expect(r.stdout).toContain('✅ MR settings: exists');
    expect(fake.state.project.schedules).toHaveLength(1);
  });

  it('gitlab:setup repairs a drifted label and keeps a human-tuned schedule', async () => {
    const p = fake.state.project;
    const label = p.labels.find((l) => l.name === 'coroner::objection');
    if (!label) throw new Error('label missing');
    label.color = '#000000';
    const schedule = p.schedules[0];
    schedule.cron = '0 * * * *';
    schedule.variables = [];
    const r = await script(fake, 'gitlab-setup');
    expect(r.code).toBe(0);
    expect(label.color).toBe('#b91c1c');
    expect(r.stdout).toContain('✅ label coroner::objection: updated');
    expect(schedule.cron).toBe('0 * * * *');
    expect(schedule.variables).toEqual([expect.objectContaining({ key: 'CENSUS_FRESHNESS', value: '7d' })]);
  });

  it('doctor flags wrong variable flags and a mismatched consumer id', async () => {
    const s = fake.state;
    s.project.variables = [
      // Protected: MR pipelines on undertaker/* would not get it.
      variable('GITLAB_PROBATION_TOKEN', s.projectToken, { masked: true, protected: true }),
      variable('DUO_FLOW_TRIGGER_TOKEN', s.userToken, { masked: true, protected: true }),
      variable('UNDERTAKER_CONSUMER_ID', '999'),
      variable('GCP_PROJECT_ID', 'tallybook-demo'),
      variable('GCP_SA_KEY', 'e30=', { masked: true }),
    ];
    s.project.consumers = [{ id: 4211, enabled: true, name: 'Undertaker' }];
    const r = await script(fake, 'doctor');
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/❌ variable GITLAB_PROBATION_TOKEN: must NOT be protected/);
    expect(r.stdout).toMatch(/❌ Undertaker flow: UNDERTAKER_CONSUMER_ID is 999, but .* 4211/);
    expect(r.stdout).toContain('Set UNDERTAKER_CONSUMER_ID to 4211');
    expect(r.stdout).toMatch(/✅ variable GCP_SA_KEY/);
  });

  it('doctor passes once the project is configured, and never prints a secret', async () => {
    const s = fake.state;
    s.project.visibility = 'public';
    s.project.license = 'mit';
    s.project.pagesUrl = 'https://demo.gitlab.io/tallybook';
    s.project.variables = [
      variable('GITLAB_PROBATION_TOKEN', s.projectToken, { masked: true }),
      variable('DUO_FLOW_TRIGGER_TOKEN', s.userToken, { masked: true, protected: true }),
      variable('UNDERTAKER_CONSUMER_ID', 'gid://gitlab/Ai::Catalog::ItemConsumer/4211'),
      variable('GCP_PROJECT_ID', 'tallybook-demo'),
      variable('GCP_DEPLOY_SA', 'probation-deployer@tallybook-demo.iam.gserviceaccount.com'),
      variable(
        'GCP_WIF_PROVIDER',
        'projects/123/locations/global/workloadIdentityPools/gitlab-pool/providers/gitlab-com',
      ),
      variable('GCP_WIF_AUDIENCE', 'https://iam.googleapis.com/projects/123/providers/gitlab-com'),
      variable('CATALOG_SYNC_TOKEN', 'glpat-fake-catalog-secret', {
        masked: true,
        protected: true,
        hidden: true,
      }),
      variable('CATALOG_GROUP_ID', '7'),
    ];
    const r = await script(fake, 'doctor');
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('❌');
    expect(r.stdout).toContain('✅ visibility: public');
    expect(r.stdout).toContain('✅ license: MIT License');
    expect(r.stdout).toContain('✅ labels: all');
    expect(r.stdout).toContain('✅ pipeline schedule');
    expect(r.stdout).toContain('✅ protected tag catalog-*');
    expect(r.stdout).toContain('✅ GITLAB_PROBATION_TOKEN (value)');
    expect(r.stdout).toContain('✅ Undertaker flow: enabled, consumer 4211 matches');
    expect(r.stdout).toContain('✅ Pages: https://demo.gitlab.io/tallybook');
    // No ledger branch yet is a warning, not a failure.
    expect(r.stdout).toMatch(/⚠️ +ledger branch: missing/);
    for (const secret of [s.projectToken, s.userToken, 'glpat-fake-catalog-secret', 'e30='])
      expect(r.stdout + r.stderr).not.toContain(secret);
  });
});
