// End-to-end: scripts/submission.ts, spawned as a human would run it in the final hour, against the in-memory GitLab
// (probation/sim) seeded with a ledger branch and merged Undertaker MRs with 🌱 notes. Always on a temp copy of the docs.
import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeGitLab, type FakeMr, start } from '../../sim/gitlab-fake.ts';
import { emptyLedger } from '../../src/ledger.ts';
import { computeSci, loadCoefficients, sciMarkdown } from '../../src/sci.ts';
import { FIXTURE_DOCS } from '../fixtures/submission-docs.ts';

const ROOT = process.cwd();
const TIMEOUT = { timeout: 60_000 };
const hasFfmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [join(ROOT, 'scripts', 'submission.ts'), ...args],
      { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, timeout: 50_000 },
      (error, stdout, stderr) =>
        done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
    );
  });
}

const c = loadCoefficients();
const m = {
  requests: 5000,
  cpuSeconds: 4,
  avgRssMb: 90,
  durationSeconds: 10,
  deployableMb: 25.9,
  coldStartMs: 812,
};
const sci = (deployableMb: number, coldStartMs: number) => computeSci(c, { ...m, deployableMb, coldStartMs });
const sprout = (before: number, after: number, coldAfter = 640) =>
  `🌱 ${sciMarkdown(sci(before, 812), sci(after, coldAfter))}`;

