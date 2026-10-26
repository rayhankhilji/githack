// census — reads production request logs, finds code nobody uses, and files one issue per candidate grave.
import { existsSync, readFileSync } from 'node:fs';
import { FLAG_DEFAULTS } from '../../../app/src/flags/flags.ts';
import { buildServer } from '../../../app/src/server.ts';
import { aggregate, type Candidate, findCandidates, parseCensusLog, readSources } from '../census.ts';
import { loadPolicy } from '../policy.ts';
import { LEDGER_BRANCH } from '../store.ts';
import { zoneFor } from '../zones.ts';
import { arg, env, gitlab, hasFlag, main, writeOut } from './common.ts';

const MARKER = (key: string) => `<!-- undertaker:key=${key} -->`;

export function issueBody(c: Candidate, zone: string | undefined): string {
  return [
    MARKER(c.key),
    `**Kind:** ${c.kind} · **Zone:** ${zone ?? 'unzoned'}${c.file ? ` · **File:** \`${c.file}\`` : ''}`,
    '',
    '### Evidence',
    c.evidence,
    '',
    'Filed by the `census` job from production request logs. Undertaker may pick this up; the Probation gate decides how far it can go alone.',
  ].join('\n');
}

main(async () => {
  const policy = loadPolicy();
  const logPath = arg('log', '.out/census-log.json');
  const lines = existsSync(logPath) ? parseCensusLog(readFileSync(logPath, 'utf8')) : [];
  const stats = aggregate(lines);
  const { app, routes } = buildServer({ censusLog: () => {} });
  await app.ready();
  await app.close();
  const pkg = JSON.parse(readFileSync('app/package.json', 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const dryRun = hasFlag('dry-run');
  const gl = dryRun ? undefined : gitlab();
  // `undertaker::` labels are scoped, so an issue carries exactly one of them: in-progress and do-not-bury
  // replace candidate. Dedupe (and honour do-not-bury) across all three.
  const known = gl
    ? (
        await Promise.all(
          ['candidate', 'in-progress', 'do-not-bury', 'buried'].map((l) =>
            gl.listIssues(`labels=undertaker::${l}&state=all&per_page=100`),
          ),
        )
      ).flat()
    : [];
  const exclude = new Set(
    known
      .filter((i) => i.labels.includes('undertaker::do-not-bury'))
      .map((i) => /undertaker:key=(.+?) -->/.exec(i.description)?.[1])
      .filter((k): k is string => Boolean(k)),
  );

  const candidates = findCandidates({
    stats,
    routes,
    flags: Object.keys(FLAG_DEFAULTS),
    dependencies: Object.keys(pkg.dependencies),
    sources: readSources('app/src'),
    windowDays: policy.census.window_days,
    minRequests: policy.census.min_requests_in_window,
    exclude,
    keep: policy.census.keep,
  });
  // Export observed traffic shapes for the verify-stage replay.
  writeOut('.out/traffic.json', JSON.stringify(stats.routeHits, null, 2));
  writeOut('.out/candidates.json', JSON.stringify(candidates, null, 2));
  console.log(`census: ${stats.requests} requests, ${candidates.length} candidate(s)`);
  for (const c of candidates) console.log(`  · [${c.kind}] ${c.title}`);
  if (!gl) return;

  // Publish observed traffic to the ledger branch for the verify-stage replay.
  const trafficJson = `${JSON.stringify(stats.routeHits, null, 2)}\n`;
  const ledgerExists = await gl.branchExists(LEDGER_BRANCH);
  const hadTraffic = ledgerExists && (await gl.getFile('traffic.json', LEDGER_BRANCH)) !== undefined;
  // The first census usually runs before any ledger write, so it creates the branch from the default branch.
  await gl.commit({
    branch: LEDGER_BRANCH,
    start_branch: ledgerExists ? undefined : (env.CI_DEFAULT_BRANCH ?? 'main'),
    commit_message: `census: ${stats.requests} requests, ${candidates.length} candidates [skip ci]`,
    actions: [{ action: hadTraffic ? 'update' : 'create', file_path: 'traffic.json', content: trafficJson }],
  });

  for (const c of candidates) {
    const zone = c.file ? zoneFor(policy, c.file)?.name : undefined;
    const existing = known.find((i) => i.description.includes(MARKER(c.key)));
    if (existing) continue;
    await gl.createIssue({
      title: `🪦 ${c.title}`,
      description: issueBody(c, zone),
      labels: ['undertaker::candidate', `zone::${zone ?? 'unzoned'}`, `kind::${c.kind}`].join(','),
    });
  }
  if (env.CI) console.log('candidate issues are up to date');
});
