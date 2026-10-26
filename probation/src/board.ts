import { label } from './gate.ts';
import type { Ledger, LedgerEvent } from './ledger.ts';
import { levelForScore, type Policy } from './policy.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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
        `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(policy.levels[lvl])}" y2="${y(policy.levels[lvl])}" class="rule"/><text x="${w - pad.r}" y="${y(policy.levels[lvl]) - 4}" class="rule-label" text-anchor="end">${label(lvl)} ≥ ${policy.levels[lvl]}</text>`,
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
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Trust score over time per zone">${rules}<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(0)}" y2="${y(0)}" class="axis"/>${lines}</svg>`;
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
        return `<div class="zone forbidden"><div class="zn">${esc(z.name)}</div><div class="lvl">Forbidden</div><div class="sc">never</div></div>`;
      const s = scores[z.name] ?? 0;
      const lvl = levelForScore(policy, s);
      return `<div class="zone ${lvl}"><div class="zn">${esc(z.name)}</div><div class="lvl">${label(lvl)}</div><div class="sc">${s} pts</div></div>`;
    })
    .join('');
  const events = [...ledger.events]
    .reverse()
    .slice(0, 30)
    .map(
      (e) =>
        `<tr><td>${e.at.slice(0, 16).replace('T', ' ')}</td><td>${esc(e.zone)}</td><td>${esc(e.event.replace(/_/g, ' '))}</td><td class="num ${e.points < 0 ? 'neg' : 'pos'}">${e.points > 0 ? '+' : ''}${e.points}</td><td class="num">${e.scoreAfter}</td><td>${e.levelBefore === e.levelAfter ? label(e.levelAfter) : `<b>${label(e.levelBefore)} → ${label(e.levelAfter)}</b>`}</td><td>${e.ref.url ? `<a href="${esc(e.ref.url)}">!${e.ref.mr}</a>` : e.ref.mr ? `!${e.ref.mr}` : ''}</td></tr>`,
    )
    .join('');
  const graves = [...ledger.graveyard]
    .reverse()
    .map(
      (g) =>
        `<div class="grave ${g.status}"><div class="rip">${g.status === 'buried' ? 'R.I.P.' : 'EXHUMED'}</div><div class="gt">${esc(g.title.replace(/^(Draft:\s*)?/i, ''))}</div><div class="gm">−${g.linesRemoved} lines · ${esc(g.zone)}${g.sciDeltaPct !== undefined ? ` · SCI ${g.sciDeltaPct.toFixed(1)}%` : ''}</div><div class="gd">${g.at.slice(0, 10)}</div></div>`,
    )
    .join('');
  const buried = ledger.graveyard.filter((g) => g.status === 'buried');
  const linesBuried = buried.reduce((n, g) => n + g.linesRemoved, 0);
  const hist = ledger.sci?.history ?? [];
  const sciNow = hist.at(-1)?.gramsPer1kRequests;
  const sciFirst = hist[0]?.gramsPer1kRequests;
  const sciDelta = sciNow !== undefined && sciFirst ? ((sciNow - sciFirst) / sciFirst) * 100 : undefined;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Probation Board</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet">
<style>
:root{--paper:#f4f1ea;--ink:#1c1a17;--muted:#6d675d;--line:#d9d3c6;--assisted:#b45309;--supervised:#1d4ed8;--hands:#15803d;--bad:#b91c1c;--card:#fbf9f4}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#12110f;--ink:#ebe6db;--muted:#9c958a;--line:#2d2a25;--assisted:#f59e0b;--supervised:#60a5fa;--hands:#4ade80;--bad:#f87171;--card:#1a1916}}
:root[data-theme="dark"]{--paper:#12110f;--ink:#ebe6db;--muted:#9c958a;--line:#2d2a25;--assisted:#f59e0b;--supervised:#60a5fa;--hands:#4ade80;--bad:#f87171;--card:#1a1916}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.55 "IBM Plex Mono",ui-monospace,monospace}
main{max-width:1040px;margin:0 auto;padding:40px 16px 64px}
h1{font:600 40px/1.1 Fraunces,Georgia,serif;margin:0}h2{font:600 22px/1.2 Fraunces,Georgia,serif;margin:48px 0 12px}
.sub{color:var(--muted);margin:8px 0 28px;max-width:70ch}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.stat{border:1px solid var(--line);background:var(--card);padding:14px 16px;border-radius:6px}.stat b{display:block;font-size:26px;font-weight:600}.stat span{color:var(--muted);font-size:12px}
.zones{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.zone{border:1px solid var(--line);border-top:4px solid var(--muted);background:var(--card);padding:10px 12px;border-radius:6px}
.zone.assisted{border-top-color:var(--assisted)}.zone.supervised{border-top-color:var(--supervised)}.zone.hands_off{border-top-color:var(--hands)}.zone.forbidden{opacity:.6;border-top-style:dashed}
.zn{font-weight:600}.lvl{font-size:12px;color:var(--muted)}.sc{font-variant-numeric:tabular-nums}
svg{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:6px}
.rule{stroke:var(--line);stroke-dasharray:4 4}.rule-label{fill:var(--muted);font-size:11px}.axis{stroke:var(--line)}
.series{fill:none;stroke-width:2}.s0{stroke:var(--hands)}.s1{stroke:var(--supervised)}.s2{stroke:var(--assisted)}.s3{stroke:var(--muted)}
.dot{fill:var(--card);stroke:var(--ink);stroke-width:1.5}.dot.bad{stroke:var(--bad);fill:var(--bad)}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin-top:8px}.legend i{display:inline-block;width:12px;height:3px;margin-right:6px;vertical-align:middle}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:6px;background:var(--card)}
table{width:100%;border-collapse:collapse;min-width:640px}td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{color:var(--muted);font-weight:400;font-size:12px}
.num{text-align:right;font-variant-numeric:tabular-nums}.pos{color:var(--hands)}.neg{color:var(--bad)}a{color:inherit}
.graves{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
.grave{background:var(--card);border:1px solid var(--line);border-radius:90px 90px 6px 6px;padding:28px 16px 16px;text-align:center}
.grave.exhumed{border-color:var(--bad)}.rip{font:600 15px Fraunces,Georgia,serif;letter-spacing:.12em;color:var(--muted)}.grave.exhumed .rip{color:var(--bad)}
.gt{margin:8px 0;font-weight:600;overflow-wrap:anywhere}.gm,.gd{color:var(--muted);font-size:12px}
footer{margin-top:48px;color:var(--muted);font-size:12px}
@media (prefers-reduced-motion:no-preference){.zone,.grave,.stat{animation:rise .4s cubic-bezier(.2,.8,.2,1) both}@keyframes rise{from{opacity:0;transform:translateY(6px)}}}
</style></head><body><main>
<h1>Probation Board</h1>
<p class="sub">${esc(agent)} deletes dead code. It started on probation and earns autonomy one surviving deploy at a time, per zone. A rollback costs ${Math.abs(policy.scoring.rolled_back)} points instantly. Rules: <code>probation/policy.yml</code>.</p>
<div class="stats">
<div class="stat"><b>${buried.length}</b><span>graves dug (survived production)</span></div>
<div class="stat"><b>−${linesBuried}</b><span>lines of code removed</span></div>
<div class="stat"><b>${ledger.graveyard.filter((g) => g.status === 'exhumed').length}</b><span>rollbacks (exhumed)</span></div>
<div class="stat"><b>${sciDelta === undefined ? '—' : `${sciDelta.toFixed(1)}%`}</b><span>SCI change since first measurement${sciNow !== undefined ? ` (${sciNow.toFixed(4)} gCO₂e/1k req)` : ''}</span></div>
</div>
<h2>Autonomy by zone</h2><div class="zones">${zoneCards}</div>
<h2>Trust over time</h2>${trustChart(ledger.events, policy, touched)}
<div class="legend">${touched.map((z, i) => `<span><i style="background:var(${['--hands', '--supervised', '--assisted', '--muted'][i % 4]})"></i>${esc(z)}</span>`).join('')}</div>
<h2>Graveyard</h2>${graves ? `<div class="graves">${graves}</div>` : '<p class="sub">No graves yet. The census has not found anything dead, or Undertaker has not been allowed to dig.</p>'}
<h2>Ledger</h2>${events ? `<div class="table-wrap"><table><thead><tr><th>When (UTC)</th><th>Zone</th><th>Event</th><th class="num">Pts</th><th class="num">Score</th><th>Level</th><th>MR</th></tr></thead><tbody>${events}</tbody></table></div>` : '<p class="sub">No scored events yet.</p>'}
<footer>Generated ${generatedAt.slice(0, 16).replace('T', ' ')} UTC from the <code>ledger</code> branch. Every row is also in <code>audit.jsonl</code>.</footer>
</main></body></html>`;
}
