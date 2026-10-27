// demo — pure decisions and formatting for the demo conductor (scripts/demo.ts), which does the clicks of
// RUNBOOK §5 through the API: which MR to merge, which pipeline is the release, which job to play. No I/O here.
import { pickCandidate } from './dig.ts';
import { label } from './gate.ts';
import type { Issue, Job, MergeRequestDetail, Pipeline, TriggerJob } from './gitlab.ts';
import { type Ledger, type LedgerEvent, levelOf, scoreOf } from './ledger.ts';
import type { Level, Policy } from './policy.ts';

export const LIFECYCLE = ['candidate', 'in-progress', 'buried', 'do-not-bury'] as const;
export type Lifecycle = (typeof LIFECYCLE)[number];

export const RELEASE_TRIGGER = 'release:run';
export const APPROVE_JOB = 'approve:production';
export const SIGNAL_JOBS = ['soak:canary', 'soak:canary-signal'];

// The release child pipeline's jobs in the order they run (release-plan.ts). Unknown jobs go last.
export const JOB_ORDER = [
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

export const FINISHED = new Set(['success', 'failed', 'canceled', 'skipped']);

const ICON: Record<string, string> = {
  success: '✅',
  failed: '❌',
  running: '🔄',
  pending: '⏳',
  created: '⏳',
  preparing: '⏳',
  waiting_for_resource: '⏳',
  waiting_for_callback: '⏳',
  scheduled: '⏰',
  manual: '✋',
  skipped: '⏭️',
  canceled: '⛔',
  canceling: '⛔',
};

export const statusIcon = (status: string | undefined) => (status ? (ICON[status] ?? '•') : '·');
export const statusText = (status: string | undefined) => `${statusIcon(status)} ${status ?? 'none'}`;

export const LEVEL_ICON: Record<Level, string> = { assisted: '🧑‍⚖️', supervised: '🟡', hands_off: '🟢' };
export const levelText = (level: Level) => `${LEVEL_ICON[level]} ${label(level)}`;

/** The newest pipeline on the default branch that can release (scheduled census runs never trigger release:run). */
export function releaseParent(pipelines: Pipeline[], afterId = 0): Pipeline | undefined {
  return pipelines
    .filter((p) => p.source !== 'schedule' && p.source !== 'parent_pipeline' && p.id > afterId)
    .sort((a, b) => b.id - a.id)[0];
}

/** The release child pipeline of a parent: the downstream of its release:run trigger job, once created. */
export function releaseChild(triggerJobs: TriggerJob[]): Pipeline | undefined {
  const bridge = triggerJobs.find((j) => j.name === RELEASE_TRIGGER) ?? triggerJobs[0];
  return bridge?.downstream_pipeline ?? undefined;
}

export const sortJobs = (jobs: Job[]) =>
  [...jobs].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
const rank = (name: string) => {
  const i = JOB_ORDER.indexOf(name);
  return i < 0 ? JOB_ORDER.length : i;
};

export function formatJobs(jobs: Job[], indent = '    '): string[] {
  const width = Math.max(0, ...jobs.map((j) => j.name.length));
  return sortJobs(jobs).map((j) => `${indent}${j.name.padEnd(width)}  ${statusText(j.status)}`);
}

export type PromotePlan =
  | { action: 'play'; job: Job }
  | { action: 'done'; job: Job; message: string }
  | { action: 'wait'; job?: Job; message: string }
  | { action: 'none'; message: string };

/** What `promote` should do with the child pipeline's approve:production job. */
export function promotePlan(jobs: Job[]): PromotePlan {
  const job = jobs.find((j) => j.name === APPROVE_JOB);
  if (!job) return { action: 'none', message: `the release pipeline has no ${APPROVE_JOB} job` };
  switch (job.status) {
    case 'manual':
      return { action: 'play', job };
    case 'success':
    case 'running':
    case 'pending':
      return {
        action: 'done',
        job,
        message: `${APPROVE_JOB} is already ${job.status} (played, or Hands-off/human: it runs on its own)`,
      };
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
      return {
        action: 'wait',
        job,
        message: `${APPROVE_JOB} is ${job.status}: deploy:staging has not finished`,
      };
    default:
      return { action: 'none', message: `${APPROVE_JOB} is ${job.status}; nothing to approve` };
  }
}

const probationLevel = (mr: { labels: string[] }) =>
  mr.labels.find((l) => l.startsWith('probation::'))?.slice(11) as Level | undefined;

export type ApprovePick =
  | { mr: MergeRequestDetail; message?: undefined }
  | { mr?: undefined; message: string };

/** The newest open Undertaker MR the gate left to a human (probation::assisted = verdict needs_human). */
export function pickAssistedMr(mrs: MergeRequestDetail[]): ApprovePick {
  const open = [...mrs].filter((m) => m.state === 'opened').sort((a, b) => b.iid - a.iid);
  const mr = open.find((m) => probationLevel(m) === 'assisted');
  if (mr) return { mr };
  if (!open.length) return { message: 'no open Undertaker MR' };
  const newest = open[0];
  const level = probationLevel(newest);
  if (!level)
    return {
      message: `!${newest.iid} has no probation:: label yet: the MR pipeline's probation:gate has not run`,
    };
  return {
    message: `!${newest.iid} is ${label(level)}: the gate auto-merges it, no approval needed`,
  };
}

export type MergePlan = { merge: true } | { merge: false; reason: string };

/** Merge only when the MR's head pipeline (which ran probation:gate) succeeded. */
export function mergePlan(mr: MergeRequestDetail): MergePlan {
  const p = mr.head_pipeline;
  if (!p) return { merge: false, reason: `!${mr.iid} has no pipeline yet; wait for probation:gate` };
  // Right after a push, head_pipeline can still be the previous commit's: only trust a pipeline for this sha.
  if (p.sha && mr.sha && p.sha !== mr.sha)
    return {
      merge: false,
      reason: `!${mr.iid}'s pipeline for the latest commit has not started yet: ${p.web_url}`,
    };
  if (p.status === 'success') return { merge: true };
  if (FINISHED.has(p.status))
    return {
      merge: false,
      reason: `!${mr.iid}'s pipeline ${p.status} (gate blocked or a check failed): ${p.web_url}`,
    };
  return {
    merge: false,
    reason: `!${mr.iid}'s pipeline is ${p.status}; re-run when it succeeds: ${p.web_url}`,
  };
}

export interface DigSteer {
  /** The issue dig would start the flow on, or undefined when nothing is diggable. */
  pick?: Issue;
  /** Diggable candidates dig would pick before the wanted issue, in order. */
  ahead: Issue[];
  /** Why the wanted issue can never be picked, if so. */
  blocked?: string;
}

/** Where `wanted` sits in dig's order. Repeats pickCandidate so the answer is exactly dig's. */
export function digSteer(candidates: Issue[], wanted: Issue, ledger: Ledger, policy: Policy): DigSteer {
  const pick = pickCandidate(candidates, ledger, policy)?.issue;
  let blocked: string | undefined;
  if (wanted.state !== 'opened') blocked = `#${wanted.iid} is ${wanted.state}`;
  else if (!wanted.labels.includes('undertaker::candidate'))
    blocked = `#${wanted.iid} is not labelled undertaker::candidate (${wanted.labels.filter((l) => l.startsWith('undertaker::')).join(', ') || 'no lifecycle label'})`;
  else if (!pickCandidate([wanted], ledger, policy))
    blocked = `#${wanted.iid} is unzoned or in a forbidden zone`;
  if (blocked) return { pick, ahead: [], blocked };
  const ahead: Issue[] = [];
  let pool = candidates.some((c) => c.iid === wanted.iid) ? candidates : [...candidates, wanted];
  for (;;) {
    const next = pickCandidate(pool, ledger, policy)?.issue;
    if (!next || next.iid === wanted.iid) break;
    ahead.push(next);
    pool = pool.filter((c) => c.iid !== next.iid);
  }
  return { pick, ahead };
}

export function steerMessage(s: DigSteer, wanted: number): string[] {
  if (s.blocked)
    return [
      `❌ dig will never pick #${wanted}: ${s.blocked}.`,
      `   → Label it undertaker::candidate (and a zone:: label) to put it back in the pool.`,
    ];
  if (!s.ahead.length) return [`✅ dig picks #${wanted} next.`];
  return [
    `⚠️  dig would pick #${s.pick?.iid} (${s.pick?.title}), not #${wanted}.`,
    `   Ahead of #${wanted} (dependency → export → flag → route): ${s.ahead.map((i) => `#${i.iid}`).join(', ')}.`,
    `   → Label each of them undertaker::in-progress (or close them) in GitLab, then re-run this command.`,
    '   → Or run it anyway with --force: Undertaker starts on the first in that order.',
  ];
}

/** Lines worth showing from a soak job log: the synthetics / signal verdict, never the npm noise. */
export function verdictLines(trace: string, max = 12): string[] {
  const clean = trace
    // biome-ignore lint/suspicious/noControlCharactersInRegex: GitLab job logs carry ANSI escapes.
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/section_(?:start|end):\d+:[\w.-]+(?:\[[^\]]*\])?/g, '');
  const lines = clean
    .split('\n')
    .map((l) => (l.split('\r').filter(Boolean).pop() ?? '').trimEnd())
    .filter((l) => /^(soak\b|soak signal|⚠ soak|✖|\s+(canary|baseline):|\s+- )/.test(l));
  return lines.slice(-max);
}

