import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadPolicy } from '../probation/src/policy.ts';
import { loadContext, policyPath } from './source.ts';
import { explainGate, getTrust, listGraves, policySummary } from './tools.ts';

// Probation MCP server (stdio) for GitLab Duo Agentic Chat in the IDE: read-only answers from policy.yml and
// the ledger. Wiring only; the handlers live in tools.ts. stdout carries the protocol, so log to stderr.

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

async function handle(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (err) {
    return { ...json({ error: (err as Error).message }), isError: true };
  }
}

const server = new McpServer({ name: 'probation', version: '1.0.0' });

server.registerTool(
  'get_trust',
  {
    title: 'Undertaker trust per zone',
    description:
      "An agent's Probation score and autonomy level (Assisted / Supervised / Hands-off) per code zone, with points needed for the next level and the latest scoring events.",
    inputSchema: {
      zone: z.string().optional().describe('Zone name from policy.yml (e.g. routes); omit for all zones'),
      agent: z.string().optional().describe('Agent key from policy.yml; defaults to undertaker'),
    },
    annotations: readOnly,
  },
  (args) =>
    handle(async () => {
      const { policy, ledger } = await loadContext();
      return getTrust(policy, ledger, args);
    }),
);

server.registerTool(
  'list_graves',
  {
    title: 'Undertaker graveyard',
    description: 'Code Undertaker has buried (deleted and survived) or exhumed (rolled back), newest first.',
    inputSchema: {
      status: z.enum(['buried', 'exhumed']).optional(),
      zone: z.string().optional(),
    },
    annotations: readOnly,
  },
  (args) => handle(async () => listGraves((await loadContext()).ledger, args)),
);

server.registerTool(
  'explain_gate',
  {
    title: 'Dry-run the Probation gate',
    description:
      'Runs the real deterministic gate (probation/src/gate.ts) on a hypothetical Undertaker MR and returns the verdict and reasons. Nothing is merged or written.',
    inputSchema: {
      files: z
        .array(
          z.object({
            path: z.string(),
            added: z.number().int().min(0),
            removed: z.number().int().min(0),
            deleted: z.boolean().optional(),
          }),
        )
        .min(1)
        .describe('Changed files with added/removed line counts'),
      agent: z.string().optional(),
      checksPassed: z.boolean().optional().describe('Whether verify/secure passed; defaults to true'),
      coronerObjection: z.string().optional(),
    },
    annotations: readOnly,
  },
  (args) =>
    handle(async () => {
      const { policy, ledger } = await loadContext();
      return explainGate(policy, ledger, args);
    }),
);

server.registerTool(
  'policy',
  {
    title: 'Probation policy',
    description: 'Zones, level thresholds and scoring points from probation/policy.yml.',
    annotations: readOnly,
  },
  () => handle(async () => policySummary(loadPolicy(policyPath()))),
);

await server.connect(new StdioServerTransport());
console.error('probation MCP server ready on stdio');
