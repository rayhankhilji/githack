// submission — final-hour helper for the Devpost submission (RUNBOOK §6).
//   check: lists every ✏️ left (blocking in README and SUBMISSION), checks LICENSE, README links, media sizes,
//          the video (--video <file>: ffprobe < 180 s; --video-url: YouTube URL shape, --online: oEmbed lookup),
//          the Devpost choices, the GitLab project (when GITLAB_TOKEN is set) and the working tree. Exits 1 on blocking issues.
//   fill:  replaces only the ✏️ placeholders it has a value for: flags, plus measured values from the `ledger` branch and
//          the dependency-burial MR's 🌱 note (GITLAB_TOKEN, GITLAB_PROJECT, optional GITLAB_API_URL). --dry-run prints a diff.
// Usage: npm run submission -- check [--video demo.mp4] [--video-url https://youtu.be/…] [--online]
//        npm run submission -- fill [--dry-run] [--name …] [--video-url …] [--pages-url …] [--app-url …] [--devpost-url …]
//                                   [--repo-url …] [--root <dir>]
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg, hasFlag, main } from '../probation/src/cli/common.ts';
import { GitLab, type GitLabConfig } from '../probation/src/gitlab.ts';
import { isUndertaker } from '../probation/src/mr.ts';
import { loadPolicy } from '../probation/src/policy.ts';
import { setupConfigFromEnv } from '../probation/src/setup.ts';
import { GitLabLedgerStore } from '../probation/src/store.ts';
import {
  applyFills,
  DEVPOST_FIELDS,
  DEVPOST_REMINDERS,
  FILL_RULES,
  findPlaceholders,
  fmtPct,
  graveStats,
  isHttpsUrl,
  isMitLicense,
  MAX_VIDEO_SECONDS,
  MEDIA_WARN_BYTES,
  newestMergedFirst,
  newestSciNote,
  type Placeholder,
  relativeTargets,
  SUBMISSION_DOCS,
  sciChange,
  touches,
  unifiedDiff,
  type Values,
  YOUTUBE_URL,
  youtubeId,
} from '../probation/src/submission.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ROOT = arg('root', REPO);
const BURIAL_PATH = 'app/package.json';
const MEDIA_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.webm',
  '.mp4',
  '.mov',
  '.pdf',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', '.out', 'public']);

const opt = (name: string) => (hasFlag(name) ? arg(name) : undefined);

function readDocs(): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const f of SUBMISSION_DOCS) {
    const p = join(ROOT, f);
    if (existsSync(p)) texts[f] = readFileSync(p, 'utf8');
  }
  return texts;
}

function gitlabConfig(): GitLabConfig | undefined {
  if (!process.env.GITLAB_TOKEN || !(process.env.GITLAB_PROJECT ?? process.env.GITLAB_PROJECT_ID))
    return undefined;
  return setupConfigFromEnv(process.env).gitlab;
}

