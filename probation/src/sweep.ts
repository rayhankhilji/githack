// sweep — finds Undertaker MRs a human closed without merging, so each costs human_rejected exactly once,
// and returns graves stuck in progress (the flow session died before opening an MR) to the candidate pool.
import type { Issue, MergeRequest } from './gitlab.ts';
import type { Ledger } from './ledger.ts';
import { candidateIssue, isUndertaker } from './mr.ts';
import type { Policy } from './policy.ts';
import { classifyChanges } from './zones.ts';

export function isRejected(mr: MergeRequest): boolean {
  return mr.state === 'closed' && !mr.merged_at;
}

// The gate labels every MR it judged `zone::a+b` (or `zone::none`); no label means the gate never ran.
export function zonesFromLabels(labels: string[]): string[] | undefined {
  const zoneLabel = labels.find((l) => l.startsWith('zone::'));
  if (!zoneLabel) return undefined;
  const value = zoneLabel.slice('zone::'.length);
  if (!value || value === 'none') return undefined;
  return value.split('+').filter(Boolean);
}

// Fallback when the gate left no zone label: score the zones the diff actually touched.
export function zonesFromPaths(policy: Policy, paths: string[]): string[] {
  return classifyChanges(policy, paths).zones;
}

// The closed, unmerged Undertaker MRs not yet scored. A prior human_rejected event for the MR makes it a no-op.
export function rejectionsToScore(
  mrs: MergeRequest[],
  ledger: Ledger,
  agent: { label: string; author_pattern: string },
): MergeRequest[] {
  const scored = new Set(
    ledger.events.filter((e) => e.event === 'human_rejected' && e.ref.mr).map((e) => e.ref.mr),
  );
  const pending: MergeRequest[] = [];
  for (const mr of mrs) {
    if (!isRejected(mr) || !isUndertaker(mr, agent) || scored.has(mr.iid)) continue;
    scored.add(mr.iid);
    pending.push(mr);
  }
  return pending;
}

export function rejectionNote(zones: string[], points: number): string {
  return `⚖️ Closed without merge: −${Math.abs(points)} in zone(s) ${zones.map((z) => `\`${z}\``).join(', ')}.`;
}

export const IN_PROGRESS = 'undertaker::in-progress';
export const DEFAULT_STALE_HOURS = 6;

// GitLab returns updated_at on every issue; still validate it, since a bad value must never trigger a reset.
function updatedAt(issue: Issue): number | undefined {
  const raw = issue.updated_at;
  const t = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(t) ? undefined : t;
}

// In-progress issues no open or merged MR closes, untouched for staleHours. Any note or label change bumps
// updated_at, so the clock starts when start-flow labelled it; an issue without updated_at is never reset.
export function staleInProgress(
  issues: Issue[],
  openOrMergedMrs: MergeRequest[],
  now: Date,
  staleHours: number,
): Issue[] {
  const claimed = new Set(
    openOrMergedMrs
      .filter((mr) => mr.state === 'opened' || mr.state === 'merged')
      .map((mr) => candidateIssue(mr.description ?? ''))
      .filter((iid) => iid !== undefined),
  );
  const cutoff = now.getTime() - staleHours * 3_600_000;
  return issues.filter((issue) => {
    const at = updatedAt(issue);
    return (
      issue.state === 'opened' &&
      issue.labels.includes(IN_PROGRESS) &&
      !claimed.has(issue.iid) &&
      at !== undefined &&
      at < cutoff
    );
  });
}

export function staleNote(hours: number): string {
  return `♻️ No Undertaker MR after ${hours} h; returned to the candidate pool.`;
}

// STALE_HOURS overrides policy census.stale_hours; both fall back to 6 h when absent or invalid.
export function staleHours(policy: Policy, override?: string): number {
  const fromEnv = Number(override);
  if (override && fromEnv > 0) return fromEnv;
  const fromPolicy = (policy.census as { stale_hours?: unknown }).stale_hours;
  return typeof fromPolicy === 'number' && fromPolicy > 0 ? fromPolicy : DEFAULT_STALE_HOURS;
}
