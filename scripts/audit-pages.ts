// audit-pages — accessibility and robustness audit of the three pages judges open: the Probation Board,
// the ledger replay and the Tallybook dashboard. Needs a browser, so it is not part of `npm test`.
//
// Usage:
//   npm i --prefix /tmp/axe axe-core            # once; axe-core is not a project dependency
//   AXE=/tmp/axe/node_modules/axe-core/axe.min.js node scripts/audit-pages.ts [--shots <dir>]
//
// Uses the globally installed playwright + Chromium (resolved from `npm root -g`), like render-media.ts.
// Checks, at 390×844 and 1280×800, light and dark, with reduced motion:
//   axe-core (WCAG 2.0–2.2 A/AA + best practice), horizontal page overflow, console errors,
//   keyboard reachability with a visible focus indicator, level-color contrast on cards,
//   the replay's keyboard controls and live status, and that reduced motion leaves no animation.
// Prints a findings table; exits 1 if any serious or critical axe violation (or a failed check) remains.
// Focus-state screenshots go to --shots (default .out/audit) to be looked at.
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildServer } from '../app/src/server.ts';
import { renderBoard } from '../probation/src/board.ts';
import type { Ledger } from '../probation/src/ledger.ts';
import { loadPolicy } from '../probation/src/policy.ts';
import { renderReplay } from '../probation/src/replay.ts';

// The slice of the playwright API this script uses (playwright's own types are not installed here).
interface ConsoleMessage {
  type(): string;
  text(): string;
}
interface Page {
  on(event: 'console', fn: (m: ConsoleMessage) => void): void;
  on(event: 'pageerror', fn: (e: Error) => void): void;
  goto(url: string, o?: { waitUntil?: 'networkidle' }): Promise<unknown>;
  addScriptTag(o: { path: string }): Promise<unknown>;
  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  keyboard: { press(key: string): Promise<void> };
  screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
  close(): Promise<void>;
}
interface Context {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Browser {
  newContext(o: {
    viewport: { width: number; height: number };
    colorScheme: 'light' | 'dark';
    reducedMotion: 'reduce' | 'no-preference';
  }): Promise<Context>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(o?: { proxy?: { server: string } }): Promise<Browser> };
}
interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: number;
  target: string;
}
interface Focus {
  tag: string;
  name: string;
  visible: boolean;
}

const axePath = process.env.AXE ?? '';
if (!axePath || !existsSync(axePath)) {
  console.error('✖ Set AXE to axe.min.js (npm i --prefix /tmp/axe axe-core; see the top of this file).');
  process.exit(1);
}
const shotsAt = process.argv.indexOf('--shots');
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : '.out/audit';
mkdirSync(shots, { recursive: true });

const globalRoot = execSync('npm root -g').toString().trim();
const { chromium } = createRequire(join(globalRoot, 'noop.js'))('playwright') as Playwright;

// The pages, written next to each other so the board ↔ replay links resolve.
execFileSync(process.execPath, ['scripts/mock-flow.ts'], { stdio: 'ignore' });
const ledger = JSON.parse(readFileSync('.out/mock-ledger.json', 'utf8')) as Ledger;
const policy = loadPolicy();
const at = '2026-10-27T03:00:00Z';
writeFileSync(join(shots, 'index.html'), renderBoard(ledger, policy, at));
writeFileSync(join(shots, 'replay.html'), renderReplay(ledger, policy, at));
const { app } = buildServer({ env: { FLAG_HOLIDAY_BANNER2024: 'on' }, censusLog: () => {} });
writeFileSync(join(shots, 'tallybook.html'), (await app.inject('/')).body);
await app.close();
const url = (file: string, q = '') => `${pathToFileURL(resolve(shots, file)).href}${q}`;
const rollback = 1 + ledger.events.findIndex((e) => e.event === 'rolled_back');
const handsOff = 1 + ledger.events.findIndex((e) => e.levelAfter === 'hands_off');

const PAGES: { name: string; file: string; states: string[] }[] = [
  { name: 'board', file: 'index.html', states: [''] },
  // Opening, Hands-off, rollback and closing record: each shows different text and level colors.
  {
    name: 'replay',
    file: 'replay.html',
    states: ['?step=0', `?step=${handsOff}`, `?step=${rollback}`, `?step=${ledger.events.length + 1}`],
  },
  { name: 'tallybook', file: 'tallybook.html', states: [''] },
];
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];
const SCHEMES = ['light', 'dark'] as const;

// Google Fonts are fetched through the session proxy when one is configured.
const proxy = process.env.HTTPS_PROXY;
const browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});

interface Row {
  page: string;
  where: string;
  check: string;
  impact: string;
  detail: string;
}
const rows: Row[] = [];
const fail = (page: string, where: string, check: string, impact: string, detail: string) =>
  rows.push({ page, where, check, impact, detail });

async function open(
  file: string,
  q: string,
  width: number,
  height: number,
  scheme: 'light' | 'dark',
  motion: 'reduce' | 'no-preference' = 'reduce',
) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
    reducedMotion: motion,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url(file, q), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((r) => setTimeout(r, 200))));
  return { ctx, page, errors };
}

