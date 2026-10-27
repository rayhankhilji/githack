// render-video — builds the FALLBACK demo video from real artifacts, for when live GitLab/Cloud Run footage fails.
// Usage: node scripts/render-video.ts [--capture-only | --reuse-clips]
// Writes docs/media/demo-rough-cut.mp4 (1920×1080 H.264, silent, captions burned in) and demo-rough-cut.srt.
// Every terminal scene is the real stdout of a real command: `npm run demo:mock`, the Probation CLIs and
// `npm run demo -- status` spawned against the in-memory GitLab API simulator (probation/sim), seeded the way
// probation/test/e2e/story.test.ts seeds it. Cards, the replay clip and the diagrams come from docs/media/.
// A persistent label says it is an offline rehearsal. There is no narration (no local TTS); captions carry it.
// Uses the globally installed playwright + Chromium (resolved from `npm root -g`) and the system ffmpeg.
// Intermediate files go to .out/video/ (gitignored). Takes about 3 minutes.
import { execFile, execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import {
  createMr,
  type FakeGitLab,
  type FakeIssue,
  fileOn,
  mergeMr,
  start,
} from '../probation/sim/gitlab-fake.ts';
import type { MrDiff } from '../probation/src/gitlab.ts';

const ROOT = process.cwd();
const W = 1920;
const H = 1080;
const FPS = 30;
const WORK = resolve('.out/video');
const MEDIA = 'docs/media';
const OUT_MP4 = join(MEDIA, 'demo-rough-cut.mp4');
const OUT_SRT = join(MEDIA, 'demo-rough-cut.srt');
const LABEL = 'Offline rehearsal · GitLab API simulator + mock ledger · live runs: see repo';

// ---------------------------------------------------------------- 1. capture real stdout

interface Shell {
  cmd: string; // what the viewer sees after the prompt
  out: string; // the command's real output (stdout, then stderr)
  note?: boolean; // a `#` narration line between commands, not a command
}

function cliEnv(fake: FakeGitLab, vars: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    CI_API_V4_URL: fake.url,
    CI_PROJECT_ID: fake.state.projectId,
    GITLAB_PROBATION_TOKEN: fake.state.projectToken,
    CI_DEFAULT_BRANCH: 'main',
    ...vars,
  };
}

function run(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  mayFail = false,
): Promise<string> {
  return new Promise((done, fail) => {
    execFile(process.execPath, [file, ...args], { cwd, env, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error && !mayFail) fail(new Error(`${file} ${args.join(' ')} failed\n${stdout}\n${stderr}`));
      else done(`${stdout}${stderr}`.replace(/\s+$/, ''));
    });
  });
}

const minus = (n: number) => Array.from({ length: n }, (_, i) => `-dead line ${i}`).join('\n');
const deleted = (path: string, n: number): MrDiff => ({
  old_path: path,
  new_path: path,
  deleted_file: true,
  diff: `@@ -1,${n} +0,0 @@\n${minus(n)}\n`,
});
const edited = (path: string, n: number): MrDiff => ({
  old_path: path,
  new_path: path,
  deleted_file: false,
  diff: `@@ -1,${n + 1} +1,1 @@\n context\n${minus(n)}\n`,
});

// The census fixture from the e2e story: live routes only, so every legacy route is a grave.
function censusLog(): string {
  const live = [
    'GET /',
    'GET /api/invoices',
    'GET /api/invoices/:id',
    'POST /api/invoices',
    'POST /api/invoices/:id/pay',
    'GET /api/invoices/:id/pdf',
    'GET /healthz',
  ];
  return Array.from({ length: 210 }, (_, i) => {
    const [method, route] = live[i % live.length].split(' ');
    return JSON.stringify({ census: 1, method, route, status: 200, flags: { newTotals: true } });
  }).join('\n');
}

export interface Captured {
  repo: Shell[];
  census: Shell[];
  dig: Shell[];
  act1: Shell[];
  mock: string;
  act4gate: Shell[];
  act4settle: Shell[];
  noteAssisted: { title: string; iid: number; body: string };
  noteHandsOff: { title: string; iid: number; body: string };
}

