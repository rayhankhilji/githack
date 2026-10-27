// submission — the final-hour checks and fills for the Devpost submission (scripts/submission.ts).
// Pure: finds ✏️ placeholders, maps measured values onto the exact placeholders they answer, and renders diffs.
// Values are only ever ones a flag or the ledger/MR notes give; a placeholder without a value stays ✏️.
import type { MrDiff } from './gitlab.ts';
import type { Ledger } from './ledger.ts';

export const MARK = '✏️';
/** The docs the submission tool reads and may fill. */
export const SUBMISSION_DOCS = ['README.md', 'docs/SUBMISSION.md', 'docs/STAGES.md', 'docs/SCI.md'];
/** A ✏️ left in these blocks the submission; elsewhere it is a warning. */
export const BLOCKING_DOCS = new Set(['README.md', 'docs/SUBMISSION.md']);
export const MAX_VIDEO_SECONDS = 180;
export const MEDIA_WARN_BYTES = 10 * 1024 * 1024;

export interface Placeholder {
  file: string;
  line: number;
  text: string;
  blocking: boolean;
}

/** Every ✏️ in a doc. Lines that only talk about the marker ("every line marked ✏️") are instructions, not placeholders. */
export function findPlaceholders(file: string, text: string): Placeholder[] {
  const out: Placeholder[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.includes(MARK)) return;
    if (line.includes(`marked ${MARK}`)) return;
    // "Optional scale-up" may be dropped instead of filled, so it never blocks.
    const blocking = BLOCKING_DOCS.has(file) && !/\boptional\b/i.test(line);
    out.push({ file, line: i + 1, text: line.trim(), blocking });
  });
  return out;
}

// ── Measured values ─────────────────────────────────────────────────────

export interface SciChange {
  pct: number;
  points: number;
  from: string;
  to: string;
}

/** SCI change from the first to the last ledger measurement, as the board's "SCI change" stat computes it. */
export function sciChange(ledger: Ledger): SciChange | undefined {
  const hist = ledger.sci?.history ?? [];
  if (hist.length < 2) return undefined;
  const first = hist[0];
  const last = hist[hist.length - 1];
  if (!first.gramsPer1kRequests) return undefined;
  return {
    pct: ((last.gramsPer1kRequests - first.gramsPer1kRequests) / first.gramsPer1kRequests) * 100,
    points: hist.length,
    from: first.at.slice(0, 10),
    to: last.at.slice(0, 10),
  };
}

export interface GraveStats {
  buried: number;
  exhumed: number;
  linesRemoved: number;
}

/** The board's graveyard stats: graves that survived production, rollbacks, and lines buried. */
export function graveStats(ledger: Ledger): GraveStats {
  const buried = ledger.graveyard.filter((g) => g.status === 'buried');
  return {
    buried: buried.length,
    exhumed: ledger.graveyard.filter((g) => g.status === 'exhumed').length,
    linesRemoved: buried.reduce((n, g) => n + g.linesRemoved, 0),
  };
}

export interface SciNote {
  totalPct?: number;
  sizeBefore?: number;
  sizeAfter?: number;
  coldBefore?: number;
  coldAfter?: number;
}

/** Reads a 🌱 note written by `measure:sci` (sciMarkdown in sci.ts). Undefined when the body is not one. */
export function parseSciNote(body: string): SciNote | undefined {
  if (!body.trimStart().startsWith('🌱')) return undefined;
  const note: SciNote = {};
  const total = /^\| \*\*Total SCI\*\* \| [^|]+ \| [^|]+ \| (-?\d+(?:\.\d+)?)% \|/m.exec(body);
  if (total) note.totalPct = Number(total[1]);
  const size = /Deployable size (\d+(?:\.\d+)?) → (\d+(?:\.\d+)?) MB/.exec(body);
  if (size) [note.sizeBefore, note.sizeAfter] = [Number(size[1]), Number(size[2])];
  const cold = /cold start (\d+) → (\d+) ms/.exec(body);
  if (cold) [note.coldBefore, note.coldAfter] = [Number(cold[1]), Number(cold[2])];
  return note;
}

/** The newest 🌱 note of an MR; notes may come in any order, so callers pass them newest first. */
export function newestSciNote(notesNewestFirst: { body: string }[]): SciNote | undefined {
  for (const n of notesNewestFirst) {
    const parsed = parseSciNote(n.body);
    if (parsed) return parsed;
  }
  return undefined;
}

export const touches = (diffs: MrDiff[], path: string) =>
  diffs.some((d) => d.new_path === path || d.old_path === path);

