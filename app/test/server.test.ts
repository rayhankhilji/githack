import { describe, expect, it } from 'vitest';
import { buildServer, type CensusLine } from '../src/server.ts';

function setup(env: NodeJS.ProcessEnv = {}) {
  const lines: CensusLine[] = [];
  const { app, routes } = buildServer({ apiKey: 'test-key', env, censusLog: (l) => lines.push(l) });
  return { app, routes, lines };
}

describe('tallybook', () => {
  it('lists invoices with per-currency outstanding totals', async () => {
    const { app } = setup();
    const res = await app.inject('/api/invoices');
    expect(res.statusCode).toBe(200);
    expect(res.json().outstanding).toEqual({ EUR: 48000, GBP: 310050, USD: 9900 });
  });

  it('rejects writes without the api key', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      payload: { customer: 'A', amountCents: 1, currency: 'USD' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates and pays an invoice', async () => {
    const { app } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      headers: { 'x-api-key': 'test-key' },
      payload: { customer: 'Acme', amountCents: 5000, currency: 'USD' },
    });
    expect(created.statusCode).toBe(201);
    const paid = await app.inject({
      method: 'POST',
      url: `/api/invoices/${created.json().id}/pay`,
      headers: { 'x-api-key': 'test-key' },
    });
    expect(paid.json().status).toBe('paid');
  });

  it('validates the create body', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      headers: { 'x-api-key': 'test-key' },
      payload: { customer: '', amountCents: -1, currency: 'JPY' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a missing invoice', async () => {
    const { app } = setup();
    expect((await app.inject('/api/invoices/inv_nope')).statusCode).toBe(404);
  });

  it('renders the dashboard', async () => {
    const { app } = setup();
    const res = await app.inject('/');
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Northwind Bakery');
    // Accessibility audit (scripts/audit-pages.ts): the table scrolls in a keyboard-reachable region on phones.
    expect(res.body).toContain('<html lang="en">');
    expect(res.body).toContain('<main>');
    expect(res.body).toContain(
      '<div class="table-wrap" role="region" aria-label="Invoices" tabindex="0"><table><thead>',
    );
    expect(res.body).toContain('color-scheme:dark');
  });

  it('serves the monthly accounting export', async () => {
    const { app } = setup();
    const res = await app.inject('/api/v1/export.csv');
    expect(res.body.split('\n')[0]).toBe('id,customer,amount_cents,currency,status');
  });

  it('writes one census line per request with route template and flags seen', async () => {
    const { app, lines } = setup({ FLAG_NEW_TOTALS: 'on' });
    await app.inject('/api/invoices');
    expect(lines).toEqual([
      { census: 1, method: 'GET', route: '/api/invoices', status: 200, flags: { newTotals: true } },
    ]);
  });

  it('exposes the route inventory used by the census', async () => {
    const { app, routes } = setup();
    await app.ready();
    expect(routes).toContain('GET /api/v1/invoices');
    expect(routes).toContain('POST /api/fax-invoice');
  });
});
