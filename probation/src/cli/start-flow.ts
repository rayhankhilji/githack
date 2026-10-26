// start-flow — scheduled job. Picks the next candidate grave and starts the Undertaker flow through the Flows API.
import { label } from '../gate.ts';
import { levelOf } from '../ledger.ts';
import { loadPolicy } from '../policy.ts';
import { env, gitlab, hasFlag, ledgerStore, main } from './common.ts';

const KIND_ORDER = ['dependency', 'export', 'flag', 'route'];

main(async () => {
  const policy = loadPolicy();
  const agent = Object.keys(policy.agents)[0];
  const gl = gitlab();
  const ledger = await ledgerStore().load();
  const forbidden = new Set(policy.zones.filter((z) => z.forbidden).map((z) => z.name));
  const open = await gl.listIssues('labels=undertaker::candidate&state=opened&per_page=100');
  const ready = open
    .filter((i) => !i.labels.some((l) => l === 'undertaker::in-progress' || l === 'undertaker::do-not-bury'))
    .map((i) => ({
      issue: i,
      zone: i.labels.find((l) => l.startsWith('zone::'))?.slice(6) ?? 'unzoned',
      kind: i.labels.find((l) => l.startsWith('kind::'))?.slice(6) ?? 'route',
    }))
    .filter((c) => !forbidden.has(c.zone) && c.zone !== 'unzoned')
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const next = ready[0];
  if (!next) {
    console.log('No candidate graves to dig. Undertaker rests.');
    return;
  }
  const level = levelOf(ledger, policy, agent, next.zone);
  const goal = [
    `Bury the dead code described in issue #${next.issue.iid}: ${next.issue.web_url}`,
    `Zone: ${next.zone}. Your current probation level in this zone: ${label(level)}.`,
    'Only delete. Do not add features. Touch only files in this zone plus tests that cover the deleted code.',
  ].join('\n');
  if (hasFlag('dry-run')) {
    console.log(goal);
    return;
  }
  const consumerId = Number(env.UNDERTAKER_CONSUMER_ID);
  const userToken = env.DUO_FLOW_TRIGGER_TOKEN;
  if (!consumerId || !userToken)
    throw new Error('UNDERTAKER_CONSUMER_ID and DUO_FLOW_TRIGGER_TOKEN are required');
  const flow = await gl.startFlow(
    { goal, ai_catalog_item_consumer_id: consumerId, start_workflow: true, issue_id: next.issue.iid },
    userToken,
  );
  await gl.updateIssue(next.issue.iid, { add_labels: 'undertaker::in-progress' });
  await gl.noteIssue(next.issue.iid, `⚰️ Undertaker flow #${flow.id} started (level: **${label(level)}**).`);
  console.log(`started flow ${flow.id} for #${next.issue.iid}`);
});