async function axe(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: axePath });
  return page.evaluate(async () => {
    const w = window as unknown as {
      axe: {
        run(
          ctx: Document,
          o: object,
        ): Promise<{
          violations: {
            id: string;
            impact: string | null;
            help: string;
            nodes: { target: string[]; any: { message: string }[] }[];
          }[];
        }>;
      };
    };
    const r = await w.axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.length,
      target: v.nodes
        .slice(0, 8)
        .map((n) => `${n.target.join(' ')}${n.any[0] ? ` [${n.any[0].message}]` : ''}`)
        .join(', '),
    }));
  });
}

// Tab through the page; every focusable control must be reached and show an outline or ring.
async function tabWalk(page: Page): Promise<{ seen: Focus[]; focusable: number }> {
  const focusable = await page.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>('a[href],button,select,input,textarea,[tabindex]')].filter(
        (e) => !(e as HTMLButtonElement).disabled && e.tabIndex >= 0 && e.getClientRects().length > 0,
      ).length,
  );
  const seen: Focus[] = [];
  for (let i = 0; i < focusable + 2; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      if (!e || e === document.body) return null;
      const cs = getComputedStyle(e);
      const outline = cs.outlineStyle !== 'none' && Number.parseFloat(cs.outlineWidth) >= 1;
      const ring = cs.boxShadow !== 'none';
      const name = (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().slice(0, 40);
      return { tag: e.tagName.toLowerCase(), name, visible: outline || ring, key: e.outerHTML.slice(0, 120) };
    });
    if (!f) break;
    if (seen.some((s) => `${s.tag}|${s.name}` === `${f.tag}|${f.name}`)) break;
    seen.push({ tag: f.tag, name: f.name, visible: f.visible });
  }
  return { seen, focusable };
}

// Level colors as text on cards, and card-colored text on level badges, from the page's own tokens.
async function levelContrast(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const hex = (v: string) => {
      const m = v.trim().match(/^#([0-9a-f]{6})$/i);
      return m ? [0, 2, 4].map((i) => Number.parseInt(m[1].slice(i, i + 2), 16) / 255) : undefined;
    };
    const lum = (c: number[]) =>
      c
        .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
        .reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a: number[], b: number[]) => {
      const [h, l] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (h + 0.05) / (l + 0.05);
    };
    const card = hex(cs.getPropertyValue('--card')) ?? hex(cs.getPropertyValue('--bg'));
    if (!card) return [];
    const out: string[] = [];
    for (const t of ['--assisted', '--supervised', '--hands', '--bad', '--muted', '--accent']) {
      const c = hex(cs.getPropertyValue(t));
      if (!c) continue;
      const r = ratio(c, card);
      out.push(`${t} ${r.toFixed(2)}:1${r < 4.5 ? ' FAIL' : ''}`);
    }
    return out;
  });
}

const contrastLog = new Set<string>();
for (const p of PAGES) {
  for (const vp of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      const where = `${vp.width} ${scheme}`;
      for (const q of p.states) {
        const { ctx, page, errors } = await open(p.file, q, vp.width, vp.height, scheme);
        const tag = `${where}${q ? ` ${q}` : ''}`;
        for (const v of await axe(page))
          fail(p.name, tag, `axe ${v.id}`, v.impact ?? '?', `${v.help} (${v.nodes}× e.g. ${v.target})`);
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (sideways > 0) fail(p.name, tag, 'overflow', 'serious', `page scrolls ${sideways}px sideways`);
        for (const e of errors) fail(p.name, tag, 'console', 'serious', e.slice(0, 120));
        // Reduced motion: nothing may be running or pending.
        const anims = await page.evaluate(() => document.getAnimations().length);
        if (anims) fail(p.name, tag, 'reduced-motion', 'serious', `${anims} animation(s) running`);
        if (q === p.states[0]) {
          const lc = await levelContrast(page);
          contrastLog.add(`${p.name} ${scheme}: ${lc.join(' · ')}`);
          for (const l of lc.filter((x) => x.endsWith('FAIL')))
            fail(p.name, where, 'level contrast', 'serious', l);
          const { seen, focusable } = await tabWalk(page);
          if (seen.length < focusable)
            fail(
              p.name,
              where,
              'keyboard',
              'serious',
              `reached ${seen.length} of ${focusable} focusable controls`,
            );
          for (const s of seen.filter((x) => !x.visible))
            fail(p.name, where, 'focus visible', 'serious', `${s.tag} "${s.name}" has no outline or ring`);
        }
        await ctx.close();
      }
    }
  }
}

