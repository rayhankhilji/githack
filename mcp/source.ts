import { resolve } from 'node:path';
import { GitLab } from '../probation/src/gitlab.ts';
import type { Ledger } from '../probation/src/ledger.ts';
import { loadPolicy, type Policy } from '../probation/src/policy.ts';
import { FileLedgerStore, GitLabLedgerStore, type LedgerStore } from '../probation/src/store.ts';

// Where the MCP server reads policy and ledger from. LEDGER_FILE wins (offline, tests, `npm run demo:mock`);
// otherwise the `ledger` branch through the GitLab API, read-only.
export function ledgerStoreFromEnv(env: NodeJS.ProcessEnv = process.env): LedgerStore {
  if (env.LEDGER_FILE) return new FileLedgerStore(resolve(env.LEDGER_FILE));
  const token = env.GITLAB_TOKEN ?? env.GITLAB_PROBATION_TOKEN;
  const projectId = env.GITLAB_PROJECT_ID ?? env.CI_PROJECT_ID;
  if (!token || !projectId) {
    throw new Error(
      'Set LEDGER_FILE to a local ledger.json, or GITLAB_TOKEN (read_api) and GITLAB_PROJECT_ID to read the ledger branch',
    );
  }
  const apiUrl = env.GITLAB_API_URL ?? env.CI_API_V4_URL ?? 'https://gitlab.com/api/v4';
  // The default branch only matters for the first write; this server never writes.
  return new GitLabLedgerStore(new GitLab({ apiUrl, projectId, token }), env.CI_DEFAULT_BRANCH ?? 'main');
}

export function policyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.POLICY_FILE ?? resolve(import.meta.dirname, '../probation/policy.yml');
}

// Loaded fresh on every tool call so the answers follow the ledger branch as CI settles MRs.
export async function loadContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ policy: Policy; ledger: Ledger }> {
  return { policy: loadPolicy(policyPath(env)), ledger: await ledgerStoreFromEnv(env).load() };
}
