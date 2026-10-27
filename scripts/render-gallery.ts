// render-gallery — composes the Devpost gallery images (1800×1200, 3:2) and the YouTube thumbnail (1280×720)
// from the existing media in docs/media. Output: docs/media/gallery/*.png
// Usage: node scripts/render-gallery.ts   (run scripts/render-media.ts first if the sources changed)
// Uses the globally installed playwright + Chromium (not a project dependency), resolved from `npm root -g`.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// The slice of the playwright API this script uses (playwright's own types are not installed here).
interface Page {
  setContent(html: string, o?: { waitUntil?: 'networkidle' }): Promise<void>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  screenshot(o: { path: string }): Promise<unknown>;
  close(): Promise<void>;
}
interface Browser {
  newPage(o: { viewport: { width: number; height: number } }): Promise<Page>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(o?: { proxy?: { server: string } }): Promise<Browser> };
}

const globalRoot = execSync('npm root -g').toString().trim();
const { chromium } = createRequire(join(globalRoot, 'noop.js'))('playwright') as Playwright;

const media = 'docs/media';
const outDir = join(media, 'gallery');
mkdirSync(outDir, { recursive: true });

// Sources are inlined as data URIs so setContent pages can load them without file:// access.
const img = (rel: string) => `data:image/png;base64,${readFileSync(join(media, rel)).toString('base64')}`;

const FONTS =
  '<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,400..700,0..100,0..1;1,9..144,600,0..100,0..1&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">';

const BASE = `
:root{--paper:#f4f1ea;--card:#fbf9f4;--ink:#1c1a17;--muted:#6d675d;--line:#d9d3c6;--assisted:#b45309;--supervised:#1d4ed8;--hands:#15803d;--bad:#b91c1c}
*{box-sizing:border-box}
html,body{margin:0;width:100vw;height:100vh;overflow:hidden}
body{position:relative;background:var(--paper);color:var(--ink);font:26px/1.45 "IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.serif{font-family:Fraunces,Georgia,serif;font-weight:600;font-optical-sizing:auto;font-variation-settings:"WONK" 0}
.frame{position:absolute;inset:64px 80px;display:flex;flex-direction:column}
.head{display:flex;justify-content:space-between;align-items:baseline;font-size:20px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);padding-bottom:18px;border-bottom:2px solid var(--ink)}
h1{font-size:64px;line-height:1.05;letter-spacing:-.015em;margin:32px 0 0}
.lede{color:var(--muted);font-size:26px;margin-top:14px;max-width:1500px}
.lede b{color:var(--ink);font-weight:600}
.shot{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--card);box-shadow:0 2px 0 var(--line)}
.shot img{display:block;width:100%}
.fill{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;margin-top:28px}
.stage{display:flex;gap:4px;height:10px;margin-top:auto}
.stage i{flex:1}.stage i:nth-child(1){background:var(--assisted)}.stage i:nth-child(2){background:var(--supervised)}.stage i:nth-child(3){background:var(--hands)}
`;

