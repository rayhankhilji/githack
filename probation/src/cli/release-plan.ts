// release-plan — runs on main after a merge. Generates the child pipeline that releases this commit,
// shaped by the autonomy level the Probation gate granted to the MR.
import { stringify } from 'yaml';
import { isUndertaker } from '../mr.ts';
import type { Level } from '../policy.ts';
import { loadPolicy } from '../policy.ts';
import { env, gitlab, main, writeOut } from './common.ts';

export interface ReleaseContext {
  mrIid?: number;
  agent?: string;
  level: Level | 'human';
  zones: string[];
}

const deployImage = 'google/cloud-sdk:slim';
const nodeImage = 'node:22-bookworm-slim';

export function releasePipeline(ctx: ReleaseContext, soakMinutes: number, canaryPercent: number) {
  const vars = {
    RELEASE_MR_IID: String(ctx.mrIid ?? ''),
    RELEASE_AGENT: ctx.agent ?? '',
    RELEASE_LEVEL: ctx.level,
    RELEASE_ZONES: ctx.zones.join(','),
    SOAK_MINUTES: String(soakMinutes),
    CANARY_PERCENT: String(canaryPercent),
  };
  const gcp = {
    image: deployImage,
    id_tokens: { GCP_ID_TOKEN: { aud: '$GCP_WIF_AUDIENCE' } },
    before_script: ['source ci/gcp-auth.sh'],
  };
  const node = {
    image: nodeImage,
    before_script: ['npm ci --no-audit --no-fund', 'npm ci --prefix app --no-audit --no-fund'],
  };
  // Humans own their own changes (normal MR approval rules apply). Only the agent's MRs are on probation.
  const autoProd = ctx.level === 'hands_off' || ctx.level === 'human';
  const isAgent = Boolean(ctx.agent);

  const jobs: Record<string, unknown> = {
    stages: ['staging', 'approve', 'canary', 'soak', 'promote', 'settle'],
    variables: vars,
    'deploy:staging': {
      ...gcp,
      stage: 'staging',
      environment: { name: 'staging', url: '$STAGING_URL' },
      script: ['bash ci/deploy.sh staging'],
      artifacts: { reports: { dotenv: 'deploy.env' } },
    },
    'approve:production': {
      stage: 'approve',
      image: 'alpine:3.20',
      // Supervised (and human) changes stop here until someone clicks play. Hands-off changes skip it.
      when: autoProd ? 'on_success' : 'manual',
      allow_failure: false,
      script: [
        autoProd
          ? 'echo "Hands-off: Undertaker earned automatic promotion in every touched zone."'
          : 'echo "Approved by $GITLAB_USER_LOGIN"',
      ],
    },
    'deploy:canary': {
      ...gcp,
      stage: 'canary',
      environment: { name: 'production', url: '$PRODUCTION_URL' },
      script: ['bash ci/deploy.sh canary'],
    },
    'soak:canary': {
      ...node,
      stage: 'soak',
      needs: ['deploy:staging', 'deploy:canary'],
      script: ['node probation/src/cli/soak.ts --url "$CANARY_URL" --minutes "$SOAK_MINUTES"'],
      artifacts: { when: 'always', paths: ['.out/'] },
    },
    // Cloud Logging's view of the canary: census lines for the new revision, and for the previous one over the
    // same window as a baseline (both serve the same clients during the split). Waits out the soak plus a minute
    // of log ingestion. allow_failure: a logging outage leaves the synthetics in charge, it is not a rollback.
    'soak:canary-logs': {
      ...gcp,
      stage: 'soak',
      needs: ['deploy:staging', 'deploy:canary'],
      allow_failure: true,
      script: [
        'mkdir -p .out',
        'SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
        'echo "Collecting census lines for $REVISION (baseline $PREVIOUS_REVISION) over the next $SOAK_MINUTES min"',
        'sleep $(( SOAK_MINUTES * 60 + 60 ))',
        'read_census() { gcloud logging read "resource.type=\\"cloud_run_revision\\" AND resource.labels.revision_name=\\"$1\\" AND jsonPayload.census=1 AND timestamp>=\\"$SINCE\\"" --freshness="$(( SOAK_MINUTES + 10 ))m" --limit=50000 --format=json; }',
        'read_census "$REVISION" > .out/canary-log.json',
        'if [ "$PREVIOUS_REVISION" != "$REVISION" ]; then read_census "$PREVIOUS_REVISION" > .out/baseline-log.json; else echo "[]" > .out/baseline-log.json; fi',
        'echo "$(grep -c \'"census"\' .out/canary-log.json || true) canary lines, $(grep -c \'"census"\' .out/baseline-log.json || true) baseline lines"',
      ],
      artifacts: { when: 'always', paths: ['.out/canary-log.json', '.out/baseline-log.json'] },
    },
    // Judges the canary's real traffic (5xx rate, hits on deleted routes). A failure fails the soak stage, so
    // promote is skipped and rollback:production runs. Exit 3 (no logs) is a warning, never a rollback.
    'soak:canary-signal': {
      ...node,
      stage: 'soak',
      needs: ['deploy:staging', 'soak:canary-logs'],
      allow_failure: { exit_codes: [3] },
      script: [
        'node probation/src/cli/soak.ts --signal .out/canary-log.json --baseline .out/baseline-log.json',
      ],
      artifacts: { when: 'always', paths: ['.out/soak-signal.json'] },
    },
    'promote:production': {
      ...gcp,
      stage: 'promote',
      environment: { name: 'production', url: '$PRODUCTION_URL' },
      script: ['bash ci/deploy.sh promote'],
    },
    // Runs when any earlier stage failed (staging, canary or soak). If deploy:staging failed, its dotenv
    // never uploaded and no traffic moved, so there is nothing to roll back.
    'rollback:production': {
      ...gcp,
      stage: 'promote',
      when: 'on_failure',
      environment: { name: 'production', url: '$PRODUCTION_URL' },
      script: [
        'if [ -z "$(printenv PREVIOUS_REVISION)" ]; then echo "deploy:staging moved no traffic; nothing to roll back"; exit 0; fi',
        'bash ci/deploy.sh rollback',
      ],
    },
  };
  if (isAgent) {
    jobs['settle:survived'] = {
      ...node,
      stage: 'settle',
      // Ledger writes are read-modify-write; one writer at a time across all pipelines.
      resource_group: 'ledger',
      needs: ['promote:production', { pipeline: '$PARENT_PIPELINE_ID', job: 'measure:sci' }],
      script: ['node probation/src/cli/settle.ts --outcome survived'],
    };
    jobs['settle:rolled-back'] = {
      ...node,
      stage: 'settle',
      resource_group: 'ledger',
      // Scores only a failed soak (synthetics or canary signal), never a failed staging deploy or log read.
      needs: ['rollback:production', 'soak:canary', 'soak:canary-signal'],
      when: 'on_failure',
      script: ['node probation/src/cli/settle.ts --outcome rolled_back'],
    };
  }
  return jobs;
}

