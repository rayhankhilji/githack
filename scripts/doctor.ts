// doctor — read-only preflight of the GitLab project (and optionally the live app) before spending credits.
// Prints ✅/⚠️/❌ with a one-line fix each and exits 1 on any ❌. Never prints a variable's value.
// Usage: GITLAB_TOKEN=… GITLAB_PROJECT=group/sub/project [TALLYBOOK_URL=https://…] npm run doctor
import { fileURLToPath } from 'node:url';
import { main } from '../probation/src/cli/common.ts';
import { type CiVariable, GitLab, type TokenInfo } from '../probation/src/gitlab.ts';
import { loadPolicy } from '../probation/src/policy.ts';
import {
  CATALOG_TAG,
  type Check,
  CONSUMERS_QUERY,
  type ConsumerNode,
  consumerCheck,
  errorMessage,
  failed,
  findSchedule,
  fixForError,
  formatCheck,
  labelCatalogue,
  labelsCheck,
  projectChecks,
  protectedTagCheck,
  scheduleCheck,
  setupConfigFromEnv,
  tokenCheck,
  variableChecks,
} from '../probation/src/setup.ts';
import { LEDGER_BRANCH } from '../probation/src/store.ts';

const POLICY = fileURLToPath(new URL('../probation/policy.yml', import.meta.url));

async function selfInfo(gl: GitLab, token?: string): Promise<[TokenInfo | undefined, string | undefined]> {
  try {
    return [await gl.tokenSelf(token), undefined];
  } catch (error) {
    return [undefined, errorMessage(error).replace(/:.*$/, '')];
  }
}

main(async () => {
  const config = setupConfigFromEnv(process.env);
  const gl = new GitLab(config.gitlab);
  const now = new Date();
  const checks: Check[] = [];
  const add = (c: Check) => {
    checks.push(c);
    console.log(formatCheck(c));
  };
  // A check that throws becomes a ❌ with a fix, so one broken endpoint never hides the rest.
  const guard = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      add({ status: 'fail', name, detail: errorMessage(error), fix: fixForError(error) });
    }
  };

  const [me, meError] = await selfInfo(gl);
  add(tokenCheck('GITLAB_TOKEN', me, meError, now));
  if (!me) {
    process.exitCode = 1;
    return;
  }

  let project: Awaited<ReturnType<GitLab['getProject']>>;
  try {
    project = await gl.getProject(true);
  } catch (error) {
    add({ status: 'fail', name: 'project', detail: errorMessage(error), fix: fixForError(error) });
    process.exitCode = 1;
    return;
  }
  add({ status: 'ok', name: 'project', detail: `${project.path_with_namespace} (id ${project.id})` });
  for (const c of projectChecks(project)) add(c);

  let vars: CiVariable[] = [];
  await guard('CI/CD variables', async () => {
    vars = await gl.listVariables();
    for (const c of variableChecks(vars)) add(c);
  });
  const value = (key: string) => {
    const v = vars.find((x) => x.key === key);
    return v ? v.value : undefined;
  };

  // The CI tokens themselves: valid, scope api, not about to expire. Values are only sent to GitLab.
  for (const key of ['GITLAB_PROBATION_TOKEN', 'DUO_FLOW_TRIGGER_TOKEN']) {
    const token = value(key);
    if (token) add(tokenCheck(`${key} (value)`, ...(await selfInfo(gl, token)), now));
  }

  await guard('labels', async () =>
    add(labelsCheck(labelCatalogue(loadPolicy(POLICY)), await gl.listLabels())),
  );

  await guard('pipeline schedule', async () => {
    const schedule = findSchedule(await gl.listPipelineSchedules());
    add(scheduleCheck(schedule, project.default_branch));
  });

  await guard(`protected tag ${CATALOG_TAG}`, async () =>
    add(protectedTagCheck(Boolean(await gl.getProtectedTag(CATALOG_TAG)), vars)),
  );

  await guard(`${LEDGER_BRANCH} branch`, async () =>
    add(
      (await gl.branchExists(LEDGER_BRANCH))
        ? { status: 'ok', name: `${LEDGER_BRANCH} branch`, detail: 'exists' }
        : {
            status: 'warn',
            name: `${LEDGER_BRANCH} branch`,
            detail: 'missing (the first census or settle job creates it)',
            fix: 'Run the pipeline schedule once (RUNBOOK §5)',
          },
    ),
  );

  try {
    const data = await gl.graphql<{ aiCatalogConfiguredItems: { nodes: ConsumerNode[] } }>(CONSUMERS_QUERY, {
      projectId: `gid://gitlab/Project/${project.id}`,
    });
    add(consumerCheck(data.aiCatalogConfiguredItems.nodes, value('UNDERTAKER_CONSUMER_ID')));
  } catch (error) {
    add({
      status: 'warn',
      name: 'Undertaker flow',
      detail: `could not query the AI Catalog (${errorMessage(error)})`,
      fix: 'Check it by hand with the GraphQL query in RUNBOOK §3.4',
    });
  }

  await guard('Pages', async () => {
    const pages = await gl.getPages();
    add(
      pages
        ? { status: 'ok', name: 'Pages', detail: pages.url }
        : {
            status: 'warn',
            name: 'Pages',
            detail: 'not deployed yet',
            fix: 'The pages job deploys it on the first main pipeline',
          },
    );
  });

  const app = process.env.TALLYBOOK_URL;
  if (!app) add({ status: 'skip', name: 'Tallybook', detail: 'TALLYBOOK_URL not set' });
  else {
    const url = `${app.replace(/\/$/, '')}/healthz`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      add(
        res.ok
          ? { status: 'ok', name: 'Tallybook', detail: `${url} → ${res.status}` }
          : {
              status: 'fail',
              name: 'Tallybook',
              detail: `${url} → ${res.status}`,
              fix: 'Check the deploy:staging log (RUNBOOK §4)',
            },
      );
    } catch (error) {
      add({
        status: 'fail',
        name: 'Tallybook',
        detail: `${url}: ${errorMessage(error)}`,
        fix: 'Check the URL and the Cloud Run service',
      });
    }
  }

  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  console.log(`\n${fails} failing, ${warns} warning${warns === 1 ? '' : 's'}, ${checks.length} checks.`);
  if (failed(checks)) process.exitCode = 1;
});