async function capture(): Promise<Captured> {
  const sh = (cmd: string) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).replace(/\s+$/, '');
  const repo: Shell[] = [
    { cmd: 'ls app/src/legacy app/src/flags', out: sh('ls app/src/legacy app/src/flags') },
    {
      cmd: 'wc -l app/src/legacy/*.ts app/src/flags/*.ts',
      out: sh('wc -l app/src/legacy/*.ts app/src/flags/*.ts'),
    },
    {
      cmd: `grep -nE '"(moment|lodash)"' app/package.json`,
      out: sh(`grep -nE '"(moment|lodash)"' app/package.json`),
    },
  ];

  const mock = execFileSync(process.execPath, ['scripts/mock-flow.ts'], { encoding: 'utf8' }).replace(
    /\s+$/,
    '',
  );

  // A scratch CI checkout, as in the e2e story: CLIs read app/ and probation/ from cwd and write .out/.
  const ws = join(WORK, 'ci');
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(join(ws, '.out'), { recursive: true });
  symlinkSync(join(ROOT, 'app'), join(ws, 'app'));
  symlinkSync(join(ROOT, 'probation'), join(ws, 'probation'));
  writeFileSync(join(ws, '.out/census-log.json'), censusLog());

  const fake = await start();
  const s = fake.state;
  const cli = (name: string, args: string[] = [], vars: Record<string, string> = {}, mayFail = false) =>
    run(join(ROOT, 'probation/src/cli', `${name}.ts`), args, ws, cliEnv(fake, vars), mayFail);
  const demo = (...args: string[]) =>
    run(
      join(ROOT, 'scripts/demo.ts'),
      args,
      ROOT,
      {
        PATH: process.env.PATH,
        GITLAB_API_URL: fake.url,
        GITLAB_PROJECT: s.project.path,
        GITLAB_TOKEN: s.userToken,
      },
      true,
    );
  const issueFor = (key: string) =>
    s.issues.find((i) => i.description.includes(`<!-- undertaker:key=${key} -->`)) as FakeIssue;
  // `| head -n N` is applied here, so the screen shows exactly what that pipe would print.
  const statusHead = async (n: number): Promise<Shell> => ({
    cmd: `node scripts/demo.ts status | head -n ${n}`,
    out: (await demo('status')).split('\n').slice(0, n).join('\n'),
  });
  const lastNote = (iid: number) =>
    s.notes.filter((n) => n.noteable === 'mr' && n.iid === iid).at(-1)?.body ?? '';

  try {
    const census: Shell[] = [
      { cmd: 'node probation/src/cli/census.ts', out: await cli('census') },
      { cmd: 'node scripts/demo.ts status   # npm run demo -- status', out: await demo('status') },
    ];

    // RUNBOOK §5: steer the story by closing the candidates we don't want yet.
    const fax = issueFor('route:POST /api/fax-invoice');
    for (const i of s.issues) if (i.iid !== fax.iid) i.state = 'closed';
    const dig: Shell[] = [
      {
        cmd: 'node probation/src/cli/start-flow.ts',
        out: await cli('start-flow', [], {
          DUO_FLOW_TRIGGER_TOKEN: s.userToken,
          UNDERTAKER_CONSUMER_ID: 'gid://gitlab/Ai::Catalog::ItemConsumer/4211',
        }),
      },
    ];
    // The Duo flow itself runs on GitLab; the simulator stands in for the MR it opens.
    const mr1 = createMr(s, {
      title: 'Draft: Bury the fax gateway (vendor dead since 2024)',
      labels: ['undertaker'],
      description: `Here lies POST /api/fax-invoice. The vendor died in 2024.\n\nCloses #${fax.iid}`,
      diffs: [deleted('app/src/legacy/fax.ts', 8), edited('app/src/legacy/index.ts', 2)],
    });
    dig.push({
      cmd: `# the Undertaker flow opens MR !${mr1.iid} (simulated: the Duo flow runs on GitLab)`,
      out: '',
      note: true,
    });
    const gate1 = await cli('gate', [], {
      CI_MERGE_REQUEST_IID: String(mr1.iid),
      CI_COMMIT_SHA: mr1.sha,
      CI_PIPELINE_ID: '101',
    });
    dig.push({ cmd: 'node probation/src/cli/gate.ts', out: gate1 });
    if (!gate1)
      dig.push({ cmd: '# no stdout: the gate labelled the MR and posted its note', out: '', note: true });
    const noteAssisted = { title: mr1.title, iid: mr1.iid, body: lastNote(mr1.iid) };

    // A human approves and merges the Assisted MR; the release child pipeline plans and settles.
    const act1: Shell[] = [
      { cmd: `# a human approves and merges !${mr1.iid}; canary + soak pass`, out: '', note: true },
    ];
    const actRelease = async (
      iid: number,
      outcome: 'survived' | 'rolled_back',
      pipeline: number,
      into: Shell[],
    ) => {
      const sha = mergeMr(s, iid);
      into.push({
        cmd: 'node probation/src/cli/release-plan.ts',
        out: await cli('release-plan', [], { CI_COMMIT_SHA: sha }),
      });
      const plan = parse(readFileSync(join(ws, '.out/release.yml'), 'utf8')) as {
        variables: Record<string, string>;
      };
      into.push({
        cmd: `node probation/src/cli/settle.ts --outcome ${outcome}`,
        out: await cli('settle', ['--outcome', outcome], {
          ...plan.variables,
          CI_COMMIT_SHA: sha,
          CI_COMMIT_SHORT_SHA: sha.slice(0, 8),
          CI_PIPELINE_ID: String(pipeline),
        }),
      });
    };
    await actRelease(mr1.iid, 'survived', 201, act1);
    act1.push(await statusHead(9));

    // Acts 2 and 3 run silently (the montage uses the mock narrative); they lift legacy to Hands-off.
    const quiet: Shell[] = [];
    for (const [n, key, lines] of [
      [2, 'route:POST /api/v1/sync', 2],
      [3, 'route:GET /api/v1/invoices', 4],
    ] as const) {
      const issue = issueFor(key);
      issue.state = 'opened';
      const mr = createMr(s, {
        title: `Draft: Bury ${key.slice(6)}`,
        labels: ['undertaker'],
        description: `Here lies ${key.slice(6)}.\n\nCloses #${issue.iid}`,
        diffs: [edited('app/src/legacy/v1.ts', lines)],
      });
      await cli('gate', [], {
        CI_MERGE_REQUEST_IID: String(mr.iid),
        CI_COMMIT_SHA: mr.sha,
        CI_PIPELINE_ID: String(100 + n),
      });
      await actRelease(mr.iid, 'survived', 200 + n, quiet);
    }

    // Act 4: Hands-off, no human. The canary soak sees the partner's monthly export 404 and rolls back.
    const exportCsv = issueFor('route:GET /api/v1/export.csv');
    exportCsv.state = 'opened';
    exportCsv.labels = ['undertaker::in-progress', 'zone::legacy', 'kind::route'];
    const mr4 = createMr(s, {
      title: 'Draft: Bury GET /api/v1/export.csv (0 requests in 7d)',
      labels: ['undertaker'],
      description: `Here lies the CSV export: 0 requests in 7d.\n\nCloses #${exportCsv.iid}`,
      diffs: [edited('app/src/legacy/v1.ts', 6), edited('app/test/server.test.ts', 6)],
    });
    const act4gate: Shell[] = [
      {
        cmd: 'node probation/src/cli/gate.ts',
        out: await cli('gate', [], {
          CI_MERGE_REQUEST_IID: String(mr4.iid),
          CI_COMMIT_SHA: mr4.sha,
          CI_PIPELINE_ID: '104',
        }),
      },
    ];
    const noteHandsOff = { title: mr4.title, iid: mr4.iid, body: lastNote(mr4.iid) };
    // The soak signal reads the canary's request log; here a recorded fixture with the partner's 404s.
    const live = (n: number, route: string) =>
      Array.from({ length: n }, () => ({ jsonPayload: { census: 1, method: 'GET', route, status: 200 } }));
    const canary = [
      ...live(40, '/'),
      ...Array.from({ length: 4 }, () => ({
        jsonPayload: { census: 1, method: 'GET', route: 'unmatched', status: 404 },
      })),
    ];
    writeFileSync(join(ws, '.out/canary-log.json'), JSON.stringify(canary));
    writeFileSync(join(ws, '.out/baseline-log.json'), JSON.stringify(live(300, '/api/v1/export.csv')));
    act4gate.push({
      cmd: '# auto-merged · deploy:canary · soak (canary log: recorded fixture)',
      out: '',
      note: true,
    });
    act4gate.push({
      cmd: 'node probation/src/cli/soak.ts --signal .out/canary-log.json --baseline .out/baseline-log.json',
      out: await cli(
        'soak',
        ['--signal', '.out/canary-log.json', '--baseline', '.out/baseline-log.json'],
        { REVISION: 'tallybook-00004-rc' },
        true,
      ),
    });
    const act4settle: Shell[] = [];
    await actRelease(mr4.iid, 'rolled_back', 204, act4settle);
    act4settle.push(await statusHead(9));
    if (!fileOn(s, 'ledger', 'ledger.json')) throw new Error('the story left no ledger');
    return { repo, census, dig, act1, mock, act4gate, act4settle, noteAssisted, noteHandsOff };
  } finally {
    await fake.close();
  }
}

