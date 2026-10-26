import { readFileSync } from 'node:fs';
import { emptyLedger, type Ledger } from '../src/ledger.ts';
import { parsePolicy } from '../src/policy.ts';

export const policy = parsePolicy(readFileSync('probation/policy.yml', 'utf8'));

export function ledgerWith(scores: Record<string, number>): Ledger {
  const ledger = emptyLedger();
  ledger.scores.undertaker = { ...scores };
  return ledger;
}

export const del = (path: string, removed = 20) => ({ path, deleted: true, added: 0, removed });
export const edit = (path: string, added: number, removed: number) => ({
  path,
  deleted: false,
  added,
  removed,
});
