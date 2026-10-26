// sweep — finds Undertaker MRs a human closed without merging, so each costs human_rejected exactly once.
import type { MergeRequest } from './gitlab.ts';
import type { Ledger } from './ledger.ts';
import { isUndertaker } from './mr.ts';
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