describe('npm run submission, end to end', TIMEOUT, () => {
  let fake: FakeGitLab;
  let dir: string;
  let gitlabEnv: Record<string, string>;
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  const snapshot = () => Object.fromEntries(Object.keys(FIXTURE_DOCS).map((f) => [f, read(f)]));
  const flags = [
    '--name',
    'Gravedigger',
    '--video-url',
    'https://youtu.be/dQw4w9WgXcQ',
    '--app-url',
    'https://tallybook-abc123-uc.a.run.app',
    '--devpost-url',
    'https://devpost.com/software/gravedigger',
  ];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'submission-e2e-'));
    for (const [f, text] of Object.entries(FIXTURE_DOCS)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    copyFileSync(join(ROOT, 'LICENSE'), join(dir, 'LICENSE'));
    mkdirSync(join(dir, 'docs/media'), { recursive: true });
    writeFileSync(join(dir, 'docs/media/replay.webm'), 'webm');

    fake = await start();
    gitlabEnv = {
      GITLAB_API_URL: fake.url,
      GITLAB_PROJECT: fake.state.project.path,
      GITLAB_TOKEN: fake.state.userToken,
    };
    fake.state.project.pagesUrl = 'https://demo.gitlab.io/tallybook';

    const ledger = emptyLedger();
    ledger.sci = {
      history: [
        { at: '2026-10-26T10:00:00Z', sha: 'a1', gramsPer1kRequests: 0.2 },
        { at: '2026-10-26T15:00:00Z', sha: 'b2', gramsPer1kRequests: 0.22 },
        { at: '2026-10-27T09:00:00Z', sha: 'c3', gramsPer1kRequests: 0.15 },
      ],
    };
    ledger.graveyard = [
      {
        at: '2026-10-26T11:00:00Z',
        mr: 10,
        title: 'Bury /api/fax-invoice',
        zone: 'legacy',
        linesRemoved: 40,
        status: 'buried',
      },
      {
        at: '2026-10-27T09:00:00Z',
        mr: 12,
        title: 'Bury moment and lodash',
        zone: 'deps',
        linesRemoved: 3,
        status: 'buried',
      },
      {
        at: '2026-10-27T10:00:00Z',
        mr: 13,
        title: 'Bury export.csv',
        zone: 'routes',
        linesRemoved: 30,
        status: 'exhumed',
      },
    ];
    fake.state.branches.set('ledger', new Map([['ledger.json', JSON.stringify(ledger)]]));

    const mr = (iid: number, mergedAt: string, labels: string[], author = 'ai-undertaker-bot'): FakeMr => ({
      id: 100 + iid,
      iid,
      project_id: 42,
      title: `MR ${iid}`,
      description: '',
      state: 'merged',
      draft: false,
      labels,
      author: { username: author },
      web_url: `${fake.state.baseUrl}/demo/tallybook/-/merge_requests/${iid}`,
      sha: `sha${iid}`,
      source_branch: `b${iid}`,
      target_branch: 'main',
      merged_at: mergedAt,
      merge_commit_sha: `m${iid}`,
      merge_when_pipeline_succeeds: false,
      created_at: mergedAt,
    });
    const diff = (path: string) => ({ new_path: path, old_path: path, deleted_file: false, diff: '-x' });
    // An older burial of app/package.json, the dependency burial (newest Undertaker MR touching it), a newer
    // Undertaker MR that does not touch it, and a human's newer package.json change: only !12 counts.
    fake.state.mrs.push(
      mr(10, '2026-10-26T11:00:00Z', ['undertaker']),
      mr(12, '2026-10-27T09:00:00Z', ['undertaker', 'zone::deps']),
      mr(13, '2026-10-27T10:00:00Z', ['undertaker']),
      mr(14, '2026-10-27T11:00:00Z', [], 'rayhan'),
    );
    fake.state.diffs.set(10, [diff('app/package.json')]);
    fake.state.diffs.set(12, [diff('app/package.json'), diff('app/package-lock.json')]);
    fake.state.diffs.set(13, [diff('app/src/routes/export.ts')]);
    fake.state.diffs.set(14, [diff('app/package.json')]);
    fake.state.notes.push(
      { noteable: 'mr', iid: 10, body: sprout(30, 28) },
      { noteable: 'mr', iid: 12, body: sprout(25.9, 20) },
      { noteable: 'mr', iid: 12, body: '🟡 **Probation gate: Supervised.**' },
      { noteable: 'mr', iid: 12, body: sprout(25.9, 15.7) },
      { noteable: 'mr', iid: 13, body: sprout(20, 19) },
      { noteable: 'mr', iid: 14, body: sprout(20, 10) },
    );
  });
  afterAll(async () => {
    await fake?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const burialPct = () => {
    const b = sci(25.9, 812).gramsPer1kRequests;
    const a = sci(15.7, 640).gramsPer1kRequests;
    return `−${Math.abs(Number((((a - b) / b) * 100).toFixed(1))).toFixed(1)}%`;
  };

  it('fill --dry-run prints a unified diff of measured and flag values and writes nothing', async () => {
    const before = snapshot();
    const r = await run(['fill', '--dry-run', '--root', dir, ...flags], gitlabEnv);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('SCI change: −25.0% over 3 measurements (2026-10-26 → 2026-10-27)');
    expect(r.stdout).toContain('graveyard: 2 graves buried, 1 exhumed (rollbacks), −43 lines');
    expect(r.stdout).toContain(`dependency burial: !12 MR 12: Total SCI ${burialPct()}`);
    expect(r.stdout).toContain('Would change 19 placeholders:');
    expect(r.stdout).toContain('--- a/README.md\n+++ b/README.md\n@@ -1,6 +1,4 @@\n-# Probation\n');
    expect(r.stdout).toContain('+# Gravedigger');
    expect(r.stdout).toContain('+- GitLab repo: http://127.0.0.1:');
    expect(r.stdout).toContain(
      '+- All burials since the first measurement: SCI −25.0% (board stat "SCI change", 3 measurements from 2026-10-26 to 2026-10-27).',
    );
    expect(r.stdout).toContain('3 ✏️ left (1 blocking) after this fill');
    expect(snapshot()).toEqual(before);
  });

  it('fill writes exactly the mapped placeholders; a second fill changes nothing', async () => {
    const r = await run(['fill', '--root', dir, ...flags], gitlabEnv);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Changed 19 placeholders:');
    const readme = read('README.md');
    expect(readme.startsWith('# Gravedigger\n\n**An AI')).toBe(true);
    expect(readme).toContain(
      '| 🪦 Probation Board (live ledger) | [demo.gitlab.io/tallybook](https://demo.gitlab.io/tallybook) |',
    );
    expect(readme).toContain(
      `Measured result from the dependency burial: SCI ${burialPct()} (the 🌱 note on [!12](${fake.state.baseUrl}/demo/tallybook/-/merge_requests/12)).`,
    );
    expect(readme).toContain('**Probation** is the deterministic CI system');
    const sub = read('docs/SUBMISSION.md');
    expect(sub).toContain('**Name:** Gravedigger\n');
    expect(sub).toContain(`- GitLab repo: ${fake.state.baseUrl}/demo/tallybook\n`);
    expect(sub).toContain('- Ledger replay: https://demo.gitlab.io/tallybook/replay.html (a 30-second');
    expect(sub).toContain(
      `- Dependency burial (moment + lodash): deployable size 25.9 MB → 15.7 MB, cold start 812 ms → 640 ms, SCI ${burialPct()} (the 🌱 note on [!12](`,
    );
    expect(sub).toContain('- ✏️ Optional scale-up');
    expect(sub).toContain('11. ✏️ Screenshots');
    expect(read('docs/STAGES.md')).toBe(FIXTURE_DOCS['docs/STAGES.md']);

    const filled = snapshot();
    const again = await run(['fill', '--root', dir, ...flags], gitlabEnv);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('Nothing to fill');
    expect(snapshot()).toEqual(filled);
    // Read-only against GitLab.
    expect(fake.state.requests.filter((q) => q.method !== 'GET')).toEqual([]);
  });

  it('check exits 1 while a blocking ✏️ or a project problem is left, 0 once clean', async () => {
    let r = await run(['check', '--root', dir]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/❌ docs\/SUBMISSION\.md:\d+ {2}11\. ✏️ Screenshots/);
    expect(r.stdout).toMatch(/⚠️ docs\/SUBMISSION\.md:\d+ {2}- ✏️ Optional scale-up/);
    expect(r.stdout).toMatch(/⚠️ docs\/STAGES\.md:5/);
    expect(r.stdout).toContain('✅ LICENSE: MIT');
    expect(r.stdout).toContain('✅ video URL: https://youtu.be/dQw4w9WgXcQ');
    expect(r.stdout).toContain('submission check: 1 blocking');

    // The screenshots are uploaded: the human drops the marker.
    const sub = join(dir, 'docs/SUBMISSION.md');
    writeFileSync(sub, read('docs/SUBMISSION.md').replace('11. ✏️ Screenshots', '11. Screenshots'));
    r = await run(['check', '--root', dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('submission check: 0 blocking');

    // With GitLab credentials it also checks the project: private, no license, no pipelines.
    r = await run(['check', '--root', dir], gitlabEnv);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('❌ GitLab: demo/tallybook is private');
    expect(r.stdout).toContain('❌ GitLab: license detected as none');
    expect(r.stdout).toContain('❌ GitLab: no pipelines yet');
    fake.state.project.visibility = 'public';
    fake.state.project.license = 'mit';
    fake.state.pipelines.push({
      id: 1,
      iid: 1,
      status: 'success',
      source: 'push',
      ref: 'main',
      sha: 'x',
      created_at: '2026-10-27T09:00:00Z',
    });
    r = await run(['check', '--root', dir], gitlabEnv);
    expect(r.code).toBe(0);

    r = await run(['check', '--root', dir, '--video-url', 'https://vimeo.com/123']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('❌ video URL: https://vimeo.com/123 is not a YouTube video URL');

    writeFileSync(join(dir, 'README.md'), `${read('README.md')}\n![gone](docs/media/gone.png)\n`);
    r = await run(['check', '--root', dir]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/❌ README\.md:\d+ broken link or image: docs\/media\/gone\.png/);
  });

  it.skipIf(!hasFfmpeg)('check --video passes under 180 s and blocks at 180 s or more', async () => {
    const clip = (seconds: number) => {
      const out = join(dir, `clip-${seconds}.mp4`);
      spawnSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=16x16:r=1',
        '-t',
        String(seconds),
        '-y',
        out,
      ]);
      return out;
    };
    // Restore a README without the broken link so the video is the only variable.
    writeFileSync(join(dir, 'README.md'), read('README.md').replace('\n![gone](docs/media/gone.png)\n', ''));
    let r = await run(['check', '--root', dir, '--video', clip(5)]);
    expect(r.stdout).toMatch(/✅ video: 5\.0 s/);
    expect(r.code).toBe(0);
    r = await run(['check', '--root', dir, '--video', clip(181)]);
    expect(r.stdout).toMatch(/❌ video: 181\.0 s, must be under 180 s/);
    expect(r.code).toBe(1);
    r = await run(['check', '--root', dir, '--video', join(dir, 'missing.mp4')]);
    expect(r.stdout).toContain('❌ video:');
    expect(r.code).toBe(1);
  });
});