// --reuse-clips keeps the scene clips of an earlier run and only re-assembles (to iterate on captions or timing).
const reuse = process.argv.includes('--reuse-clips');
if (!reuse) rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const captured = await capture();
writeFileSync(join(WORK, 'captured.json'), JSON.stringify(captured, null, 2));
if (process.argv.includes('--capture-only')) {
  console.log(`ok ${join(WORK, 'captured.json')}`);
  process.exit(0);
}

// ---------------------------------------------------------------- 2. render stills with Chromium

// The slice of the playwright API this script uses (playwright's own types are not installed here).
interface Page {
  goto(url: string, o?: { waitUntil?: 'networkidle' }): Promise<unknown>;
  setContent(html: string, o?: { waitUntil?: 'networkidle' }): Promise<void>;
  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  screenshot(o: { path: string; fullPage?: boolean; omitBackground?: boolean }): Promise<unknown>;
  close(): Promise<void>;
}
interface Browser {
  newPage(o: { viewport: { width: number; height: number }; deviceScaleFactor?: number }): Promise<Page>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(o?: { proxy?: { server: string } }): Promise<Browser> };
}

const globalRoot = execSync('npm root -g').toString().trim();
const { chromium } = createRequire(join(globalRoot, 'noop.js'))('playwright') as Playwright;
// Google Fonts are fetched through the session proxy when one is configured.
const proxy = process.env.HTTPS_PROXY;
const browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=IBM+Plex+Mono:wght@400;500;600&display=block" rel="stylesheet">';
// DESIGN_SYSTEM §2 tokens.
const DARK = { paper: '#12110f', card: '#1a1916', ink: '#ebe6db', muted: '#9c958a', line: '#2d2a25' };
const LIGHT = { paper: '#f4f1ea', card: '#fbf9f4', ink: '#1c1a17', muted: '#6d675d', line: '#d9d3c6' };
const LEVEL_DARK = { assisted: '#f59e0b', supervised: '#60a5fa', hands: '#4ade80', bad: '#f87171' };
// Keep scene content clear of the honesty label (top) and the caption bar (bottom).
const SAFE_TOP = 84;
const SAFE_BOTTOM = 190;

const esc = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const page = (body: string, css: string) =>
  `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>*{box-sizing:border-box;margin:0}${css}</style></head><body>${body}</body></html>`;

async function open(
  html: string,
  opts: { width?: number; height?: number; scale?: number } = {},
): Promise<Page> {
  const p = await browser.newPage({
    viewport: { width: opts.width ?? W, height: opts.height ?? H },
    deviceScaleFactor: opts.scale ?? 1,
  });
  await p.setContent(html, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready.then(() => new Promise<void>((r) => setTimeout(r, 300))));
  return p;
}

