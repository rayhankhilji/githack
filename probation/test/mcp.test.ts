import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../../mcp/source.ts';
import { explainGate, getTrust, listGraves, policySummary } from '../../mcp/tools.ts';
import { applyEvent, emptyLedger, type Ledger } from '../src/ledger.ts';
import { del, edit, policy } from './helpers.ts';

// Two survived soaks in legacy (Supervised at 20), one rollback in routes (floored at 0), one grave each way.
function fixtureLedger(): Ledger {
  let ledger = emptyLedger();
  const score = (zone: string, event: 'survived_soak' | 'rolled_back', mr: number) => {
    ledger = applyEvent(ledger, policy, {
      agent: 'undertaker',
      zones: [zone],
      event,
      ref: { mr },
      at: `2026-10-2${mr}T00:00:00Z`,
    }).ledger;
  };
  score('legacy', 'survived_soak', 1);
  score('legacy', 'survived_soak', 2);
  score('routes', 'rolled_back', 3);
  ledger.graveyard.push(
    {
      at: '2026-10-21T00:00:00Z',
      mr: 1,
      title: 'POST /api/fax-invoice',
      zone: 'legacy',
      linesRemoved: 80,
      status: 'buried',
    },
    {
      at: '2026-10-23T00:00:00Z',
      mr: 3,
      title: 'GET /api/v1/export.csv',
      zone: 'routes',
      linesRemoved: 40,
      status: 'exhumed',
    },
  );
  return ledger;
}

function writeFixture(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'probation-mcp-')), 'ledger.json');
  writeFileSync(file, JSON.stringify(fixtureLedger()));
  return file;
}

describe('probation MCP tools', () => {
  const ledger = fixtureLedger();

  it('get_trust reports score, level and the next threshold per zone', () => {
    const trust = getTrust(policy, ledger);
    const legacy = trust.zones.find((z) => z.zone === 'legacy');
    expect(legacy).toMatchObject({
      score: 20,
      level: 'supervised',
      next: { level: 'hands_off', pointsNeeded: 10 },
    });
    expect(trust.excludedZones.map((z) => z.zone)).toEqual(['auth', 'probation', 'tests']);
  });

  it('get_trust filters to one zone and shows why it is Assisted', () => {
    const trust = getTrust(policy, ledger, { zone: 'routes' });
    expect(trust.zones).toHaveLength(1);
    expect(trust.zones[0]).toMatchObject({ score: 0, level: 'assisted' });
    expect(trust.zones[0].recentEvents.map((e) => e.event)).toEqual(['rolled_back']);
    expect(() => getTrust(policy, ledger, { zone: 'nope' })).toThrow(/unknown zone/);
  });

  it('list_graves counts buried and exhumed, newest first', () => {
    const graves = listGraves(ledger);
    expect(graves).toMatchObject({ total: 2, buried: 1, exhumed: 1, linesRemoved: 80 });
    expect(graves.graves[0].status).toBe('exhumed');
    expect(listGraves(ledger, { status: 'buried' }).graves.map((g) => g.mr)).toEqual([1]);
  });

  it('explain_gate runs the real gate', () => {
    expect(explainGate(policy, ledger, { files: [del('app/src/legacy/v1.ts')] }).verdict).toBe(
      'merge_supervised',
    );
    const mixed = explainGate(policy, ledger, {
      files: [del('app/src/legacy/v1.ts'), edit('app/src/server.ts', 0, 3)],
    });
    expect(mixed.verdict).toBe('needs_human');
    const forbidden = explainGate(policy, ledger, { files: [del('probation/policy.yml')] });
    expect(forbidden.verdict).toBe('block');
    expect(forbidden.reasons.join(' ')).toMatch(/forbidden zone/);
  });

  it('policy lists every zone with its kind', () => {
    const summary = policySummary(policy);
    expect(summary.levels).toEqual(policy.levels);
    expect(summary.zones.find((z) => z.name === 'auth')?.kind).toBe('forbidden');
  });

  it('loadContext reads LEDGER_FILE and refuses to guess without a source', async () => {
    const ctx = await loadContext({ LEDGER_FILE: writeFixture() });
    expect(ctx.ledger.scores.undertaker.legacy).toBe(20);
    await expect(loadContext({})).rejects.toThrow(/LEDGER_FILE/);
  });
});

describe('probation MCP server over stdio', () => {
  it('lists the tools and answers explain_gate', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['mcp/probation-server.ts'],
      env: { PATH: process.env.PATH ?? '', LEDGER_FILE: writeFixture() },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'probation-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['explain_gate', 'get_trust', 'list_graves', 'policy']);
      const res = await client.callTool({
        name: 'explain_gate',
        arguments: { files: [{ path: 'app/src/legacy/v1.ts', added: 0, removed: 30 }] },
      });
      const [content] = res.content as { type: string; text: string }[];
      expect(JSON.parse(content.text)).toMatchObject({ verdict: 'merge_supervised', level: 'supervised' });
    } finally {
      await client.close();
    }
  }, 15000);
});
