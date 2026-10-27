import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emptyLedger, type Ledger } from '../src/ledger.ts';
import { computeSci, loadCoefficients, pctChange, sciMarkdown } from '../src/sci.ts';
import {
  applyFills,
  FILL_RULES,
  findPlaceholders,
  fmtPct,
  graveStats,
  isMitLicense,
  newestMergedFirst,
  newestSciNote,
  parseSciNote,
  relativeTargets,
  sciChange,
  touches,
  unifiedDiff,
  type Values,
  youtubeId,
} from '../src/submission.ts';
import { FIXTURE_DOCS } from './fixtures/submission-docs.ts';

const c = loadCoefficients();
const m = {
  requests: 5000,
  cpuSeconds: 4,
  avgRssMb: 90,
  durationSeconds: 10,
  deployableMb: 25.9,
  coldStartMs: 812,
};
const before = computeSci(c, m);
const after = computeSci(c, { ...m, deployableMb: 15.7, coldStartMs: 640 });
const note = `🌱 ${sciMarkdown(before, after)}`;

// The placeholders as they were before any fill; the real docs are checked for drift separately below.
const docs = FIXTURE_DOCS;

const full: Values = {
  name: 'Gravedigger',
  videoUrl: 'https://youtu.be/dQw4w9WgXcQ',
  pagesUrl: 'https://demo.gitlab.io/tallybook/',
  appUrl: 'https://tallybook-abc123-uc.a.run.app',
  devpostUrl: 'https://devpost.com/software/gravedigger',
  repoUrl: 'https://gitlab.com/demo/tallybook',
  sciChange: { pct: -12.34, points: 7, from: '2026-10-26', to: '2026-10-27' },
  burial: { iid: 12, url: 'https://gitlab.com/demo/tallybook/-/merge_requests/12', ...parseSciNote(note) },
};

describe('the 🌱 note and the ledger', () => {
  it('reads Total SCI Δ, size and cold start from a note sciMarkdown wrote', () => {
    const parsed = parseSciNote(note);
    expect(parsed?.totalPct).toBe(
      Number(pctChange(before.gramsPer1kRequests, after.gramsPer1kRequests).toFixed(1)),
    );
    expect(parsed).toMatchObject({ sizeBefore: 25.9, sizeAfter: 15.7, coldBefore: 812, coldAfter: 640 });
  });

  it('ignores notes that are not 🌱 and a note without a baseline has no Δ', () => {
    expect(parseSciNote('⛔ **Probation gate: blocked.**')).toBeUndefined();
    const noBaseline = parseSciNote(`🌱 ${sciMarkdown(undefined, after)}`);
    expect(noBaseline?.totalPct).toBeUndefined();
    expect(noBaseline?.sizeBefore).toBeUndefined();
    expect(
      newestSciNote([{ body: 'lgtm' }, { body: note }, { body: `🌱 ${sciMarkdown(after, before)}` }]),
    ).toEqual(parseSciNote(note));
  });

  it('SCI change runs from the first to the last history point, like the board', () => {
    const ledger: Ledger = emptyLedger();
    expect(sciChange(ledger)).toBeUndefined();
    ledger.sci = {
      history: [
        { at: '2026-10-26T10:00:00Z', sha: 'a', gramsPer1kRequests: 0.2 },
        { at: '2026-10-26T12:00:00Z', sha: 'b', gramsPer1kRequests: 0.25 },
        { at: '2026-10-27T09:00:00Z', sha: 'c', gramsPer1kRequests: 0.15 },
      ],
    };
    expect(sciChange(ledger)).toEqual({
      pct: -25.000000000000007,
      points: 3,
      from: '2026-10-26',
      to: '2026-10-27',
    });
    expect(fmtPct(-25.000000000000007)).toBe('−25.0%');
    expect(fmtPct(3.04)).toBe('+3.0%');
  });

  it('counts buried and exhumed graves and the lines buried', () => {
    const ledger = emptyLedger();
    ledger.graveyard = [
      { at: 'x', title: 'a', zone: 'legacy', linesRemoved: 40, status: 'buried' },
      { at: 'x', title: 'b', zone: 'deps', linesRemoved: 2, status: 'buried' },
      { at: 'x', title: 'c', zone: 'routes', linesRemoved: 30, status: 'exhumed' },
    ];
    expect(graveStats(ledger)).toEqual({ buried: 2, exhumed: 1, linesRemoved: 42 });
  });

  it('picks merged MRs newest merge first and spots app/package.json', () => {
    const mrs = [
      { iid: 3, state: 'merged', merged_at: '2026-10-26T10:00:00Z' },
      { iid: 5, state: 'opened', merged_at: null },
      { iid: 4, state: 'merged', merged_at: '2026-10-27T10:00:00Z' },
    ];
    expect(newestMergedFirst(mrs).map((x) => x.iid)).toEqual([4, 3]);
    const diff = (p: string) => ({ new_path: p, old_path: p, deleted_file: false, diff: '' });
    expect(touches([diff('app/src/x.ts'), diff('app/package.json')], 'app/package.json')).toBe(true);
    expect(touches([diff('package.json')], 'app/package.json')).toBe(false);
  });
});