// Level words and failure words carry their DESIGN_SYSTEM colors in terminal output.
function paint(text: string): string {
  return esc(text).replace(
    /(?<![\w-])(Hands-off|hands_off|Supervised|supervised|Assisted|assisted|survived|FAIL|✖|rolled_back|reverted|-40|−40|404s?)(?![\w-])/g,
    (m) => {
      const c = /^hands|^Hands|survived/.test(m)
        ? LEVEL_DARK.hands
        : /^[Ss]uper/.test(m)
          ? LEVEL_DARK.supervised
          : /^[Aa]ssist/.test(m)
            ? LEVEL_DARK.assisted
            : LEVEL_DARK.bad;
      return `<b style="color:${c};font-weight:600">${m}</b>`;
    },
  );
}

interface TermScene {
  title: string; // window title: what is running
  source: string; // where the output comes from, shown in the title bar
  shells: Shell[];
}

/** Renders a terminal scene as one PNG per reveal step; returns [png, seconds] pairs that fill `seconds`. */
async function terminal(name: string, t: TermScene, seconds: number): Promise<[string, number][]> {
  const lines: { kind: 'cmd' | 'note' | 'out'; text: string }[] = [];
  for (const sh of t.shells) {
    lines.push({ kind: sh.note ? 'note' : 'cmd', text: sh.cmd });
    if (sh.out) for (const l of sh.out.split('\n')) lines.push({ kind: 'out', text: l });
  }
  const css = `
    body{background:${DARK.paper};color:${DARK.ink};font:400 27px/1.45 'IBM Plex Mono',ui-monospace,monospace;width:${W}px;height:${H}px;overflow:hidden}
    .win{position:absolute;left:64px;right:64px;top:${SAFE_TOP}px;bottom:${SAFE_BOTTOM}px;background:${DARK.card};border:1px solid ${DARK.line};border-radius:6px;display:flex;flex-direction:column;overflow:hidden}
    .bar{display:flex;align-items:center;gap:18px;padding:0 24px;height:58px;border-bottom:1px solid ${DARK.line};font-size:21px;color:${DARK.muted};flex:none}
    .dots{display:flex;gap:9px}.dots i{width:13px;height:13px;border-radius:50%;background:${DARK.line};display:block}
    .bar .t{color:${DARK.ink};font-weight:500}.bar .s{margin-left:auto}
    pre{flex:1;margin:0;padding:22px 30px;font:inherit;white-space:pre-wrap;word-break:break-word;overflow:hidden}
    .l{display:none}.l.on{display:block}
    .cmd .p{color:${LEVEL_DARK.hands};font-weight:600}.cmd{color:${DARK.ink};font-weight:500;margin-top:10px}
    .note{color:${DARK.muted};font-style:italic;margin-top:10px}.out{color:#d6d0c4}
    .cur{display:inline-block;width:.6em;height:1.1em;background:${DARK.ink};vertical-align:-.18em;margin-left:2px}`;
  const body = `<div class="win"><div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="t">${esc(
    t.title,
  )}</span><span class="s">${esc(t.source)}</span></div><pre id="t">${lines
    .map(
      (l, i) =>
        `<div class="l ${l.kind}" id="l${i}" data-text="${esc(l.text)}">${
          l.kind === 'out'
            ? paint(l.text) || ' '
            : `<span class="p">${l.kind === 'cmd' ? '$ ' : ''}</span><span class="c"></span>`
        }</div>`,
    )
    .join(
      '',
    )}<div class="l on" id="end"><span class="p" style="color:${LEVEL_DARK.hands};font-weight:600">$ </span><span class="cur"></span></div></pre></div>`;
  const p = await open(page(body, css));

  // Steps: type each command in four strokes, then print its output a few lines per beat.
  type Step = { n: number; typed?: number; dur: number };
  const steps: Step[] = [{ n: 0, dur: 0.6 }];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.kind !== 'out') {
      for (const f of [0.25, 0.5, 0.75, 1])
        steps.push({ n: i, typed: Math.ceil(l.text.length * f), dur: 0.09 });
      steps.push({ n: i + 1, dur: l.kind === 'cmd' ? 0.45 : 0.6 });
    } else {
      const last = steps.at(-1) as Step;
      // Batch fast output: about 14 lines a second.
      if (last.typed === undefined && last.dur < 0.14 && last.n === i) last.n = i + 1;
      else steps.push({ n: i + 1, dur: 0.07 });
    }
  }
  const used = steps.reduce((a, s) => a + s.dur, 0);
  const hold = seconds - used;
  if (hold < 1.5)
    throw new Error(`terminal ${name}: ${used.toFixed(1)} s of typing does not fit in ${seconds} s`);
  (steps.at(-1) as Step).dur += hold;

  const out: [string, number][] = [];
  for (const [k, st] of steps.entries()) {
    await p.evaluate(
      ({ n, typed }) => {
        const all = document.querySelectorAll<HTMLElement>('.l:not(#end)');
        all.forEach((el, i) => {
          const on = i < n || (i === n && typed !== undefined);
          el.classList.toggle('on', on);
          const c = el.querySelector<HTMLElement>('.c');
          if (c)
            c.textContent =
              i === n && typed !== undefined
                ? (el.dataset.text ?? '').slice(0, typed)
                : (el.dataset.text ?? '');
        });
        const end = document.getElementById('end') as HTMLElement;
        end.style.display = typed === undefined ? 'block' : 'none';
        const cur = document.querySelector('.cur') as HTMLElement;
        if (typed !== undefined) all[n].querySelector('.c')?.after(cur);
        else end.append(cur);
        const pre = document.getElementById('t') as HTMLElement;
        pre.scrollTop = pre.scrollHeight;
      },
      { n: st.n, typed: st.typed },
    );
    const png = join(WORK, `${name}-${String(k).padStart(3, '0')}.png`);
    await p.screenshot({ path: png });
    out.push([png, st.dur]);
  }
  await p.close();
  return out;
}

