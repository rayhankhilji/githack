// render-media — screenshots the video title cards and the mock Probation Board for the demo video and README.
// Usage: node scripts/render-media.ts
// Uses the globally installed playwright + Chromium (not a project dependency), resolved from `npm root -g`.
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderBoard } from '../probation/src/board.ts';
import type { Ledger } from '../probation/src/ledger.ts';
import { loadPolicy } from '../probation/src/policy.ts';

// The slice of the playwright API this script uses (playwright's own types are not installed here).
interface Page {
  emulateMedia(o: { colorScheme?: 'light' | 'dark'; reducedMotion?: 'reduce' }): Promise<void>;
  goto(url: string, o?: { waitUntil?: 'networkidle' }): Promise<unknown>;
  setContent(html: string, o?: { waitUntil?: 'networkidle' }): Promise<void>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
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

const cardsDir = 'docs/media/cards';
const pngDir = join(cardsDir, 'png');
mkdirSync(pngDir, { recursive: true });

// Google Fonts are fetched through the session proxy when one is configured.
const proxy = process.env.HTTPS_PROXY;
const browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});

// Layout guard: report anything that scrolls sideways or spills past a fixed-size card.
async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const de = document.documentElement;
    if (de.scrollWidth > window.innerWidth) out.push(`page scrolls sideways (${de.scrollWidth}px)`);
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      // The ledger table scrolls inside its own wrapper on purpose.
      if (el.closest('.table-wrap')) continue;
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 0.5)
        out.push(`${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} ends at ${r.right}px`);
    }
    return out.slice(0, 5);
  });
}

async function shoot(
  name: string,
  load: (p: Page) => Promise<unknown>,
  width: number,
  height: number,
  colorScheme: 'light' | 'dark',
  fullPage: boolean,
  path: string,
) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
  await load(page);
  // Web fonts swap in after load; give layout a beat to settle on the final faces.
  await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((r) => setTimeout(r, 300))));
  const problems = await overflow(page);
  if (fullPage === false) {
    const tall = await page.evaluate(() => document.documentElement.scrollHeight);
    if (tall > height) problems.push(`content is ${tall}px tall, card is ${height}px`);
  }
  await page.screenshot({ path, fullPage });
  await page.close();
  console.log(
    `${problems.length ? '✖' : 'ok'} ${name} → ${path}${problems.map((p) => `\n   ${p}`).join('')}`,
  );
  return problems.length;
}

let issues = 0;
for (const file of readdirSync(cardsDir)
  .filter((f) => f.endsWith('.html'))
  .sort()) {
  const url = pathToFileURL(resolve(cardsDir, file)).href;
  const out = join(pngDir, file.replace(/\.html$/, '.png'));
  issues += await shoot(
    file,
    (p) => p.goto(url, { waitUntil: 'networkidle' }),
    1920,
    1080,
    'light',
    false,
    out,
  );
}

// The board is rendered from the mock story, the same ledger `npm run demo:mock` produces.
execFileSync(process.execPath, ['scripts/mock-flow.ts'], { stdio: 'ignore' });
const ledger = JSON.parse(readFileSync('.out/mock-ledger.json', 'utf8')) as Ledger;
const html = renderBoard(ledger, loadPolicy(), '2026-10-27T03:00:00Z');
const board = (p: Page) => p.setContent(html, { waitUntil: 'networkidle' });
issues += await shoot('board (light, 1100)', board, 1100, 800, 'light', true, 'docs/media/board-light.png');
issues += await shoot('board (dark, 390)', board, 390, 844, 'dark', true, 'docs/media/board-dark-mobile.png');

await browser.close();
if (issues) {
  console.error(`✖ ${issues} layout problem(s) above`);
  process.exit(1);
}
