// doccheck — keeps the judge-facing Markdown honest: links, repo paths, CI job names, npm scripts and the numbers
// that policy.yml and sci-coefficients.yml own. checkDocs() is pure; repoFacts()/loadDocs() do the file reads.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, normalize, posix } from 'node:path';
import { parse } from 'yaml';
import { type Policy, parsePolicy, type ScoringEvent } from './policy.ts';
import type { SciCoefficients } from './sci.ts';

export interface DocFile {
  /** Repo-relative, forward slashes. */
  path: string;
  text: string;
}

export interface RepoFacts {
  /** Repo-relative path (file or directory) exists. */
  exists: (path: string) => boolean;
  /** Top-level entries of the repo (`app`, `docs`, `.gitlab-ci.yml`, …): a backticked path starting with one is checked. */
  topLevel: Set<string>;
  /** Basenames of files in the repo plus file names the code and CI generate (`ledger.json`, `replay.html`, …). */
  fileNames: Set<string>;
  jobs: Set<string>;
  npmScripts: Set<string>;
  appScripts: Set<string>;
  policy: Policy;
  sci: SciCoefficients;
  testFiles: number;
  /** Total Vitest tests, when the caller ran Vitest. Without it, hard-coded test counts are warnings. */
  testCount?: number;
}

export interface Finding {
  file: string;
  line: number;
  severity: 'error' | 'warning';
  message: string;
}

const IGNORE_MARK = 'doccheck:ignore';
const FILE_EXT = /\.(?:ts|js|mjs|yml|yaml|json|jsonl|md|sh|html|png|svg|webm|mp4|xml|env|txt)$/;
// Paths under these are written by CI or the CLIs, never committed.
const GENERATED_DIRS = ['.out/', 'public/', 'node_modules/'];
// Top-level keys of a GitLab CI file that are not jobs.
const CI_KEYWORDS = new Set([
  'stages',
  'variables',
  'include',
  'workflow',
  'default',
  'image',
  'services',
  'cache',
  'before_script',
  'after_script',
  'spec',
]);
// Files that live outside this repo: GitLab's catalog and CI schemas, and the mapping catalog-sync commits.
const EXTERNAL_FILES = new Set(['flow_v2.json', 'ci.json', '.ai-catalog-mapping.json']);
// Jobs the catalog-sync CI component adds (`.gitlab-ci.yml` only overrides their stage and rules).
export const COMPONENT_JOBS = ['validate-items', 'catalog-sync'];

/** Job names defined in a GitLab CI YAML file (hidden `.templates` and keywords excluded). */
export function ciJobNames(yamlText: string): string[] {
  const doc = parse(yamlText, {
    customTags: [{ tag: '!reference', collection: 'seq', resolve: (v: unknown) => v }],
  }) as Record<string, unknown>;
  return Object.keys(doc).filter((k) => !k.startsWith('.') && !CI_KEYWORDS.has(k));
}

/**
 * Job names in the release child pipeline, read from release-plan.ts source (a CLI module cannot be imported:
 * main() runs on import). probation/test/docs.test.ts checks this against releasePipeline() itself.
 */
export function childJobNames(releasePlanSource: string): string[] {
  const names = new Set<string>();
  for (const m of releasePlanSource.matchAll(/^\s*'([a-z]+:[a-z-]+)': \{/gm)) names.add(m[1]);
  for (const m of releasePlanSource.matchAll(/jobs\['([a-z]+:[a-z-]+)'\]\s*=/g)) names.add(m[1]);
  return [...names];
}

type Check = (doc: DocFile, line: string, n: number, facts: RepoFacts, out: Finding[]) => void;

export function checkDocs(docs: DocFile[], facts: RepoFacts): Finding[] {
  const out: Finding[] = [];
  for (const doc of docs) {
    // A file a command in the doc creates (e.g. `gcloud … keys create k.json`) may be named in its prose.
    const local = new Set(
      [...doc.text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].flatMap((b) =>
        [...b[1].matchAll(/[\w-]+\.(?:json|jsonl|yml|yaml|md|html|xml|env|txt)\b/g)].map((m) => m[0]),
      ),
    );
    const docFacts: RepoFacts = {
      ...facts,
      fileNames: new Set([...facts.fileNames, ...local, ...EXTERNAL_FILES]),
    };
    let fenced = false;
    doc.text.split('\n').forEach((line, i) => {
      const n = i + 1;
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return;
      }
      if (line.includes(IGNORE_MARK)) return;
      checkNpmRuns(doc, line, n, docFacts, out);
      checkNumbers(doc, line, n, docFacts, out);
      if (fenced) {
        checkFencedPaths(doc, line, n, docFacts, out);
        return;
      }
      checkLinks(doc, line, n, docFacts, out);
      checkCodeSpans(doc, line, n, docFacts, out);
    });
  }
  return out;
}