/** A gate note as it appears on the MR: a GitLab-style comment rendered from the note's Markdown. */
async function mrNote(
  name: string,
  note: { title: string; iid: number; body: string },
  labels: string[],
): Promise<string> {
  const md = (t: string) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/&lt;sub&gt;(.*)&lt;\/sub&gt;/, '<small>$1</small>');
  const blocks: string[] = [];
  let list: string[] = [];
  for (const line of [...note.body.split('\n'), '']) {
    if (line.startsWith('- ')) list.push(`<li>${md(line.slice(2))}</li>`);
    else {
      if (list.length) blocks.push(`<ul>${list.join('')}</ul>`);
      list = [];
      if (line.trim()) blocks.push(`<p>${md(line)}</p>`);
    }
  }
  const pill = (l: string) => {
    const c = l.includes('hands') ? '#15803d' : l.includes('assisted') ? '#b45309' : LIGHT.muted;
    return `<span class="pill" style="border-color:${c};color:${c}">${esc(l)}</span>`;
  };
  const css = `
    body{background:${LIGHT.paper};color:${LIGHT.ink};font:400 26px/1.5 'IBM Plex Mono',ui-monospace,monospace;width:${W}px;height:${H}px;overflow:hidden}
    .wrap{position:absolute;left:180px;right:180px;top:${SAFE_TOP + 26}px}
    .kicker{font-size:20px;letter-spacing:.14em;text-transform:uppercase;color:${LIGHT.muted}}
    h1{font:600 52px/1.15 Fraunces,Georgia,serif;margin:12px 0 14px}
    .meta{display:flex;gap:12px;align-items:center;margin-bottom:28px;font-size:21px;color:${LIGHT.muted}}
    .pill{border:1.5px solid;border-radius:999px;padding:2px 14px;font-size:19px;font-weight:500}
    .note{background:${LIGHT.card};border:1px solid ${LIGHT.line};border-radius:6px}
    .head{display:flex;gap:16px;align-items:center;padding:18px 28px;border-bottom:1px solid ${LIGHT.line};font-size:22px;color:${LIGHT.muted}}
    .av{width:44px;height:44px;border-radius:50%;background:${LIGHT.ink};color:${LIGHT.paper};display:grid;place-items:center;font-weight:600;font-size:18px}
    .head b{color:${LIGHT.ink}}
    .body{padding:24px 34px 28px}.body p{margin:0 0 16px}.body ul{margin:0 0 16px;padding-left:34px}
    code{font:inherit;background:#ece7dc;border-radius:4px;padding:0 6px}
    small{font-size:20px;color:${LIGHT.muted};display:block;margin-top:8px}`;
  const body = `<div class="wrap"><div class="kicker">MR !${note.iid} · gate note · posted by probation/src/cli/gate.ts (gateComment) to the GitLab API simulator</div>
    <h1>${esc(note.title)}</h1><div class="meta">${labels.map(pill).join('')}<span>undertaker → main</span></div>
    <div class="note"><div class="head"><span class="av">PB</span><b>Probation bot</b><span>@probation-bot · just now</span></div>
    <div class="body">${blocks.join('')}</div></div></div>`;
  const p = await open(page(body, css));
  const png = join(WORK, `${name}.png`);
  await p.screenshot({ path: png });
  await p.close();
  return png;
}

/** The Probation Board from the mock ledger (`.out/board.html`, written by demo:mock), at 1920 px wide. */
async function board(): Promise<{ png: string; height: number; boxes: Record<string, [number, number]> }> {
  // Same 1100 px layout as docs/media/board-light.png, rendered at 1920/1100 scale so it is sharp at 1080p.
  const scale = W / 1100;
  const p = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: scale });
  await p.goto(pathToFileURL(resolve('.out/board.html')).href, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready.then(() => new Promise<void>((r) => setTimeout(r, 300))));
  const css = await p.evaluate(() => {
    const box = (el: Element | null | undefined): [number, number] => {
      const r = (el as Element).getBoundingClientRect();
      return [r.top + window.scrollY, r.bottom + window.scrollY];
    };
    const h2 = (t: string) => [...document.querySelectorAll('h2')].find((h) => h.textContent?.startsWith(t));
    const chartTop = box(h2('Trust over time'))[0];
    const chartEnd = box(h2('Graveyard'))[0];
    return {
      stats: [box(document.querySelector('h1'))[0], box(h2('Autonomy by zone'))[0]] as [number, number],
      chart: [chartTop, chartEnd] as [number, number],
      height: document.documentElement.scrollHeight,
    };
  });
  const png = join(WORK, 'board.png');
  await p.screenshot({ path: png, fullPage: true });
  await p.close();
  const px = ([a, b]: [number, number]): [number, number] => [Math.round(a * scale), Math.round(b * scale)];
  return {
    png,
    height: Math.round(css.height * scale),
    boxes: { stats: px(css.stats), chart: px(css.chart) },
  };
}

