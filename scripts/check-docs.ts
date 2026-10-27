// check-docs — verifies the judge-facing Markdown against the repo: links, backticked paths, CI job names,
// `npm run` scripts and the numbers policy.yml and sci-coefficients.yml own. Exits 1 on any error.
// Usage: node scripts/check-docs.ts [--vitest]   (--vitest also runs the suite to verify hard-coded test counts)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFlag, main } from '../probation/src/cli/common.ts';
import { checkDocs, formatFinding, loadDocs, repoFacts } from '../probation/src/doccheck.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function vitestCount(): number {
  const out = join(mkdtempSync(join(tmpdir(), 'check-docs-')), 'vitest.json');
  spawnSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${out}`], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const report = JSON.parse(readFileSync(out, 'utf8')) as { numTotalTests: number };
  return report.numTotalTests;
}

main(async () => {
  const docs = loadDocs(ROOT);
  const findings = checkDocs(docs, repoFacts(ROOT, hasFlag('vitest') ? vitestCount() : undefined));
  for (const f of findings) console.log(formatFinding(f));
  const errors = findings.filter((f) => f.severity === 'error').length;
  console.log(`check-docs: ${docs.length} files, ${errors} errors, ${findings.length - errors} warnings`);
  if (errors > 0) process.exit(1);
});
