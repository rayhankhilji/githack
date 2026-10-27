import { label } from './gate.ts';
import type { Ledger, LedgerEvent, SciPoint } from './ledger.ts';
import { type Level, levelForScore, type Policy } from './policy.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Signed percentage with a real minus sign, so negative values never rely on color alone.
const pct = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : ''}${Math.abs(n).toFixed(1)}%`;

// The nine DevSecOps stages and what Probation runs in each (shown as a strip on the board).
export const STAGES: { stage: string; runs: string }[] = [
  { stage: 'Plan', runs: 'Nightly census files a grave issue for code production proves dead.' },
  { stage: 'Create', runs: 'Undertaker flow digs it: a deletion-only MR plus a coroner’s report.' },
  { stage: 'Verify', runs: 'verify:check (lint, types, tests) and a traffic replay of real requests.' },
  { stage: 'Package', runs: 'Cloud Build builds the image; its size feeds the SCI note.' },
  { stage: 'Secure', runs: 'SAST, secret and dependency scanning, plus an npm audit gate.' },
  { stage: 'Release', runs: 'Canary child pipeline: staging → canary → soak → promote.' },
  { stage: 'Configure', runs: 'Cloud Run revision tags, traffic split and feature flags.' },
  { stage: 'Monitor', runs: 'Soak synthetics and census request logs watch production.' },
  { stage: 'Govern', runs: 'policy.yml, CODEOWNERS and the append-only ledger decide autonomy.' },
];

// A small tombstone glyph for the tab; ink on a paper outline so it reads on light and dark tab bars.
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M8 28V13a8 8 0 0 1 16 0v15z" fill="#1c1a17" stroke="#f4f1ea" stroke-width="1.5"/><path d="M12.5 14h7M12.5 18.5h7" stroke="#f4f1ea" stroke-width="2" stroke-linecap="round"/><path d="M4 28.5h24" stroke="#6d675d" stroke-width="2.5" stroke-linecap="round"/></svg>',
)}`;

// Distance to the next level for a zone card; progress is the share of the current band already earned.
export function nextPromotion(
  policy: Policy,
  score: number,
): { text: string; progress: number; next?: Level } {
  const { supervised, hands_off } = policy.levels;
  if (score >= hands_off) return { text: 'top level', progress: 1 };
  const [floor, next, ceil] =
    score >= supervised
      ? [supervised, 'hands_off' as const, hands_off]
      : [policy.levels.assisted, 'supervised' as const, supervised];
  return {
    text: `next promotion in ${ceil - score} pts`,
    progress: Math.min(1, Math.max(0, (score - floor) / (ceil - floor))),
    next,
  };
}

// SCI trend: a static sparkline (stretched to the tile; strokes and dots are non-scaling so they stay crisp) of gCO₂e per 1k requests, labelled first → last.
export function sciSparkline(history: SciPoint[]): string {
  const w = 200;
  const h = 40;
  const p = 4;
  if (history.length === 0)
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="No SCI measurements yet"><line x1="${p}" x2="${w - p}" y1="${h / 2}" y2="${h / 2}" class="spark-empty"/></svg><div class="spark-label">no measurements yet</div>`;
  const vals = history.map((s) => s.gramsPer1kRequests);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const x = (i: number) => (history.length === 1 ? w / 2 : p + (i / (history.length - 1)) * (w - 2 * p));
  const y = (v: number) => (hi === lo ? h / 2 : h - p - ((v - lo) / (hi - lo)) * (h - 2 * p));
  const first = vals[0];
  const last = vals[vals.length - 1];
  // No meaningful % change from a zero baseline; treat it as unknown rather than 0%.
  const delta = first ? ((last - first) / first) * 100 : undefined;
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const dots = history
    .map(
      (s, i) =>
        `<path d="M${x(i).toFixed(1)} ${y(s.gramsPer1kRequests).toFixed(1)}h0" class="${i === history.length - 1 ? `spark-last ${delta === undefined ? '' : delta <= 0 ? 'down' : 'up'}` : 'spark-dot'}"><title>${esc(`${s.at.slice(0, 16).replace('T', ' ')} · ${s.sha.slice(0, 8)} · ${s.gramsPer1kRequests.toFixed(4)} g`)}</title></path>`,
    )
    .join('');
  const text =
    history.length === 1
      ? `1 measurement · ${first.toFixed(4)} g`
      : `${first.toFixed(4)} → ${last.toFixed(4)} g${delta === undefined ? '' : ` · ${pct(delta)}`}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(`SCI per 1k requests over ${history.length} measurements: ${text}`)}"><polyline points="${pts}" class="spark-line"/>${dots}</svg><div class="spark-label">${esc(text)}</div>`;
}