/** Transparent full-frame overlays: the caption bar and the honesty label. */
async function overlay(name: string, html: string): Promise<string> {
  const css = `html,body{background:transparent;width:${W}px;height:${H}px;overflow:hidden}
    .cap{position:absolute;left:50%;bottom:50px;transform:translateX(-50%);width:max-content;max-width:1840px;white-space:nowrap;
      background:rgba(18,17,15,.9);color:#f4f1ea;font:500 34px/1.38 'IBM Plex Mono',ui-monospace,monospace;padding:14px 30px;border-radius:6px}
    .label{position:absolute;top:16px;right:22px;background:rgba(18,17,15,.82);color:#ebe6db;border:1px solid rgba(235,230,219,.28);
      font:500 19px/1 'IBM Plex Mono',ui-monospace,monospace;padding:9px 14px;border-radius:4px;display:flex;gap:10px;align-items:center}
    .label i{width:10px;height:10px;border-radius:50%;background:#f59e0b;display:block}`;
  const p = await open(page(html, css));
  const png = join(WORK, `${name}.png`);
  await p.screenshot({ path: png, omitBackground: true });
  await p.close();
  return png;
}

// ---------------------------------------------------------------- 3. the cut (docs/DEMO_SCRIPT.md order and timing)

type Source =
  | { kind: 'card'; png: string }
  | { kind: 'term'; term: TermScene }
  | { kind: 'note'; note: Captured['noteAssisted']; labels: string[] }
  | { kind: 'replay'; from: number }
  | { kind: 'board'; region: 'stats' | 'chart' }
  | { kind: 'diagram'; png: string; zoom: number; focus?: [number, number] };
interface Scene {
  name: string;
  dur: number;
  src: Source;
  caps: string[]; // voice-over lines, shown in order across the scene
}

const c = captured;
const card = (n: string): Source => ({ kind: 'card', png: join(MEDIA, 'cards/png', `${n}.png`) });
const SIM = 'real CLI stdout · GitLab API simulator (probation/sim)';
const mockLines = c.mock.split('\n');
const m2 = mockLines.findIndex((l) => l.startsWith('!2 ')) + 1;
const m4 = mockLines.findIndex((l) => l.startsWith('!4 ')) - 1;

const scenes: Scene[] = [
  { name: '01-hook', dur: 4, src: card('01-hook'), caps: [] },
  {
    name: 'board-chart',
    dur: 8,
    src: { kind: 'board', region: 'chart' },
    caps: [
      'Code generation is solved. But nobody lets an AI delete code,',
      'and nobody lets an AI ship to production alone. So we put one on probation.',
    ],
  },
  {
    name: 'repo',
    dur: 16,
    src: {
      kind: 'term',
      term: { title: 'tallybook · the repo', source: 'real shell output', shells: c.repo },
    },
    caps: [
      'This is Tallybook, an invoicing app with years of debt:',
      'dead API versions, stale flags, unused packages.',
      'Every line costs build time, image size, cold starts, and carbon.',
    ],
  },
  {
    name: 'census',
    dur: 20,
    src: {
      kind: 'term',
      term: { title: 'census:collect', source: `${SIM} · request log: fixture`, shells: c.census },
    },
    caps: [
      "Every night a census reads Cloud Run's request logs",
      'and files a grave for each piece of code that production proves is dead.',
      'Evidence, not guesses.',
    ],
  },
  {
    name: 'architecture',
    dur: 6,
    // Push in on rows 1–2: the Duo flow that only deletes, and the gate that decides.
    src: { kind: 'diagram', png: join(MEDIA, 'diagrams/architecture.png'), zoom: 0.5, focus: [960, 380] },
    caps: ['Undertaker is a GitLab Duo flow that can only delete.'],
  },
  {
    name: 'dig',
    dur: 8,
    src: { kind: 'term', term: { title: 'census:dig → MR pipeline', source: SIM, shells: c.dig } },
    caps: ['It digs the grave, opens a minimal MR, then a coroner step attacks its own work.'],
  },
  {
    name: 'note-assisted',
    dur: 7,
    src: {
      kind: 'note',
      note: c.noteAssisted,
      labels: ['undertaker', 'probation::assisted', 'zone::legacy'],
    },
    caps: [
      "It can't merge. A deterministic gate decides,",
      'and a new agent starts on Assisted: a human approves.',
    ],
  },
  { name: '02-ladder', dur: 6, src: card('02-ladder'), caps: [] },
  {
    name: 'act1',
    dur: 14,
    src: { kind: 'term', term: { title: 'release child pipeline · act 1', source: SIM, shells: c.act1 } },
    caps: ['Every change ships through a canary and a soak.'],
  },
  {
    name: 'replay-promoted',
    dur: 5,
    src: { kind: 'replay', from: 3 },
    caps: ['Survive production, earn trust, per code zone.'],
  },
  {
    name: 'mock',
    dur: 7,
    src: {
      kind: 'term',
      term: {
        title: 'npm run demo:mock · acts 2–3',
        source: 'real stdout · mock ledger',
        shells: [
          {
            cmd: `node scripts/mock-flow.ts | sed -n '${m2},${m4}p'`,
            out: mockLines.slice(m2 - 1, m4).join('\n'),
          },
        ],
      },
    },
    caps: ['Supervised: it merges itself; I approve production.'],
  },
  {
    name: 'replay-handsoff',
    dur: 8,
    src: { kind: 'replay', from: 8.5 },
    caps: ["Two graves later, it's Hands-off in the legacy zone."],
  },
  {
    name: 'note-handsoff',
    dur: 6,
    src: {
      kind: 'note',
      note: c.noteHandsOff,
      labels: ['undertaker', 'probation::hands_off', 'zone::legacy'],
    },
    caps: ["Now nobody's watching. It buries the CSV export: zero hits in seven days."],
  },
  {
    name: 'act4-soak',
    dur: 10,
    src: {
      kind: 'term',
      term: { title: 'release child pipeline · act 4 · no human', source: SIM, shells: c.act4gate },
    },
    caps: ['But our bookkeeping partner calls it once a month.', 'The canary soak catches the 404,'],
  },
  { name: '03-rollback', dur: 5, src: card('03-rollback'), caps: [] },
  {
    name: 'act4-settle',
    dur: 8,
    src: {
      kind: 'term',
      term: { title: 'rollback:soak → settle:rolled-back', source: SIM, shells: c.act4settle },
    },
    caps: ['traffic rolls back, the commit is reverted,', 'and Undertaker loses 40 points.'],
  },
  {
    name: 'replay-rollback',
    dur: 6,
    src: { kind: 'replay', from: 17 },
    caps: ['Back to Assisted. That grave is never touched again.'],
  },
  {
    name: 'board-stats',
    dur: 6,
    src: { kind: 'board', region: 'stats' },
    caps: ['Every MR is measured in gCO₂e per thousand requests with the SCI spec.'],
  },
  {
    name: 'stages',
    dur: 6,
    src: { kind: 'diagram', png: join(MEDIA, 'diagrams/stages.png'), zoom: 0.08 },
    caps: [
      'Plan, create, verify, package, secure, release, configure, monitor, govern:',
      'all nine stages, on GitLab and Cloud Run.',
    ],
  },
  { name: '04-stages', dur: 4, src: card('04-stages'), caps: [] },
  {
    name: 'replay-end',
    dur: 6,
    src: { kind: 'replay', from: 24.4 },
    caps: ['Autonomy you can earn, and lose.', 'Probation.'],
  },
  { name: '05-end', dur: 6, src: card('05-end'), caps: [] },
];