// GET …/merge_requests/:iid/notes (doc/api/notes.md), newest first. gitlab.ts has no reader for MR notes.
async function mrNotes(config: GitLabConfig, iid: number): Promise<{ body: string; system?: boolean }[]> {
  const path = `/projects/${encodeURIComponent(config.projectId)}/merge_requests/${iid}/notes?sort=desc&order_by=created_at&per_page=100`;
  const res = await fetch(`${config.apiUrl}${path}`, { headers: { 'PRIVATE-TOKEN': config.token } });
  if (!res.ok) throw new Error(`GitLab GET ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as { body: string; system?: boolean }[];
}

function printPlaceholders(list: Placeholder[]): void {
  for (const file of SUBMISSION_DOCS) {
    const mine = list.filter((p) => p.file === file);
    if (!mine.length) continue;
    console.log(`\n${file}`);
    for (const p of mine)
      console.log(`  ${p.blocking ? '❌' : '⚠️'} ${p.file}:${p.line}  ${p.text.slice(0, 140)}`);
  }
}

// ── check ──

function walkMedia(dir: string, rel = ''): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkMedia(join(dir, e.name), path));
    else if (MEDIA_EXT.has(extname(e.name).toLowerCase()))
      out.push({ path, bytes: statSync(join(dir, e.name)).size });
  }
  return out;
}

async function check(): Promise<void> {
  let blocking = 0;
  let warnings = 0;
  const fail = (msg: string) => {
    blocking++;
    console.log(`❌ ${msg}`);
  };
  const warn = (msg: string) => {
    warnings++;
    console.log(`⚠️  ${msg}`);
  };
  const ok = (msg: string) => console.log(`✅ ${msg}`);
  const docs = readDocs();

  // Placeholders.
  const placeholders = Object.entries(docs).flatMap(([f, t]) => findPlaceholders(f, t));
  const blockingMarks = placeholders.filter((p) => p.blocking);
  if (placeholders.length) {
    console.log(`✏️  ${placeholders.length} placeholders left (${blockingMarks.length} blocking):`);
    printPlaceholders(placeholders);
    console.log('');
    blocking += blockingMarks.length;
    warnings += placeholders.length - blockingMarks.length;
  } else ok('no ✏️ placeholders left');

  // LICENSE.
  const license = join(ROOT, 'LICENSE');
  if (!existsSync(license)) fail('LICENSE: missing (the rules require an MIT license visible in the repo)');
  else if (!isMitLicense(readFileSync(license, 'utf8'))) fail('LICENSE: not the MIT license text');
  else ok('LICENSE: MIT');

  // README links and images.
  const broken = relativeTargets(docs['README.md'] ?? '').filter((t) => !existsSync(join(ROOT, t.target)));
  for (const b of broken) fail(`README.md:${b.line} broken link or image: ${b.target}`);
  if (!broken.length) ok('README: every relative link and image exists');

  // Media sizes.
  const big = walkMedia(ROOT).filter((m) => m.bytes > MEDIA_WARN_BYTES);
  for (const m of big) warn(`${m.path} is ${(m.bytes / 1024 / 1024).toFixed(1)} MB (> 10 MB in the repo)`);
  if (!big.length) ok('media: no file over 10 MB');

  // Video file duration.
  const video = opt('video');
  if (video) {
    if (!existsSync(video)) fail(`video: ${video} not found`);
    else {
      const probe = spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', video],
        { encoding: 'utf8' },
      );
      const seconds = Number(probe.stdout?.trim());
      if (probe.error || probe.status !== 0 || !Number.isFinite(seconds))
        fail(
          `video: ffprobe could not read ${video} (${probe.error?.message ?? probe.stderr?.trim() ?? 'no output'})`,
        );
      else if (seconds >= MAX_VIDEO_SECONDS)
        fail(`video: ${seconds.toFixed(1)} s, must be under ${MAX_VIDEO_SECONDS} s`);
      else ok(`video: ${seconds.toFixed(1)} s (under ${MAX_VIDEO_SECONDS} s)`);
    }
  }

  // YouTube URLs: the flag and every one already in the README and SUBMISSION.
  const urls = new Set<string>();
  const flagUrl = opt('video-url');
  if (flagUrl) urls.add(flagUrl);
  for (const f of ['README.md', 'docs/SUBMISSION.md'])
    for (const m of (docs[f] ?? '').matchAll(YOUTUBE_URL)) urls.add(m[0]);
  for (const url of urls) {
    const id = youtubeId(url);
    if (!id) {
      fail(
        `video URL: ${url} is not a YouTube video URL (https://youtu.be/<id> or https://www.youtube.com/watch?v=<id>)`,
      );
      continue;
    }
    if (!hasFlag('online')) {
      ok(`video URL: ${url} (id ${id}; add --online to check it is public or unlisted)`);
      continue;
    }
    // oEmbed answers 200 for public and unlisted videos, 401/403/404 for private or missing ones.
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`,
    ).catch((e: unknown) => e as Error);
    if (res instanceof Error) warn(`video URL: could not reach YouTube (${res.message})`);
    else if (res.ok) ok(`video URL: ${url} is viewable (public or unlisted)`);
    else fail(`video URL: ${url} → ${res.status}; the video must be public or unlisted`);
  }

  // Devpost choices.
  const sub = docs['docs/SUBMISSION.md'] ?? '';
  for (const field of DEVPOST_FIELDS) {
    if (field.pattern.test(sub)) ok(`SUBMISSION states ${field.label}`);
    else fail(`docs/SUBMISSION.md does not state ${field.label}`);
  }

  // The GitLab project, when credentials are present.
  const config = gitlabConfig();
  if (!config)
    console.log(
      'ℹ️  GitLab project not checked (set GITLAB_TOKEN and GITLAB_PROJECT to check visibility, license, pipelines)',
    );
  else {
    const gl = new GitLab(config);
    try {
      const project = await gl.getProject(true);
      if (project.visibility === 'public') ok(`GitLab: ${project.path_with_namespace} is public`);
      else
        fail(`GitLab: ${project.path_with_namespace} is ${project.visibility}; the rules need a public repo`);
      if (project.license?.key === 'mit') ok('GitLab: detects the MIT license');
      else
        fail(
          `GitLab: license detected as ${project.license?.name ?? 'none'}; push LICENSE to the default branch`,
        );
      const pipelines = await gl.listPipelines('per_page=1');
      if (pipelines.length) ok('GitLab: CI pipeline history exists');
      else fail('GitLab: no pipelines yet; judges need a visible CI pipeline history');
    } catch (error) {
      fail(`GitLab: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Working tree.
  const git = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
  if (git.status !== 0) warn(`git: ${ROOT} is not a git working tree`);
  else if (git.stdout.trim())
    warn(
      `git: uncommitted changes (${git.stdout.trim().split('\n').length} paths); commit and push before 13:00 UTC`,
    );
  else ok('git: working tree clean');

  console.log('\nBefore you press Submit:');
  for (const r of DEVPOST_REMINDERS) console.log(`  ☐ ${r}`);
  console.log(`\nsubmission check: ${blocking} blocking, ${warnings} warnings`);
  if (blocking > 0) process.exitCode = 1;
}

