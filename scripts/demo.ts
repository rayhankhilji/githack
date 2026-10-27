// demo — the demo conductor: each act of RUNBOOK §5 is one command instead of a round of clicks in GitLab.
// Decisions (which MR, which pipeline, which job) live in probation/src/demo.ts; this file only does the API calls.
// Usage: GITLAB_TOKEN=… GITLAB_PROJECT=group/project npm run demo -- <status|dig|approve|promote|watch> [options]
//   dig [--issue N] [--force]   run the census schedule now (checks first that dig would pick #N)
//   approve                     approve + merge the newest Assisted Undertaker MR (only if its pipeline passed)
//   promote                     play approve:production in the newest release child pipeline
//   watch [--timeout 900] [--interval 15] [--new]   follow the release child pipeline to the end
// Never prints a token.
import { fileURLToPath } from 'node:url';
import { hasFlag, main } from '../probation/src/cli/common.ts';
import {
  type DemoSnapshot,
  digSteer,
  FINISHED,
  formatJobs,
  issueLine,
  LIFECYCLE,
  type Lifecycle,
  ledgerDelta,
  ledgerRows,
  mergePlan,
  mrLine,
  nextStep,
  pickAssistedMr,
  promotePlan,
  releaseChild,
  releaseParent,
  SIGNAL_JOBS,
  statusText,
  steerMessage,
  transitions,
  verdictLines,
} from '../probation/src/demo.ts';
import {
  GitLab,
  type Issue,
  type Job,
  type MergeRequestDetail,
  type Pipeline,
} from '../probation/src/gitlab.ts';
import type { Ledger } from '../probation/src/ledger.ts';
import { isUndertaker } from '../probation/src/mr.ts';
import { loadPolicy } from '../probation/src/policy.ts';
import { findSchedule, SCHEDULE_DESCRIPTION, setupConfigFromEnv } from '../probation/src/setup.ts';
import { GitLabLedgerStore } from '../probation/src/store.ts';

