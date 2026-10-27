// board — renders the Probation Board (GitLab Pages) from the ledger, plus the ledger replay and gate playground next to it.
import { dirname, join } from 'node:path';
import { renderBoard } from '../board.ts';
import { buildPlayground } from '../playground.ts';
import { loadPolicy } from '../policy.ts';
import { renderReplay } from '../replay.ts';
import { arg, env, ledgerStore, main, writeOut } from './common.ts';

// Shown when Pages is published from the offline rehearsal ledger (no live runs yet), so nobody mistakes it for production.
const REHEARSAL_BANNER =
  '<p role="note" style="border:1px solid var(--line);border-left:4px solid var(--assisted);padding:8px 12px;margin:0 0 16px">Offline rehearsal: this board shows the scripted demo ledger from <code>npm run demo:mock</code>, not live production runs.</p>';

const withBanner = (html: string) =>
  env.BOARD_REHEARSAL === '1' ? html.replace(/<main\b[^>]*>/, (m) => m + REHEARSAL_BANNER) : html;

main(async () => {
  const out = arg('out', 'public/index.html');
  const ledger = await ledgerStore().load();
  const policy = loadPolicy();
  // The board links to replay.html and playground.html, so they always sit in the same directory.
  const replay = join(dirname(out), 'replay.html');
  const playground = join(dirname(out), 'playground.html');
  writeOut(out, withBanner(renderBoard(ledger, policy)));
  writeOut(replay, withBanner(renderReplay(ledger, policy)));
  writeOut(playground, withBanner(await buildPlayground(policy, ledger)));
  console.log(`board: wrote ${out}, ${replay} and ${playground}`);
});
