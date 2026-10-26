import { describe, expect, it } from 'vitest';
import { buildServer } from '../../app/src/server.ts';
import { aggregate, findCandidates, parseCensusLog, readSources } from '../src/census.ts';

const line = (method: string, route: string, flags = {}) => ({
  census: 1,
  method,
  route,
  status: 200,
  flags,
});

function traffic() {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(line('GET', '/api/invoices', { newTotals: true }));
  for (let i = 0; i < 100; i++) lines.push(line('GET', '/', { holidayBanner2024: false }));
  lines.push(line('GET', '/api/invoices/:id'));
  return lines;
}

async function routes() {
  const { app, routes } = buildServer({ censusLog: () => {} });
  await app.ready();
  await app.close();
  return routes;
}

describe('census', () => {
  it('T-F01-AC1: parses gcloud JSON entries and JSONL alike', () => {
    const gcloud = JSON.stringify([{ jsonPayload: line('GET', '/') }, { textPayload: 'boot' }]);
    expect(parseCensusLog(gcloud)).toHaveLength(1);
    expect(parseCensusLog(`${JSON.stringify(line('GET', '/'))}\n`)).toHaveLength(1);
  });

  it('T-F01-AC2: finds dead routes, stale flags, unused deps and orphan exports', async () => {
    const candidates = findCandidates({
      stats: aggregate(traffic()),
      routes: await routes(),
      flags: ['newTotals', 'legacyPdf', 'holidayBanner2024'],
      dependencies: ['fastify', 'lodash', 'moment'],
      sources: readSources('app/src'),
      windowDays: 7,
      minRequests: 200,
      exclude: new Set(),
      keep: ['GET /healthz'],
    });
    const keys = candidates.map((c) => c.key);
    expect(keys).toContain('route:POST /api/fax-invoice');
    expect(keys).toContain('route:GET /api/v1/export.csv');
    expect(keys).toContain('flag:newTotals');
    expect(keys).toContain('flag:legacyPdf');
    expect(keys).toContain('dependency:moment');
    expect(keys).toContain('export:app/src/lib/money.ts#formatMoneyLegacy');
    expect(keys).not.toContain('route:GET /api/invoices');
    expect(keys).not.toContain('export:app/src/flags/flags.ts#readFlag');
    expect(keys).not.toContain('route:GET /healthz');
    expect(keys).not.toContain('dependency:fastify');
    expect(candidates.find((c) => c.key === 'route:POST /api/fax-invoice')?.file).toBe(
      'app/src/legacy/fax.ts',
    );
  });

  it('T-F01-AC3: too little traffic means no route or flag verdicts', async () => {
    const candidates = findCandidates({
      stats: aggregate(traffic().slice(0, 50)),
      routes: await routes(),
      flags: ['legacyPdf'],
      dependencies: [],
      sources: [],
      windowDays: 7,
      minRequests: 200,
      exclude: new Set(),
    });
    expect(candidates).toEqual([]);
  });

  it('T-F01-AC4: do-not-bury candidates are skipped', async () => {
    const candidates = findCandidates({
      stats: aggregate(traffic()),
      routes: await routes(),
      flags: [],
      dependencies: [],
      sources: [],
      windowDays: 7,
      minRequests: 200,
      exclude: new Set(['route:GET /api/v1/export.csv']),
    });
    expect(candidates.map((c) => c.key)).not.toContain('route:GET /api/v1/export.csv');
  });
});
