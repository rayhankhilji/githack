// board — renders the Probation Board (GitLab Pages) from the ledger, plus the ledger replay and gate playground next to it.
import { dirname, join } from 'node:path';
import { renderBoard } from '../board.ts';
import { buildPlayground } from '../playground.ts';
import { loadPolicy } from '../policy.ts';
import { renderReplay } from '../replay.ts';
import { arg, ledgerStore, main, writeOut } from './common.ts';

main(async () => {
  const out = arg('out', 'public/index.html');
  const ledger = await ledgerStore().load();
  const policy = loadPolicy();
  // The board links to replay.html and playground.html, so they always sit in the same directory.
  const replay = join(dirname(out), 'replay.html');
  const playground = join(dirname(out), 'playground.html');
  writeOut(out, renderBoard(ledger, policy));
  writeOut(replay, renderReplay(ledger, policy));
  writeOut(playground, await buildPlayground(policy, ledger));
  console.log(`board: wrote ${out}, ${replay} and ${playground}`);
});
