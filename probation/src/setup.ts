// setup — the GitLab project setup Probation needs, as data and pure checks.
// scripts/gitlab-setup.ts applies it idempotently; scripts/doctor.ts verifies it read-only. No I/O here.
import type { CiVariable, GitLabConfig, Label, PipelineSchedule, Project, TokenInfo } from './gitlab.ts';
import type { Policy } from './policy.ts';

export type Status = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  status: Status;
  name: string;
  detail: string;
  /** One line telling the human what to do; shown for warn and fail. */
  fix?: string;
}

const ICON: Record<Status, string> = { ok: '✅', warn: '⚠️ ', fail: '❌', skip: '⏭️ ' };

export function formatCheck(c: Check): string {
  const line = `${ICON[c.status]} ${c.name}: ${c.detail}`;
  return c.fix && (c.status === 'warn' || c.status === 'fail') ? `${line}\n   → ${c.fix}` : line;
}

export const failed = (checks: Check[]) => checks.some((c) => c.status === 'fail');

export interface SetupConfig {
  gitlab: GitLabConfig;
  cron: string;
  freshness: string;
}

export function setupConfigFromEnv(env: NodeJS.ProcessEnv): SetupConfig {
  const token = env.GITLAB_TOKEN;
  const projectId = env.GITLAB_PROJECT ?? env.GITLAB_PROJECT_ID;
  if (!token || !projectId)
    throw new Error(
      'Set GITLAB_TOKEN (your personal access token, scope api, Maintainer on the project) and GITLAB_PROJECT (group/sub/project or numeric id)',
    );
  return {
    gitlab: {
      apiUrl: (env.GITLAB_API_URL ?? 'https://gitlab.com/api/v4').replace(/\/$/, ''),
      projectId,
      token,
    },
    cron: env.CENSUS_CRON ?? '17 2 * * *',
    freshness: env.CENSUS_FRESHNESS ?? '7d',
  };
}

// ---------- Labels ----------

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

// DESIGN_SYSTEM §2 light-theme colors.
export const COLORS = {
  assisted: '#b45309',
  supervised: '#1d4ed8',
  hands_off: '#15803d',
  red: '#b91c1c',
  muted: '#6d675d',
} as const;

export function labelCatalogue(policy: Policy): LabelSpec[] {
  const m = COLORS.muted;
  return [
    {
      name: 'undertaker',
      color: m,
      description: 'Authored by the Undertaker deletion agent; the Probation gate decides how far it goes',
    },
    {
      name: 'undertaker::candidate',
      color: m,
      description: 'Census found no use for this code; Undertaker may pick it up',
    },
    { name: 'undertaker::in-progress', color: m, description: 'Undertaker is working on this grave' },
    { name: 'undertaker::buried', color: m, description: 'Deleted and survived production' },
    {
      name: 'undertaker::do-not-bury',
      color: COLORS.red,
      description: 'Never propose this again (set by a human or by a rollback)',
    },
    {
      name: 'probation::assisted',
      color: COLORS.assisted,
      description: 'Gate: a human must approve and merge',
    },
    {
      name: 'probation::supervised',
      color: COLORS.supervised,
      description: 'Gate: auto-merge; a human approves production',
    },
    {
      name: 'probation::hands_off',
      color: COLORS.hands_off,
      description: 'Gate: auto-merge and auto-release, guarded by the soak',
    },
    { name: 'probation::promotion', color: m, description: 'Undertaker earned a higher level in a zone' },
    {
      name: 'probation::demotion',
      color: COLORS.red,
      description: 'Undertaker lost a level in a zone after a rollback or rejection',
    },
    {
      name: 'coroner::objection',
      color: COLORS.red,
      description: 'The coroner found a live caller; the gate blocks the MR',
    },
    ...policy.zones.map((z) => ({
      name: `zone::${z.name}`,
      color: m,
      description: `Probation zone${z.forbidden ? ' (forbidden to Undertaker)' : z.neutral ? ' (neutral)' : ''}: ${z.globs.join(', ')}`,
    })),
    ...(['route', 'flag', 'dependency', 'export'] as const).map((k) => ({
      name: `kind::${k}`,
      color: m,
      description: `Census candidate kind: ${k}`,
    })),
  ];
}

export type LabelAction = 'create' | 'update' | 'exists' | 'inherited';

