// start-flow — scheduled job. Picks the next candidate grave and starts the Undertaker flow through the Flows API.
import { goalFor, pickCandidate } from '../dig.ts';
import { label } from '../gate.ts';
import { loadPolicy } from '../policy.ts';
import { env, gitlab, hasFlag, ledgerStore, main } from './common.ts';

main(async () => {
  const policy = loadPolicy();
  const gl = gitlab();
  const ledger = await ledgerStore().load();
  const open = await gl.listIssues('labels=undertaker::candidate&state=opened&per_page=100');
  const next = pickCandidate(open, ledger, policy);
  if (!next) {
    console.log('No candidate graves to dig. Undertaker rests.');
    return;
  }
  const goal = goalFor(next);
  if (hasFlag('dry-run')) {
    console.log(goal);
    return;
  }
  // Numeric suffix of the AiCatalogItemConsumer GID (RUNBOOK §3 step 4). A full GID is accepted too.
  const consumerId = Number(
    String(env.UNDERTAKER_CONSUMER_ID ?? '').replace(/^gid:\/\/gitlab\/[\w:]+\//, ''),
  );
  const userToken = env.DUO_FLOW_TRIGGER_TOKEN;
  if (!Number.isInteger(consumerId) || consumerId <= 0 || !userToken)
    throw new Error('UNDERTAKER_CONSUMER_ID (numeric) and DUO_FLOW_TRIGGER_TOKEN are required');
  // issue_id is the issue IID: the API resolves it with project.issues by iid (ee/lib/api/ai/duo_workflows/workflows.rb).
  const flow = await gl.startFlow(
    { goal, ai_catalog_item_consumer_id: consumerId, start_workflow: true, issue_id: next.issue.iid },
    userToken,
  );
  await gl.updateIssue(next.issue.iid, { add_labels: 'undertaker::in-progress' });
  const link = flow.web_url ? ` ([session](${flow.web_url}))` : '';
  await gl.noteIssue(
    next.issue.iid,
    `⚰️ Undertaker flow #${flow.id} started${link} (level: **${label(next.level)}**).`,
  );
  console.log(
    `started flow ${flow.id} for #${next.issue.iid}${flow.workload?.message ? `: ${flow.workload.message}` : ''}`,
  );
});