/** Ledger events written after `before` (by settle:* in the release pipeline), one line each. */
export function ledgerDelta(before: Ledger, after: Ledger): string[] {
  const events: LedgerEvent[] = after.events.slice(before.events.length);
  return events.map((e) => {
    const points = e.points >= 0 ? `+${e.points}` : String(e.points);
    const level =
      e.levelBefore === e.levelAfter
        ? levelText(e.levelAfter)
        : `${levelText(e.levelBefore)} → ${levelText(e.levelAfter)} ${LEVEL_RANK[e.levelAfter] > LEVEL_RANK[e.levelBefore] ? '🎖️' : '⬇️'}`;
    return `${e.zone}: ${points} ${e.event} → score ${e.scoreAfter}, ${level}${e.ref.mr ? ` (!${e.ref.mr})` : ''}`;
  });
}
const LEVEL_RANK: Record<Level, number> = { assisted: 0, supervised: 1, hands_off: 2 };

/** Scored zones (not forbidden, not neutral) with the agent's score and level. */
export function ledgerRows(ledger: Ledger, policy: Policy): string[] {
  const agent = Object.keys(policy.agents)[0];
  const zones = policy.zones.filter((z) => !z.forbidden && !z.neutral).map((z) => z.name);
  const width = Math.max(...zones.map((z) => z.length));
  return zones.map(
    (z) =>
      `  ${z.padEnd(width)}  ${String(scoreOf(ledger, agent, z)).padStart(4)}  ${levelText(levelOf(ledger, policy, agent, z))}`,
  );
}

