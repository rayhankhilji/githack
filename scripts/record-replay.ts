// record-replay — records the ledger replay (the mock probation story) as a 1080p clip for the demo video,
// plus four key frames. Usage: node scripts/record-replay.ts
// Writes docs/media/replay.webm, docs/media/replay.mp4 and docs/media/replay-frames/0N.png.
// --frames-only skips the clip (about 3 minutes of recording and encoding) to iterate on the layout.
// Uses the globally installed playwright + Chromium (resolved from `npm root -g`) and the system ffmpeg.
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Ledger } from '../probation/src/ledger.ts';
import { loadPolicy } from '../probation/src/policy.ts';
import { renderReplay } from '../probation/src/replay.ts';

// The slice of the playwright API this script uses (playwright's own types are not installed here).
interface Video {
  path(): Promise<string>;
}
interface Page {
  goto(url: string, o?: { waitUntil?: 'networkidle' }): Promise<unknown>;
  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  waitForFunction(fn: string, arg?: unknown, o?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(o: { path: string }): Promise<unknown>;
  video(): Video | null;
}
interface Context {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Browser {
  newContext(o: {
    viewport: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    reducedMotion?: 'reduce' | 'no-preference';
    recordVideo?: { dir: string; size: { width: number; height: number } };
  }): Promise<Context>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(o?: { proxy?: { server: string } }): Promise<Browser> };
}

const globalRoot = execSync('npm root -g').toString().trim();
const { chromium } = createRequire(join(globalRoot, 'noop.js'))('playwright') as Playwright;

const W = 1920;
const H = 1080;
const media = 'docs/media';
const framesDir = join(media, 'replay-frames');
const work = '.out/replay-rec';
rmSync(work, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
mkdirSync(work, { recursive: true });

// The same story `npm run demo:mock` plays: five acts, a climb to Hands-off, one rollback.
execFileSync(process.execPath, ['scripts/mock-flow.ts'], { stdio: 'ignore' });
const ledger = JSON.parse(readFileSync('.out/mock-ledger.json', 'utf8')) as Ledger;
const page = join(work, 'replay.html');
writeFileSync(page, renderReplay(ledger, loadPolicy(), '2026-10-27T03:00:00Z'));
const url = (q: string) => `${pathToFileURL(resolve(page)).href}?${q}`;

// Google Fonts are fetched through the session proxy when one is configured.
const proxy = process.env.HTTPS_PROXY;
const browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});
const settle = (p: Page) =>
  p.evaluate(() => document.fonts.ready.then(() => new Promise<void>((r) => setTimeout(r, 400))));

// Layout guard: nothing may scroll sideways, and the whole stage must fit one 1080p frame.
async function check(p: Page): Promise<string[]> {
  return p.evaluate(() => {
    const out: string[] = [];
    const de = document.documentElement;
    if (de.scrollWidth > window.innerWidth) out.push(`page scrolls sideways (${de.scrollWidth}px)`);
    const bar = document.querySelector('.bar')?.getBoundingClientRect();
    if (bar && bar.bottom > window.innerHeight) out.push(`controls end at ${Math.round(bar.bottom)}px`);
    return out;
  });
}

// 1. Key frames, each shown the way the player reaches it (the step before, then one step forward).
const frames = await browser.newContext({
  viewport: { width: W, height: H },
  colorScheme: 'light',
  reducedMotion: 'no-preference',
});
const fp = await frames.newPage();
const steps = ledger.events.length + 2;
const handsOff = 1 + ledger.events.findIndex((e) => e.levelAfter === 'hands_off');
const rollback = 1 + ledger.events.findIndex((e) => e.event === 'rolled_back');
const shots: [string, number, number][] = [
  ['01', 0, 0], // the opening: everything at 0, Assisted
  ['02', handsOff, 1600], // Hands-off reached, after the counter and badge settle
  ['03', rollback, 620], // mid-flash, the −40 stamp just landed
  ['04', steps - 1, 1600], // the closing record
];
let problems: string[] = [];
for (const [name, step, wait] of shots) {
  await fp.goto(url(`autoplay=0&step=${Math.max(0, step - 1)}`), { waitUntil: 'networkidle' });
  await settle(fp);
  if (step > 0)
    await fp.evaluate(
      (s) => (window as unknown as { replay: { show(k: number): void } }).replay.show(s),
      step,
    );
  await fp.waitForTimeout(wait);
  problems = problems.concat((await check(fp)).map((p) => `frame ${name}: ${p}`));
  await fp.screenshot({ path: join(framesDir, `${name}.png`) });
}
await frames.close();
if (process.argv.includes('--frames-only')) {
  await browser.close();
  console.log(`ok ${framesDir}/01..04.png${problems.length ? `\n✖ ${problems.join('\n✖ ')}` : ''}`);
  process.exit(problems.length ? 1 : 0);
}

// 2. The clip: load paused, wait for fonts, then play at 1× (about 30 s) and hold the closing record.
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  colorScheme: 'light',
  reducedMotion: 'no-preference',
  recordVideo: { dir: work, size: { width: W, height: H } },
});
const t0 = Date.now();
const vp = await ctx.newPage();
await vp.goto(url('autoplay=0&speed=1'), { waitUntil: 'networkidle' });
await settle(vp);
const lead = (Date.now() - t0) / 1000;
await vp.evaluate(() => (window as unknown as { replay: { play(): void } }).replay.play());
await vp.waitForFunction('document.documentElement.dataset.done === "true"', undefined, { timeout: 120_000 });
await vp.waitForTimeout(3000);
const raw = await vp.video()?.path();
await ctx.close();
await browser.close();
if (!raw) throw new Error('no video was recorded');

// Trim the blank lead-in and re-encode small: VP9 for the web, H.264 for video editors.
const ff = (args: string[]) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
const trim = ['-ss', lead.toFixed(2), '-i', raw, '-an'];
ff([
  ...trim,
  '-c:v',
  'libvpx-vp9',
  '-b:v',
  '0',
  '-crf',
  '36',
  '-row-mt',
  '1',
  '-deadline',
  'good',
  join(media, 'replay.webm'),
]);
ff([
  ...trim,
  '-c:v',
  'libx264',
  '-crf',
  '22',
  '-preset',
  'slow',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  join(media, 'replay.mp4'),
]);
for (const f of ['replay.webm', 'replay.mp4'])
  console.log(`ok ${join(media, f)} (${(statSync(join(media, f)).size / 1e6).toFixed(1)} MB)`);
console.log(`ok ${framesDir}/01..04.png`);
if (problems.length) {
  console.error(`✖ layout problems:\n   ${problems.join('\n   ')}`);
  process.exit(1);
}
