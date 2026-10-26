// settle — the verdict after production. Scores the agent, writes the ledger, announces promotions and demotions.
import { existsSync, readFileSync } from 'node:fs';
import { label } from '../gate.ts';
import { applyEvent, type Grave, type Ledger, levelChanges } from '../ledger.ts';
import { candidateIssue, diffStats } from '../mr.ts';
import { loadPolicy, type ScoringEvent } from '../policy.ts';
import type { SciResult } from '../sci.ts';
import { arg, env, gitlab, hasFlag, ledgerStore, main } from './common.ts';

export function graveFor(
  mr: { iid: number; title: string },
  zones: string[],
  linesRemoved: number,
  status: Grave['status'],
  sci?: number,
): Grave {
  return {
    at: new Date().toISOString(),
    mr: mr.iid,
    title: mr.title,
    zone: zones.join('+'),
    linesRemoved,
    sciDeltaPct: sci,
    status,
  };
}

main(async () => {
  const policy = loadPolicy();
  const outcome = arg('outcome') as 'survived' | 'rolled_back';
  const event: ScoringEvent = outcome === 'survived' ? 'survived_soak' : 'rolled_back';
  const agent = env.RELEASE_AGENT || Object.keys(policy.agents)[0];
  const zones = (env.RELEASE_ZONES ?? arg('zones', '')).split(',').filter(Boolean);
  const iid = Number(env.RELEASE_MR_IID || arg('mr', '0'));
  const gl = hasFlag('offline') ? undefined : gitlab();
  const mr = gl && iid ? await gl.getMr(iid) : { iid, title: `MR !${iid}`, web_url: '', description: '' };
  const store = ledgerStore();
  const before: Ledger = await store.load();
  const { ledger, written } = applyEvent(before, policy, {
    agent,
    zones,
    event,
    ref: {
      mr: iid,
      sha: env.CI_COMMIT_SHA,
      pipeline: Number(env.CI_PIPELINE_ID) || undefined,
      url: mr.web_url,
    },
  });

  const sci = existsSync('.out/sci.json')
    ? (JSON.parse(readFileSync('.out/sci.json', 'utf8')) as SciResult)
    : undefined;
  const sciDelta =
    sci && ledger.sci?.baseline
      ? ((sci.gramsPer1kRequests - ledger.sci.baseline.gramsPer1kRequests) /
          ledger.sci.baseline.gramsPer1kRequests) *
        100
      : undefined;
  const removed = gl && iid ? diffStats(await gl.mrDiffs(iid)).reduce((n, f) => n + f.removed, 0) : 0;
  ledger.graveyard.push(
    graveFor(mr, zones, removed, outcome === 'survived' ? 'buried' : 'exhumed', sciDelta),
  );
  if (outcome === 'survived' && sci) {
    ledger.sci ??= { history: [] };
    ledger.sci.baseline = sci;
    ledger.sci.history.push({
      at: new Date().toISOString(),
      sha: env.CI_COMMIT_SHA ?? '',
      gramsPer1kRequests: sci.gramsPer1kRequests,
      imageMb: sci.measurement.deployableMb,
    });
  }
  await store.save(ledger, written, `probation: ${event} for !${iid} (${zones.join(', ')})`);

  for (const e of written)
    console.log(
      `${e.zone}: ${e.points > 0 ? '+' : ''}${e.points} → ${e.scoreAfter} (${label(e.levelAfter)})`,
    );
  if (!gl) return;
  const changes = levelChanges(written);
  const lines = written.map(
    (e) =>
      `- **${e.zone}**: ${e.points > 0 ? '+' : ''}${e.points} → score ${e.scoreAfter} · ${label(e.levelAfter)}`,
  );
  const verdict =
    outcome === 'survived'
      ? '✅ Survived production soak.'
      : '🚨 Rolled back. The canary broke a real client.';
  if (iid) await gl.noteMr(iid, [verdict, '', ...lines].join('\n'));
  for (const change of changes) {
    const promoted = policy.levels[change.levelAfter] > policy.levels[change.levelBefore];
    await gl.createIssue({
      title: `${promoted ? '🎖️ Promotion' : '⬇️ Demotion'}: ${agent} is now ${label(change.levelAfter)} in zone ${change.zone}`,
      description: [
        `${agent} moved from **${label(change.levelBefore)}** to **${label(change.levelAfter)}** in zone \`${change.zone}\` after ${change.event.replace('_', ' ')} on !${iid}.`,
        '',
        `Score: ${change.scoreAfter}. Thresholds: Supervised ≥ ${policy.levels.supervised}, Hands-off ≥ ${policy.levels.hands_off} (probation/policy.yml).`,
        '',
        'Recorded in the `ledger` branch (audit.jsonl). No action needed; close when read.',
      ].join('\n'),
      labels: `probation::${promoted ? 'promotion' : 'demotion'},zone::${change.zone}`,
    });
  }
  // Close or flag the candidate issue that started this MR.
  // Only the closing reference counts: the epitaph and quoted evidence may mention other issues.
  const issueRef = candidateIssue(mr.description);
  if (issueRef) {
    const issueIid = issueRef;
    if (outcome === 'survived')
      await gl.updateIssue(issueIid, { state_event: 'close', remove_labels: 'undertaker::in-progress' });
    else {
      await gl.updateIssue(issueIid, {
        add_labels: 'undertaker::do-not-bury',
        remove_labels: 'undertaker::in-progress',
      });
      await gl.noteIssue(
        issueIid,
        `🚨 Exhumed: burying this broke a real client during the canary soak (see !${iid}). Marked do-not-bury; the census will skip it.`,
      );
    }
  }
  // Revert last: a revert conflict must not stop the candidate from being marked do-not-bury.
  if (outcome === 'rolled_back' && env.CI_COMMIT_SHA) {
    // Production is already back on the previous revision; now take the code back too.
    const revert = await gl.revertCommit(env.CI_COMMIT_SHA, env.CI_DEFAULT_BRANCH ?? 'main');
    console.log(`reverted ${env.CI_COMMIT_SHORT_SHA} as ${revert.id}`);
  }
});
