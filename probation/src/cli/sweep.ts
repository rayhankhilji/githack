// sweep — scheduled: score human_rejected once for every Undertaker MR closed without merge, then return
// in-progress graves with no MR after census.stale_hours to the candidate pool.

import { label } from '../gate.ts';
import type { GitLab } from '../gitlab.ts';
import { applyEvent, type Ledger, type LedgerEvent, levelChanges } from '../ledger.ts';
import { candidateIssue, diffStats, isUndertaker } from '../mr.ts';
import { loadPolicy, type Policy } from '../policy.ts';
import {
  IN_PROGRESS,
  rejectionNote,
  rejectionsToScore,
  staleHours,
  staleInProgress,
  staleNote,
  zonesFromLabels,
  zonesFromPaths,
} from '../sweep.ts';
import { env, gitlab, ledgerStore, main } from './common.ts';

main(async () => {
  const policy = loadPolicy();
  const gl = gitlab();
  // Rejections first: a human-closed MR marks its issue do-not-bury, which must win over a stale reset.
  await sweepRejections(policy, gl);
  await sweepStale(policy, gl);
});

async function sweepStale(policy: Policy, gl: GitLab) {
  const [, agent] = Object.entries(policy.agents)[0];
  const hours = staleHours(policy, env.STALE_HOURS);
  const issues = await gl.listIssues(`labels=${IN_PROGRESS}&state=opened&per_page=100`);
  if (issues.length === 0) return;
  const query = (state: string) => `state=${state}&labels=${encodeURIComponent(agent.label)}&per_page=100`;
  const mrs = [...(await gl.listMrs(query('opened'))), ...(await gl.listMrs(query('merged')))].filter((mr) =>
    isUndertaker(mr, agent),
  );
  const stale = staleInProgress(issues, mrs, new Date(), hours);
  for (const issue of stale) {
    // Scoped label: candidate replaces in-progress.
    await gl.updateIssue(issue.iid, { add_labels: 'undertaker::candidate' });
    await gl.noteIssue(issue.iid, staleNote(hours));
    console.log(`#${issue.iid}: in progress for over ${hours} h with no MR, returned to candidates`);
  }
  if (stale.length === 0) console.log(`no stale in-progress graves (${issues.length} in progress)`);
}

async function sweepRejections(policy: Policy, gl: GitLab) {
  const [agentName, agent] = Object.entries(policy.agents)[0];
  const store = ledgerStore();
  const before: Ledger = await store.load();
  const closed = await gl.listMrs(`state=closed&labels=${encodeURIComponent(agent.label)}&per_page=100`);
  const pending = rejectionsToScore(closed, before, agent);
  if (pending.length === 0) {
    console.log('no unscored rejections');
    return;
  }

  let ledger = before;
  const written: LedgerEvent[] = [];
  const scored: { iid: number; zones: string[]; events: LedgerEvent[]; issue?: number }[] = [];
  for (const mr of pending) {
    const zones =
      zonesFromLabels(mr.labels) ??
      zonesFromPaths(
        policy,
        diffStats(await gl.mrDiffs(mr.iid)).map((f) => f.path),
      );
    if (zones.length === 0) {
      console.log(`!${mr.iid}: no scorable zones, skipped`);
      continue;
    }
    const result = applyEvent(ledger, policy, {
      agent: agentName,
      zones,
      event: 'human_rejected',
      ref: { mr: mr.iid, pipeline: Number(env.CI_PIPELINE_ID) || undefined, url: mr.web_url },
      note: 'closed without merge',
    });
    ledger = result.ledger;
    written.push(...result.written);
    scored.push({ iid: mr.iid, zones, events: result.written, issue: candidateIssue(mr.description ?? '') });
  }
  if (written.length === 0) return;
  // Save before any notes, so a failed note never leads to double-scoring on the next run.
  await store.save(
    ledger,
    written,
    `probation: human_rejected for ${scored.map((s) => `!${s.iid}`).join(', ')}`,
  );

  for (const e of written)
    console.log(`!${e.ref.mr} ${e.zone}: ${e.points} → ${e.scoreAfter} (${label(e.levelAfter)})`);
  for (const s of scored) {
    await gl.noteMr(s.iid, rejectionNote(s.zones, policy.scoring.human_rejected));
    // A human said no to this grave: release it from in-progress so it is neither stuck nor dug again.
    if (s.issue) {
      await gl.updateIssue(s.issue, { add_labels: 'undertaker::do-not-bury' });
      await gl.noteIssue(s.issue, `⚖️ A human closed !${s.iid} without merging. Marked do-not-bury.`);
    }
  }
  for (const change of levelChanges(written)) {
    await gl.createIssue({
      title: `⬇️ Demotion: ${agentName} is now ${label(change.levelAfter)} in zone ${change.zone}`,
      description: [
        `${agentName} moved from **${label(change.levelBefore)}** to **${label(change.levelAfter)}** in zone \`${change.zone}\` after a human closed !${change.ref.mr} without merging.`,
        '',
        `Score: ${change.scoreAfter}. Thresholds: Supervised ≥ ${policy.levels.supervised}, Hands-off ≥ ${policy.levels.hands_off} (probation/policy.yml).`,
        '',
        'Recorded in the `ledger` branch (audit.jsonl). No action needed; close when read.',
      ].join('\n'),
      labels: `probation::demotion,zone::${change.zone}`,
    });
  }
}