/** Merged MRs, newest merge first (merged_at, then iid). */
export function newestMergedFirst<T extends { iid: number; state: string; merged_at?: string | null }>(
  mrs: T[],
): T[] {
  return mrs
    .filter((m) => m.state === 'merged')
    .sort((a, b) => (b.merged_at ?? '').localeCompare(a.merged_at ?? '') || b.iid - a.iid);
}

export interface Burial extends SciNote {
  iid: number;
  url: string;
}

export interface Values {
  name?: string;
  videoUrl?: string;
  pagesUrl?: string;
  appUrl?: string;
  devpostUrl?: string;
  repoUrl?: string;
  sciChange?: SciChange;
  burial?: Burial;
}

// ── Formatting ──────────────────────────────────────────────────────────

/** Signed percent with a typographic minus, as the board and docs write it. */
export const fmtPct = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : ''}${Math.abs(n).toFixed(1)}%`;
const bare = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');
const link = (url: string) => `[${bare(url)}](${url})`;
const mrLink = (b: Burial) => `[!${b.iid}](${b.url})`;

// ── The placeholder map ─────────────────────────────────────────────────

export interface FillRule {
  id: string;
  file: string;
  /** What it fills, for the report. */
  fills: string;
  /** Matches only the ✏️ text (single match, no g flag), so a filled doc never matches again. */
  pattern: RegExp;
  /** The replacement, or undefined when the value is unknown (the placeholder stays). */
  replace: (v: Values, m: RegExpExecArray) => string | undefined;
}

const SUB = 'docs/SUBMISSION.md';

/** Applied in order: the burial line's leading ✏️ goes only after all its inner placeholders are filled. */
export const FILL_RULES: FillRule[] = [
  {
    id: 'readme.title',
    file: 'README.md',
    fills: '--name: the README title',
    pattern: /^# Probation$/m,
    replace: (v) => v.name && `# ${v.name}`,
  },
  {
    id: 'readme.working-title',
    file: 'README.md',
    fills: '--name: removes the ✏️ "Working title" note',
    pattern: /^> ✏️ \*\*Working title\.\*\*[^\n]*\n\n?/m,
    replace: (v) => (v.name ? '' : undefined),
  },
  {
    id: 'readme.video',
    file: 'README.md',
    fills: '--video-url',
    pattern: /^(\| 🎬 Demo video[^|\n]*\| )✏️ YouTube link( \|)$/m,
    replace: (v, m) => v.videoUrl && `${m[1]}[Watch on YouTube](${v.videoUrl})${m[2]}`,
  },
  {
    id: 'readme.pages',
    file: 'README.md',
    fills: '--pages-url (or the GitLab Pages API)',
    pattern: /^(\| 🪦 Probation Board[^|\n]*\| )✏️ GitLab Pages URL( \|)$/m,
    replace: (v, m) => v.pagesUrl && `${m[1]}${link(v.pagesUrl)}${m[2]}`,
  },
  {
    id: 'readme.app',
    file: 'README.md',
    fills: '--app-url',
    pattern: /^(\| 🧾 Tallybook on Cloud Run[^|\n]*\| )✏️ `https:\/\/tallybook-…\.run\.app`( \|)$/m,
    replace: (v, m) => v.appUrl && `${m[1]}${link(v.appUrl)}${m[2]}`,
  },
  {
    id: 'readme.devpost',
    file: 'README.md',
    fills: '--devpost-url',
    pattern: /^(\| 📄 Devpost page[^|\n]*\| )✏️ link( \|)$/m,
    replace: (v, m) => v.devpostUrl && `${m[1]}[Devpost](${v.devpostUrl})${m[2]}`,
  },
  {
    id: 'readme.sci-burial',
    file: 'README.md',
    fills: "Total SCI Δ from the dependency burial MR's 🌱 note",
    pattern: /✏️ Measured result from the dependency burial: SCI −X% \(copy from that MR's 🌱 note\)\./,
    replace: (v) =>
      v.burial?.totalPct === undefined
        ? undefined
        : `Measured result from the dependency burial: SCI ${fmtPct(v.burial.totalPct)} (the 🌱 note on ${mrLink(v.burial)}).`,
  },
  {
    id: 'submission.name',
    file: SUB,
    fills: '--name: the Name field',
    pattern: /^\*\*Name:\*\* Probation ✏️$/m,
    replace: (v) => v.name && `**Name:** ${v.name}`,
  },
  {
    id: 'submission.working-title',
    file: SUB,
    fills: '--name: drops the "working title" sentences from the top note',
    pattern:
      / Pick the final name yourself \(the FAQ asks for a human-chosen name, not an AI-chosen one\)\. "Probation" is a working title\./,
    replace: (v) => (v.name ? '' : undefined),
  },
  {
    id: 'submission.repo',
    file: SUB,
    fills: '--repo-url (or the GitLab project web_url)',
    pattern: /^- ✏️ GitLab repo$/m,
    replace: (v) => v.repoUrl && `- GitLab repo: ${v.repoUrl}`,
  },
  {
    id: 'submission.app',
    file: SUB,
    fills: '--app-url',
    pattern: /^- ✏️ Tallybook on Cloud Run$/m,
    replace: (v) => v.appUrl && `- Tallybook on Cloud Run: ${v.appUrl}`,
  },
  {
    id: 'submission.pages',
    file: SUB,
    fills: '--pages-url (or the GitLab Pages API)',
    pattern: /^- ✏️ Probation Board \(GitLab Pages\)$/m,
    replace: (v) => v.pagesUrl && `- Probation Board (GitLab Pages): ${v.pagesUrl}`,
  },
  {
    id: 'submission.video',
    file: SUB,
    fills: '--video-url',
    pattern: /^- ✏️ YouTube video \(under 3 minutes\)$/m,
    replace: (v) => v.videoUrl && `- YouTube video (under 3 minutes): ${v.videoUrl}`,
  },
  {
    id: 'submission.replay',
    file: SUB,
    fills: '--pages-url + /replay.html',
    pattern:
      /^- ✏️ Ledger replay \(`replay\.html` on the Pages site; (a 30-second recording is in `docs\/media\/replay\.webm`)\)$/m,
    replace: (v, m) =>
      v.pagesUrl && `- Ledger replay: ${v.pagesUrl.replace(/\/+$/, '')}/replay.html (${m[1]})`,
  },
  {
    id: 'submission.burial-size',
    file: SUB,
    fills: 'deployable size before → after, from the 🌱 note',
    pattern: /app layer ✏️ X MB → ✏️ Y MB/,
    replace: ({ burial: b }) =>
      b?.sizeBefore === undefined || b.sizeAfter === undefined
        ? undefined
        : `deployable size ${b.sizeBefore.toFixed(1)} MB → ${b.sizeAfter.toFixed(1)} MB`,
  },
  {
    id: 'submission.burial-cold',
    file: SUB,
    fills: 'cold start before → after, from the 🌱 note',
    pattern: /cold start ✏️ a ms → ✏️ b ms/,
    replace: ({ burial: b }) =>
      b?.coldBefore === undefined || b.coldAfter === undefined
        ? undefined
        : `cold start ${b.coldBefore} ms → ${b.coldAfter} ms`,
  },
  {
    id: 'submission.burial-sci',
    file: SUB,
    fills: 'Total SCI Δ, from the 🌱 note',
    pattern: /SCI ✏️ −X% \(copy from that MR's 🌱 note\)/,
    replace: ({ burial: b }) =>
      b?.totalPct === undefined ? undefined : `SCI ${fmtPct(b.totalPct)} (the 🌱 note on ${mrLink(b)})`,
  },
  {
    id: 'submission.burial-line',
    file: SUB,
    fills: "the burial line's leading ✏️, once nothing on it is left to fill",
    pattern: /^- ✏️ (Dependency burial \(moment \+ lodash\): (?!.*✏️).*)$/m,
    replace: (_v, m) => `- ${m[1]}`,
  },
  {
    id: 'submission.sci-all',
    file: SUB,
    fills: 'SCI change first → last ledger measurement (board stat)',
    pattern: /^- ✏️ All burials since the first measurement: SCI ✏️ −X% \(board stat "SCI change"\)\.$/m,
    replace: ({ sciChange: s }) =>
      s &&
      `- All burials since the first measurement: SCI ${fmtPct(s.pct)} (board stat "SCI change", ${s.points} measurements from ${s.from} to ${s.to}).`,
  },
];

export interface Change {
  file: string;
  rule: string;
  line: number;
  before: string;
  after: string;
}

/** Applies every rule that has a value. Idempotent: a filled placeholder no longer matches its rule. */
export function applyFills(
  texts: Record<string, string>,
  values: Values,
  rules: FillRule[] = FILL_RULES,
): { texts: Record<string, string>; changes: Change[] } {
  const out = { ...texts };
  const changes: Change[] = [];
  for (const rule of rules) {
    const text = out[rule.file];
    if (text === undefined) continue;
    const m = rule.pattern.exec(text);
    if (!m) continue;
    const replacement = rule.replace(values, m);
    if (replacement === undefined || replacement === m[0]) continue;
    out[rule.file] = text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length);
    // Line numbers refer to the file as it was before this fill, when the matched text is still there.
    const original = texts[rule.file].indexOf(m[0]);
    const at = original >= 0 ? texts[rule.file].slice(0, original) : text.slice(0, m.index);
    changes.push({
      file: rule.file,
      rule: rule.id,
      line: at.split('\n').length,
      before: m[0].replace(/\n+$/, ''),
      after: replacement || '(removed)',
    });
  }
  return { texts: out, changes };
}