describe('placeholders', () => {
  it('lists every ✏️ with its line; README and SUBMISSION block, the rest and "Optional" warn', () => {
    const text =
      '# T\n> Replace every line marked ✏️ before you submit.\n- ✏️ GitLab repo\n- ✏️ Optional scale-up\n';
    expect(findPlaceholders('docs/SUBMISSION.md', text)).toEqual([
      { file: 'docs/SUBMISSION.md', line: 3, text: '- ✏️ GitLab repo', blocking: true },
      { file: 'docs/SUBMISSION.md', line: 4, text: '- ✏️ Optional scale-up', blocking: false },
    ]);
    expect(findPlaceholders('docs/STAGES.md', '| ✏️ Screenshot |')[0].blocking).toBe(false);
  });

  it('every rule matches its placeholder in the fixture', () => {
    for (const rule of FILL_RULES) {
      // The burial line's leading ✏️ only matches once its inner placeholders are filled.
      if (rule.id === 'submission.burial-line') continue;
      expect(rule.pattern.test(docs[rule.file]), rule.id).toBe(true);
    }
  });

  it('every blocking ✏️ left in the real docs is mapped by a rule or is a known manual one', () => {
    // Stays true after the real fill (fewer ✏️), and fails when a doc rewords a placeholder the map relies on.
    const manual = [/^11\. ✏️ Screenshots from the live project/];
    for (const file of ['README.md', 'docs/SUBMISSION.md']) {
      for (const p of findPlaceholders(file, readFileSync(file, 'utf8')).filter((x) => x.blocking)) {
        const mapped = FILL_RULES.some((r) => r.file === file && r.pattern.test(`${p.text}\n\n`));
        expect(mapped || manual.some((re) => re.test(p.text)), `${file}:${p.line} ${p.text}`).toBe(true);
      }
    }
  });

  it('fills every mapped placeholder and leaves the unknown ones', () => {
    const { texts, changes } = applyFills(docs, full);
    expect(changes.map((x) => x.rule)).toEqual(FILL_RULES.map((r) => r.id));
    const readme = texts['README.md'];
    expect(readme.startsWith('# Gravedigger\n\n**An AI that deletes dead code')).toBe(true);
    expect(readme).toContain(
      '| 🎬 Demo video (under 3 min) | [Watch on YouTube](https://youtu.be/dQw4w9WgXcQ) |',
    );
    expect(readme).toContain(
      '| 🪦 Probation Board (live ledger) | [demo.gitlab.io/tallybook](https://demo.gitlab.io/tallybook/) |',
    );
    expect(readme).toContain(
      '| 🧾 Tallybook on Cloud Run | [tallybook-abc123-uc.a.run.app](https://tallybook-abc123-uc.a.run.app) |',
    );
    expect(readme).toContain('| 📄 Devpost page | [Devpost](https://devpost.com/software/gravedigger) |');
    const pct = fmtPct(full.burial?.totalPct ?? 0);
    expect(readme).toContain(
      `Measured result from the dependency burial: SCI ${pct} (the 🌱 note on [!12](https://gitlab.com/demo/tallybook/-/merge_requests/12)).`,
    );
    // The CI system keeps its name; only the title changed.
    expect(readme).toContain('**Probation** is the deterministic CI system');
    expect(findPlaceholders('README.md', readme)).toEqual([]);

    const sub = texts['docs/SUBMISSION.md'];
    expect(sub).toContain('**Name:** Gravedigger\n');
    expect(sub).not.toContain('"Probation" is a working title');
    expect(sub).toContain('- GitLab repo: https://gitlab.com/demo/tallybook\n');
    expect(sub).toContain(
      '- Ledger replay: https://demo.gitlab.io/tallybook/replay.html (a 30-second recording',
    );
    expect(sub).toContain(
      `- Dependency burial (moment + lodash): deployable size 25.9 MB → 15.7 MB, cold start 812 ms → 640 ms, SCI ${pct} (the 🌱 note on [!12](`,
    );
    expect(sub).toContain(
      '- All burials since the first measurement: SCI −12.3% (board stat "SCI change", 7 measurements from 2026-10-26 to 2026-10-27).',
    );
    // No value for these: they stay.
    expect(findPlaceholders('docs/SUBMISSION.md', sub).map((p) => p.text.slice(0, 22))).toEqual([
      '- ✏️ Optional scale-up',
      '11. ✏️ Screenshots fro',
    ]);
    expect(texts['docs/STAGES.md']).toBe(docs['docs/STAGES.md']);
    expect(texts['docs/SCI.md']).toBe(docs['docs/SCI.md']);
  });

  it('is idempotent and changes nothing without values', () => {
    const once = applyFills(docs, full).texts;
    expect(applyFills(once, full).changes).toEqual([]);
    expect(applyFills(docs, {}).changes).toEqual([]);
  });

  it('fills only what it knows: a partial note leaves the burial line marked', () => {
    const { texts, changes } = applyFills(docs, { burial: { iid: 9, url: 'https://x/9', totalPct: -4 } });
    expect(changes.map((x) => x.rule)).toEqual(['readme.sci-burial', 'submission.burial-sci']);
    expect(texts['docs/SUBMISSION.md']).toContain(
      '- ✏️ Dependency burial (moment + lodash): app layer ✏️ X MB',
    );
    expect(texts['docs/SUBMISSION.md']).toContain('SCI −4.0% (the 🌱 note on [!9](https://x/9))');
  });

  it('keeping the working title only removes the notes', () => {
    const { texts, changes } = applyFills(docs, { name: 'Probation' });
    expect(changes.map((x) => x.rule)).toEqual([
      'readme.working-title',
      'submission.name',
      'submission.working-title',
    ]);
    expect(texts['README.md'].startsWith('# Probation\n\n**An AI')).toBe(true);
  });
});

