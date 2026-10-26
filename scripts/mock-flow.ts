// mock-flow — plays the whole Probation story locally, with no GitLab, GCP or credits:
// census → Undertaker MRs → gate → production soak → ledger → board.
// Usage: npm run demo:mock   (writes .out/mock-ledger.json and .out/board.html)
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderBoard } from '../probation/src/board.ts';
import { decide, label } from '../probation/src/gate.ts';
import { applyEvent, emptyLedger, type Ledger } from '../probation/src/ledger.ts';
import { loadPolicy } from '../probation/src/policy.ts';

const policy = loadPolicy();
const agent = 'undertaker';

interface Act {
  mr: number;
  title: string;
  files: { path: string; deleted: boolean; added: number; removed: number }[];
  production: 'survives' | 'breaks';
  humanApproves?: boolean;
}

const acts: Act[] = [
  {
    mr: 1,
    title: 'Bury the fax gateway (vendor dead since 2024)',
    files: [
      { path: 'app/src/legacy/fax.ts', deleted: true, added: 0, removed: 8 },
      { path: 'app/src/legacy/index.ts', deleted: false, added: 0, removed: 2 },
    ],
    production: 'survives',
    humanApproves: true,
  },
  {
    mr: 2,
    title: 'Bury POST /api/v1/sync (no-op since 2025)',
    files: [{ path: 'app/src/legacy/v1.ts', deleted: false, added: 0, removed: 2 }],
    production: 'survives',
    humanApproves: true,
  },
  {
    mr: 3,
    title: 'Bury GET /api/v1/invoices (0 requests in 7d)',
    files: [{ path: 'app/src/legacy/v1.ts', deleted: false, added: 0, removed: 4 }],
    production: 'survives',
  },
  {
    mr: 4,
    title: 'Bury GET /api/v1/export.csv (0 requests in 7d)',
    files: [
      { path: 'app/src/legacy/v1.ts', deleted: false, added: 0, removed: 6 },
      { path: 'app/test/server.test.ts', deleted: false, added: 0, removed: 6 },
    ],
    production: 'breaks',
  },
  {
    mr: 5,
    title: 'Bury the v1 deprecation shim',
    files: [{ path: 'app/src/legacy/v1.ts', deleted: false, added: 0, removed: 3 }],
    production: 'survives',
    humanApproves: true,
  },
];

let ledger: Ledger = emptyLedger();
let clock = Date.parse('2026-10-27T00:00:00Z');
const tick = () => {
  clock += 37 * 60_000;
  return new Date(clock).toISOString();
};

console.log('⚰️  Probation mock run\n');
for (const act of acts) {
  const d = decide(policy, ledger, { agent, files: act.files, introducedFindings: [], checksPassed: true });
  const zones = d.zones.map((z) => z.zone);
  console.log(`!${act.mr} ${act.title}`);
  console.log(`   gate: ${d.verdict} (${label(d.level)}) · −${d.linesRemoved}/+${d.linesAdded}`);
  if (d.verdict === 'block') continue;
  if (d.verdict === 'needs_human' && !act.humanApproves) {
    const r = applyEvent(ledger, policy, {
      agent,
      zones,
      event: 'human_rejected',
      ref: { mr: act.mr },
      at: tick(),
    });
    ledger = r.ledger;
    console.log('   human: closed without merging → human_rejected\n');
    continue;
  }
  if (d.verdict === 'needs_human') console.log('   human: approved and merged');
  if (d.verdict === 'merge_supervised') console.log('   gate: auto-merged; human approved production');
  if (d.verdict === 'merge_hands_off') console.log('   gate: auto-merged; canary → soak with no human');
  const event = act.production === 'survives' ? 'survived_soak' : 'rolled_back';
  const r = applyEvent(ledger, policy, { agent, zones, event, ref: { mr: act.mr }, at: tick() });
  ledger = r.ledger;
  ledger.graveyard.push({
    at: r.written[0].at,
    mr: act.mr,
    title: act.title,
    zone: zones.join('+'),
    linesRemoved: d.linesRemoved,
    status: event === 'survived_soak' ? 'buried' : 'exhumed',
  });
  for (const e of r.written) {
    const move =
      e.levelBefore === e.levelAfter
        ? label(e.levelAfter)
        : `${label(e.levelBefore)} → ${label(e.levelAfter)}`;
    console.log(
      `   prod: ${act.production === 'survives' ? 'survived soak' : 'synthetic "bookkeeping-partner-monthly-export" → 404, rolled back'}`,
    );
    console.log(`   ledger: ${e.zone} ${e.points > 0 ? '+' : ''}${e.points} → ${e.scoreAfter} · ${move}\n`);
  }
}

mkdirSync('.out', { recursive: true });
writeFileSync('.out/mock-ledger.json', `${JSON.stringify(ledger, null, 2)}\n`);
writeFileSync('.out/board.html', renderBoard(ledger, policy));
console.log('wrote .out/mock-ledger.json and .out/board.html');