/** What to do per wanted label. Group labels can't be edited from the project, so they count as present. */
export function planLabels(
  wanted: LabelSpec[],
  existing: Label[],
): { spec: LabelSpec; action: LabelAction }[] {
  return wanted.map((spec) => {
    const have = existing.find((l) => l.name === spec.name);
    if (!have) return { spec, action: 'create' };
    if (have.is_project_label === false) return { spec, action: 'inherited' };
    const same =
      have.color.toLowerCase() === spec.color.toLowerCase() && (have.description ?? '') === spec.description;
    return { spec, action: same ? 'exists' : 'update' };
  });
}

export function labelsCheck(wanted: LabelSpec[], existing: Label[]): Check {
  const names = new Set(existing.map((l) => l.name));
  const missing = wanted.filter((l) => !names.has(l.name)).map((l) => l.name);
  return missing.length
    ? {
        status: 'fail',
        name: 'labels',
        detail: `${missing.length} missing (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''})`,
        fix: 'npm run gitlab:setup',
      }
    : { status: 'ok', name: 'labels', detail: `all ${wanted.length} present` };
}

// ---------- Pipeline schedule, protected tag, MR settings ----------

export const SCHEDULE_DESCRIPTION = 'Probation census + dig + sweep';
export const CATALOG_TAG = 'catalog-*';
export const MAINTAINER = 40;

export const findSchedule = (schedules: PipelineSchedule[]) =>
  schedules.find((s) => s.description === SCHEDULE_DESCRIPTION);

