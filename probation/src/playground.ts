import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ledger } from './ledger.ts';
import type { Policy } from './policy.ts';
import { scriptJson } from './replay.ts';

// Gate playground (playground.html, next to the board): anyone can try the real probation:gate in the
// browser. The page runs the same decide() and gateComment() as CI, bundled by esbuild from gate.ts and
// mr.ts; it never re-implements a rule. renderPlayground is pure; buildPlayground does the I/O.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface PlaygroundFile {
  path: string;
  deleted: boolean;
  added: number;
  removed: number;
}

export interface PlaygroundPreset {
  id: string;
  title: string;
  blurb: string;
  files: PlaygroundFile[];
  // Zone scores laid over the current ledger (the rest of the ledger stays as it is).
  scores?: Record<string, number>;
  checksPassed?: boolean;
  finding?: boolean;
  coroner?: boolean;
}

export const PRESETS: PlaygroundPreset[] = [
  {
    id: 'fax',
    title: 'Bury the fax gateway',
    blurb: 'Delete legacy/fax.ts and unhook it',
    files: [
      { path: 'app/src/legacy/fax.ts', deleted: true, added: 0, removed: 8 },
      { path: 'app/src/legacy/index.ts', deleted: false, added: 0, removed: 2 },
    ],
  },
  {
    id: 'auth',
    title: 'Touch auth',
    blurb: 'Delete a line from the API key check',
    files: [{ path: 'app/src/auth/apiKey.ts', deleted: false, added: 0, removed: 3 }],
  },
  {
    id: 'policy',
    title: 'Edit its own policy',
    blurb: 'Lower the Hands-off threshold',
    files: [{ path: 'probation/policy.yml', deleted: false, added: 1, removed: 1 }],
  },
  {
    id: 'test',
    title: 'Weaken a test',
    blurb: 'Bury v1 code, add a line to its test',
    files: [
      { path: 'app/src/legacy/v1.ts', deleted: false, added: 0, removed: 4 },
      { path: 'app/test/server.test.ts', deleted: false, added: 1, removed: 0 },
    ],
  },
  {
    id: 'handsoff',
    title: 'Hands-off legacy',
    blurb: 'Legacy at 30 points, no human needed',
    files: [{ path: 'app/src/legacy/v1.ts', deleted: false, added: 0, removed: 6 }],
    scores: { legacy: 30 },
  },
  {
    id: 'grow',
    title: 'Grow the codebase',
    blurb: 'Add 12 lines, remove 2',
    files: [{ path: 'app/src/legacy/v1.ts', deleted: false, added: 12, removed: 2 }],
  },
];

// The entry esbuild bundles: only re-exports of the modules the gate CLI itself uses.
const ENTRY = [
  "export { decide, label } from './gate.ts';",
  "export { gateComment } from './mr.ts';",
  "export { levelForScore } from './policy.ts';",
  "export { zoneFor } from './zones.ts';",
].join('\n');

export const BUNDLE_GLOBAL = 'ProbationGate';

