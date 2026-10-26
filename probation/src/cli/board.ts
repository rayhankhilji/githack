// board — renders the Probation Board (GitLab Pages) from the ledger.
import { renderBoard } from '../board.ts';
import { loadPolicy } from '../policy.ts';
import { arg, ledgerStore, main, writeOut } from './common.ts';

main(async () => {
  const out = arg('out', 'public/index.html');
  writeOut(out, renderBoard(await ledgerStore().load(), loadPolicy()));
  console.log(`board: wrote ${out}`);
});