main(async () => {
  const policy = loadPolicy();
  const [agentName, agent] = Object.entries(policy.agents)[0];
  const ctx: ReleaseContext = { level: 'human', zones: [] };
  if (env.GITLAB_PROBATION_TOKEN && env.CI_COMMIT_SHA) {
    const mrs = await gitlab().mrsForCommit(env.CI_COMMIT_SHA);
    const mr = mrs.find((m) => m.state === 'merged');
    if (mr && isUndertaker(mr, agent)) {
      const level = mr.labels.find((l) => l.startsWith('probation::'))?.slice(11) as Level | undefined;
      ctx.mrIid = mr.iid;
      ctx.agent = agentName;
      ctx.level = level ?? 'assisted';
      ctx.zones =
        mr.labels
          .find((l) => l.startsWith('zone::'))
          ?.slice(6)
          .split('+') ?? [];
    }
  }
  writeOut(
    '.out/release.yml',
    // No YAML anchors and no line folding, so the child pipeline reads plainly in the GitLab UI.
    stringify(releasePipeline(ctx, policy.soak.minutes, policy.soak.canary_percent), {
      aliasDuplicateObjects: false,
      lineWidth: 0,
    }),
  );
  console.log(
    `release plan: level=${ctx.level}${ctx.mrIid ? ` mr=!${ctx.mrIid} zones=${ctx.zones.join('+')}` : ''}`,
  );
});
