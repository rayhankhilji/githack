// gitlab-setup — creates the GitLab project setup Probation needs, idempotently: labels, the census
// schedule, the catalog-* protected tag and MR settings. Reads (never writes or prints) CI/CD variables.
// Usage: GITLAB_TOKEN=… GITLAB_PROJECT=group/sub/project npm run gitlab:setup
import { fileURLToPath } from 'node:url';
import { main } from '../probation/src/cli/common.ts';
import { GitLab } from '../probation/src/gitlab.ts';
import { loadPolicy } from '../probation/src/policy.ts';
import {
  CATALOG_TAG,
  type Check,
  errorMessage,
  findSchedule,
  fixForError,
  formatCheck,
  labelCatalogue,
  MAINTAINER,
  missingVariables,
  mrSettingsPatch,
  planLabels,
  SCHEDULE_DESCRIPTION,
  setupConfigFromEnv,
} from '../probation/src/setup.ts';

const POLICY = fileURLToPath(new URL('../probation/policy.yml', import.meta.url));

main(async () => {
  const config = setupConfigFromEnv(process.env);
  const gl = new GitLab(config.gitlab);
  let failures = 0;
  const report = (c: Check) => {
    if (c.status === 'fail') failures++;
    console.log(formatCheck(c));
  };
  // Each step reports its own failure and the next one still runs.
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      report({ status: 'fail', name, detail: errorMessage(error), fix: fixForError(error) });
    }
  };

  let project: Awaited<ReturnType<GitLab['getProject']>>;
  try {
    project = await gl.getProject();
  } catch (error) {
    throw new Error(
      `cannot read project ${config.gitlab.projectId}: ${errorMessage(error)}\n  → ${fixForError(error)}`,
    );
  }
  console.log(
    `GitLab project ${project.path_with_namespace} (id ${project.id}, default branch ${project.default_branch})\n`,
  );

  await step('labels', async () => {
    const plan = planLabels(labelCatalogue(loadPolicy(POLICY)), await gl.listLabels());
    for (const { spec, action } of plan) {
      const name = `label ${spec.name}`;
      try {
        if (action === 'create') await gl.createLabel(spec);
        if (action === 'update')
          await gl.updateLabel(spec.name, { color: spec.color, description: spec.description });
        const detail = {
          create: 'created',
          update: 'updated color/description',
          exists: 'exists',
          inherited: 'exists (group label)',
        }[action];
        report({ status: 'ok', name, detail });
      } catch (error) {
        report({ status: 'fail', name, detail: errorMessage(error), fix: fixForError(error) });
      }
    }
  });

  await step('pipeline schedule', async () => {
    const name = 'pipeline schedule';
    let schedule = findSchedule(await gl.listPipelineSchedules());
    if (!schedule) {
      schedule = await gl.createPipelineSchedule({
        description: SCHEDULE_DESCRIPTION,
        ref: project.default_branch,
        cron: config.cron,
        cron_timezone: 'UTC',
      });
      await gl.createPipelineScheduleVariable(schedule.id, {
        key: 'CENSUS_FRESHNESS',
        value: config.freshness,
      });
      report({
        status: 'ok',
        name,
        detail: `created "${SCHEDULE_DESCRIPTION}" (${config.cron} UTC on ${project.default_branch}, CENSUS_FRESHNESS=${config.freshness})`,
      });
      return;
    }
    // Keep the human's cron and CENSUS_FRESHNESS (the demo sets 6h); only add the variable if it is missing.
    const full = await gl.getPipelineSchedule(schedule.id);
    if (!full.variables?.some((v) => v.key === 'CENSUS_FRESHNESS')) {
      await gl.createPipelineScheduleVariable(schedule.id, {
        key: 'CENSUS_FRESHNESS',
        value: config.freshness,
      });
      report({
        status: 'ok',
        name,
        detail: `exists (${schedule.cron}); added CENSUS_FRESHNESS=${config.freshness}`,
      });
    } else
      report({
        status: 'ok',
        name,
        detail: `exists (${schedule.cron} on ${schedule.ref.replace(/^refs\/heads\//, '')})`,
      });
  });

  await step(`protected tag ${CATALOG_TAG}`, async () => {
    const name = `protected tag ${CATALOG_TAG}`;
    if (await gl.getProtectedTag(CATALOG_TAG)) return report({ status: 'ok', name, detail: 'exists' });
    await gl.protectTag(CATALOG_TAG, MAINTAINER);
    report({ status: 'ok', name, detail: 'created (Maintainers may create)' });
  });

  await step('MR settings', async () => {
    const patch = mrSettingsPatch(project);
    if (patch) await gl.updateProject(patch);
    report({
      status: 'ok',
      name: 'MR settings',
      detail: `${patch ? 'updated' : 'exists'}: pipelines must succeed, delete source branch on merge (auto-merge needs no setting)`,
    });
  });

  await step('CI/CD variables', async () => {
    const missing = missingVariables(await gl.listVariables());
    if (!missing.length)
      return report({ status: 'ok', name: 'CI/CD variables', detail: 'all required variables are set' });
    for (const key of missing)
      report({
        status: 'warn',
        name: `variable ${key}`,
        detail: 'missing (set its value yourself; setup never writes variables)',
        fix: 'Settings → CI/CD → Variables (RUNBOOK §2)',
      });
  });

  console.log(
    failures
      ? `\n${failures} step(s) failed. Fix them and run again; it is safe to re-run.`
      : '\nDone. Next: set any missing variables, enable the flow (RUNBOOK §3), then run `npm run doctor`.',
  );
  if (failures) process.exitCode = 1;
});
