// baseline — runs on main after a successful release: records the security fingerprints the gate diffs against.
import { readdirSync } from 'node:fs';
import { readReports } from '../security.ts';
import { env, ledgerStore, main } from './common.ts';

main(async () => {
  const reports = readdirSync('.').filter((f) => /^gl-.*-report\.json$/.test(f));
  const findings = readReports(reports);
  const store = ledgerStore();
  const ledger = await store.load();
  ledger.security = {
    at: new Date().toISOString(),
    sha: env.CI_COMMIT_SHA ?? '',
    fingerprints: findings.map((f) => f.fingerprint),
  };
  await store.save(
    ledger,
    [],
    `probation: security baseline ${findings.length} finding(s) at ${env.CI_COMMIT_SHORT_SHA ?? ''}`,
  );
  console.log(`baseline: ${findings.length} finding(s) from ${reports.length} report(s)`);
});