export function scheduleCheck(schedule: PipelineSchedule | undefined, defaultBranch: string): Check {
  const name = 'pipeline schedule';
  if (!schedule)
    return {
      status: 'fail',
      name,
      detail: `"${SCHEDULE_DESCRIPTION}" not found`,
      fix: 'npm run gitlab:setup',
    };
  const ref = schedule.ref.replace(/^refs\/heads\//, '');
  if (!schedule.active)
    return {
      status: 'warn',
      name,
      detail: 'exists but inactive',
      fix: 'Build → Pipeline schedules → Edit → Active',
    };
  if (ref !== defaultBranch)
    return {
      status: 'warn',
      name,
      detail: `targets ${ref}, not ${defaultBranch}`,
      fix: `Build → Pipeline schedules → Edit → target ${defaultBranch}`,
    };
  return { status: 'ok', name, detail: `${schedule.cron} (${schedule.cron_timezone}) on ${ref}` };
}

/** Project settings PUT body that brings the MR settings in line, or undefined when they already are. */
export function mrSettingsPatch(project: Project) {
  const patch: {
    only_allow_merge_if_pipeline_succeeds?: boolean;
    remove_source_branch_after_merge?: boolean;
  } = {};
  if (project.only_allow_merge_if_pipeline_succeeds !== true)
    patch.only_allow_merge_if_pipeline_succeeds = true;
  if (project.remove_source_branch_after_merge !== true) patch.remove_source_branch_after_merge = true;
  return Object.keys(patch).length ? patch : undefined;
}

export function projectChecks(project: Project): Check[] {
  const checks: Check[] = [];
  checks.push(
    project.visibility === 'public'
      ? { status: 'ok', name: 'visibility', detail: 'public' }
      : {
          status: 'fail',
          name: 'visibility',
          detail: `${project.visibility} (the hackathon requires public)`,
          fix: 'Settings → General → Visibility → Public',
        },
  );
  checks.push(
    project.license?.key === 'mit'
      ? { status: 'ok', name: 'license', detail: project.license.name }
      : {
          status: 'fail',
          name: 'license',
          detail: project.license ? `detected ${project.license.name}, not MIT` : 'none detected',
          fix: 'Push the MIT LICENSE file at the repository root to the default branch',
        },
  );
  checks.push(
    mrSettingsPatch(project)
      ? {
          status: 'warn',
          name: 'MR settings',
          detail: '"Pipelines must succeed" or "Delete source branch" is off',
          fix: 'npm run gitlab:setup',
        }
      : {
          status: 'ok',
          name: 'MR settings',
          detail: 'pipelines must succeed, source branch deleted on merge',
        },
  );
  return checks;
}

// ---------- CI/CD variables ----------

export interface VariableRule {
  key: string;
  masked?: boolean;
  /** true: must be protected; false: must not be; undefined: either. */
  protected?: boolean;
  why: string;
}

// RUNBOOK §2. GITLAB_PROBATION_TOKEN must reach MR pipelines on unprotected undertaker/* branches.
export const REQUIRED_VARIABLES: VariableRule[] = [
  {
    key: 'GITLAB_PROBATION_TOKEN',
    masked: true,
    protected: false,
    why: 'project token for every Probation job',
  },
  { key: 'DUO_FLOW_TRIGGER_TOKEN', masked: true, why: 'your personal token that starts the Undertaker flow' },
  { key: 'UNDERTAKER_CONSUMER_ID', why: 'the flow consumer id, RUNBOOK §3' },
  { key: 'GCP_PROJECT_ID', why: 'the Google Cloud project for deploys' },
];
export const WIF_VARIABLES = ['GCP_DEPLOY_SA', 'GCP_WIF_PROVIDER', 'GCP_WIF_AUDIENCE'];
export const SA_KEY_VARIABLE: VariableRule = {
  key: 'GCP_SA_KEY',
  masked: true,
  why: 'service-account key fallback',
};
export const CATALOG_VARIABLES: VariableRule[] = [
  { key: 'CATALOG_SYNC_TOKEN', masked: true, protected: true, why: 'AI Catalog sync on catalog-* tags' },
  { key: 'CATALOG_GROUP_ID', why: 'top-level group for the AI Catalog sync' },
];

const VARS_FIX = 'Settings → CI/CD → Variables (RUNBOOK §2)';

/** Required variables (or groups of them) that are not set, for gitlab:setup to list. */
export function missingVariables(vars: CiVariable[]): string[] {
  const has = (k: string) => vars.some((v) => v.key === k);
  const missing = REQUIRED_VARIABLES.filter((r) => !has(r.key)).map((r) => r.key);
  const wifMissing = WIF_VARIABLES.filter((k) => !has(k));
  if (wifMissing.length && !has(SA_KEY_VARIABLE.key))
    missing.push(`${wifMissing.join(' + ')} (or ${SA_KEY_VARIABLE.key} instead of the WIF trio)`);
  return missing;
}

function ruleCheck(rule: VariableRule, v: CiVariable | undefined, optional = false): Check {
  const name = `variable ${rule.key}`;
  if (!v)
    return optional
      ? { status: 'skip', name, detail: `not set (optional: ${rule.why})` }
      : { status: 'fail', name, detail: `missing (${rule.why})`, fix: VARS_FIX };
  const masked = v.masked || v.hidden === true;
  const problems: string[] = [];
  if (rule.masked && !masked) problems.push('must be masked');
  if (rule.protected === true && !v.protected) problems.push('must be protected');
  if (rule.protected === false && v.protected)
    problems.push('must NOT be protected (MR pipelines on undertaker/* branches need it)');
  if (problems.length)
    return { status: 'fail', name, detail: problems.join('; '), fix: `${VARS_FIX}: edit the flags` };
  const flags = [masked && 'masked', v.protected && 'protected'].filter(Boolean).join(', ');
  return { status: 'ok', name, detail: flags ? `set (${flags})` : 'set' };
}

export function variableChecks(vars: CiVariable[]): Check[] {
  const get = (k: string) => vars.find((v) => v.key === k);
  const checks = REQUIRED_VARIABLES.map((r) => ruleCheck(r, get(r.key)));
  const wif = WIF_VARIABLES.filter((k) => get(k));
  if (wif.length === WIF_VARIABLES.length)
    checks.push({ status: 'ok', name: 'GCP auth', detail: 'Workload Identity Federation variables set' });
  else if (get(SA_KEY_VARIABLE.key)) checks.push(ruleCheck(SA_KEY_VARIABLE, get(SA_KEY_VARIABLE.key)));
  else
    checks.push({
      status: 'fail',
      name: 'GCP auth',
      detail: `missing ${WIF_VARIABLES.filter((k) => !get(k)).join(', ')} (or GCP_SA_KEY)`,
      fix: 'Run infra/gcp-bootstrap.sh and copy its output into Settings → CI/CD → Variables (RUNBOOK §2.1)',
    });
  const catalog = CATALOG_VARIABLES.map((r) => ruleCheck(r, get(r.key), true));
  const setCount = CATALOG_VARIABLES.filter((r) => get(r.key)).length;
  if (setCount === 1)
    catalog.push({
      status: 'warn',
      name: 'AI Catalog sync',
      detail: 'only one of CATALOG_SYNC_TOKEN / CATALOG_GROUP_ID is set',
      fix: 'Set both or neither (RUNBOOK §8.1)',
    });
  return [...checks, ...catalog];
}

export function protectedTagCheck(exists: boolean, vars: CiVariable[]): Check {
  const name = `protected tag ${CATALOG_TAG}`;
  if (exists) return { status: 'ok', name, detail: 'Maintainers only' };
  const syncs = vars.some((v) => v.key === 'CATALOG_SYNC_TOKEN');
  return {
    status: syncs ? 'fail' : 'warn',
    name,
    detail: syncs ? 'missing, so the protected CATALOG_SYNC_TOKEN never reaches tag pipelines' : 'missing',
    fix: 'npm run gitlab:setup',
  };
}

// ---------- Tokens ----------

const DAY = 86_400_000;

/** A token's self-information. `role` names which token for the message. */
export function tokenCheck(
  name: string,
  info: TokenInfo | undefined,
  error: string | undefined,
  now: Date,
): Check {
  if (!info)
    return {
      status: 'fail',
      name,
      detail: `rejected (${error ?? 'unknown error'})`,
      fix: 'Create a new token with scope api (it may be expired or revoked)',
    };
  if (!info.active || info.revoked)
    return { status: 'fail', name, detail: 'inactive or revoked', fix: 'Create a new token with scope api' };
  if (!info.scopes.includes('api'))
    return {
      status: 'fail',
      name,
      detail: `scopes ${info.scopes.join(', ') || 'none'}, needs api`,
      fix: 'Create a new token with scope api',
    };
  const days = info.expires_at
    ? (new Date(info.expires_at).getTime() - now.getTime()) / DAY
    : Number.POSITIVE_INFINITY;
  if (days < 2)
    return {
      status: 'warn',
      name,
      detail: `"${info.name}" expires ${info.expires_at}`,
      fix: 'Rotate it before the demo runs',
    };
  return { status: 'ok', name, detail: `"${info.name}", scopes ${info.scopes.join(', ')}` };
}

// ---------- Undertaker flow consumer ----------

export const CONSUMERS_QUERY = `query($projectId: ProjectID!) {
  aiCatalogConfiguredItems(projectId: $projectId, itemTypes: [FLOW]) {
    nodes { id enabled item { name itemType } }
  }
}`;

export interface ConsumerNode {
  id: string;
  enabled: boolean | null;
  item: { name: string; itemType: string } | null;
}

/** "gid://gitlab/Ai::Catalog::ItemConsumer/4211" or "4211" → 4211. */
export const consumerNumber = (id: string) => Number(/(\d+)\s*$/.exec(id)?.[1] ?? Number.NaN);

/**
 * value: UNDERTAKER_CONSUMER_ID as read from the CI variable; undefined when unset, null when hidden.
 * The consumer id is not a secret, so it may appear in the output.
 */
export function consumerCheck(nodes: ConsumerNode[], value: string | null | undefined): Check {
  const name = 'Undertaker flow';
  const enabledFlows = nodes.filter((n) => n.enabled !== false);
  const undertaker = enabledFlows.filter((n) => /undertaker/i.test(n.item?.name ?? ''));
  const ids = undertaker.map((n) => consumerNumber(n.id));
  if (!undertaker.length)
    return {
      status: 'fail',
      name,
      detail: enabledFlows.length
        ? `no enabled flow named Undertaker (found ${enabledFlows.map((n) => n.item?.name).join(', ')})`
        : 'not enabled on this project',
      fix: 'Create and enable the flow (RUNBOOK §3), or push a catalog-* tag (§8.1)',
    };
  if (value === undefined)
    return {
      status: 'fail',
      name,
      detail: 'UNDERTAKER_CONSUMER_ID is not set',
      fix: `Set UNDERTAKER_CONSUMER_ID to ${ids[0]}`,
    };
  if (value === null)
    return {
      status: 'warn',
      name,
      detail: `enabled as consumer ${ids.join(', ')}; the variable is hidden, so not compared`,
    };
  const n = consumerNumber(value);
  if (!ids.includes(n))
    return {
      status: 'fail',
      name,
      detail: `UNDERTAKER_CONSUMER_ID is ${Number.isNaN(n) ? 'not a number' : n}, but the enabled Undertaker consumer is ${ids.join(' or ')}`,
      fix: `Set UNDERTAKER_CONSUMER_ID to ${ids[0]}`,
    };
  return { status: 'ok', name, detail: `enabled, consumer ${n} matches UNDERTAKER_CONSUMER_ID` };
}

// ---------- Errors ----------

/** A one-line fix for a failed GitLab call, from its status code. */
export function fixForError(error: unknown): string {
  const text = String(error);
  if (text.includes('→ 401'))
    return 'GITLAB_TOKEN is invalid or expired: create a personal access token with scope api';
  if (text.includes('→ 403'))
    return 'GITLAB_TOKEN needs scope api and the Maintainer (or Owner) role on the project';
  if (text.includes('→ 404'))
    return 'Check GITLAB_PROJECT (group/sub/project or numeric id) and that the token can see it';
  return 'Retry; if it persists, do this step by hand (RUNBOOK §1–§2)';
}

export const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 200);