describe('diff and checks', () => {
  it('renders a git-style unified diff with removals first', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n');
    const b = a.replace('5', 'five');
    expect(unifiedDiff('x.md', a, b)).toBe(
      [
        '--- a/x.md',
        '+++ b/x.md',
        '@@ -2,7 +2,7 @@',
        ' 2',
        ' 3',
        ' 4',
        '-5',
        '+five',
        ' 6',
        ' 7',
        ' 8',
        '',
      ].join('\n'),
    );
    expect(unifiedDiff('x.md', a, a)).toBe('');
    expect(unifiedDiff('x.md', 'a\nb', 'a')).toBe(
      ['--- a/x.md', '+++ b/x.md', '@@ -1,2 +1,1 @@', ' a', '-b', ''].join('\n'),
    );
  });

  it('accepts YouTube video URLs only', () => {
    expect(youtubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('http://youtu.be/dQw4w9WgXcQ')).toBeUndefined();
    expect(youtubeId('https://www.youtube.com/watch?v=short')).toBeUndefined();
    expect(youtubeId('https://www.youtube.com/@channel')).toBeUndefined();
    expect(youtubeId('https://vimeo.com/123')).toBeUndefined();
    expect(youtubeId('not a url')).toBeUndefined();
  });

  it('recognises the MIT license and the README relative targets', () => {
    expect(isMitLicense(readFileSync('LICENSE', 'utf8'))).toBe(true);
    expect(isMitLicense('Apache License\nVersion 2.0')).toBe(false);
    const targets = relativeTargets(
      '[a](docs/A.md#x) ![i](img.png) [w](https://x.y)\n```\n[c](code.md)\n```\n',
    );
    expect(targets).toEqual([
      { line: 1, target: 'docs/A.md' },
      { line: 1, target: 'img.png' },
    ]);
  });
});