// Focus-state screenshots of the replay controls (both themes, desktop), to be looked at by a human.
for (const scheme of SCHEMES) {
  const { ctx, page } = await open('replay.html', '?step=2', 1280, 800, scheme);
  await page.evaluate(() => document.getElementById('restart')?.focus());
  await page.keyboard.press('Tab'); // Back
  await page.keyboard.press('Tab'); // Play
  await page.screenshot({ path: join(shots, `focus-replay-play-${scheme}.png`) });
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab'); // past Next and Speed into the step ticks
  await page.screenshot({ path: join(shots, `focus-replay-tick-${scheme}.png`) });
  await ctx.close();
  const b = await open('index.html', '', 1280, 800, scheme);
  await b.page.evaluate(() => (document.querySelector('a.replay') as HTMLElement | null)?.focus());
  await b.page.keyboard.press('Shift+Tab');
  await b.page.keyboard.press('Tab');
  await b.page.screenshot({ path: join(shots, `focus-board-link-${scheme}.png`) });
  await b.ctx.close();
}

// Replay keyboard: space plays and pauses, → and ← step, and the live status changes once per step.
{
  const { ctx, page } = await open('replay.html', '?step=0', 1280, 800, 'light');
  await page.evaluate(() => {
    const w = window as unknown as { announced: string[] };
    w.announced = [];
    const s = document.getElementById('status');
    if (s)
      new MutationObserver(() => w.announced.push(s.textContent ?? '')).observe(s, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const state = () =>
    page.evaluate(() => {
      const w = window as unknown as { replay: { step: number; playing: boolean }; announced: string[] };
      const live = document.getElementById('status');
      return {
        step: w.replay.step,
        playing: w.replay.playing,
        announced: [...w.announced],
        live: live?.getAttribute('aria-live') ?? live?.getAttribute('role') ?? '',
      };
    });
  const s0 = await state();
  if (s0.live !== 'polite')
    fail('replay', 'keys', 'aria-live', 'serious', 'status is not a polite live region');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const s1 = await state();
  if (s1.step !== 2) fail('replay', 'keys', 'keyboard →', 'serious', `→ twice went to step ${s1.step}`);
  await page.keyboard.press('ArrowLeft');
  const s2 = await state();
  if (s2.step !== 1) fail('replay', 'keys', 'keyboard ←', 'serious', `← went to step ${s2.step}`);
  const texts = s2.announced.filter((t, i, a) => t && a.indexOf(t) === i);
  if (s2.announced.length !== 3 || texts.length !== 2)
    fail('replay', 'keys', 'announce', 'serious', `3 steps announced ${s2.announced.length} time(s)`);
  await page.keyboard.press(' ');
  const s3 = await state();
  if (!s3.playing) fail('replay', 'keys', 'keyboard space', 'serious', 'space did not start playing');
  await page.keyboard.press(' ');
  const s4 = await state();
  if (s4.playing) fail('replay', 'keys', 'keyboard space', 'serious', 'space did not pause');
  // With reduced motion, stepping must not start a transition or animation either.
  const anims = await page.evaluate(() => document.getAnimations().length);
  if (anims) fail('replay', 'keys', 'reduced-motion', 'serious', `${anims} animation(s) after stepping`);
  await ctx.close();
}

// Sanity for the motion check: without reduced motion the replay does animate.
{
  const { ctx, page } = await open('replay.html', '?step=0&autoplay=0', 1280, 800, 'light', 'no-preference');
  await page.evaluate(() => (window as unknown as { replay: { show(k: number): void } }).replay.show(1));
  const anims = await page.evaluate(() => document.getAnimations().length);
  if (!anims) fail('replay', 'motion', 'motion sanity', 'minor', 'no animation even without reduced motion');
  await ctx.close();
}
await browser.close();

console.log([...contrastLog].map((l) => `  contrast ${l}`).join('\n'));
const order = ['critical', 'serious', 'moderate', 'minor', '?'];
rows.sort((a, b) => order.indexOf(a.impact) - order.indexOf(b.impact) || a.page.localeCompare(b.page));
if (!rows.length)
  console.log('ok no findings: axe clean, no overflow, no console errors, keyboard and motion ok');
else {
  const cols: (keyof Row)[] = ['impact', 'page', 'where', 'check', 'detail'];
  const width = cols.map((c) => Math.min(60, Math.max(c.length, ...rows.map((r) => r[c].length))));
  const fmt = (r: Record<string, string>) =>
    cols.map((c, i) => r[c].slice(0, 60).padEnd(width[i])).join(' │ ');
  console.log(fmt({ impact: 'impact', page: 'page', where: 'where', check: 'check', detail: 'detail' }));
  console.log(width.map((w) => '─'.repeat(w)).join('─┼─'));
  for (const r of rows) console.log(fmt({ ...r }));
  // Full detail once per distinct finding (the table cuts it at 60 characters).
  console.log('');
  for (const d of new Set(rows.map((r) => `${r.page} ${r.check}: ${r.detail}`))) console.log(`  ${d}`);
}
const blocking = rows.filter((r) => r.impact === 'critical' || r.impact === 'serious');
console.log(
  `\n${blocking.length ? '✖' : 'ok'} ${rows.length} finding(s), ${blocking.length} serious or critical`,
);
console.log(`  focus screenshots in ${shots}/focus-*.png`);
process.exit(blocking.length ? 1 : 0);
