import { nextPromotion } from './board.ts';
import { label } from './gate.ts';
import type { Grave, Ledger, LedgerEvent } from './ledger.ts';
import { type Level, levelForScore, type Policy, type ScoringEvent } from './policy.ts';

// Ledger replay: the probation story re-told event by event, published next to the board (replay.html).
// The steps are computed here (pure, tested); a small inline script only animates between them.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Signed points with a real minus sign, so negative values never rely on color alone.
export const signed = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : '±'}${Math.abs(n)}`;

// JSON for a <script type="application/json"> block: no `<`, `>` or `&` survives, so `</script>` or
// `<!--` inside a grave title can never end the block. JSON.parse turns the escapes back into text.
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// One caption fragment; the tone colours it (a level, or positive/negative points).
export interface CaptionPart {
  t: string;
  k?: Level | 'pos' | 'neg';
}

export interface ReplayChange {
  zone: string;
  event: ScoringEvent;
  points: number;
  scoreBefore: number;
  scoreAfter: number;
  levelBefore: Level;
  levelAfter: Level;
}

export interface ReplayStep {
  kind: 'start' | 'event' | 'end';
  at?: string;
  mr?: number;
  url?: string;
  event?: ScoringEvent;
  caption: CaptionPart[];
  detail: string;
  scores: Record<string, number>;
  levels: Record<string, Level>;
  // Distance to the next level per zone, as on the board's zone cards.
  next: Record<string, string>;
  changes: ReplayChange[];
  // How many graves (oldest first) are dug by the end of this step.
  graves: number;
  // How long the step holds at 1× speed before autoplay moves on, in ms.
  hold: number;
}

export interface ReplayStory {
  agent: string;
  zones: string[];
  levels: { supervised: number; hands_off: number };
  max: number;
  steps: ReplayStep[];
  graves: Grave[];
  events: LedgerEvent[];
}

const HEAD: Record<ScoringEvent, string> = {
  survived_soak: 'survived the soak',
  rolled_back: 'rolled back',
  human_rejected: 'rejected by a human',
  security_finding: 'added a security finding',
};

// Stamp text for a lost-points step, e.g. "−40 · rolled back".
export const STAMP: Record<ScoringEvent, string> = {
  survived_soak: 'survived',
  rolled_back: 'rolled back',
  human_rejected: 'rejected',
  security_finding: 'security finding',
};

const graveTitle = (g: Grave) => g.title.replace(/^(Draft:\s*)?/i, '');

export function replayStory(ledger: Ledger, policy: Policy): ReplayStory {
  const agent = Object.keys(policy.agents)[0];
  const events = ledger.events.filter((e) => e.agent === agent);
  const order = policy.zones.map((z) => z.name);
  const zones = [...new Set(events.map((e) => e.zone))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const graves = [...ledger.graveyard].sort((a, b) => a.at.localeCompare(b.at));
  const max = Math.max(policy.levels.hands_off + 20, ...events.map((e) => e.scoreAfter));
  const scores: Record<string, number> = Object.fromEntries(zones.map((z) => [z, 0]));
  const levels = () =>
    Object.fromEntries(zones.map((z) => [z, levelForScore(policy, scores[z])])) as Record<string, Level>;
  const next = () =>
    Object.fromEntries(
      zones.map((z) => {
        const nx = nextPromotion(policy, scores[z]);
        return [z, `${nx.text}${nx.next ? ` → ${label(nx.next)}` : ''}`];
      }),
    );
  const rb = policy.scoring.rolled_back;

  const steps: ReplayStep[] = [
    {
      kind: 'start',
      caption: [
        { t: `${agent} starts on probation` },
        { t: zones.length === 1 ? `${zones[0]} at 0` : 'every zone at 0' },
        { t: label('assisted'), k: 'assisted' },
      ],
      detail: `Supervised at ${policy.levels.supervised} pts · Hands-off at ${policy.levels.hands_off} · a rollback costs ${Math.abs(rb)}`,
      scores: { ...scores },
      levels: levels(),
      next: next(),
      changes: [],
      graves: 0,
      hold: 3000,
    },
  ];

  // A change that touched several zones writes one event per zone at the same instant: one step.
  for (let i = 0; i < events.length; ) {
    const first = events[i];
    const group: LedgerEvent[] = [];
    while (
      i < events.length &&
      events[i].at === first.at &&
      events[i].event === first.event &&
      events[i].ref.mr === first.ref.mr
    )
      group.push(events[i++]);
    const changes = group.map((e) => {
      const change: ReplayChange = {
        zone: e.zone,
        event: e.event,
        points: e.points,
        scoreBefore: scores[e.zone],
        scoreAfter: e.scoreAfter,
        levelBefore: e.levelBefore,
        levelAfter: e.levelAfter,
      };
      scores[e.zone] = e.scoreAfter;
      return change;
    });
    const who = first.ref.mr !== undefined ? `!${first.ref.mr}` : 'A change';
    const caption: CaptionPart[] = [
      { t: `${who} ${HEAD[first.event]}`, k: first.points < 0 ? 'neg' : undefined },
    ];
    for (const c of changes) {
      caption.push({ t: `${c.zone} ${signed(c.points)} → ${c.scoreAfter}`, k: c.points < 0 ? 'neg' : 'pos' });
      const up = c.levelAfter !== c.levelBefore && c.scoreAfter > c.scoreBefore;
      caption.push({
        t:
          c.levelAfter === c.levelBefore
            ? label(c.levelAfter)
            : `${up ? 'up to' : 'down to'} ${label(c.levelAfter)}`,
        k: c.levelAfter,
      });
    }
    const grave = graves.find((g) => g.mr !== undefined && g.mr === first.ref.mr && g.at >= first.at);
    const promoted = changes.some((c) => c.scoreAfter > c.scoreBefore && c.levelAfter !== c.levelBefore);
    steps.push({
      kind: 'event',
      at: first.at,
      mr: first.ref.mr,
      url: first.ref.url,
      event: first.event,
      caption,
      detail: grave ? graveTitle(grave) : (first.note ?? ''),
      scores: { ...scores },
      levels: levels(),
      next: next(),
      changes,
      graves: graves.filter((g) => g.at <= first.at).length,
      hold: first.points < 0 ? 6000 : promoted ? 5000 : 4000,
    });
  }

  const buried = graves.filter((g) => g.status === 'buried');
  const exhumed = graves.length - buried.length;
  steps.push({
    kind: 'end',
    at: events.at(-1)?.at,
    caption: [
      { t: `${buried.length} grave${buried.length === 1 ? '' : 's'} buried` },
      { t: `${exhumed} exhumed`, k: exhumed ? 'neg' : undefined },
      { t: `−${buried.reduce((n, g) => n + g.linesRemoved, 0)} lines` },
    ],
    detail: `${zones.map((z) => `${z} ${scores[z]} pts · ${label(levelForScore(policy, scores[z]))}`).join(' · ')}. Autonomy you can earn, and lose.`,
    scores: { ...scores },
    levels: levels(),
    next: next(),
    changes: [],
    graves: graves.length,
    hold: 3500,
  });

  return {
    agent,
    zones,
    levels: { supervised: policy.levels.supervised, hands_off: policy.levels.hands_off },
    max,
    steps,
    graves,
    events,
  };
}

export const captionText = (parts: CaptionPart[]) => parts.map((p) => p.t).join(' · ');

const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M8 28V13a8 8 0 0 1 16 0v15z" fill="#1c1a17" stroke="#f4f1ea" stroke-width="1.5"/><path d="M13 10l7 5-7 5z" fill="#f4f1ea"/><path d="M4 28.5h24" stroke="#6d675d" stroke-width="2.5" stroke-linecap="round"/></svg>',
)}`;

