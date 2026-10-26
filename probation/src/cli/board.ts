// board — renders the Probation Board (GitLab Pages) from the ledger, plus the ledger replay next to it.
import { dirname, join } from 'node:path';
import { renderBoard } from '../board.ts';
import { loadPolicy } from '../policy.ts';
import { renderReplay } from '../replay.ts';
import { arg, ledgerStore, main, writeOut } from './common.ts';

main(async () => {
  const out = arg('out', 'public/index.html');
  const ledger = await ledgerStore().load();
  const policy = loadPolicy();
  // The board links to replay.html, so it always sits in the same directory.
  const replay = join(dirname(out), 'replay.html');
  writeOut(out, renderBoard(ledger, policy));
  writeOut(replay, renderReplay(ledger, policy));
  console.log(`board: wrote ${out} and ${replay}`);
});
