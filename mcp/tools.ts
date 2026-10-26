import { decide, type GateDecision, label } from '../probation/src/gate.ts';
import type { Grave, Ledger, LedgerEvent } from '../probation/src/ledger.ts';
import { type Level, levelForScore, type Policy, type Zone } from '../probation/src/policy.ts';

// Pure handlers behind the Probation MCP server. They only read a policy and a ledger, so the
// answers an IDE agent gets are the same numbers the CI gate uses.

export const DEFAULT_AGENT = 'undertaker';

export interface ZoneTrust {
  zone: string;
  score: number;
  level: Level;
  levelLabel: string;
  // Points still needed for the next level; absent at Hands-off.
  next?: { level: Level; atScore: number; pointsNeeded: number };
  recentEvents: LedgerEvent[];
}

export interface TrustReport {
  agent: string;
  zones: ZoneTrust[];
  excludedZones: { zone: string; why: string }[];
}

const NEXT: Record<Level, Level | undefined> = {
  assisted: 'supervised',
  supervised: 'hands_off',
  hands_off: undefined,
};

// Only zones that can earn trust have a score; forbidden and neutral zones are reported separately.
function scoredZones(policy: Policy): Zone[] {
  return policy.zones.filter((z) => !z.forbidden && !z.neutral);
}

export function getTrust(
  policy: Policy,
  ledger: Ledger,
  args: { zone?: string; agent?: string } = {},
): TrustReport {
  const agent = args.agent ?? DEFAULT_AGENT;
  if (args.zone && !policy.zones.some((z) => z.name === args.zone)) {
    throw new Error(
      `unknown zone "${args.zone}"; policy.yml zones: ${policy.zones.map((z) => z.name).join(', ')}`,
    );
  }
  const zones = scoredZones(policy)
    .filter((z) => !args.zone || z.name === args.zone)
    .map((z): ZoneTrust => {
      const score = ledger.scores[agent]?.[z.name] ?? 0;
      const level = levelForScore(policy, score);
      const nextLevel = NEXT[level];
      return {
        zone: z.name,
        score,
        level,
        levelLabel: label(level),
        next: nextLevel && {
          level: nextLevel,
          atScore: policy.levels[nextLevel],
          pointsNeeded: policy.levels[nextLevel] - score,
        },
        recentEvents: ledger.events.filter((e) => e.agent === agent && e.zone === z.name).slice(-5),
      };
    });
  const excludedZones = policy.zones
    .filter((z) => (z.forbidden || z.neutral) && (!args.zone || z.name === args.zone))
    .map((z) => ({
      zone: z.name,
      why: z.forbidden
        ? 'forbidden: every change here is blocked, whatever the score'
        : 'neutral: deletions here never raise or lower trust; added lines are blocked',
    }));
  return { agent, zones, excludedZones };
}

export function listGraves(ledger: Ledger, args: { status?: Grave['status']; zone?: string } = {}) {
  const graves = ledger.graveyard
    .filter((g) => (!args.status || g.status === args.status) && (!args.zone || g.zone === args.zone))
    .sort((a, b) => b.at.localeCompare(a.at));
  return {
    total: graves.length,
    buried: graves.filter((g) => g.status === 'buried').length,
    exhumed: graves.filter((g) => g.status === 'exhumed').length,
    linesRemoved: graves.filter((g) => g.status === 'buried').reduce((n, g) => n + g.linesRemoved, 0),
    graves,
  };
}

export interface ExplainGateArgs {
  files: { path: string; added: number; removed: number; deleted?: boolean }[];
  agent?: string;
  checksPassed?: boolean;
  coronerObjection?: string;
}

export function explainGate(
  policy: Policy,
  ledger: Ledger,
  args: ExplainGateArgs,
): GateDecision & { summary: string } {
  if (!args.files.length) throw new Error('files must list at least one changed file');
  const decision = decide(policy, ledger, {
    agent: args.agent ?? DEFAULT_AGENT,
    files: args.files.map((f) => ({ ...f, deleted: f.deleted ?? false })),
    // Security findings come from CI scanners; a hypothetical change has none to diff.
    introducedFindings: [],
    checksPassed: args.checksPassed ?? true,
    coronerObjection: args.coronerObjection,
  });
  return { ...decision, summary: summarize(decision) };
}

function summarize(d: GateDecision): string {
  switch (d.verdict) {
    case 'block':
      return `Blocked: ${d.reasons.length} rule(s) in policy.yml / gate.ts stop this MR.`;
    case 'needs_human':
      return `Needs a human: the least-trusted zone is ${label(d.level)}, so a maintainer must approve and merge.`;
    case 'merge_supervised':
      return 'Auto-merge at Supervised: the gate merges, a human still approves the production deploy.';
    case 'merge_hands_off':
      return 'Hands-off: the gate merges and the release ships through canary and soak with no human click.';
  }
}

export function policySummary(policy: Policy) {
  return {
    agents: policy.agents,
    levels: policy.levels,
    scoring: policy.scoring,
    zones: policy.zones.map((z) => ({
      name: z.name,
      globs: z.globs,
      kind: z.forbidden ? 'forbidden' : z.neutral ? 'neutral' : 'scored',
    })),
    soak: policy.soak,
    rule: 'A file belongs to the first zone whose glob matches; the least-trusted touched zone sets the level.',
  };
}