export interface DemoSnapshot {
  issues: Record<Lifecycle, Issue[]>;
  mrs: MergeRequestDetail[];
  parent?: Pipeline;
  child?: Pipeline;
  childJobs: Job[];
}

/** The one command to run next, from what `status` saw. */
export function nextStep(s: DemoSnapshot): string {
  const approve = s.childJobs.find((j) => j.name === APPROVE_JOB);
  if (s.child && approve?.status === 'manual')
    return 'npm run demo -- promote   (Supervised: you approve production)';
  if (s.child && !FINISHED.has(s.child.status)) return 'npm run demo -- watch   (release in flight)';
  if (s.parent && !FINISHED.has(s.parent.status) && !s.child)
    return 'npm run demo -- watch   (main pipeline running; the release child starts after package:image)';
  const assisted = pickAssistedMr(s.mrs);
  if (assisted.mr) return `npm run demo -- approve   (!${assisted.mr.iid} waits for a human)`;
  const open = s.mrs.filter((m) => m.state === 'opened');
  if (open.length) return `wait for !${open[0].iid}'s pipeline (probation:gate), then npm run demo -- status`;
  if (s.issues['in-progress'].length)
    return `Undertaker is digging #${s.issues['in-progress'][0].iid}; wait for its MR (Automate → Agent sessions), then npm run demo -- status`;
  return 'npm run demo -- dig   (census + dig: starts Undertaker on the next candidate)';
}

export function mrLine(mr: MergeRequestDetail): string {
  const level = probationLevel(mr);
  const levelLabel = level ? levelText(level) : '· no gate yet';
  const p = mr.head_pipeline;
  const auto = mr.merge_when_pipeline_succeeds ? ' · auto-merge set' : '';
  return `  !${mr.iid}  ${levelLabel}  pipeline ${statusText(p?.status)}${auto}  ${mr.title}\n      ${mr.web_url}`;
}

export function issueLine(issue: Issue): string {
  const zone = issue.labels.find((l) => l.startsWith('zone::'))?.slice(6) ?? '?';
  const kind = issue.labels.find((l) => l.startsWith('kind::'))?.slice(6) ?? '?';
  return `    #${issue.iid} [${zone}/${kind}] ${issue.title}`;
}

/** One line per job whose status changed since the last poll. */
export function transitions(prev: Map<string, string>, jobs: Job[]): string[] {
  const out: string[] = [];
  for (const j of sortJobs(jobs)) {
    const was = prev.get(j.name);
    if (was !== j.status) out.push(`${j.name}: ${was ? `${statusText(was)} → ` : ''}${statusText(j.status)}`);
    prev.set(j.name, j.status);
  }
  return out;
}