// Bundles the real gate for the browser as an IIFE that sets window.ProbationGate. policy.ts imports
// node:fs and yaml for loadPolicy/parsePolicy, which the page never calls (it embeds the parsed policy):
// they resolve to stubs that throw, and tree shaking drops them.
export async function buildGateBundle(): Promise<string> {
  const { build } = await import('esbuild');
  const result = await build({
    stdin: {
      contents: ENTRY,
      resolveDir: dirname(fileURLToPath(import.meta.url)),
      sourcefile: 'playground-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: BUNDLE_GLOBAL,
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [
      {
        name: 'no-node',
        setup(b) {
          b.onResolve({ filter: /^(node:.*|yaml)$/ }, (a) => ({ path: a.path, namespace: 'no-node' }));
          b.onLoad({ filter: /.*/, namespace: 'no-node' }, (a) => ({
            contents: `const no = () => { throw new Error(${JSON.stringify(`${a.path} is not available in the browser`)}); }; export const readFileSync = no; export const parse = no;`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.out', 'public', 'coverage', 'dist']);

// The repository tree for the file picker: tracked files from git, or a walk when git is missing
// (the pages job's node image may not ship it).
export function repoFiles(root = '.'): string[] {
  try {
    const out = execFileSync('git', ['ls-files'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = out.split('\n').filter(Boolean);
    if (files.length) return files.sort();
  } catch {
    // fall through to the walk
  }
  const walk = (dir: string, rel: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (SKIP_DIRS.has(e.name)) return [];
      const path = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? walk(join(dir, e.name), path) : [path];
    });
  return walk(root, '').sort();
}

// The I/O half: bundle the gate, list the repo, render. Called by the board CLI and the mock flow.
export async function buildPlayground(
  policy: Policy,
  ledger: Ledger,
  generatedAt = new Date().toISOString(),
): Promise<string> {
  return renderPlayground(policy, ledger, repoFiles(), generatedAt, await buildGateBundle());
}

// A bundle inside <script> must not contain `</script` or `<!--`; `<\/` means the same in JS strings and regexes.
export function inlineScript(js: string): string {
  const safe = js.replace(/<\/(script)/gi, '<\\/$1');
  if (safe.includes('<!--')) throw new Error('bundle contains "<!--" and cannot be inlined');
  return safe;
}

const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M8 28V13a8 8 0 0 1 16 0v15z" fill="#1c1a17" stroke="#f4f1ea" stroke-width="1.5"/><path d="M11 14h10M13 18.5h6" stroke="#f4f1ea" stroke-width="2" stroke-linecap="round"/><path d="M4 28.5h24" stroke="#6d675d" stroke-width="2.5" stroke-linecap="round"/></svg>',
)}`;

const TOKENS_LIGHT =
  '--paper:#f4f1ea;--card:#fbf9f4;--ink:#1c1a17;--muted:#6d675d;--line:#d9d3c6;--assisted:#b45309;--supervised:#1d4ed8;--hands:#15803d;--bad:#b91c1c;color-scheme:light';
const TOKENS_DARK =
  '--paper:#12110f;--card:#1a1916;--ink:#ebe6db;--muted:#9c958a;--line:#2d2a25;--assisted:#f59e0b;--supervised:#60a5fa;--hands:#4ade80;--bad:#f87171;color-scheme:dark';

const STYLE = `
:root{${TOKENS_LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${TOKENS_DARK}}}
:root[data-theme="dark"]{${TOKENS_DARK}}
:root[data-theme="light"]{${TOKENS_LIGHT}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.55 "IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
a{color:inherit}
main{max-width:1040px;margin:0 auto;padding:24px 16px 64px}
.head{display:flex;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;align-items:baseline;padding-bottom:10px;border-bottom:2px solid var(--ink);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.head nav{display:flex;gap:16px;letter-spacing:.06em}
h1{font:600 40px/44px Fraunces,Georgia,serif;margin:24px 0 8px}
h2{font:600 22px/26px Fraunces,Georgia,serif;margin:0 0 12px}
.sub{color:var(--muted);margin:0 0 24px;max-width:72ch}
code{font-family:inherit;overflow-wrap:anywhere}
.cap{color:var(--muted);font-size:12px;line-height:18px}
.presets{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin:0 0 28px;padding:0;list-style:none}
.presets button{width:100%;height:100%;text-align:left;display:flex;flex-direction:column;gap:2px;padding:10px 12px}
.presets b{font-weight:600}.presets span{color:var(--muted);font-size:12px;line-height:16px}
.presets button[aria-pressed="true"]{border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
.grid{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
@media (min-width:900px){.grid{grid-template-columns:minmax(0,11fr) minmax(0,9fr);align-items:start}.inputs{grid-column:1;grid-row:1}.verdict{grid-column:2;grid-row:1;position:sticky;top:16px}}
.inputs{display:grid;gap:16px;min-width:0}
.panel,.verdict{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:16px;min-width:0}
button,input{font:inherit;color:var(--ink)}
button{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px 12px;cursor:pointer;min-height:44px}
button:hover{border-color:var(--muted)}
input[type="text"],input[type="number"]{background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:8px 10px;min-height:44px;min-width:0}
input[type="number"]{width:5.2em;text-align:right}
input[type="checkbox"]{width:18px;height:18px;margin:0;accent-color:var(--ink)}
button:focus-visible,input:focus-visible,a:focus-visible,.table-wrap:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.adder{display:flex;gap:8px}.adder input{flex:1}
label.lbl{display:block;font-weight:600;margin-bottom:6px}
.table-wrap{overflow-x:auto;margin-top:14px;border:1px solid var(--line);border-radius:6px}
table{width:100%;border-collapse:collapse}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
tr:last-child td{border-bottom:0}
th{color:var(--muted);font-weight:400;font-size:12px;white-space:nowrap}
th.num,td.num{text-align:right}
.fp{font-weight:600;overflow-wrap:anywhere}
.fz{font-size:12px;color:var(--muted);margin-top:2px}.fz.forbidden{color:var(--bad)}
.del{display:inline-flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:var(--muted);min-height:24px;cursor:pointer}
.rm{min-width:44px;padding:8px;color:var(--muted)}
.empty-files{margin:14px 0 0;padding:14px;border:1px dashed var(--line);border-radius:6px;color:var(--muted)}
fieldset{border:0;padding:0;margin:16px 0 0}
legend{font-weight:600;padding:0;margin-bottom:6px}
.check{display:flex;align-items:center;gap:10px;min-height:32px;cursor:pointer}
.thresholds{display:flex;gap:6px 16px;flex-wrap:wrap;margin:-4px 0 12px}
.scores{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.zs{border:1px solid var(--line);border-top:4px solid var(--lc,var(--muted));border-radius:6px;padding:8px 10px;background:var(--paper)}
.zs.assisted{--lc:var(--assisted)}.zs.supervised{--lc:var(--supervised)}.zs.hands_off{--lc:var(--hands)}
.zs label{display:block;font-weight:600}
.zs-row input{width:4.4em}.zs-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px}
.zs-lvl{white-space:nowrap;font-size:12px;font-weight:600;color:color-mix(in srgb,var(--lc) 90%,var(--ink))}
.row-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.verdict{border-left:6px solid var(--vc,var(--muted))}
.verdict.block{--vc:var(--bad)}.verdict.needs_human{--vc:var(--assisted)}.verdict.merge_supervised{--vc:var(--supervised)}.verdict.merge_hands_off{--vc:var(--hands)}
.vk{color:var(--muted);font-size:12px;letter-spacing:.14em;text-transform:uppercase}
.vline{font:600 30px/34px Fraunces,Georgia,serif;margin:6px 0 4px;color:color-mix(in srgb,var(--vc,var(--ink)) 90%,var(--ink));overflow-wrap:anywhere}
.vnext{margin:0 0 12px}
.vmeta{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0 0 12px;padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.vmeta b{font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;padding:0;list-style:none}
.chip{border:1px solid var(--line);border-left:4px solid var(--lc,var(--muted));border-radius:6px;padding:2px 8px;font-size:12px;background:var(--paper)}
.chip.assisted{--lc:var(--assisted)}.chip.supervised{--lc:var(--supervised)}.chip.hands_off{--lc:var(--hands)}
.reasons{margin:0 0 14px;padding-left:20px}.reasons li{margin:4px 0;overflow-wrap:anywhere}
.reasons code{background:var(--paper);border:1px solid var(--line);border-radius:4px;padding:0 4px}
h3{font-size:12px;font-weight:400;color:var(--muted);letter-spacing:.14em;text-transform:uppercase;margin:16px 0 6px}
.note-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.note-head h3{margin:0}
.note-head button{min-height:32px;padding:4px 10px;font-size:12px}
pre{margin:6px 0 0;padding:12px;background:var(--paper);border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/18px "IBM Plex Mono",ui-monospace,monospace}
details{margin-top:12px}summary{cursor:pointer;color:var(--muted);font-size:12px;min-height:24px}
summary:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.empty{color:var(--muted);margin:8px 0 0}
.empty b{display:block;font:600 22px/26px Fraunces,Georgia,serif;color:var(--ink);margin-bottom:6px}
footer{margin-top:40px;color:var(--muted);font-size:12px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media (max-width:480px){h1{font-size:32px;line-height:36px}.vline{font-size:26px;line-height:30px}th,td{padding:8px 6px}input[type="number"]{width:3.8em;padding:8px 4px}}
@media (prefers-reduced-motion:no-preference){.presets li,.panel,.verdict{animation:rise .4s cubic-bezier(.2,.8,.2,1) both}.verdict.changed .vbody{animation:rise .4s cubic-bezier(.2,.8,.2,1) both}@keyframes rise{from{opacity:0;transform:translateY(6px)}}}
`;

// The page script: state in, real gate out. DOM APIs and textContent only (never innerHTML), plain JS,
// no template strings in here. window.ProbationGate is the esbuild bundle of gate.ts and mr.ts.
const SCRIPT = `
(() => {
  const G = window.${BUNDLE_GLOBAL};
  const data = JSON.parse(document.getElementById('pg-data').textContent);
  const policy = data.policy;
  const agent = data.agent;
  const root = document.documentElement;
  const q = new URLSearchParams(location.search);
  if (q.get('theme') === 'dark' || q.get('theme') === 'light') root.dataset.theme = q.get('theme');
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const BT = String.fromCharCode(96);
  // Gate reasons are Markdown for the MR note; render code spans and bold as elements, never as HTML.
  const md = (parent, text) => {
    const parts = text.split(new RegExp('(' + BT + '[^' + BT + ']+' + BT + '|\\\\*\\\\*[^*]+\\\\*\\\\*)'));
    for (const p of parts) {
      if (!p) continue;
      if (p.startsWith(BT) && p.endsWith(BT) && p.length > 1) parent.append(el('code', '', p.slice(1, -1)));
      else if (p.startsWith('**') && p.endsWith('**') && p.length > 3) parent.append(el('b', '', p.slice(2, -2)));
      else parent.append(document.createTextNode(p));
    }
  };
  const scored = policy.zones.filter((z) => !z.forbidden && !z.neutral).map((z) => z.name);
  const VERDICT = {
    block: ['\\u26d4 Blocked', 'The gate job fails. Nothing merges; the MR waits for a human or is closed.'],
    needs_human: ['\\ud83e\\uddd1\\u200d\\u2696\\ufe0f Needs a human', 'A human must approve and merge. Surviving production earns trust.'],
    merge_supervised: ['\\ud83d\\udfe1 Merge, supervised', 'The gate sets auto-merge; promotion to production waits for a human.'],
    merge_hands_off: ['\\ud83d\\udfe2 Merge, hands-off', 'The gate sets auto-merge; canary, soak and promotion run with no human.'],
  };
  const clampInt = (v) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 0;
  };
  const state = { files: [], scores: {}, checks: true, finding: false, coroner: false, preset: '' };
  const ledgerScores = () => {
    const s = {};
    for (const z of scored) s[z] = clampInt((data.scores || {})[z]);
    return s;
  };

  // Zone of a path, as the gate classifies it (first matching glob in policy.yml).
  const zoneText = (path) => {
    const z = G.zoneFor(policy, path);
    if (!z) return ['outside every zone', 'forbidden'];
    if (z.forbidden) return [z.name + ' \\u00b7 forbidden', 'forbidden'];
    if (z.neutral) return [z.name + ' \\u00b7 neutral (tests)', ''];
    return [z.name + ' \\u00b7 earns trust', ''];
  };

  const scoreInputs = {};
  const buildScores = () => {
    const box = $('scores');
    for (const z of scored) {
      const card = el('div', 'zs');
      const id = 'score-' + z;
      const lab = el('label', '', z);
      lab.htmlFor = id;
      const row = el('div', 'zs-row');
      const input = el('input');
      input.type = 'number';
      input.id = id;
      input.min = '0';
      input.step = '5';
      input.inputMode = 'numeric';
      const lvl = el('span', 'zs-lvl');
      lvl.id = id + '-lvl';
      input.setAttribute('aria-describedby', lvl.id);
      input.addEventListener('input', () => {
        state.scores[z] = clampInt(input.value);
        custom();
        update();
      });
      row.append(input, lvl);
      card.append(lab, row);
      box.append(card);
      scoreInputs[z] = { input, lvl, card };
    }
  };
  const syncScores = () => {
    for (const z of scored) {
      const s = scoreInputs[z];
      if (document.activeElement !== s.input) s.input.value = String(state.scores[z]);
      const level = G.levelForScore(policy, state.scores[z]);
      s.card.className = 'zs ' + level;
      s.lvl.textContent = G.label(level);
    }
  };

  const renderFiles = () => {
    const body = $('files');
    body.replaceChildren();
    $('files-wrap').hidden = !state.files.length;
    $('files-empty').hidden = state.files.length > 0;
    state.files.forEach((f, i) => {
      const tr = el('tr');
      const td = el('td');
      // Break long paths after a slash, not mid-name.
      const fp = el('div', 'fp');
      f.path.split('/').forEach((seg, k, all) => { fp.append(document.createTextNode(seg + (k < all.length - 1 ? '/' : ''))); if (k < all.length - 1) fp.append(el('wbr')); });
      td.append(fp);
      const zt = zoneText(f.path);
      td.append(el('div', 'fz ' + zt[1], zt[0]));
      const del = el('label', 'del');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = f.deleted;
      cb.addEventListener('change', () => { f.deleted = cb.checked; custom(); update(); });
      del.append(cb, document.createTextNode('file deleted'));
      td.append(del);
      tr.append(td);
      for (const key of ['added', 'removed']) {
        const c = el('td', 'num');
        const n = el('input');
        n.type = 'number';
        n.min = '0';
        n.inputMode = 'numeric';
        n.value = String(f[key]);
        n.setAttribute('aria-label', 'Lines ' + key + ' in ' + f.path);
        n.addEventListener('input', () => { f[key] = clampInt(n.value); custom(); update(); });
        c.append(n);
        tr.append(c);
      }
      const rc = el('td', 'num');
      const rm = el('button', 'rm', '\\u2715');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove ' + f.path);
      rm.addEventListener('click', () => {
        state.files.splice(i, 1);
        custom();
        renderFiles();
        update();
        const next = document.querySelectorAll('#files .rm')[Math.min(i, state.files.length - 1)];
        (next || $('path')).focus();
      });
      rc.append(rm);
      tr.append(rc);
      body.append(tr);
    });
  };

  const addFile = () => {
    const input = $('path');
    const path = input.value.trim().replace(/^\\.?\\/+/, '');
    if (!path) { input.focus(); return; }
    const at = state.files.findIndex((f) => f.path === path);
    if (at < 0) {
      state.files.push({ path, deleted: false, added: 0, removed: 1 });
      custom();
      renderFiles();
      update();
    }
    input.value = '';
    const rows = document.querySelectorAll('#files tr');
    const row = rows[at < 0 ? rows.length - 1 : at];
    // Focus the new row's "removed" count: the number the visitor most likely sets next.
    if (row) row.querySelectorAll('input[type="number"]')[1].focus();
  };

  const custom = () => {
    if (!state.preset) return;
    state.preset = '';
    syncPresets();
  };
  const syncPresets = () => {
    for (const b of document.querySelectorAll('[data-preset]')) b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset));
  };
  const applyPreset = (id) => {
    const p = data.presets.find((x) => x.id === id);
    if (!p) return;
    state.files = p.files.map((f) => Object.assign({}, f));
    state.scores = Object.assign(ledgerScores(), p.scores || {});
    state.checks = p.checksPassed !== false;
    state.finding = !!p.finding;
    state.coroner = !!p.coroner;
    state.preset = id;
    $('checks').checked = state.checks;
    $('finding').checked = state.finding;
    $('coroner').checked = state.coroner;
    syncPresets();
    renderFiles();
    update();
  };

  // Exactly what probation:gate passes to decide(), built from the page state.
  const gateInput = () => ({
    agent,
    files: state.files.map((f) => ({ path: f.path, deleted: f.deleted, added: f.added, removed: f.removed })),
    introducedFindings: state.finding ? [{ fingerprint: 'playground', severity: 'High', name: 'simulated SAST finding' }] : [],
    checksPassed: state.checks,
    coronerObjection: state.coroner ? 'see the coroner note on this MR' : undefined,
  });

  let lastKey = '';
  let announceTimer = 0;
  const announce = (text) => {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { $('status').textContent = text; }, 350);
  };
  const update = () => {
    syncScores();
    const card = $('verdict');
    const has = state.files.length > 0;
    $('v-body').hidden = !has;
    $('v-empty').hidden = has;
    if (!has) {
      card.className = 'verdict';
      if (lastKey !== 'empty') announce('No files in the merge request yet.');
      lastKey = 'empty';
      return;
    }
    const ledger = { version: 1, scores: { [agent]: Object.assign({}, state.scores) }, events: [], graveyard: [] };
    const input = gateInput();
    const d = G.decide(policy, ledger, input);
    const v = VERDICT[d.verdict];
    $('v-line').textContent = v[0];
    $('v-next').textContent = v[1];
    $('v-level').textContent = G.label(d.level);
    $('v-diff').textContent = '\\u2212' + d.linesRemoved + ' / +' + d.linesAdded;
    $('v-zones-n').textContent = String(d.zones.length);
    const chips = $('v-zones');
    chips.replaceChildren();
    for (const z of d.zones) chips.append(el('li', 'chip ' + z.level, z.zone + ' \\u00b7 ' + z.score + ' pts \\u00b7 ' + G.label(z.level)));
    chips.hidden = !d.zones.length;
    const list = $('v-reasons');
    list.replaceChildren();
    for (const r of d.reasons) { const li = el('li'); md(li, r); list.append(li); }
    $('v-reasons-h').textContent = d.verdict === 'block' ? 'Why it is blocked' : 'Why';
    $('note').textContent = G.gateComment(d, 0);
    $('input-json').textContent = JSON.stringify(input, null, 2) + '\\n\\nscores.' + agent + ' = ' + JSON.stringify(state.scores);
    const key = d.verdict + '|' + d.level + '|' + d.reasons.join('|');
    card.className = 'verdict ' + d.verdict;
    if (key !== lastKey) {
      void card.offsetWidth;
      card.classList.add('changed');
      announce('Verdict: ' + v[0].replace(/^\\S+\\s/, '') + '. Level ' + G.label(d.level) + '. ' + d.reasons.length + (d.reasons.length === 1 ? ' reason.' : ' reasons.'));
    }
    lastKey = key;
  };

  buildScores();
  for (const b of document.querySelectorAll('[data-preset]')) b.addEventListener('click', () => applyPreset(b.dataset.preset));
  $('add').addEventListener('click', addFile);
  $('path').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFile(); } });
  $('clear').addEventListener('click', () => { state.files = []; custom(); renderFiles(); update(); $('path').focus(); });
  for (const id of ['checks', 'finding', 'coroner']) $(id).addEventListener('change', () => { state[id] = $(id).checked; custom(); update(); });
  $('load-ledger').addEventListener('click', () => { state.scores = ledgerScores(); custom(); update(); });
  $('zero').addEventListener('click', () => { for (const z of scored) state.scores[z] = 0; custom(); update(); });
  $('copy').addEventListener('click', () => {
    const done = (t) => { $('copy').textContent = t; setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500); };
    try { navigator.clipboard.writeText($('note').textContent).then(() => done('Copied'), () => done('Select and copy')); } catch (e) { done('Select and copy'); }
  });
  $('app').hidden = false;
  state.scores = ledgerScores();
  const first = q.get('preset');
  if (first === 'none') { renderFiles(); update(); }
  else applyPreset(data.presets.some((p) => p.id === first) ? first : data.presets[0].id);
  window.playground = { state, gateInput, applyPreset, decide: () => G.decide(policy, { version: 1, scores: { [agent]: state.scores }, events: [], graveyard: [] }, gateInput()) };
})();
`;

export function renderPlayground(
  policy: Policy,
  ledger: Ledger,
  files: string[],
  generatedAt: string,
  gateBundle: string,
): string {
  const agent = Object.keys(policy.agents)[0];
  const scores = ledger.scores[agent] ?? {};
  const scoredZones = policy.zones.filter((z) => !z.forbidden && !z.neutral);
  const forbidden = policy.zones.filter((z) => z.forbidden).map((z) => z.name);
  const neutral = policy.zones.filter((z) => z.neutral).map((z) => z.name);
  const data = { policy, agent, scores, presets: PRESETS, generatedAt };
  const kb = (gateBundle.length / 1024).toFixed(1);
  const options = files.map((f) => `<option value="${esc(f)}"></option>`).join('');
  const presets = PRESETS.map(
    (p) =>
      `<li><button type="button" data-preset="${esc(p.id)}" aria-pressed="false"><b>${esc(p.title)}</b><span>${esc(p.blurb)}</span></button></li>`,
  ).join('');
  const description = `Try the real probation:gate in your browser: pick files, set lines and per-zone trust, and see the verdict and MR note ${agent} would get.`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gate Playground</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website"><meta property="og:title" content="Probation Gate Playground"><meta property="og:description" content="${esc(description)}">
<meta name="theme-color" content="#f4f1ea" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#12110f" media="(prefers-color-scheme: dark)">
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body><main>
<div class="head"><span>Probation + Undertaker · gate playground</span><nav aria-label="Pages"><a href="index.html">← The board</a><a href="replay.html">Ledger replay</a></nav></div>
<h1>Gate playground</h1>
<p class="sub">Propose a merge request as ${esc(agent)} and see what <code>probation:gate</code> decides. This page runs the same <code>decide()</code> from <code>probation/src/gate.ts</code>, bundled for the browser, against <code>probation/policy.yml</code>. Nothing leaves the page.</p>
<noscript><p class="sub">The playground needs JavaScript to run the gate. The rules are in <code>probation/policy.yml</code>; the decisions so far are on <a href="index.html">the board</a>.</p></noscript>
<div id="app" hidden>
<h2 id="h-presets">Try a case</h2>
<ul class="presets" aria-labelledby="h-presets">${presets}</ul>
<div class="grid">
<section class="verdict" id="verdict" aria-labelledby="h-verdict">
<h2 id="h-verdict" class="vk">What probation:gate decides</h2>
<div id="v-empty" class="empty" hidden><b>No files yet.</b>Add a file to the merge request, or pick a case above. With no files the gate has nothing to judge.</div>
<div id="v-body" class="vbody">
<p class="vline" id="v-line"></p>
<p class="vnext" id="v-next"></p>
<div class="vmeta"><span>Level <b id="v-level"></b></span><span>Diff <b id="v-diff"></b> lines</span><span>Zones <b id="v-zones-n"></b></span></div>
<ul class="chips" id="v-zones" aria-label="Zones touched, with score and level"></ul>
<h3 id="v-reasons-h">Why</h3>
<ul class="reasons" id="v-reasons" aria-labelledby="v-reasons-h"></ul>
<div class="note-head"><h3 id="note-h">MR note the gate posts</h3><button type="button" id="copy">Copy</button></div>
<pre id="note" aria-labelledby="note-h" tabindex="0"></pre>
<details><summary>Gate input (what decide() received)</summary><pre id="input-json"></pre></details>
</div>
</section>
<div class="inputs">
<section class="panel" aria-labelledby="h-mr">
<h2 id="h-mr">The merge request</h2>
<label class="lbl" for="path">Add a file</label>
<div class="adder"><input type="text" id="path" list="repo-files" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="search or type a path…" aria-describedby="path-hint"><button type="button" id="add">Add</button></div>
<datalist id="repo-files">${options}</datalist>
<p class="cap" id="path-hint">${files.length ? `Search ${files.length} files from the repository tree, or type any path.` : 'No repository file list was embedded; type any path.'} A path outside every zone blocks the MR.</p>
<div class="table-wrap" id="files-wrap" hidden><table><thead><tr><th scope="col">File</th><th scope="col" class="num">Added</th><th scope="col" class="num">Removed</th><th scope="col"><span class="sr">Remove</span></th></tr></thead><tbody id="files"></tbody></table></div>
<p class="empty-files" id="files-empty">No files in this merge request yet.</p>
<div class="row-btns"><button type="button" id="clear">Clear files</button></div>
<fieldset><legend>Pipeline signals</legend>
<label class="check"><input type="checkbox" id="checks" checked> verify and secure checks passed</label>
<label class="check"><input type="checkbox" id="finding"> introduces a new security finding</label>
<label class="check"><input type="checkbox" id="coroner"> the coroner objected</label>
</fieldset>
</section>
<section class="panel" aria-labelledby="h-ledger">
<h2 id="h-ledger">Trust ledger</h2>
<p class="cap thresholds"><span>Supervised ≥ ${policy.levels.supervised} pts</span><span>Hands-off ≥ ${policy.levels.hands_off} pts</span><span>MR level = lowest zone touched</span></p>
<div class="scores" id="scores"></div>
<p class="cap">${scoredZones.length} zones earn trust. ${forbidden.length ? `Forbidden at any score: ${esc(forbidden.join(', '))}. ` : ''}${neutral.length ? `Neutral (never scored): ${esc(neutral.join(', '))}.` : ''}</p>
<div class="row-btns"><button type="button" id="load-ledger">Load current ledger</button><button type="button" id="zero">All zero (day one)</button></div>
</section>
</div>
</div>
</div>
<p class="sr" id="status" role="status" aria-live="polite"></p>
<footer>Generated ${esc(generatedAt.slice(0, 16).replace('T', ' '))} UTC. Decided in your browser by <code>probation/src/gate.ts</code> (bundled, ${kb} KB) from <code>probation/policy.yml</code>; current scores from the <code>ledger</code> branch.</footer>
</main>
<script type="application/json" id="pg-data">${scriptJson(data)}</script>
<script>${inlineScript(gateBundle)}</script>
<script>${SCRIPT}</script>
</body></html>`;
}