const POLICY = fileURLToPath(new URL('../probation/policy.yml', import.meta.url));
const COMMANDS = ['status', 'dig', 'approve', 'promote', 'watch'];

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function numberOption(name: string, fallback: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a number, got ${raw}`);
  return n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toISOString().slice(11, 19);
const next = (line: string) => console.log(`\n👉 Next: ${line}`);

interface Ctx {
  gl: GitLab;
  policy: ReturnType<typeof loadPolicy>;
  defaultBranch: string;
  path: string;
}

async function loadLedger(ctx: Ctx): Promise<Ledger> {
  return new GitLabLedgerStore(ctx.gl, ctx.defaultBranch).load();
}

async function undertakerMrs(ctx: Ctx): Promise<MergeRequestDetail[]> {
  const agent = Object.values(ctx.policy.agents)[0];
  const open = (await ctx.gl.listMrs('state=opened&per_page=50')).filter((m) => isUndertaker(m, agent));
  // The list endpoint has no head_pipeline; the single GET does.
  return Promise.all(open.map((m) => ctx.gl.getMrDetail(m.iid)));
}

async function lifecycleIssues(ctx: Ctx): Promise<Record<Lifecycle, Issue[]>> {
  const entries = await Promise.all(
    LIFECYCLE.map(async (l) => {
      const state = l === 'candidate' || l === 'in-progress' ? 'opened' : 'all';
      return [l, await ctx.gl.listIssues(`labels=undertaker::${l}&state=${state}&per_page=100`)] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<Lifecycle, Issue[]>;
}

interface Release {
  parent?: Pipeline;
  child?: Pipeline;
  jobs: Job[];
}

async function findRelease(ctx: Ctx, afterId = 0): Promise<Release> {
  const pipelines = await ctx.gl.listPipelines(
    `ref=${encodeURIComponent(ctx.defaultBranch)}&order_by=id&sort=desc&per_page=20`,
  );
  const parent = releaseParent(pipelines, afterId);
  if (!parent) return { jobs: [] };
  const child = releaseChild(await ctx.gl.pipelineTriggerJobs(parent.id));
  if (!child) return { parent, jobs: [] };
  // The bridge's downstream_pipeline status lags; read the pipeline itself.
  const [fresh, jobs] = await Promise.all([ctx.gl.getPipeline(child.id), ctx.gl.pipelineJobs(child.id)]);
  return { parent, child: fresh, jobs };
}

// ---------- status ----------

async function status(ctx: Ctx): Promise<void> {
  const [ledger, issues, mrs, release] = await Promise.all([
    loadLedger(ctx),
    lifecycleIssues(ctx),
    undertakerMrs(ctx),
    findRelease(ctx),
  ]);
  console.log(`🪦 Probation demo status · ${ctx.path}\n`);
  console.log(`Ledger (${Object.keys(ctx.policy.agents)[0]}), ${ledger.events.length} events`);
  for (const row of ledgerRows(ledger, ctx.policy)) console.log(row);

  console.log('\nGraves');
  for (const l of LIFECYCLE) {
    const list = issues[l];
    console.log(`  undertaker::${l} (${list.length})`);
    for (const i of list.slice(0, 5)) console.log(issueLine(i));
    if (list.length > 5) console.log(`    … ${list.length - 5} more`);
  }

  console.log(`\nOpen Undertaker MRs (${mrs.length})`);
  for (const mr of mrs.sort((a, b) => b.iid - a.iid)) console.log(mrLine(mr));

  console.log('\nRelease');
  if (!release.parent) console.log(`  no pipeline on ${ctx.defaultBranch} yet`);
  else {
    console.log(`  ${ctx.defaultBranch} #${release.parent.id}  ${statusText(release.parent.status)}`);
    console.log(`      ${release.parent.web_url}`);
    if (!release.child) console.log('  release child: not started');
    else {
      console.log(`  release child #${release.child.id}  ${statusText(release.child.status)}`);
      console.log(`      ${release.child.web_url}`);
      for (const line of formatJobs(release.jobs)) console.log(line);
    }
  }
  const snapshot: DemoSnapshot = { issues, mrs, ...release, childJobs: release.jobs };
  next(nextStep(snapshot));
}

// ---------- dig ----------

