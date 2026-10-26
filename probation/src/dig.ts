// dig — pure candidate selection for `undertaker:dig` (F-09). start-flow.ts does the I/O.
import { label } from './gate.ts';
import type { Issue } from './gitlab.ts';
import { type Ledger, levelOf } from './ledger.ts';
import type { Level, Policy } from './policy.ts';

export const KIND_ORDER = ['dependency', 'export', 'flag', 'route'];
const SKIP_LABELS = new Set(['undertaker::in-progress', 'undertaker::do-not-bury']);

export interface Candidate {
  issue: Issue;
  zone: string;
  kind: string;
  agent: string;
  level: Level;
}

/** Next grave to dig: skips in-progress, do-not-bury, unzoned and forbidden-zone issues; dependency → export → flag → route. */
export function pickCandidate(issues: Issue[], ledger: Ledger, policy: Policy): Candidate | null {
  const agent = Object.keys(policy.agents)[0];
  const forbidden = new Set(policy.zones.filter((z) => z.forbidden).map((z) => z.name));
  const ready = issues
    .filter((i) => !i.labels.some((l) => SKIP_LABELS.has(l)))
    .map((i) => ({
      issue: i,
      zone: i.labels.find((l) => l.startsWith('zone::'))?.slice(6) ?? 'unzoned',
      kind: i.labels.find((l) => l.startsWith('kind::'))?.slice(6) ?? 'route',
    }))
    .filter((c) => !forbidden.has(c.zone) && c.zone !== 'unzoned')
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const next = ready[0];
  if (!next) return null;
  return { ...next, agent, level: levelOf(ledger, policy, agent, next.zone) };
}

/** The flow goal: the issue to bury, its zone and the agent's current level there. */
export function goalFor(c: Candidate): string {
  return [
    `Bury the dead code described in issue #${c.issue.iid}: ${c.issue.web_url}`,
    `Zone: ${c.zone}. Your current probation level in this zone: ${label(c.level)}.`,
    'Only delete. Do not add features. Touch only files in this zone plus tests that cover the deleted code.',
  ].join('\n');
}