// Score-over-time step chart per zone, with the promotion thresholds drawn as rules.
export function trustChart(events: LedgerEvent[], policy: Policy, zones: string[]): string {
  const w = 720;
  const h = 220;
  const pad = { l: 36, r: 12, t: 12, b: 24 };
  const maxScore = Math.max(policy.levels.hands_off + 20, ...events.map((e) => e.scoreAfter));
  const n = Math.max(events.length, 1);
  const x = (i: number) => pad.l + (i / n) * (w - pad.l - pad.r);
  const y = (s: number) => h - pad.b - (s / maxScore) * (h - pad.t - pad.b);
  const rules = (['supervised', 'hands_off'] as const)
    .map(
      (lvl) =>
        `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(policy.levels[lvl])}" y2="${y(policy.levels[lvl])}" class="rule"/><text x="${pad.l + 4}" y="${y(policy.levels[lvl]) - 4}" class="rule-label"><tspan class="rl-name">${label(lvl)} </tspan>≥ ${policy.levels[lvl]}</text>`,
    )
    .join('');
  const lines = zones
    .map((zone, zi) => {
      let score = 0;
      const pts: string[] = [`${x(0)},${y(0)}`];
      events.forEach((e, i) => {
        if (e.zone !== zone) return;
        pts.push(`${x(i + 1)},${y(score)}`);
        score = e.scoreAfter;
        pts.push(`${x(i + 1)},${y(score)}`);
      });
      pts.push(`${x(n)},${y(score)}`);
      const dots = events
        .map((e, i) =>
          e.zone === zone
            ? `<circle cx="${x(i + 1)}" cy="${y(e.scoreAfter)}" r="4" class="dot ${e.points < 0 ? 'bad' : ''}"><title>${esc(`${e.zone}: ${e.event} on !${e.ref.mr ?? '?'} → ${e.scoreAfter}`)}</title></circle>`
            : '',
        )
        .join('');
      return `<polyline points="${pts.join(' ')}" class="series s${zi % 4}"/>${dots}`;
    })
    .join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Trust score over time per zone">${rules}<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(0)}" y2="${y(0)}" class="axis"/>${lines}</svg>`;
}

export function renderBoard(ledger: Ledger, policy: Policy, generatedAt = new Date().toISOString()): string {
  const agents = Object.keys(policy.agents);
  const agent = agents[0];
  const zoneNames = policy.zones.map((z) => z.name);
  const scores = ledger.scores[agent] ?? {};
  const touched = zoneNames.filter((z) => z in scores);
  const zoneCards = policy.zones
    .filter((z) => !z.neutral)
    .map((z) => {
      if (z.forbidden)
        return `<div class="zone forbidden"><div class="zn">${esc(z.name)}</div><div class="lvl">Forbidden</div><div class="sc">never</div><div class="meter" aria-hidden="true"></div><div class="nx">forbidden · humans only</div></div>`;
      const s = scores[z.name] ?? 0;
      const lvl = levelForScore(policy, s);
      const nx = nextPromotion(policy, s);
      return `<div class="zone ${lvl}"><div class="zn">${esc(z.name)}</div><div class="lvl">${label(lvl)}</div><div class="sc">${s} pts</div><div class="meter" aria-hidden="true"><i style="width:${Math.round(nx.progress * 100)}%"></i></div><div class="nx">${nx.text}${nx.next ? ` → ${label(nx.next)}` : ''}</div></div>`;
    })
    .join('');
  const events = [...ledger.events]
    .reverse()
    .slice(0, 30)
    .map(
      (e) =>
        `<tr><td>${e.at.slice(0, 16).replace('T', ' ')}</td><td>${esc(e.zone)}</td><td>${esc(e.event.replace(/_/g, ' '))}</td><td class="num ${e.points < 0 ? 'neg' : 'pos'}">${e.points > 0 ? '+' : e.points < 0 ? '−' : ''}${Math.abs(e.points)}</td><td class="num">${e.scoreAfter}</td><td>${e.levelBefore === e.levelAfter ? label(e.levelAfter) : `<b>${label(e.levelBefore)} → ${label(e.levelAfter)}</b>`}</td><td>${e.ref.url ? `<a href="${esc(e.ref.url)}">!${e.ref.mr}</a>` : e.ref.mr ? `!${e.ref.mr}` : ''}</td></tr>`,
    )
    .join('');
  const graves = [...ledger.graveyard]
    .reverse()
    .map(
      (g) =>
        `<div class="grave ${g.status}"><div class="rip">${g.status === 'buried' ? 'R.I.P.' : 'EXHUMED'}</div><div class="gt">${esc(g.title.replace(/^(Draft:\s*)?/i, ''))}</div><div class="gm">−${g.linesRemoved} lines · ${esc(g.zone)}${g.sciDeltaPct !== undefined ? ` · <span class="nw">SCI ${pct(g.sciDeltaPct)}</span>` : ''}</div><div class="gd">${g.at.slice(0, 10)}</div></div>`,
    )
    .join('');
  const stages = STAGES.map(
    (s, i) =>
      `<li><span class="sn">${String(i + 1).padStart(2, '0')}</span><b>${esc(s.stage)}</b><span class="sd">${esc(s.runs)}</span></li>`,
  ).join('');
  const buried = ledger.graveyard.filter((g) => g.status === 'buried');
  const linesBuried = buried.reduce((n, g) => n + g.linesRemoved, 0);
  const hist = ledger.sci?.history ?? [];
  const sciNow = hist.at(-1)?.gramsPer1kRequests;
  const sciFirst = hist[0]?.gramsPer1kRequests;
  const sciDelta = sciNow !== undefined && sciFirst ? ((sciNow - sciFirst) / sciFirst) * 100 : undefined;
  const description = `${agent} deletes dead code on probation: ${buried.length} graves dug, −${linesBuried} lines, autonomy earned per zone by surviving production. Rules in probation/policy.yml.`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Probation Board</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website"><meta property="og:title" content="Probation Board"><meta property="og:description" content="${esc(description)}">
<meta name="theme-color" content="#f4f1ea" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#12110f" media="(prefers-color-scheme: dark)">
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet">
<style>
:root{--paper:#f4f1ea;--ink:#1c1a17;--muted:#6d675d;--line:#d9d3c6;--assisted:#b45309;--supervised:#1d4ed8;--hands:#15803d;--bad:#b91c1c;--card:#fbf9f4;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#12110f;--ink:#ebe6db;--muted:#9c958a;--line:#2d2a25;--assisted:#f59e0b;--supervised:#60a5fa;--hands:#4ade80;--bad:#f87171;--card:#1a1916;color-scheme:dark}}
:root[data-theme="dark"]{--paper:#12110f;--ink:#ebe6db;--muted:#9c958a;--line:#2d2a25;--assisted:#f59e0b;--supervised:#60a5fa;--hands:#4ade80;--bad:#f87171;--card:#1a1916;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.55 "IBM Plex Mono",ui-monospace,monospace}
main{max-width:1040px;margin:0 auto;padding:40px 16px 64px}
h1{font:600 40px/1.1 Fraunces,Georgia,serif;margin:0}h2{font:600 22px/1.2 Fraunces,Georgia,serif;margin:48px 0 12px}
.sub{color:var(--muted);margin:8px 0 28px;max-width:70ch}code{overflow-wrap:anywhere}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.stat{border:1px solid var(--line);background:var(--card);padding:14px 16px;border-radius:6px;min-width:0}.stat b{display:block;font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}.stat>span{color:var(--muted);font-size:12px}
.spark{display:block;width:100%;height:40px;margin-top:10px;overflow:visible}.spark-line{fill:none;stroke:var(--ink);stroke-width:1.5;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.spark-dot,.spark-last{fill:none;stroke-linecap:round;vector-effect:non-scaling-stroke}.spark-dot{stroke:var(--muted);stroke-width:4}.spark-last{stroke-width:8}.spark-last.down{stroke:var(--hands)}.spark-last.up{stroke:var(--assisted)}.spark-empty{stroke:var(--line);stroke-dasharray:3 3;vector-effect:non-scaling-stroke}
.spark-label{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;margin-top:4px}
.zones{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.zone{border:1px solid var(--line);border-top:4px solid var(--muted);background:var(--card);padding:10px 12px;border-radius:6px;--lc:var(--muted)}
.zone.assisted{border-top-color:var(--assisted);--lc:var(--assisted)}.zone.supervised{border-top-color:var(--supervised);--lc:var(--supervised)}.zone.hands_off{border-top-color:var(--hands);--lc:var(--hands)}
/* Forbidden recedes through a 60% dashed rule and muted text, not card opacity, so its text keeps 4.5:1. */
.zone.forbidden{border-top-style:dashed;border-top-color:color-mix(in srgb,var(--muted) 60%,transparent)}.zone.forbidden .zn,.zone.forbidden .sc{color:var(--muted)}
.zn{font-weight:600}.lvl{font-size:12px;color:var(--lc);font-weight:600}.zone.forbidden .lvl{color:var(--muted)}.sc{font-variant-numeric:tabular-nums}
.meter{height:3px;background:var(--line);border-radius:2px;margin:8px 0 6px;overflow:hidden}.meter i{display:block;height:100%;background:var(--lc)}
.nx{font-size:12px;line-height:16px;color:var(--muted);font-variant-numeric:tabular-nums}
.chart{display:block;width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:6px}
.rule{stroke:var(--muted);stroke-opacity:.45;stroke-dasharray:4 4}.rule-label{fill:var(--muted);font-size:11px}.axis{stroke:var(--line)}
.series{fill:none;stroke-width:2}.s0{stroke:var(--hands)}.s1{stroke:var(--supervised)}.s2{stroke:var(--assisted)}.s3{stroke:var(--muted)}
.dot{fill:var(--card);stroke:var(--ink);stroke-width:1.5}.dot.bad{stroke:var(--bad);fill:var(--bad)}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin-top:8px}.legend i{display:inline-block;width:12px;height:3px;margin-right:6px;vertical-align:middle}
.stages{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:0;border:1px solid var(--line);border-radius:6px;background:var(--card);overflow:hidden}
.stages li{display:grid;grid-template-columns:28px 1fr;column-gap:10px;padding:12px 14px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);margin:0 -1px -1px 0}
.sn{grid-row:span 2;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;padding-top:2px}.stages b{font-weight:600}.sd{color:var(--muted);font-size:12px;line-height:18px}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:6px;background:var(--card)}
table{width:100%;border-collapse:collapse;min-width:640px}td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{color:var(--muted);font-weight:400;font-size:12px}
.num{text-align:right;font-variant-numeric:tabular-nums}.pos{color:var(--hands)}.neg{color:var(--bad)}a{color:inherit}
a:focus-visible,.table-wrap:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.graves{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
.grave{background:var(--card);border:1px solid var(--line);border-radius:90px 90px 6px 6px;padding:28px 16px 16px;text-align:center}
.grave.exhumed{border-color:var(--bad)}.rip{font:600 15px Fraunces,Georgia,serif;letter-spacing:.12em;color:var(--muted)}.grave.exhumed .rip{color:var(--bad)}
.nw{white-space:nowrap}.gt{margin:8px 0;font-weight:600;overflow-wrap:anywhere}.gm,.gd{color:var(--muted);font-size:12px}
.replay{font:14px/1.55 "IBM Plex Mono",ui-monospace,monospace;margin-left:12px;white-space:nowrap}
footer{margin-top:48px;color:var(--muted);font-size:12px}
/* On phones the 720-unit chart shrinks to half size: scale its labels, lines and dots back up. */
@media (max-width:480px){h1{font-size:32px;line-height:36px}.rule-label{font-size:22px}.rl-name{display:none}.series{stroke-width:3.5}.dot{r:7;stroke-width:2.5}}
@media (prefers-reduced-motion:no-preference){.zone,.grave,.stat,.stages li{animation:rise .4s cubic-bezier(.2,.8,.2,1) both}@keyframes rise{from{opacity:0;transform:translateY(6px)}}}
</style></head><body><main>
<h1>Probation Board</h1>
<p class="sub">${esc(agent)} deletes dead code. It started on probation and earns autonomy one surviving deploy at a time, per zone. A rollback costs ${Math.abs(policy.scoring.rolled_back)} points instantly. Rules: <code>probation/policy.yml</code>.</p>
<div class="stats">
<div class="stat"><b>${buried.length}</b><span>graves dug (survived production)</span></div>
<div class="stat"><b>−${linesBuried}</b><span>lines of code removed</span></div>
<div class="stat"><b>${ledger.graveyard.filter((g) => g.status === 'exhumed').length}</b><span>rollbacks (exhumed)</span></div>
<div class="stat"><b>${sciDelta === undefined ? '—' : pct(sciDelta)}</b><span>SCI change since first measurement${sciNow !== undefined ? ` (${sciNow.toFixed(4)} gCO₂e/1k req)` : ''}</span>${sciSparkline(hist)}</div>
</div>
<h2>Autonomy by zone <a class="replay" href="playground.html">⚖ Try the gate</a></h2><div class="zones">${zoneCards}</div>
<h2>Trust over time <a class="replay" href="replay.html">▶ Replay the story</a></h2>${trustChart(ledger.events, policy, touched)}
<div class="legend">${touched.map((z, i) => `<span><i style="background:var(${['--hands', '--supervised', '--assisted', '--muted'][i % 4]})"></i>${esc(z)}</span>`).join('')}</div>
<h2>Graveyard</h2>${graves ? `<div class="graves">${graves}</div>` : '<p class="sub">No graves yet. The census has not found anything dead, or Undertaker has not been allowed to dig.</p>'}
<h2>Nine stages, one lifecycle</h2><ol class="stages">${stages}</ol>
<h2>Ledger</h2>${events ? `<div class="table-wrap" role="region" aria-label="Ledger, last 30 events" tabindex="0"><table><thead><tr><th>When (UTC)</th><th>Zone</th><th>Event</th><th class="num">Pts</th><th class="num">Score</th><th>Level</th><th>MR</th></tr></thead><tbody>${events}</tbody></table></div>` : '<p class="sub">No scored events yet.</p>'}
<footer>Generated ${generatedAt.slice(0, 16).replace('T', ' ')} UTC from the <code>ledger</code> branch. Every row is also in <code>audit.jsonl</code>.</footer>
</main></body></html>`;
}