async function dig(ctx: Ctx): Promise<void> {
  const wantedRaw = option('issue');
  if (wantedRaw !== undefined) {
    const wantedIid = Number(wantedRaw.replace(/^#/, ''));
    if (!Number.isInteger(wantedIid) || wantedIid <= 0)
      throw new Error(`--issue must be an issue IID, got ${wantedRaw}`);
    const [wanted, candidates, ledger] = await Promise.all([
      ctx.gl.getIssue(wantedIid),
      ctx.gl.listIssues('labels=undertaker::candidate&state=opened&per_page=100'),
      loadLedger(ctx),
    ]);
    const steer = digSteer(candidates, wanted, ledger, ctx.policy);
    for (const line of steerMessage(steer, wantedIid)) console.log(line);
    console.log('   (The census runs first and may file new candidates; dig orders them the same way.)');
    if ((steer.blocked || steer.ahead.length) && !hasFlag('force')) {
      process.exitCode = 1;
      next(`steer as above, then npm run demo -- dig --issue ${wantedIid}`);
      return;
    }
  }
  const schedule = findSchedule(await ctx.gl.listPipelineSchedules());
  if (!schedule)
    throw new Error(`pipeline schedule "${SCHEDULE_DESCRIPTION}" not found: run npm run gitlab:setup`);
  const before = (await ctx.gl.schedulePipelines(schedule.id))[0]?.id ?? 0;
  await ctx.gl.playPipelineSchedule(schedule.id);
  console.log(`▶️  Played schedule #${schedule.id} "${schedule.description}" (census → dig → sweep).`);
  // play only queues the run; the pipeline shows up a few seconds later.
  let pipeline: Pipeline | undefined;
  for (let i = 0; i < 10 && !pipeline; i++) {
    pipeline = (await ctx.gl.schedulePipelines(schedule.id)).find((p) => p.id > before);
    if (!pipeline) await sleep(numberOption('interval', 2) * 1000);
  }
  if (pipeline) console.log(`   Pipeline #${pipeline.id}: ${pipeline.web_url}`);
  else console.log('   The pipeline has not appeared yet: Build → Pipelines (source: schedule).');
  next(
    'watch undertaker:dig finish, then the flow session; npm run demo -- status shows the MR when it opens',
  );
}

// ---------- approve ----------

async function approve(ctx: Ctx): Promise<void> {
  const pick = pickAssistedMr(await undertakerMrs(ctx));
  if (!pick.mr) {
    console.log(`⚠️  Nothing to approve: ${pick.message}.`);
    process.exitCode = 1;
    next('npm run demo -- status');
    return;
  }
  const mr = pick.mr;
  console.log(`🧑‍⚖️ !${mr.iid} ${mr.title}\n   ${mr.web_url}`);
  const approvals = await ctx.gl.mrApprovals(mr.iid);
  if (approvals.user_has_approved) console.log('✅ approved (already, by you)');
  else {
    await ctx.gl.approveMr(mr.iid, mr.sha);
    console.log('✅ approved');
  }
  const plan = mergePlan(mr);
  if (!plan.merge) {
    console.log(`⚠️  not merging: ${plan.reason}`);
    process.exitCode = 1;
    next('npm run demo -- approve again once the pipeline succeeds');
    return;
  }
  if (mr.draft) {
    // Same as clicking "Mark as ready": a draft cannot merge.
    await ctx.gl.updateMr(mr.iid, { title: mr.title.replace(/^(Draft:|\[Draft\]|\(Draft\))\s*/i, '') });
    console.log('✅ marked ready');
  }
  const merged = await ctx.gl.acceptMr(mr.iid, mr.sha);
  console.log(`✅ merged (state: ${merged.state})`);
  next('npm run demo -- watch --new   (main pipeline → release child → soak → settle)');
}

// ---------- promote ----------

async function promote(ctx: Ctx): Promise<void> {
  const release = await findRelease(ctx);
  if (!release.child) {
    console.log(
      release.parent
        ? `⏳ ${ctx.defaultBranch} #${release.parent.id} (${release.parent.status}) has no release child yet: ${release.parent.web_url}`
        : `⚠️  no pipeline on ${ctx.defaultBranch}`,
    );
    process.exitCode = 1;
    next('npm run demo -- watch --new, then promote when approve:production waits');
    return;
  }
  console.log(
    `Release child #${release.child.id} ${statusText(release.child.status)}: ${release.child.web_url}`,
  );
  const plan = promotePlan(release.jobs);
  if (plan.action === 'play') {
    const job = await ctx.gl.playJob(plan.job.id);
    console.log(`▶️  Played ${job.name} (${statusText(job.status)}): ${job.web_url}`);
    next('npm run demo -- watch   (canary → 3 min soak → promote → settle)');
    return;
  }
  console.log(`${plan.action === 'done' ? 'ℹ️ ' : '⚠️ '} ${plan.message}`);
  if (plan.action !== 'done') process.exitCode = 1;
  next(plan.action === 'wait' ? 'npm run demo -- promote again in a minute' : 'npm run demo -- watch');
}

// ---------- watch ----------

async function watch(ctx: Ctx): Promise<void> {
  const timeoutS = numberOption('timeout', 900);
  const intervalMs = numberOption('interval', 15) * 1000;
  const deadline = Date.now() + timeoutS * 1000;
  const ledgerBefore = await loadLedger(ctx);
  // --new: ignore pipelines that already exist (right after a merge the new main pipeline lags by seconds).
  let afterId = 0;
  if (hasFlag('new')) {
    const latest = await ctx.gl.listPipelines(
      `ref=${encodeURIComponent(ctx.defaultBranch)}&order_by=id&sort=desc&per_page=20`,
    );
    afterId = releaseParent(latest)?.id ?? 0;
  }
  const seen = new Map<string, string>();
  let announced = '';
  let hinted = false;
  let release: Release = { jobs: [] };
  for (;;) {
    release = await findRelease(ctx, afterId);
    const key = release.child
      ? `child ${release.child.id}`
      : release.parent
        ? `parent ${release.parent.id} ${release.parent.status}`
        : 'none';
    if (key !== announced) {
      announced = key;
      if (release.child)
        console.log(`👀 ${clock()} release child #${release.child.id}: ${release.child.web_url}`);
      else if (release.parent)
        console.log(
          `⏳ ${clock()} ${ctx.defaultBranch} #${release.parent.id} ${statusText(release.parent.status)}, release child not started: ${release.parent.web_url}`,
        );
      else console.log(`⏳ ${clock()} waiting for a new pipeline on ${ctx.defaultBranch}…`);
    }
    for (const line of transitions(seen, release.jobs)) console.log(`   ${clock()} ${line}`);
    const approveJob = release.jobs.find((j) => j.name === 'approve:production');
    if (approveJob?.status === 'manual' && !hinted) {
      hinted = true;
      console.log(
        '   ✋ approve:production waits for you: run npm run demo -- promote (in another terminal)',
      );
    }
    if (release.child && FINISHED.has(release.child.status)) break;
    // A parent that failed before triggering release:run never gets a child.
    if (!release.child && release.parent && FINISHED.has(release.parent.status)) break;
    if (Date.now() + intervalMs > deadline) {
      console.log(`⌛ timed out after ${timeoutS} s; the pipeline keeps running.`);
      process.exitCode = 1;
      next('npm run demo -- watch');
      return;
    }
    await sleep(intervalMs);
  }

  if (!release.child) {
    console.log(`❌ ${ctx.defaultBranch} #${release.parent?.id} ${release.parent?.status} before releasing.`);
    process.exitCode = 1;
    next(`open ${release.parent?.web_url}`);
    return;
  }

  for (const name of SIGNAL_JOBS) {
    const job = release.jobs.find((j) => j.name === name);
    if (!job || !['success', 'failed'].includes(job.status)) continue;
    const lines = verdictLines(await ctx.gl.jobTrace(job.id).catch(() => ''));
    console.log(`\n${statusText(job.status)} ${name}${lines.length ? '' : ' (no verdict lines in the log)'}`);
    for (const l of lines) console.log(`   ${l}`);
  }

  const ledgerAfter = await loadLedger(ctx);
  const delta = ledgerDelta(ledgerBefore, ledgerAfter);
  console.log('\nLedger');
  if (delta.length) for (const d of delta) console.log(`   ${d}`);
  else console.log('   no change (human release, or settle did not run)');

  const ok = release.child.status === 'success';
  console.log(
    `\n${ok ? '✅ released' : '❌ release failed'}: child #${release.child.id} ${release.child.status}`,
  );
  if (!ok) process.exitCode = 1;
  next(
    ok
      ? 'npm run demo -- status, then npm run demo -- dig for the next act'
      : 'check the revert commit and the ⬇️ demotion issue, then npm run demo -- status',
  );
}

main(async () => {
  const command = process.argv[2];
  if (!command || !COMMANDS.includes(command))
    throw new Error(`usage: npm run demo -- <${COMMANDS.join('|')}> (see the header of scripts/demo.ts)`);
  const config = setupConfigFromEnv(process.env);
  const gl = new GitLab(config.gitlab);
  const project = await gl.getProject();
  const ctx: Ctx = {
    gl,
    policy: loadPolicy(POLICY),
    defaultBranch: project.default_branch,
    path: project.path_with_namespace,
  };
  await { status, dig, approve, promote, watch }[command as 'status'](ctx);
});