// ── fill ──

async function measured(values: Values, notes: string[]): Promise<void> {
  const config = gitlabConfig();
  if (!config) {
    notes.push('no GitLab env (GITLAB_TOKEN, GITLAB_PROJECT): measured values stay ✏️');
    return;
  }
  const gl = new GitLab(config);
  const project = await gl.getProject();
  values.repoUrl ??= project.web_url;
  values.pagesUrl ??= (await gl.getPages())?.url || undefined;
  const ledger = await new GitLabLedgerStore(gl, project.default_branch).load();
  values.sciChange = sciChange(ledger);
  if (values.sciChange)
    notes.push(
      `SCI change: ${fmtPct(values.sciChange.pct)} over ${values.sciChange.points} measurements (${values.sciChange.from} → ${values.sciChange.to})`,
    );
  else notes.push('SCI change: fewer than two measurements in ledger.json sci.history; stays ✏️');
  const g = graveStats(ledger);
  notes.push(
    `graveyard: ${g.buried} graves buried, ${g.exhumed} exhumed (rollbacks), −${g.linesRemoved} lines (no placeholder; paste into Devpost if useful)`,
  );

  const agent = loadPolicy(join(REPO, 'probation/policy.yml')).agents.undertaker;
  const merged = newestMergedFirst(
    (await gl.listMrs('state=merged&per_page=100')).filter((m) => isUndertaker(m, agent)),
  );
  for (const mr of merged) {
    if (!touches(await gl.mrDiffs(mr.iid), BURIAL_PATH)) continue;
    const note = newestSciNote((await mrNotes(config, mr.iid)).filter((n) => !n.system));
    if (!note) {
      notes.push(`burial MR !${mr.iid} has no 🌱 note; its values stay ✏️`);
      return;
    }
    values.burial = { iid: mr.iid, url: mr.web_url, ...note };
    notes.push(
      `dependency burial: !${mr.iid} ${mr.title}: Total SCI ${note.totalPct === undefined ? 'unknown (no baseline)' : fmtPct(note.totalPct)}`,
    );
    return;
  }
  notes.push(`no merged Undertaker MR touches ${BURIAL_PATH}; burial values stay ✏️`);
}

async function fill(): Promise<void> {
  const values: Values = {
    name: opt('name')?.trim() || undefined,
    videoUrl: opt('video-url'),
    pagesUrl: opt('pages-url'),
    appUrl: opt('app-url'),
    devpostUrl: opt('devpost-url'),
    repoUrl: opt('repo-url'),
  };
  if (values.videoUrl && !youtubeId(values.videoUrl))
    throw new Error(`--video-url ${values.videoUrl} is not a YouTube video URL (https://youtu.be/<id>)`);
  for (const key of ['pagesUrl', 'appUrl', 'devpostUrl', 'repoUrl'] as const) {
    const v = values[key];
    if (v && !isHttpsUrl(v)) throw new Error(`${key}: ${v} is not an https:// URL`);
  }
  if (values.name && /[✏\n|]/.test(values.name)) throw new Error('--name must be one line without ✏️ or |');

  const notes: string[] = [];
  await measured(values, notes);
  const before = readDocs();
  const { texts, changes } = applyFills(before, values);
  const dry = hasFlag('dry-run');

  for (const n of notes) console.log(`ℹ️  ${n}`);
  if (!changes.length)
    console.log('\nNothing to fill: every placeholder with a known value is already filled.');
  else {
    console.log(`\n${dry ? 'Would change' : 'Changed'} ${changes.length} placeholders:`);
    for (const c of changes)
      console.log(`  ${c.file}:${c.line} [${c.rule}] ${c.before.slice(0, 70)} → ${c.after.slice(0, 90)}`);
  }
  if (dry) {
    for (const f of Object.keys(texts)) process.stdout.write(unifiedDiff(f, before[f], texts[f]));
  } else {
    for (const f of Object.keys(texts)) if (texts[f] !== before[f]) writeFileSync(join(ROOT, f), texts[f]);
  }
  if (values.name && changes.some((c) => c.rule.endsWith('title')))
    console.log(
      `\nℹ️  The video cards (docs/media/cards/*.html) still say "Probation + Undertaker": edit them by hand and re-render (scripts/render-media.ts) if the name changed.`,
    );
  const left = Object.entries(texts).flatMap(([f, t]) => findPlaceholders(f, t));
  console.log(
    `\n${left.length} ✏️ left (${left.filter((p) => p.blocking).length} blocking)${dry ? ' after this fill' : ''}:`,
  );
  printPlaceholders(left);
  console.log(`\nRules: ${FILL_RULES.length} placeholder mappings; unknown values stay ✏️.`);
}

main(async () => {
  const cmd = process.argv[2];
  if (cmd === 'check') return check();
  if (cmd === 'fill') return fill();
  throw new Error('usage: npm run submission -- check|fill [options] (see scripts/submission.ts)');
});