// ── Diff ────────────────────────────────────────────────────────────────

/** A unified diff (git style, 3 lines of context) of one file; empty when nothing changed. */
export function unifiedDiff(path: string, a: string, b: string, context = 3): string {
  if (a === b) return '';
  const x = a.split('\n');
  const y = b.split('\n');
  // LCS table; the docs are a few hundred lines, so O(n·m) is fine.
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  type Op = { kind: ' ' | '-' | '+'; text: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) ops.push({ kind: ' ', text: x[i++], ai: i, bi: ++j });
    // Removals before additions, as git prints them.
    else if (i < x.length && (j === y.length || lcs[i + 1][j] >= lcs[i][j + 1]))
      ops.push({ kind: '-', text: x[i++], ai: i, bi: j });
    else ops.push({ kind: '+', text: y[j++], ai: i, bi: j });
  }
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].kind === ' ') {
      k++;
      continue;
    }
    // Grow a hunk while changes are within 2·context lines of each other.
    const start = Math.max(0, k - context);
    let end = k;
    let lastChange = k;
    while (end < ops.length && end - lastChange <= 2 * context) {
      if (ops[end].kind !== ' ') lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const hunk = ops.slice(start, end);
    const aStart = hunk.find((o) => o.kind !== '+')?.ai ?? hunk[0].ai;
    const bStart = hunk.find((o) => o.kind !== '-')?.bi ?? hunk[0].bi;
    const aLen = hunk.filter((o) => o.kind !== '+').length;
    const bLen = hunk.filter((o) => o.kind !== '-').length;
    lines.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of hunk) lines.push(`${o.kind}${o.text}`);
    k = end;
  }
  return `${lines.join('\n')}\n`;
}

