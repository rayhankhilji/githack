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
      needs: ['rollback:production', 'soak:canary'],
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