const FADE = 0.2; // DEMO_SCRIPT: cut each card in and out with a 200 ms cross-fade; everything else cuts hard.
const PAPER = '0xf4f1ea';
const ff = (args: string[]) =>
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
const enc = (dur: number) => [
  '-r',
  String(FPS),
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '14',
  '-pix_fmt',
  'yuv420p',
  '-an',
  '-t',
  dur.toFixed(3),
];

// Ken Burns on a still: compose at 2× on paper, then zoom slowly while drifting from the centre of the safe
// area toward `focus` (output pixels; default: stay centred).
function kenBurns(
  png: string,
  dur: number,
  out: string,
  zoom: number,
  fit: [number, number],
  focus?: [number, number],
) {
  const frames = Math.round(dur * FPS);
  const cy = SAFE_TOP + (H - SAFE_BOTTOM - SAFE_TOP) / 2;
  const [fx, fy] = focus ?? [W / 2, cy];
  // Ease in-out so the move starts and lands softly.
  const e = `(0.5-0.5*cos(PI*on/${frames}))`;
  const at = (a: number, b: number) => `(${a * 2}+(${(b - a) * 2})*${e})`;
  ff([
    '-i',
    png,
    '-vf',
    [
      `scale=${fit[0] * 2}:${fit[1] * 2}:force_original_aspect_ratio=decrease`,
      `pad=${W * 2}:${H * 2}:(ow-iw)/2:${cy * 2}-ih/2:color=${PAPER}`,
      `zoompan=z='1+${zoom}*${e}':x='${at(W / 2, fx)}-iw/zoom/2':y='${at(cy, fy)}-ih/zoom/2':d=${frames}:s=${W}x${H}:fps=${FPS}`,
    ].join(','),
    ...enc(dur),
    out,
  ]);
}