const TOKENS_LIGHT =
  '--paper:#f4f1ea;--card:#fbf9f4;--ink:#1c1a17;--muted:#6d675d;--line:#d9d3c6;--assisted:#b45309;--supervised:#1d4ed8;--hands:#15803d;--bad:#b91c1c;color-scheme:light';
const TOKENS_DARK =
  '--paper:#12110f;--card:#1a1916;--ink:#ebe6db;--muted:#9c958a;--line:#2d2a25;--assisted:#f59e0b;--supervised:#60a5fa;--hands:#4ade80;--bad:#f87171;color-scheme:dark';

// Sizes are in rem and the root size grows with the viewport, so the same page reads on a phone,
// a laptop and a 1080p recording. Motion is transform/opacity only, and only without reduced motion.
const STYLE = `
:root{${TOKENS_LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${TOKENS_DARK}}}
:root[data-theme="dark"]{${TOKENS_DARK}}
:root[data-theme="light"]{${TOKENS_LIGHT}}
html{font-size:clamp(14px,calc(.5vw + 9px),20px)}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:1rem/1.55 "IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:86rem;margin:0 auto;padding:clamp(20px,1.6rem,40px) 16px 32px}
@media (min-width:700px){.wrap{padding-left:clamp(16px,3vw,64px);padding-right:clamp(16px,3vw,64px)}}
.head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline;padding-bottom:.8rem;border-bottom:2px solid var(--ink);font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.head a{letter-spacing:.06em}
h1{font:600 2.6rem/1.08 Fraunces,Georgia,serif;margin:1rem 0 .25rem;letter-spacing:-.01em;overflow-wrap:anywhere}
.sub{color:var(--muted);margin:0;max-width:96ch}
code{font-family:inherit;overflow-wrap:anywhere}
.cap{margin:1.2rem 0 1.1rem;padding:.2rem 0 .2rem 1.2rem;border-left:.4rem solid var(--lc,var(--muted));min-height:6.9rem}
.cap.assisted{--lc:var(--assisted)}.cap.supervised{--lc:var(--supervised)}.cap.hands_off{--lc:var(--hands)}.cap.neg{--lc:var(--bad)}
.when{color:var(--muted);font-size:.85rem;letter-spacing:.06em}
.line{font-weight:600;font-size:1.85rem;line-height:1.3;margin:.25rem 0 .35rem;overflow-wrap:anywhere}
.line .sep{color:var(--muted);font-weight:400}
/* The caption sits on --paper, where light amber and green are 4.45:1; 10% ink lifts every tone past 5:1. */
.k-pos,.k-hands_off{--k:var(--hands)}.k-neg{--k:var(--bad)}.k-assisted{--k:var(--assisted)}.k-supervised{--k:var(--supervised)}
[class^="k-"]{color:color-mix(in srgb,var(--k) 90%,var(--ink))}
.detail{margin:0;color:var(--muted);font-size:1.05rem;overflow-wrap:anywhere}
.stage{display:grid;grid-template-columns:minmax(0,1fr);gap:1.2rem}
@media (min-width:900px){.stage{grid-template-columns:minmax(0,5fr) minmax(0,7fr)}}
.zones{display:grid;gap:1rem;grid-auto-rows:1fr}
.zc{position:relative;overflow:hidden;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-top:.35rem solid var(--lc);border-radius:6px;padding:1.1rem 1.3rem 1.3rem;--lc:var(--assisted)}
.zc.supervised{--lc:var(--supervised)}.zc.hands_off{--lc:var(--hands)}
.zc-top{display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap}
.zn{font-weight:600;font-size:1.15rem}.zn small{color:var(--muted);font-weight:400;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;margin-right:.5rem}
.badge{display:inline-block;background:var(--lc);color:var(--card);font-weight:600;font-size:1rem;padding:.2rem .75rem;border-radius:999px}
.score{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;margin:.4rem 0 .2rem}
.score b{font-size:4.4rem;line-height:1;font-weight:600}
.score .u{color:var(--muted);font-size:1.1rem}
.delta{font-weight:600;font-size:1.5rem;opacity:0}.delta.pos{color:var(--hands)}.delta.neg{color:var(--bad)}.delta.on{opacity:1}
.move{font-size:.95rem;font-weight:600;color:var(--lc);opacity:0}.move.down{color:var(--bad)}.move.on{opacity:1}
.track{position:relative;height:.8rem;background:var(--line);border-radius:999px;margin:1rem 0 2.4rem}
.nx{color:var(--muted);font-size:.9rem}.zc.neg .nx{display:none}
.fill,.lost{position:absolute;top:0;bottom:0;left:0;border-radius:999px}
.fill{width:100%;background:var(--lc);transform-origin:0 50%;transform:scaleX(0)}
.lost{background:var(--bad);opacity:0}.lost.on{opacity:.9}
/* The tick is faded through its color, not opacity, so its label keeps full --muted contrast. */
.tick{position:absolute;top:-.3rem;bottom:-.3rem;width:2px;background:color-mix(in srgb,var(--ink) 55%,transparent)}
.tick span{position:absolute;top:1.5rem;left:0;transform:translateX(-50%);white-space:nowrap;font-size:.8rem;color:var(--muted)}
.tick.end span{transform:translateX(-100%)}
.stamp{align-self:flex-start;margin-top:auto;border:.2rem solid var(--bad);color:var(--bad);background:var(--card);font-weight:600;font-size:1.35rem;letter-spacing:.08em;text-transform:uppercase;padding:.3rem .8rem;border-radius:6px;transform:rotate(-6deg);opacity:0;pointer-events:none}
.zc.neg .stamp{opacity:1}
.flash{position:absolute;inset:0;background:var(--bad);opacity:0;pointer-events:none}
.chartbox{margin:0;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:.6rem .6rem .2rem;min-width:0}
.chartbox figcaption{color:var(--muted);font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;padding:.2rem .4rem .4rem}
.chart{display:block;width:100%;height:auto;overflow:visible}
.rule{stroke:var(--muted);stroke-opacity:.5;stroke-dasharray:5 5}.rule-label{fill:var(--muted);font-size:15px}.axis{stroke:var(--line);stroke-width:1.5}
.xl{fill:var(--muted);font-size:15px;text-anchor:middle}
.seg{fill:none;stroke-width:3;stroke-linejoin:round;opacity:0}.seg.on,.dot.on{opacity:1}
.s0{stroke:var(--hands)}.s1{stroke:var(--supervised)}.s2{stroke:var(--assisted)}.s3{stroke:var(--muted)}.seg.bad{stroke:var(--bad)}
.dot{fill:var(--card);stroke:var(--ink);stroke-width:2;opacity:0}.dot.bad{fill:var(--bad);stroke:var(--bad)}
.now{fill:none;stroke:var(--ink);stroke-width:2;opacity:.8}
.yard{margin-top:1.1rem}
.yard h2{font:600 1.35rem/1.2 Fraunces,Georgia,serif;margin:0 0 .7rem}
.graves{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:.9rem}
.grave{border:2px dashed var(--line);border-radius:6rem 6rem 6px 6px;padding:1.1rem .9rem .8rem;text-align:center;min-height:8.4rem}
.grave>*{opacity:0}
.grave.dug{background:var(--card);border:1px solid var(--line);padding:calc(1.1rem + 1px) calc(.9rem + 1px) calc(.8rem + 1px)}.grave.dug>*{opacity:1}
.grave.exhumed.dug{border-color:var(--bad);border-width:2px;padding:1.1rem .9rem .8rem}
.rip{font:600 1rem Fraunces,Georgia,serif;letter-spacing:.12em;color:var(--muted)}.grave.exhumed .rip{color:var(--bad)}
.gt{margin:.4rem 0;font-weight:600;font-size:.9rem;line-height:1.35;overflow-wrap:anywhere}
.gm{color:var(--muted);font-size:.8rem}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem 1rem;margin-top:1.1rem;padding-top:.9rem;border-top:1px solid var(--line)}
.ctl{display:flex;gap:.5rem;flex-wrap:wrap}
button,select{font:inherit;font-size:.9rem;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:.4rem .8rem;cursor:pointer;min-height:44px}
button:hover,select:hover{border-color:var(--muted)}
button:focus-visible,select:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
button.primary{background:var(--ink);color:var(--paper);border-color:var(--ink);min-width:7.5rem}
.speed{color:var(--muted);font-size:.9rem;display:flex;align-items:center;gap:.4rem}
.ticks{list-style:none;display:flex;flex-wrap:wrap;gap:.35rem;margin:0;padding:0;margin-left:auto}
.ticks button{min-width:44px;padding:.3rem .55rem;font-size:.8rem;color:var(--muted)}
.ticks button.past{color:var(--ink)}
.ticks button[aria-current="step"]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.empty{margin:2rem 0;padding:2rem 1.4rem;background:var(--card);border:1px dashed var(--line);border-radius:6px;max-width:60ch}
.empty b{font:600 1.35rem/1.3 Fraunces,Georgia,serif;display:block;margin-bottom:.5rem}
footer{margin-top:1.6rem;color:var(--muted);font-size:.8rem}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media (prefers-reduced-motion:no-preference){
.fill{transition:transform .7s cubic-bezier(.2,.8,.2,1)}
.seg,.dot{transition:opacity .4s cubic-bezier(.2,.8,.2,1)}
.now{transition:transform .5s cubic-bezier(.2,.8,.2,1)}
.lost{transition:opacity .4s}
.grave>*{transition:opacity .4s}
.anim .grave.new{animation:rise .5s cubic-bezier(.2,.8,.2,1) both}
.anim .delta.on{animation:rise .4s cubic-bezier(.2,.8,.2,1) both}
.anim .line{animation:fadein .4s cubic-bezier(.2,.8,.2,1) both}
.anim .zc.up .badge{animation:pop .7s cubic-bezier(.2,.8,.2,1) both}
.anim .move.on{animation:rise .4s .2s cubic-bezier(.2,.8,.2,1) both}
.anim .zc.neg .stamp{animation:stamp .45s .15s cubic-bezier(.2,.8,.2,1) both}
.anim .zc.neg .flash{animation:flash 1.1s ease-out both}
@keyframes rise{from{opacity:0;transform:translateY(6px)}}
@keyframes fadein{from{opacity:0;transform:translateY(4px)}}
@keyframes pop{0%{transform:scale(1)}40%{transform:scale(1.25)}100%{transform:scale(1)}}
@keyframes stamp{from{opacity:0;transform:rotate(-6deg) scale(1.3)}to{opacity:1;transform:rotate(-6deg) scale(1)}}
@keyframes flash{0%{opacity:0}12%{opacity:.28}40%{opacity:.04}55%{opacity:.2}100%{opacity:0}}
}
/* On phones the 720-unit chart draws at about half size: scale its labels, lines and dots back up. */
@media (max-width:480px){.line{font-size:1.35rem}.score b{font-size:3.4rem}h1{font-size:2.1rem}.ticks{margin-left:0}.rule-label,.xl{font-size:26px}.rl-name{display:none}.seg{stroke-width:5}.dot{r:9}.graves{grid-template-columns:repeat(2,minmax(0,1fr))}.grave{min-height:0}}
`;