// ── Checks ──────────────────────────────────────────────────────────────

/** The 11-character video id of a YouTube watch, youtu.be, shorts or embed URL; undefined for anything else. */
export function youtubeId(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:') return undefined;
  const id = /^[\w-]{11}$/;
  const host = u.hostname.replace(/^(www|m)\./, '');
  if (host === 'youtu.be') {
    const v = u.pathname.slice(1);
    return id.test(v) ? v : undefined;
  }
  if (host !== 'youtube.com') return undefined;
  if (u.pathname === '/watch') {
    const v = u.searchParams.get('v') ?? '';
    return id.test(v) ? v : undefined;
  }
  const m = /^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/.exec(u.pathname);
  return m?.[1];
}

export const YOUTUBE_URL = /https:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/[^\s)>\]]+/g;

export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** LICENSE is the MIT text (first line and grant), which GitLab shows as "MIT License". */
export function isMitLicense(text: string): boolean {
  return /^\s*MIT License\b/.test(text) && text.includes('Permission is hereby granted, free of charge');
}

/** Relative link and image targets of a Markdown doc (scheme URLs and in-page anchors are skipped). */
export function relativeTargets(text: string): { line: number; target: string }[] {
  const out: { line: number; target: string }[] = [];
  let fenced = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    const found = [
      ...line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
      ...line.matchAll(/<(?:img|source|video)[^>]*\ssrc="([^"]+)"/g),
    ];
    for (const m of found) {
      const target = decodeURI(m[1].split('#')[0].split('?')[0]);
      if (target && !/^[a-z]+:/i.test(target)) out.push({ line: i + 1, target });
    }
  });
  return out;
}

/** The Devpost choices the submission text must state, so they are copied over correctly. */
export const DEVPOST_FIELDS: { label: string; pattern: RegExp }[] = [
  { label: 'Path A (Start Fresh)', pattern: /\bA: Start Fresh\b|\bPath A\b/ },
  { label: 'Category: Hands-off', pattern: /\*\*Category:\*\* Hands-off|Category: Hands-off/ },
  { label: 'Most Environmentally Impactful opt-in', pattern: /Most Environmentally Impactful/ },
];

export const DEVPOST_REMINDERS = [
  'Devpost: pick Path A (Start Fresh) and the Hands-off category; opt in to Most Environmentally Impactful (and Most Stages Covered).',
  'The GitLab repo is public, LICENSE (MIT) is visible on its overview page, and the CI pipeline history is visible.',
  'The YouTube video is public or unlisted (not private) and under 3 minutes.',
  'Paste the text from docs/SUBMISSION.md; upload the gallery images in its order.',
];
