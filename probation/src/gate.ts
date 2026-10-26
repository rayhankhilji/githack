import { type Ledger, levelOf } from './ledger.ts';
import { type Level, minLevel, type Policy } from './policy.ts';
import type { Finding } from './security.ts';
import { classifyChanges } from './zones.ts';

export type Verdict = 'block' | 'needs_human' | 'merge_supervised' | 'merge_hands_off';

export interface GateInput {
  agent: string;
  files: { path: string; deleted: boolean; added: number; removed: number }[];
  introducedFindings: Finding[];
  checksPassed: boolean;
  // Set when the coroner (the flow's adversarial self-review) objected to its own MR.
  coronerObjection?: string;
}

export interface GateDecision {
  verdict: Verdict;
  level: Level;
  zones: { zone: string; score: number; level: Level }[];
  reasons: string[];
  linesRemoved: number;
  linesAdded: number;
}

// The gate is deterministic on purpose: autonomy is enforced by the pipeline, never by the agent's own judgement.
export function decide(policy: Policy, ledger: Ledger, input: GateInput): GateDecision {
  const changed = classifyChanges(
    policy,
    input.files.map((f) => f.path),
  );
  const zones = changed.zones.map((zone) => ({
    zone,
    score: ledger.scores[input.agent]?.[zone] ?? 0,
    level: levelOf(ledger, policy, input.agent, zone),
  }));
  const linesAdded = input.files.reduce((n, f) => n + f.added, 0);
  const linesRemoved = input.files.reduce((n, f) => n + f.removed, 0);
  const level = zones.length ? minLevel(zones.map((z) => z.level)) : 'assisted';
  const base = { level, zones, linesAdded, linesRemoved };

  const blocks: string[] = [];
  for (const f of changed.forbidden) blocks.push(`\`${f.file}\` is in forbidden zone **${f.zone}**`);
  for (const f of changed.unzoned) blocks.push(`\`${f}\` is outside every zone in policy.yml`);
  for (const path of changed.neutral) {
    const file = input.files.find((f) => f.path === path);
    if (file && file.added > 0)
      blocks.push(`\`${path}\` adds or edits test lines; Undertaker may only delete tests of code it buries`);
  }
  if (!zones.length) blocks.push('touches no zone that can earn trust');
  if (input.introducedFindings.length) {
    blocks.push(
      `introduces ${input.introducedFindings.length} new security finding(s): ${input.introducedFindings.map((f) => f.name).join(', ')}`,
    );
  }
  if (!input.checksPassed) blocks.push('verify/secure checks did not pass');
  if (input.coronerObjection) blocks.push(`the coroner objected: ${input.coronerObjection}`);
  // Undertaker exists to delete. A change that grows the codebase is out of its mandate.
  if (linesAdded > linesRemoved)
    blocks.push(`adds more lines (${linesAdded}) than it removes (${linesRemoved})`);
  if (blocks.length) return { ...base, verdict: 'block', reasons: blocks };

  const reasons = zones.map((z) => `zone **${z.zone}**: score ${z.score} → ${label(z.level)}`);
  if (level === 'hands_off') return { ...base, verdict: 'merge_hands_off', reasons };
  if (level === 'supervised') return { ...base, verdict: 'merge_supervised', reasons };
  return { ...base, verdict: 'needs_human', reasons };
}

export function label(level: Level): string {
  return { assisted: 'Assisted', supervised: 'Supervised', hands_off: 'Hands-off' }[level];
}