// The player: builds the zone cards, chart and graves from the JSON block (textContent only, never
// innerHTML), then shows one step at a time. Plain JS, no libraries; no template strings in here.
const SCRIPT = `
(() => {
  const story = JSON.parse(document.getElementById('replay-data').textContent);
  const steps = story.steps;
  const root = document.documentElement;
  const q = new URLSearchParams(location.search);
  if (q.get('theme') === 'dark' || q.get('theme') === 'light') root.dataset.theme = q.get('theme');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs, cls) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (cls) e.setAttribute('class', cls);
    return e;
  };
  const LABEL = { assisted: 'Assisted', supervised: 'Supervised', hands_off: 'Hands-off' };
  const STAMP = { survived_soak: 'survived', rolled_back: 'rolled back', human_rejected: 'rejected', security_finding: 'security finding' };
  const signed = (n) => (n < 0 ? '\\u2212' : n > 0 ? '+' : '\\u00b1') + Math.abs(n);
  const pct = (s) => Math.max(0, Math.min(1, s / story.max));
  const restart = (node, cls) => { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };

  // Zone cards.
  const cards = {};
  for (const z of story.zones) {
    const c = el('div', 'zc assisted');
    const top = el('div', 'zc-top');
    const zn = el('div', 'zn');
    zn.append(el('small', '', 'zone'), document.createTextNode(z));
    const badge = el('span', 'badge', LABEL.assisted);
    top.append(zn, badge);
    const score = el('div', 'score');
    const n = el('b', '', '0');
    const delta = el('span', 'delta');
    const move = el('span', 'move');
    score.append(n, el('span', 'u', 'pts'), delta, move);
    const track = el('div', 'track');
    const fill = el('i', 'fill');
    const lost = el('i', 'lost');
    track.append(fill, lost);
    for (const [lvl, at] of [['supervised', story.levels.supervised], ['hands_off', story.levels.hands_off]]) {
      const t = el('span', 'tick');
      t.style.left = (pct(at) * 100) + '%';
      t.append(el('span', '', LABEL[lvl] + ' ' + at));
      track.append(t);
    }
    const end = el('span', 'tick end');
    end.style.left = '100%';
    end.append(el('span', '', String(story.max)));
    track.append(end);
    const nx = el('div', 'nx');
    const stamp = el('div', 'stamp');
    const flash = el('div', 'flash');
    flash.setAttribute('aria-hidden', 'true');
    c.append(flash, top, score, track, nx, stamp);
    $('zones').append(c);
    cards[z] = { c, badge, n, delta, move, fill, lost, stamp, flash, nx, shown: 0, raf: 0 };
  }

  // Trust chart: one segment and dot per step, revealed as the story reaches it.
  const svg = $('chart');
  const W = 720, H = 250, P = { l: 16, r: 150, t: 10, b: 36 };
  const span = Math.max(steps.length - 2, 1);
  const x = (i) => P.l + (i / span) * (W - P.l - P.r);
  const y = (s) => H - P.b - pct(s) * (H - P.t - P.b);
  for (const [lvl, at] of [['supervised', story.levels.supervised], ['hands_off', story.levels.hands_off]]) {
    svg.append(sv('line', { x1: P.l, x2: W - P.r + 4, y1: y(at), y2: y(at) }, 'rule'));
    const t = sv('text', { x: W - P.r + 12, y: y(at) + 5 }, 'rule-label');
    const nm = sv('tspan', {}, 'rl-name');
    nm.textContent = LABEL[lvl] + ' ';
    t.append(nm, document.createTextNode('\\u2265 ' + at));
    svg.append(t);
  }
  svg.append(sv('line', { x1: P.l, x2: W - P.r, y1: y(0), y2: y(0) }, 'axis'));
  const segs = [];
  steps.forEach((s, i) => {
    if (s.kind !== 'event') return;
    const lab = sv('text', { x: x(i), y: H - P.b + 24 }, 'xl');
    lab.textContent = s.mr !== undefined ? '!' + s.mr : String(i);
    svg.append(lab);
    for (const ch of s.changes) {
      const zi = story.zones.indexOf(ch.zone);
      const d = 'M' + x(i - 1) + ' ' + y(ch.scoreBefore) + 'H' + x(i) + 'V' + y(ch.scoreAfter);
      const p = sv('path', { d }, 'seg s' + (zi % 4) + (ch.points < 0 ? ' bad' : ''));
      const dot = sv('circle', { cx: x(i), cy: y(ch.scoreAfter), r: 6 }, 'dot' + (ch.points < 0 ? ' bad' : ''));
      const tt = sv('title', {});
      tt.textContent = ch.zone + ' ' + signed(ch.points) + ' \\u2192 ' + ch.scoreAfter;
      dot.append(tt);
      svg.append(p, dot);
      segs.push({ i, p, dot });
    }
  });
  // Unchanged zones carry their score flat across steps where another zone moved.
  steps.forEach((s, i) => {
    if (s.kind !== 'event') return;
    story.zones.forEach((z, zi) => {
      if (s.changes.some((c) => c.zone === z)) return;
      const prev = steps[i - 1].scores[z];
      const p = sv('path', { d: 'M' + x(i - 1) + ' ' + y(prev) + 'H' + x(i) }, 'seg s' + (zi % 4));
      svg.prepend(p);
      segs.push({ i, p });
    });
  });
  const now = sv('circle', { cx: 0, cy: 0, r: 11 }, 'now');
  now.setAttribute('aria-hidden', 'true');
  svg.append(now);

  // Graveyard plots, oldest first; a plot is dug when the story reaches its grave.
  const plots = story.graves.map((g) => {
    const d = el('div', 'grave ' + g.status);
    d.append(
      el('div', 'rip', g.status === 'buried' ? 'R.I.P.' : 'EXHUMED'),
      el('div', 'gt', g.title.replace(/^(Draft:\\s*)?/i, '')),
      el('div', 'gm', '\\u2212' + g.linesRemoved + ' lines \\u00b7 ' + g.zone + (g.mr !== undefined ? ' \\u00b7 !' + g.mr : '')),
    );
    $('graves').append(d);
    return d;
  });

  // Step ticks double as a scrubber.
  const ticks = steps.map((s, i) => {
    const li = el('li');
    const b = el('button', '', s.kind === 'start' ? 'Start' : s.kind === 'end' ? 'End' : s.mr !== undefined ? '!' + s.mr : String(i));
    b.type = 'button';
    // The accessible name starts with the visible label (WCAG 2.5.3), then says what the step holds.
    const said = s.caption.map((p) => p.t).join(' \\u00b7 ');
    b.setAttribute('aria-label', said.startsWith(b.textContent) ? said : b.textContent + ': ' + said);
    b.addEventListener('click', () => { pause(); show(i); });
    li.append(b);
    $('ticks').append(li);
    return b;
  });

  const tween = (card, to, animate) => {
    cancelAnimationFrame(card.raf);
    const from = card.shown;
    if (!animate || from === to) { card.shown = to; card.n.textContent = String(to); return; }
    const t0 = performance.now();
    const dur = 700 / speed;
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      card.n.textContent = String(Math.round(from + (to - from) * e));
      if (k < 1) card.raf = requestAnimationFrame(tick); else card.shown = to;
    };
    card.raf = requestAnimationFrame(tick);
  };

  let cur = -1;
  let playing = false;
  let timer = 0;
  let speed = Number(q.get('speed')) || 1;
  speed = Math.max(0.25, Math.min(4, speed));
  const sel = $('speed');
  if (![...sel.options].some((o) => Number(o.value) === speed)) sel.append(new Option(speed + '\\u00d7', String(speed)));
  sel.value = String([...sel.options].find((o) => Number(o.value) === speed).value);
  sel.addEventListener('change', () => { speed = Number(sel.value) || 1; if (playing) schedule(); });

  function show(k) {
    k = Math.max(0, Math.min(steps.length - 1, k));
    const animate = !reduced && k === cur + 1;
    cur = k;
    const s = steps[k];
    root.dataset.step = String(k);
    document.body.classList.toggle('anim', animate);
    const evs = steps.filter((t) => t.kind === 'event').length;
    const when = s.at ? s.at.slice(0, 16).replace('T', ' ') + ' UTC' : '';
    $('when').textContent = (s.kind === 'start' ? 'Opening the file' : s.kind === 'end' ? 'Record closed' : 'Step ' + k + ' of ' + evs) + (when ? ' \\u00b7 ' + when : '');
    const line = $('line');
    line.replaceChildren();
    s.caption.forEach((p, i) => {
      if (i) line.append(el('span', 'sep', ' \\u00b7 '));
      line.append(el('span', p.k ? 'k-' + p.k : '', p.t));
    });
    if (animate) restart(line, 'line');
    $('detail').textContent = s.detail;
    const neg = s.changes.some((c) => c.points < 0);
    const lead = s.changes[0] ? s.levels[s.changes[0].zone] : s.levels[story.zones[0]];
    $('cap').className = 'cap ' + (neg ? 'neg' : lead || '');
    for (const z of story.zones) {
      const card = cards[z];
      const ch = s.changes.find((c) => c.zone === z);
      const lvl = s.levels[z];
      const up = !!ch && ch.levelAfter !== ch.levelBefore && ch.scoreAfter > ch.scoreBefore;
      const down = !!ch && ch.levelAfter !== ch.levelBefore && ch.scoreAfter < ch.scoreBefore;
      card.c.className = 'zc ' + lvl + (up ? ' up' : '') + (ch && ch.points < 0 ? ' neg' : '');
      card.badge.textContent = LABEL[lvl];
      card.nx.textContent = s.next[z];
      tween(card, s.scores[z], animate);
      card.fill.style.transform = 'scaleX(' + pct(s.scores[z]) + ')';
      card.delta.textContent = ch ? signed(ch.points) : '';
      card.delta.className = 'delta' + (ch ? ' on ' + (ch.points < 0 ? 'neg' : 'pos') : '');
      card.move.textContent = up ? '\\u25b2 promoted' : down ? '\\u25bc demoted' : '';
      card.move.className = 'move' + (up || down ? ' on' : '') + (down ? ' down' : '');
      card.stamp.textContent = ch && ch.points < 0 ? signed(ch.points) + ' \\u00b7 ' + STAMP[ch.event] : '';
      if (ch && ch.points < 0) {
        card.lost.style.left = pct(ch.scoreAfter) * 100 + '%';
        card.lost.style.width = (pct(ch.scoreBefore) - pct(ch.scoreAfter)) * 100 + '%';
      }
      card.lost.classList.toggle('on', !!ch && ch.points < 0);
      if (animate) {
        if (ch) restart(card.delta, 'on');
        if (up || down) restart(card.move, 'on');
        if (up) restart(card.badge, 'badge');
        if (ch && ch.points < 0) { restart(card.flash, 'flash'); restart(card.stamp, 'stamp'); }
      }
    }
    for (const g of segs) {
      g.p.classList.toggle('on', g.i <= k);
      if (g.dot) g.dot.classList.toggle('on', g.i <= k);
    }
    const ev = Math.min(k, steps.length - 2);
    const z0 = s.changes[0] ? s.changes[0].zone : story.zones[0];
    now.style.transform = 'translate(' + x(ev) + 'px, ' + y(s.scores[z0]) + 'px)';
    plots.forEach((d, i) => {
      const dug = i < s.graves;
      d.classList.toggle('new', dug && !d.classList.contains('dug'));
      d.classList.toggle('dug', dug);
      // An undug plot is blank on screen; keep its title from screen readers until the story reaches it.
      if (dug) d.removeAttribute('aria-hidden'); else d.setAttribute('aria-hidden', 'true');
    });
    ticks.forEach((b, i) => {
      b.classList.toggle('past', i <= k);
      if (i === k) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    $('back').disabled = k === 0;
    $('fwd').disabled = k === steps.length - 1;
    $('status').textContent = s.caption.map((p) => p.t).join(' \\u00b7 ') + '. ' + s.detail;
  }

  function ui() {
    const btn = $('play');
    btn.textContent = playing ? '\\u275a\\u275a Pause' : cur === steps.length - 1 ? '\\u21ba Replay' : '\\u25b6 Play';
    root.dataset.playing = String(playing);
    root.dataset.done = String(cur === steps.length - 1);
  }
  function schedule() {
    clearTimeout(timer);
    if (!playing) return;
    if (cur >= steps.length - 1) { playing = false; ui(); return; }
    timer = setTimeout(() => { show(cur + 1); schedule(); }, steps[cur].hold / speed);
  }
  function play() {
    if (cur >= steps.length - 1) { cur = -1; show(0); }
    playing = true; ui(); schedule();
  }
  function pause() { playing = false; clearTimeout(timer); ui(); }
  const step = (d) => { pause(); show(cur + d); ui(); };

  $('play').addEventListener('click', () => (playing ? pause() : play()));
  $('back').addEventListener('click', () => step(-1));
  $('fwd').addEventListener('click', () => step(1));
  $('restart').addEventListener('click', () => { const was = playing; pause(); cur = -1; show(0); if (was) play(); else ui(); });
  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tag = e.target && e.target.tagName;
    if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'SELECT' && tag !== 'INPUT') { e.preventDefault(); playing ? pause() : play(); }
    else if (e.key === 'ArrowLeft' && tag !== 'SELECT') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight' && tag !== 'SELECT') { e.preventDefault(); step(1); }
    else if (e.key === 'Home') { e.preventDefault(); pause(); cur = -1; show(0); ui(); }
  });

  // Reduced motion: no transitions, and no timer unless the URL asks for autoplay.
  const auto = q.get('autoplay');
  show(Number(q.get('step')) || 0);
  if (auto === '1' || (auto !== '0' && !reduced)) play(); else ui();
  window.replay = { play, pause, show, get step() { return cur; }, get playing() { return playing; }, steps: steps.length };
})();
`;

