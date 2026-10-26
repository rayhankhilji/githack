// sweep — scheduled: score human_rejected once for every Undertaker MR closed without merge.
import { label } from '../gate.ts';
import { applyEvent, type Ledger, type LedgerEvent, levelChanges } from '../ledger.ts';
import { diffStats } from '../mr.ts';
import { loadPolicy } from '../policy.ts';
import { rejectionNote, rejectionsToScore, zonesFromLabels, zonesFromPaths } from '../sweep.ts';
import { env, gitlab, ledgerStore, main } from './common.ts';

main(async () => {
  const policy = loadPolicy();
  const [agentName, agent] = Object.entries(policy.agents)[0];
  const gl = gitlab();
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
  const scored: { iid: number; zones: string[]; events: LedgerEvent[] }[] = [];
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
    scored.push({ iid: mr.iid, zones, events: result.written });
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
  for (const s of scored) await gl.noteMr(s.iid, rejectionNote(s.zones, policy.scoring.human_rejected));
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
});
