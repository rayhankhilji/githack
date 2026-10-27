import type { FastifyInstance } from 'fastify';
import { formatMoney, totalOutstanding } from '../lib/money.ts';
import type { AppDeps } from '../server.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function uiRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/', async (request, reply) => {
    const invoices = deps.store.list();
    const totals = Object.entries(totalOutstanding(invoices))
      .map(([currency, cents]) => formatMoney(cents, currency as 'USD'))
      .join(' · ');
    const banner = request.flag('holidayBanner2024')
      ? '<div class="banner">Happy holidays 2024! Invoices sent this week are due in January.</div>'
      : '';
    const rows = invoices
      .map(
        (i) =>
          `<tr><td>${esc(i.id)}</td><td>${esc(i.customer)}</td><td class="num">${formatMoney(i.amountCents, i.currency)}</td><td><span class="pill ${i.status}">${i.status}</span></td><td>${i.issuedAt}</td></tr>`,
      )
      .join('');
    return reply.type('text/html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Tallybook</title>
<style>
:root{--bg:#f7f5f0;--fg:#1d1b16;--muted:#6b665c;--line:#e2ddd2;--accent:#2f6f4e;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#141310;--fg:#ece8df;--muted:#a39d90;--line:#2c2a24;--accent:#6fbf93;color-scheme:dark}}
body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:860px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 4px}
p{color:var(--muted);margin:0 0 24px}table{width:100%;border-collapse:collapse}
/* On phones the table scrolls inside its wrapper (focusable, so it scrolls by keyboard too); the page never does. */
.table-wrap{overflow-x:auto}.table-wrap:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
td,th{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line)}th{font-weight:600;color:var(--muted);font-size:13px}
.num{font-variant-numeric:tabular-nums}.pill{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line)}
.paid{color:var(--accent)}.banner{background:#fde68a;color:#3b2f00;padding:8px 12px;border-radius:8px;margin-bottom:16px}
</style></head><body><main>${banner}<h1>Tallybook</h1><p>Outstanding: ${totals || 'nothing'}</p>
<div class="table-wrap" role="region" aria-label="Invoices" tabindex="0"><table><thead><tr><th>ID</th><th>Customer</th><th>Amount</th><th>Status</th><th>Issued</th></tr></thead><tbody>${rows}</tbody></table></div>
</main></body></html>`);
  });
}