export function renderReplay(ledger: Ledger, policy: Policy, generatedAt = new Date().toISOString()): string {
  const story = replayStory(ledger, policy);
  const agent = story.agent;
  const evs = story.steps.length - 2;
  const body = story.events.length
    ? `<section id="cap" class="cap assisted" aria-hidden="true"><div class="when" id="when"></div><p class="line" id="line">${esc(captionText(story.steps[0].caption))}</p><p class="detail" id="detail"></p></section>
<p class="sr" id="status" role="status" aria-live="polite"></p>
<section class="stage" aria-label="Autonomy by zone"><div class="zones" id="zones"></div>
<figure class="chartbox"><figcaption>Trust over time</figcaption><svg class="chart" id="chart" viewBox="0 0 720 250" role="img" aria-label="Trust score per zone, drawn step by step"></svg></figure></section>
<section class="yard"><h2>Graveyard</h2><div class="graves" id="graves"></div></section>
<div class="bar"><div class="ctl" role="group" aria-label="Replay controls"><button type="button" id="restart" title="Restart (Home)">↺ Restart</button><button type="button" id="back" title="Previous step (←)">◀ Back</button><button type="button" id="play" class="primary" title="Play or pause (space)">▶ Play</button><button type="button" id="fwd" title="Next step (→)">Next ▶</button></div>
<label class="speed">Speed <select id="speed"><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="3">3×</option></select></label>
<ol class="ticks" id="ticks" aria-label="Steps"></ol></div>
<noscript><p class="sub">The replay needs JavaScript. The same events are listed on <a href="index.html">the board</a>.</p></noscript>
<script type="application/json" id="replay-data">${scriptJson(story)}</script>
<script>${SCRIPT}</script>`
    : `<div class="empty"><b>Nothing to replay yet.</b>The ledger has no scored events. When ${esc(agent)}’s first grave survives (or fails) a production soak, its story starts here. Rules: <code>probation/policy.yml</code>.</div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Probation Replay</title>
<meta name="description" content="${esc(`${agent}'s probation, replayed from the ledger: ${evs} scored events, step by step.`)}">
<meta name="theme-color" content="#f4f1ea" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#12110f" media="(prefers-color-scheme: dark)">
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body><main class="wrap">
<div class="head"><span>Probation + Undertaker · ledger replay</span><a href="index.html">← The board</a></div>
<h1>In the matter of ${esc(agent)}</h1>
<p class="sub">Every scored event on the ledger${evs > 0 ? ` (${evs})` : ''}, replayed in order. Rules: <code>probation/policy.yml</code>.</p>
${body}
<footer>Generated ${esc(generatedAt.slice(0, 16).replace('T', ' '))} UTC from the <code>ledger</code> branch.${story.events.length ? ' Space plays or pauses, ← and → step.' : ''}</footer>
</main></body></html>`;
}
