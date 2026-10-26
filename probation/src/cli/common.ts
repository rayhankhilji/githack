import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configFromEnv, GitLab } from '../gitlab.ts';
import { FileLedgerStore, GitLabLedgerStore, type LedgerStore } from '../store.ts';

export const env = process.env;

export function gitlab(): GitLab {
  return new GitLab(configFromEnv());
}

export function ledgerStore(): LedgerStore {
  if (env.LEDGER_FILE) return new FileLedgerStore(env.LEDGER_FILE);
  return new GitLabLedgerStore(gitlab(), env.CI_DEFAULT_BRANCH ?? 'main');
}

export function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function writeOut(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function main(fn: () => Promise<void>): void {
  fn().catch((error) => {
    console.error(`✖ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
