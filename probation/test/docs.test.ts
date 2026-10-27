import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  checkDocs,
  childJobNames,
  ciJobNames,
  type DocFile,
  formatFinding,
  loadDocs,
  repoFacts,
} from '../src/doccheck.ts';

vi.mock('../src/cli/common.ts', async (orig) => ({ ...(await orig<object>()), main: () => {} }));
const { releasePipeline } = await import('../src/cli/release-plan.ts');

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const facts = repoFacts(ROOT);
const check = (text: string, path = 'docs/X.md') => checkDocs([{ path, text }], facts);
const errors = (text: string, path?: string) =>
  check(text, path)
    .filter((f) => f.severity === 'error')
    .map((f) => f.message);

describe('docs truth check', () => {
  it('the judge-facing docs name only jobs, files, scripts and numbers that exist', () => {
    const docs: DocFile[] = loadDocs(ROOT);
    expect(docs.map((d) => d.path)).toEqual(expect.arrayContaining(['README.md', 'docs/SUBMISSION.md']));
    const found = checkDocs(docs, facts)
      .filter((f) => f.severity === 'error')
      .map(formatFinding);
    expect(found).toEqual([]);
  });

  it('reads child-pipeline job names from release-plan.ts exactly as releasePipeline() emits them', () => {
    const emitted = Object.keys(
      releasePipeline({ level: 'supervised', agent: 'undertaker', zones: [] }, 3, 10),
    )
      .filter((k) => k.includes(':'))
      .sort();
    const parsed = childJobNames(readFileSync(`${ROOT}/probation/src/cli/release-plan.ts`, 'utf8')).sort();
    expect(parsed).toEqual(emitted);
    expect(parsed).toContain('soak:canary-signal');
  });

  it('reads job names from .gitlab-ci.yml, skipping templates and keywords', () => {
    const jobs = ciJobNames(readFileSync(`${ROOT}/.gitlab-ci.yml`, 'utf8'));
    expect(jobs).toEqual(
      expect.arrayContaining(['census:collect', 'probation:gate', 'validate-items', 'pages']),
    );
    expect(jobs).not.toContain('.node');
    expect(jobs).not.toContain('stages');
  });

  it('flags unknown job names, missing paths, broken links and unknown npm scripts', () => {
    expect(errors('Run `soak:canary-signals` then `rollback:soak`.')).toEqual([
      'unknown CI job or npm script `soak:canary-signals`',
    ]);
    expect(errors('See `probation/src/nope.ts` and `probation/src/gate.ts`.')).toEqual([
      'missing path `probation/src/nope.ts`',
    ]);
    expect(errors('![x](media/missing.png) [ok](STAGES.md) [web](https://example.com)')).toHaveLength(1);
    expect(errors('```bash\nnpm run nope\nnpm run demo:mock\n```')).toEqual([
      '`npm run nope`: no such script in package.json',
    ]);
  });

  it('ignores placeholders, globs, generated paths, label scopes and candidate keys', () => {
    const text = [
      '`app/src/auth/**`, `release-<pipeline iid>`, `.out/board.html`, `public/index.html`, `zone::legacy`,',
      '`dependency:moment`, `settle:*`, `https://x.run.app`, `ledger.json`, `audit.jsonl`, `replay.html`.',
    ].join('\n');
    expect(errors(text)).toEqual([]);
  });

  it('checks thresholds, scores and SCI coefficients against the config files', () => {
    expect(errors('| **Supervised** | ≥ 10 |\n| **Hands-off** | ≥ 30 |')).toEqual([]);
    expect(errors('**Hands-off** (≥ 25: no human)')).toHaveLength(1);
    expect(errors('a rollback costs −40, a human rejection −20 and a new security finding −30')).toEqual([]);
    expect(errors('a rollback costs −50')).toHaveLength(1);
    expect(errors('!1 survived the soak · +10 → Supervised')).toEqual([]);
    expect(errors('I is 412 gCO₂e/kWh')).toHaveLength(1);
    expect(errors('PUE 1.2 and 4.26 W per vCPU')).toHaveLength(1);
  });

  it('warns about hard-coded test counts unless a real count is given', () => {
    expect(check('Vitest **12 passed**')[0].severity).toBe('warning');
    const exact = checkDocs([{ path: 'docs/X.md', text: 'Vitest **12 passed**' }], {
      ...facts,
      testCount: 12,
    });
    expect(exact).toEqual([]);
  });
});
