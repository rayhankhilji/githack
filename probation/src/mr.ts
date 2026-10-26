import { type GateDecision, label } from './gate.ts';
import type { MergeRequest, MrDiff } from './gitlab.ts';

export function countLines(diff: string) {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

export function isUndertaker(mr: MergeRequest, agent: { label: string; author_pattern: string }): boolean {
  return mr.labels.includes(agent.label) || new RegExp(agent.author_pattern).test(mr.author.username);
}

export function gateComment(d: GateDecision, removedFindings: number): string {
  const head = {
    block: '⛔ **Probation gate: blocked.**',
    needs_human: `🧑‍⚖️ **Probation gate: Undertaker is on ${label(d.level)} in this zone.** A human must approve and merge. Each MR that survives production earns trust.`,
    merge_supervised: `🟡 **Probation gate: ${label(d.level)}.** Auto-merging; production promotion waits for a human approval.`,
    merge_hands_off: `🟢 **Probation gate: ${label(d.level)}.** Auto-merging and shipping to production through a canary. No human needed.`,
  }[d.verdict];
  return [
    head,
    '',
    ...d.reasons.map((r) => `- ${r}`),
    '',
    `Diff: **−${d.linesRemoved} / +${d.linesAdded}** lines${removedFindings ? ` · ${removedFindings} existing security finding(s) removed` : ''}.`,
    '',
    '<sub>Decided by `probation/src/gate.ts` from `probation/policy.yml` and the ledger. The agent does not decide its own autonomy.</sub>',
  ].join('\n');
}

export function diffStats(diffs: MrDiff[]) {
  return diffs.map((d) => ({ path: d.new_path, deleted: d.deleted_file, ...countLines(d.diff) }));
}