const boardShot = await board();
const clips: string[] = [];
for (const sc of scenes) {
  const out = join(WORK, `clip-${sc.name}.mp4`);
  if (reuse && existsSync(out)) {
    clips.push(out);
    continue;
  }
  const s = sc.src;
  if (s.kind === 'card') ff(['-loop', '1', '-framerate', String(FPS), '-i', s.png, ...enc(sc.dur), out]);
  else if (s.kind === 'term') {
    const steps = await terminal(sc.name, s.term, sc.dur);
    const list = join(WORK, `${sc.name}.txt`);
    // The concat demuxer needs the last image listed twice for its duration to count.
    writeFileSync(
      list,
      `${steps.map(([png, d]) => `file '${png}'\nduration ${d.toFixed(3)}`).join('\n')}\nfile '${(steps.at(-1) as [string, number])[0]}'\n`,
    );
    ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS}`, ...enc(sc.dur), out]);
  } else if (s.kind === 'note') kenBurns(await mrNote(sc.name, s.note, s.labels), sc.dur, out, 0.035, [W, H]);
  else if (s.kind === 'diagram')
    kenBurns(s.png, sc.dur, out, s.zoom, [W - 200, H - SAFE_TOP - SAFE_BOTTOM - 20], s.focus);
  else if (s.kind === 'replay')
    // Shift the replay page down 60 px (dropping its footer) so its header clears the honesty label.
    ff([
      '-ss',
      String(s.from),
      '-i',
      join(MEDIA, 'replay.webm'),
      '-vf',
      `crop=${W}:${H - 60}:0:0,pad=${W}:${H}:0:60:color=${PAPER},fps=${FPS}`,
      ...enc(sc.dur),
      out,
    ]);
  else {
    // A slow drift that lands the region's top just under the honesty label; paper masks the label strip.
    const [a] = boardShot.boxes[s.region];
    const pad = 400;
    const y1 = Math.round(a - (SAFE_TOP + 12) + pad);
    const y0 = y1 - 24;
    ff([
      '-loop',
      '1',
      '-framerate',
      String(FPS),
      '-i',
      boardShot.png,
      '-vf',
      `pad=iw:ih+${pad * 2}:0:${pad}:color=${PAPER},crop=${W}:${H}:0:'${y0}+(${y1 - y0})*t/${sc.dur}',drawbox=x=0:y=0:w=iw:h=${SAFE_TOP - 6}:color=${PAPER}@1:t=fill`,
      ...enc(sc.dur),
      out,
    ]);
  }
  clips.push(out);
  console.log(`ok clip ${sc.name} (${sc.dur} s)`);
}

// ---------------------------------------------------------------- 4. assemble, caption, label

// Chain the clips: xfade at card boundaries, concat elsewhere. Track where each scene starts on the final timeline.
const isCard = (i: number) => scenes[i]?.src.kind === 'card';
// Every input on one timebase first, or xfade refuses to join a concat output to a clip.
const graph: string[] = scenes.map((_, i) => `[${i}:v]settb=AVTB,setpts=PTS-STARTPTS[s${i}]`);
const starts: number[] = [0];
let cur = scenes[0].dur;
let label = 's0';
for (let i = 1; i < scenes.length; i++) {
  const next = `v${i}`;
  const fade = isCard(i) || isCard(i - 1);
  if (fade) {
    graph.push(
      `[${label}][s${i}]xfade=transition=fade:duration=${FADE}:offset=${(cur - FADE).toFixed(3)}[${next}]`,
    );
    starts.push(cur - FADE);
    cur += scenes[i].dur - FADE;
  } else {
    graph.push(`[${label}][s${i}]concat=n=2:v=1:a=0,settb=AVTB[${next}]`);
    starts.push(cur);
    cur += scenes[i].dur;
  }
  label = next;
}
const total = cur;

// Cues: each scene's lines share its time by length, inside a short margin.
interface Cue {
  from: number;
  to: number;
  text: string;
}
const cues: Cue[] = [];
scenes.forEach((sc, i) => {
  if (!sc.caps.length) return;
  const from = starts[i] + 0.25;
  const span = sc.dur - 0.5;
  const weight = sc.caps.map((t) => t.length + 25);
  const sum = weight.reduce((a, b) => a + b, 0);
  let t = from;
  for (const [k, text] of sc.caps.entries()) {
    const d = (span * weight[k]) / sum;
    cues.push({ from: t, to: t + d - (k < sc.caps.length - 1 ? 0.08 : 0), text });
    t += d;
  }
});

// One line per cue: at 34 px Plex Mono, 84 characters fill the frame.
for (const q of cues)
  if ([...q.text].length > 84) throw new Error(`caption too long for one line: ${q.text}`);
const labelPng = await overlay('label', `<div class="label"><i></i>${esc(LABEL)}</div>`);
const capPngs: string[] = [];
for (const [k, cue] of cues.entries())
  capPngs.push(await overlay(`cap-${k}`, `<div class="cap">${esc(cue.text)}</div>`));
await browser.close();

let o = label;
graph.push(`[${o}][${scenes.length}:v]overlay=0:0[l0]`);
o = 'l0';
cues.forEach((cue, k) => {
  const next = `c${k}`;
  graph.push(
    `[${o}][${scenes.length + 1 + k}:v]overlay=0:0:enable='between(t,${cue.from.toFixed(3)},${cue.to.toFixed(3)})'[${next}]`,
  );
  o = next;
});
writeFileSync(join(WORK, 'graph.txt'), graph.join(';\n'));
ff([
  ...clips.flatMap((p) => ['-i', p]),
  '-i',
  labelPng,
  ...capPngs.flatMap((p) => ['-i', p]),
  '-filter_complex_script',
  join(WORK, 'graph.txt'),
  '-map',
  `[${o}]`,
  '-r',
  String(FPS),
  '-c:v',
  'libx264',
  '-preset',
  'slow',
  '-crf',
  '21',
  '-tune',
  'stillimage',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  '-an',
  OUT_MP4,
]);

const stamp = (t: number) => {
  const ms = Math.round(t * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
writeFileSync(
  OUT_SRT,
  cues.map((q, k) => `${k + 1}\n${stamp(q.from)} --> ${stamp(q.to)}\n${q.text}\n`).join('\n'),
);

const probe = execFileSync('ffprobe', [
  '-v',
  'error',
  '-select_streams',
  'v:0',
  '-show_entries',
  'stream=width,height:format=duration',
  '-of',
  'default=noprint_wrappers=1:nokey=1',
  OUT_MP4,
])
  .toString()
  .trim()
  .split('\n');
console.log(
  `ok ${OUT_MP4} (${probe[0]}×${probe[1]}, ${Number(probe[2]).toFixed(1)} s, ${(statSync(OUT_MP4).size / 1e6).toFixed(1)} MB)`,
);
console.log(`ok ${OUT_SRT} (${cues.length} cues)`);
console.log('scenes:');
for (const [i, sc] of scenes.entries())
  console.log(`  ${stamp(starts[i]).slice(3, 8)}  ${starts[i].toFixed(1).padStart(5)} s  ${sc.name}`);
if (total > 175) {
  console.error(`✖ ${total.toFixed(1)} s is over the 2:55 budget`);
  process.exit(1);
}
