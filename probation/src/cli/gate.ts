// probation:gate — runs last in every MR pipeline. Decides how far an Undertaker MR may go on its own.
import { readdirSync } from 'node:fs';
import { decide } from '../gate.ts';
import type { MrDiff } from '../gitlab.ts';
import { applyEvent } from '../ledger.ts';
import { diffStats, gateComment, isUndertaker } from '../mr.ts';
import { loadPolicy } from '../policy.ts';
import { diffFindings, readReports } from '../security.ts';
import { env, gitlab, ledgerStore, main, writeOut } from './common.ts';

main(async () => {
  const policy = loadPolicy();
  const [agentName, agent] = Object.entries(policy.agents)[0];
  const gl = gitlab();
  const iid = Number(env.CI_MERGE_REQUEST_IID);
  if (!iid) throw new Error('probation:gate must run in a merge request pipeline');
  const mr = await gl.getMr(iid);
  if (!isUndertaker(mr, agent)) {
    console.log(`MR !${iid} is not from ${agentName}; probation does not apply.`);
    return;
  }

  const diffs: MrDiff[] = await gl.mrDiffs(iid);
  const files = diffStats(diffs);
  const store = ledgerStore();
  let ledger = await store.load();
  const reports = readdirSync('.').filter((f) => /^gl-.*-report\.json$/.test(f));
  const findings = diffFindings(ledger.security?.fingerprints, readReports(reports));

  const decision = decide(policy, ledger, {
    agent: agentName,
    files,
    introducedFindings: ledger.security ? findings.introduced : [],
    checksPassed: true,
    coronerObjection: mr.labels.includes('coroner::objection')
      ? 'see the coroner note on this MR'
      : undefined,
  });
  writeOut('.out/gate.json', JSON.stringify({ mr: iid, ...decision }, null, 2));
  await gl.noteMr(iid, gateComment(decision, ledger.security ? findings.removed.length : 0));
  await gl.updateMr(iid, {
    add_labels: `probation::${decision.level},zone::${decision.zones.map((z) => z.zone).join('+') || 'none'}`,
    remove_labels: ['assisted', 'supervised', 'hands_off']
      .filter((l) => l !== decision.level)
      .map((l) => `probation::${l}`)
      .join(','),
  });

  if (decision.verdict === 'block') {
    const alreadyScored = ledger.events.some((e) => e.event === 'security_finding' && e.ref.mr === iid);
    if (ledger.security && findings.introduced.length && !alreadyScored) {
      const scored = applyEvent(ledger, policy, {
        agent: agentName,
        zones: decision.zones.map((z) => z.zone),
        event: 'security_finding',
        ref: { mr: iid, url: mr.web_url },
      });
      ledger = scored.ledger;
      await store.save(ledger, scored.written, `probation: security finding on !${iid}`);
    }
    throw new Error(`blocked: ${decision.reasons.join('; ')}`);
  }
  if (decision.verdict === 'needs_human') return;

  if (mr.draft) await gl.updateMr(iid, { title: mr.title.replace(/^(Draft:|\[Draft\]|\(Draft\))\s*/i, '') });
  // In merged-results pipelines CI_COMMIT_SHA is the merge ref, not the source HEAD the merge API checks.
  await gl.mergeMr(iid, env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA || env.CI_COMMIT_SHA || '');
  console.log(`MR !${iid}: ${decision.verdict}, auto-merge set.`);
});