function page(label: string, file: string, body: string, css = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${FONTS}<style>${BASE}${css}</style></head><body>
<div class="frame"><div class="head"><span>${label}</span><span>${file}</span></div>${body}</div></body></html>`;
}

const LADDER = `<div class="ladder">
  <div class="step a"><div class="lv">Assisted</div><div class="th">≥ 0 pts</div><div class="who">A human approves every merge and deploy.</div></div>
  <div class="step s"><div class="lv">Supervised</div><div class="th">≥ 10 pts</div><div class="who">The gate merges. A human approves production.</div></div>
  <div class="step h"><div class="lv">Hands-off</div><div class="th">≥ 30 pts</div><div class="who">Merges and ships alone, through canary and soak.</div></div>
</div>`;
const LADDER_CSS = `
.ladder{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;align-items:end}
.step{background:var(--card);border:1px solid var(--line);border-top:8px solid var(--c);border-radius:8px;padding:20px 24px 22px;display:flex;flex-direction:column}
.step.a{--c:var(--assisted);height:260px}.step.s{--c:var(--supervised);height:340px}.step.h{--c:var(--hands);height:420px}
.lv{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:40px;line-height:1;color:var(--c)}
.th{font-size:24px;font-weight:600;margin-top:10px}
.who{color:var(--muted);font-size:21px;line-height:1.4;margin-top:auto}`;

const W = 1800;
const H = 1200;
type Shot = { file: string; width: number; height: number; html: string };
const shots: Shot[] = [];

shots.push({
  file: '01-cover.png',
  width: W,
  height: H,
  html: page(
    'Probation + Undertaker',
    'GitLab · Google Cloud',
    `<div class="cover">
  <div class="left">
    <h1 class="serif big">An AI that deletes dead code — and has to <em>earn the right</em> to ship it.</h1>
    <div class="lede">Every deletion that survives a production soak earns <b class="g">+10</b>. A rollback costs <b class="r">−40</b>.</div>
  </div>
  <div class="right">
    <div class="shot"><img src="${img('replay-frames/03.png')}" alt=""></div>
    <div class="cap">The ledger replay: a rolled-back deletion drops its zone back to Assisted.</div>
  </div>
  <div class="ladwrap">${LADDER}</div>
</div>`,
    `${LADDER_CSS}
.cover{flex:1;display:grid;grid-template-columns:1fr 560px;grid-template-rows:auto 1fr;column-gap:56px;margin-top:8px;min-height:0}
.left{display:flex;flex-direction:column;min-height:0}
h1.big{font-size:94px;line-height:1.04;margin-top:44px;text-wrap:balance}
h1.big em{font-style:italic;color:var(--hands)}
.lede .g{color:var(--hands)}.lede .r{color:var(--bad)}
.ladwrap{grid-column:1/-1;align-self:end}.ladwrap .step.a{height:250px}.ladwrap .step.s{height:320px}.ladwrap .step.h{height:390px}
.right{display:flex;flex-direction:column;padding-top:56px}
.cap{color:var(--muted);font-size:20px;margin-top:14px}`,
  ),
});

shots.push({
  file: '02-architecture.png',
  width: W,
  height: H,
  html: page(
    'Architecture',
    '02 / 07',
    `<div class="row"><h1 class="serif">One agent, one deterministic gate.</h1>
<div class="lede">The agent only proposes deletions. CI jobs decide how far each one goes alone, from a policy file and a ledger humans own.</div></div>
<div class="fill"><div class="shot"><img src="${img('diagrams/architecture.png')}" alt=""></div></div>`,
    `.row h1{font-size:52px;margin-top:24px}.row .lede{font-size:23px;margin-top:8px}
.fill .shot{height:100%;aspect-ratio:1600/1120}.fill .shot img{height:100%;width:auto}`,
  ),
});

shots.push({
  file: '03-gate.png',
  width: W,
  height: H,
  html: page(
    'Gate playground',
    '03 / 07',
    `<div class="split"><div class="txt">
  <h1 class="serif">The gate is code, not a model.</h1>
  <div class="lede">The MR's level is the <b>least-trusted zone</b> it touches. The same <b>decide()</b> that runs in CI runs in the browser — try a case and see the verdict.</div>
  <ul class="v">
    <li><i style="--c:var(--assisted)"></i>needs_human</li>
    <li><i style="--c:var(--supervised)"></i>merge_supervised</li>
    <li><i style="--c:var(--hands)"></i>merge_hands_off</li>
    <li><i style="--c:var(--bad)"></i>block</li>
  </ul>
</div>
<div class="shot crop"><img src="${img('playground.png')}" alt=""></div></div>`,
    `.split{flex:1;display:grid;grid-template-columns:520px 1fr;gap:56px;margin-top:36px;min-height:0}
.txt h1{margin-top:0;font-size:60px}.txt .lede{font-size:24px;margin-top:22px}
.v{list-style:none;padding:0;margin:36px 0 0;font-size:24px;font-weight:600}.v li{display:flex;align-items:center;gap:14px;margin-top:12px}
.v i{width:22px;height:22px;border-radius:4px;background:var(--c)}
.crop{height:100%}.crop img{width:122%;max-width:none;margin:-62px 0 0 -11.7%}`,
  ),
});

shots.push({
  file: '04-rollback.png',
  width: W,
  height: H,
  html: page(
    'Rollback',
    '04 / 07',
    `<div class="row"><h1 class="serif">The canary caught it.</h1>
<div class="lede">A deletion broke a monthly partner export during the soak. The pipeline routed traffic back, reverted the commit and took <b class="r">−40</b>: the zone is back to <b class="a">Assisted</b>.</div></div>
<div class="fill"><div class="shot"><img src="${img('replay-frames/03.png')}" alt=""></div></div>`,
    `.row h1{font-size:64px;margin-top:24px;color:var(--bad)}.row .lede{font-size:24px}.lede .r{color:var(--bad)}.lede .a{color:var(--assisted)}
.fill .shot{height:100%;aspect-ratio:16/9}.fill .shot img{height:100%;width:auto}`,
  ),
});

shots.push({
  file: '05-stages.png',
  width: W,
  height: H,
  html: page(
    'Nine stages',
    '05 / 07',
    `<div class="row"><h1 class="serif">Every stage of the pipeline, for one deletion.</h1>
<div class="lede">Plan, create, verify, package, secure, release, configure, monitor, govern — each a real GitLab CI job or Duo flow.</div></div>
<div class="fill"><div class="shot"><img src="${img('diagrams/stages.png')}" alt=""></div></div>`,
    `.row h1{font-size:60px}.fill{flex:0 0 auto;margin-top:72px}.fill .shot{width:100%}.frame>.row{margin-top:110px}`,
  ),
});

shots.push({
  file: '06-board.png',
  width: W,
  height: H,
  html: page(
    'Board',
    '06 / 07',
    `<div class="row"><h1 class="serif">The board: trust per zone, and the graveyard.</h1>
<div class="lede">Published to GitLab Pages from the ledger branch. Light on desktop, dark on a phone.</div></div>
<div class="duo"><div class="shot desk"><img src="${img('board-light.png')}" alt=""></div>
<div class="shot phone"><img src="${img('board-dark-mobile.png')}" alt=""></div></div>`,
    `.row h1{font-size:56px;margin-top:24px}.row .lede{font-size:23px}
.duo{flex:1;min-height:0;display:grid;grid-template-columns:1fr 400px;gap:48px;margin-top:28px}
.duo .shot{height:100%}.phone{border-radius:28px;border:10px solid var(--ink)}`,
  ),
});

shots.push({
  file: '07-sustainability.png',
  width: W,
  height: H,
  html: page(
    'Sustainability',
    '07 / 07',
    `<h1 class="serif">Dead code has a carbon cost. We measure it on every MR.</h1>
<div class="lede">Green Software Foundation <b>Software Carbon Intensity</b> (ISO/IEC 21031:2024), per 1,000 requests.</div>
<div class="formula">SCI = ((E × I) + M) per R</div>
<div class="facts">
  <div class="f"><div class="k">E · energy</div><div class="n">measured</div><div class="d">CPU time, memory, image transfer and cold start of the real app under load, × PUE 1.1</div></div>
  <div class="f"><div class="k">I · grid intensity</div><div class="n">432 <small>gCO₂e/kWh</small></div><div class="d">Cloud Run region us-central1, Google's 2025 location-based data</div></div>
  <div class="f"><div class="k">M · embodied</div><div class="n">0.713 <small>g / vCPU-h</small></div><div class="d">server embodied emissions amortised over 4 years (CCF method)</div></div>
</div>
<div class="deps"><div class="lab">Unused dependencies in the demo app</div><div class="bar"><i style="width:${(10.2 / 25.9) * 100}%"></i></div>
<div class="dl"><b>moment + lodash: 10.2 of 25.9 MB</b> of the app layer — weight every cold start pulls.</div></div>`,
    `h1{font-size:60px}
.formula{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:120px;line-height:1;margin:64px 0 0;letter-spacing:-.01em}
.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:48px}
.f{background:var(--card);border:1px solid var(--line);border-top:6px solid var(--hands);border-radius:8px;padding:22px 26px}
.k{font-size:20px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.n{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:56px;line-height:1.1;margin-top:8px}.n small{font-family:"IBM Plex Mono",monospace;font-size:22px;font-weight:400;color:var(--muted)}
.d{font-size:20px;color:var(--muted);margin-top:10px;line-height:1.4}
.deps{margin-top:auto;margin-bottom:24px}.deps .lab{font-size:20px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.bar{height:40px;background:var(--line);border-radius:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--assisted)}
.dl{font-size:28px;margin-top:16px}.dl b{color:var(--assisted)}`,
  ),
});

shots.push({
  file: 'youtube-thumbnail.png',
  width: 1280,
  height: 720,
  html: `<!doctype html><html lang="en"><head><meta charset="utf-8">${FONTS}<style>${BASE}
body{width:1280px;height:720px}
.t{position:absolute;left:72px;top:64px;right:72px}
.t h1{font-size:144px;line-height:.95;margin:0;letter-spacing:-.02em;font-weight:700;font-optical-sizing:none;font-variation-settings:"opsz" 36,"WONK" 0}
.t h1 em{font-style:italic;color:var(--assisted)}
.t p{font-size:40px;font-weight:600;margin:30px 0 0;line-height:1.25}
.lad{position:absolute;left:72px;right:72px;bottom:56px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px;align-items:end}
.lad div{border-radius:8px;color:#fff;font:700 46px/1 Fraunces,Georgia,serif;padding:20px 24px;display:flex;align-items:flex-end}
.lad .a{background:var(--assisted);height:110px}.lad .s{background:var(--supervised);height:170px}.lad .h{background:var(--hands);height:230px}
</style></head><body>
<div class="t"><h1 class="serif">AI on <em>probation</em></h1><p>It deletes dead code.<br>It earns the right to ship.</p></div>
<div class="lad"><div class="a">Assisted</div><div class="s">Supervised</div><div class="h">Hands-off</div></div>
</body></html>`,
});

// Layout guard: anything spilling past the canvas edge.
async function overflow(p: Page): Promise<string[]> {
  return p.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.frame *, .t, .lad')) {
      if (el.closest('.shot')) continue;
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 0.5 || r.bottom > window.innerHeight + 0.5)
        out.push(
          `${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} ends at ${r.right}×${r.bottom}`,
        );
    }
    return out.slice(0, 5);
  });
}

// Google Fonts are fetched through the session proxy when one is configured.
const proxy = process.env.HTTPS_PROXY;
const browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});
let issues = 0;
for (const s of shots) {
  const p = await browser.newPage({ viewport: { width: s.width, height: s.height } });
  await p.setContent(s.html, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready.then(() => new Promise<void>((r) => setTimeout(r, 300))));
  const problems = await overflow(p);
  const path = join(outDir, s.file);
  await p.screenshot({ path });
  await p.close();
  const kb = Math.round(statSync(path).size / 1024);
  console.log(
    `${problems.length ? '✖' : 'ok'} ${path} (${kb} KB)${problems.map((m) => `\n   ${m}`).join('')}`,
  );
  issues += problems.length;
}
await browser.close();
if (issues) {
  console.error(`✖ ${issues} layout problem(s) above`);
  process.exit(1);
}