const add = (out: Finding[], doc: DocFile, n: number, severity: Finding['severity'], message: string) =>
  out.push({ file: doc.path, line: n, severity, message });

const checkLinks: Check = (doc, line, n, facts, out) => {
  const targets = [
    ...line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
    ...line.matchAll(/<(?:img|source|video)[^>]*\ssrc="([^"]+)"/g),
  ];
  for (const m of targets) {
    const target = m[1].split('#')[0].split('?')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    const path = posix.normalize(posix.join(posix.dirname(doc.path), decodeURI(target)));
    if (path.startsWith('..') || !facts.exists(path)) {
      add(out, doc, n, 'error', `broken link: ${m[1]} (resolves to ${path})`);
    }
  }
};

const checkCodeSpans: Check = (doc, line, n, facts, out) => {
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].trim();
    checkJobName(doc, span, n, facts, out);
    // "GitLab's `app/validators/…`" names a file in GitLab's own repository.
    if (/GitLab's $/.test(line.slice(0, m.index))) continue;
    checkPath(doc, span, n, facts, out);
  }
};

// In code blocks only paths that start at the repo root are checked (commands, trees).
const checkFencedPaths: Check = (doc, line, n, facts, out) => {
  for (const m of line.matchAll(/(?:^|[\s"'(=])((?:\.?[\w-]+\/)+[\w.-]*)/g)) {
    const first = m[1].split('/')[0];
    if (facts.topLevel.has(first)) checkPath(doc, m[1], n, facts, out);
  }
};

function checkJobName(doc: DocFile, span: string, n: number, facts: RepoFacts, out: Finding[]) {
  if (!/^[a-z][a-z-]*:[a-z*][a-z-]*\*?$/.test(span)) return;
  const known = [...facts.jobs, ...facts.npmScripts];
  // Only spans in a job's or script's namespace (`soak:…`, `gitlab:…`) are names; `dependency:moment` is a key.
  const namespace = span.split(':')[0];
  if (!known.some((j) => j.startsWith(`${namespace}:`))) return;
  if (span.endsWith('*')) {
    const prefix = span.slice(0, -1);
    if (!known.some((j) => j.startsWith(prefix))) add(out, doc, n, 'error', `no CI job matches \`${span}\``);
    return;
  }
  if (!known.includes(span)) {
    add(out, doc, n, 'error', `unknown CI job or npm script \`${span}\``);
  }
}

function checkPath(doc: DocFile, raw: string, n: number, facts: RepoFacts, out: Finding[]) {
  // Placeholders, globs, URLs, commands with arguments and routes are not repo paths.
  if (/[\s<>*{}…$?=|@,]|:\/\//.test(raw) || raw.startsWith('/') || raw.startsWith('~')) return;
  const path = raw
    .replace(/^\.\//, '')
    .replace(/:\d+(?:-\d+)?$/, '')
    .replace(/#.*$/, '');
  if (!path || GENERATED_DIRS.some((d) => path.startsWith(d))) return;
  if (!path.includes('/')) {
    // `.ts`, `.mp4`: an extension, not a file.
    if (/^\.\w+$/.test(path)) return;
    if (FILE_EXT.test(path) && !facts.fileNames.has(path)) {
      add(out, doc, n, 'error', `no file named \`${path}\` in the repo or produced by its code`);
    }
    return;
  }
  const first = path.split('/')[0];
  const docDir = posix.dirname(doc.path);
  if (facts.topLevel.has(first)) {
    if (!facts.exists(path.replace(/\/$/, ''))) add(out, doc, n, 'error', `missing path \`${raw}\``);
    return;
  }
  // Relative to the doc (e.g. `media/replay.webm` in docs/), when its first folder is there.
  const relative = posix.normalize(posix.join(docDir, path));
  if (
    docDir !== '.' &&
    facts.exists(posix.join(docDir, first)) &&
    !facts.exists(relative.replace(/\/$/, ''))
  ) {
    add(out, doc, n, 'error', `missing path \`${raw}\` (resolves to ${relative})`);
  }
}

const checkNpmRuns: Check = (doc, line, n, facts, out) => {
  for (const m of line.matchAll(/npm run ([a-z][\w:.-]*[\w])/g)) {
    const name = m[1];
    if (facts.npmScripts.has(name)) continue;
    if (line.includes('--prefix app') && facts.appScripts.has(name)) continue;
    add(out, doc, n, 'error', `\`npm run ${name}\`: no such script in package.json`);
  }
};

const SCORING_WORDS: [RegExp, ScoringEvent][] = [
  [/rollbacks?|rolled[ _]back/i, 'rolled_back'],
  [/rejections?|rejected|closed[- ]unmerged/i, 'human_rejected'],
  [/security finding|new finding/i, 'security_finding'],
  [/surviv\w*(?: the)?(?: canary)? soak|survived|survives/i, 'survived_soak'],
];

const num = (s: string) => Number(s.replace('−', '-'));

const checkNumbers: Check = (doc, line, n, facts, out) => {
  const { policy, sci } = facts;
  const expect = (what: string, found: number, want: number | number[]) => {
    const ok = Array.isArray(want) ? want.includes(found) : found === want;
    if (!ok) add(out, doc, n, 'error', `${what} is ${found} here but ${want} in the config`);
  };
  // Autonomy thresholds.
  for (const m of line.matchAll(/Supervised\W{0,12}(?:\(score\s*)?(?:≥|>=)\s*(\d+)/g)) {
    expect('Supervised threshold', Number(m[1]), policy.levels.supervised);
  }
  for (const m of line.matchAll(/Hands-off\W{0,12}(?:\(score\s*)?(?:≥|>=)\s*(\d+)/g)) {
    expect('Hands-off threshold', Number(m[1]), policy.levels.hands_off);
  }
  for (const m of line.matchAll(/Assisted\W{0,12}(?:\(score\s*)?<\s*(\d+)/g)) {
    expect('Assisted upper bound', Number(m[1]), policy.levels.supervised);
  }
  // Scoring: a keyword followed closely by a signed number, or a signed number followed by the keyword.
  for (const [word, event] of SCORING_WORDS) {
    const after = new RegExp(`(?:${word.source})[^.;:\\n+−]{0,30}?([+−]\\d+)\\b(?![%.\\d])`, 'gi');
    const before = new RegExp(`([+−]\\d+)\\b(?![%.\\d])\\s*(?:·|points?|pts)?\\s*(?:${word.source})`, 'gi');
    for (const m of [...line.matchAll(after), ...line.matchAll(before)]) {
      expect(`score for ${event}`, num(m[1]), policy.scoring[event]);
    }
  }
  // Software Carbon Intensity coefficients.
  for (const m of line.matchAll(/(\d+(?:\.\d+)?)\s*gCO(?:₂|2)e(?:q)?\/kWh/g)) {
    expect('grid intensity (gCO₂e/kWh)', Number(m[1]), sci.grid.grams_co2e_per_kwh);
  }
  for (const m of line.matchAll(/(\d+\.\d+) W per vCPU/g)) {
    expect('watts per vCPU', Number(m[1]), [sci.compute.min_watts_per_vcpu, sci.compute.max_watts_per_vcpu]);
  }
  for (const m of line.matchAll(/(\d+\.\d+) kWh(?:\/GB-h| per GB-hour)/g)) {
    expect('memory kWh per GB-hour', Number(m[1]), sci.memory.kwh_per_gb_hour);
  }
  for (const m of line.matchAll(/(\d+\.\d+) kWh\/GB(?![-\w])/g)) {
    expect('network kWh per GB', Number(m[1]), sci.network.kwh_per_gb);
  }
  for (const m of line.matchAll(/PUE\**\s*(\d+\.\d+)/g)) expect('PUE', Number(m[1]), sci.pue);
  for (const m of line.matchAll(/(\d+\.\d+) g per vCPU-hour/g)) {
    expect('embodied g per vCPU-hour', Number(m[1]), sci.embodied.grams_per_vcpu_hour);
  }
  // Soak and census settings.
  for (const m of line.matchAll(
    /(\d+)(?:[- ]min(?:ute)?s?(?: of synthetic| soak)| minutes of synthetic)|against the canary for (\d+) minutes|`soak\.minutes` \((\d+)\)/g,
  )) {
    expect('soak minutes', Number(m[1] ?? m[2] ?? m[3]), policy.soak.minutes);
  }
  for (const m of line.matchAll(/(\d+)% (?:of real traffic|production canary|canary)|canary \((\d+)%\)/g)) {
    expect('canary percent', Number(m[1] ?? m[2]), policy.soak.canary_percent);
  }
  for (const m of line.matchAll(/(\d+)-day (?:census )?window/g)) {
    expect('census window (days)', Number(m[1]), policy.census.window_days);
  }
  // Test counts go stale with every new test.
  for (const m of line.matchAll(/\b(\d+) test files\b/g)) {
    expect('number of test files', Number(m[1]), facts.testFiles);
  }
  for (const m of line.matchAll(/\b(\d+) (?:tests|test cases)\b|Vitest \**(\d+) passed/g)) {
    const count = Number(m[1] ?? m[2]);
    if (facts.testCount === undefined) {
      add(out, doc, n, 'warning', `hard-coded test count (${count}); it goes stale with every new test`);
    } else if (count !== facts.testCount) {
      add(out, doc, n, 'error', `test count is ${count} here but Vitest runs ${facts.testCount}`);
    }
  }
};

export function formatFinding(f: Finding): string {
  return `${f.severity === 'error' ? '✖' : '⚠'} ${f.file}:${f.line} ${f.message}`;
}

// ── I/O: gather the facts from a checkout ───────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '.out', 'public']);

function walk(dir: string, rel = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(join(dir, entry.name), path));
    else files.push(path);
  }
  return files;
}

export function loadDocs(root: string): DocFile[] {
  const paths = ['README.md', 'AGENTS.md', 'CLAUDE.md'];
  for (const dir of ['docs', 'docs/build']) {
    for (const f of readdirSync(join(root, dir)).sort()) {
      if (f.endsWith('.md')) paths.push(`${dir}/${f}`);
    }
  }
  return paths
    .filter((p) => existsSync(join(root, p)))
    .map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
}

export function repoFacts(root: string, testCount?: number): RepoFacts {
  const read = (p: string) => readFileSync(join(root, p), 'utf8');
  const files = walk(root);
  const fileNames = new Set(files.map((f) => basename(f)));
  // File names the code, scripts and CI write or read (ledger branch files, .out/ reports, board pages).
  for (const f of files) {
    if (!/^(?:probation\/src|scripts|mcp|app\/src|ci)\/.*\.(?:ts|sh)$/.test(f) && f !== '.gitlab-ci.yml')
      continue;
    for (const m of read(f).matchAll(/[\w-]+\.(?:json|jsonl|yml|md|html|xml|env)\b/g)) fileNames.add(m[0]);
  }
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const appPkg = JSON.parse(read('app/package.json')) as { scripts?: Record<string, string> };
  const jobs = new Set([
    ...ciJobNames(read('.gitlab-ci.yml')),
    ...childJobNames(read('probation/src/cli/release-plan.ts')),
    ...COMPONENT_JOBS,
  ]);
  return {
    exists: (p) => {
      const abs = join(root, normalize(p));
      return existsSync(abs) && (statSync(abs).isFile() || statSync(abs).isDirectory());
    },
    topLevel: new Set(readdirSync(root).filter((e) => !SKIP_DIRS.has(e))),
    fileNames,
    jobs,
    npmScripts: new Set(Object.keys(pkg.scripts)),
    appScripts: new Set(Object.keys(appPkg.scripts ?? {})),
    policy: parsePolicy(read('probation/policy.yml')),
    sci: parse(read('probation/sci-coefficients.yml')) as SciCoefficients,
    testFiles: files.filter((f) => f.endsWith('.test.ts')).length,
    testCount,
  };
}
