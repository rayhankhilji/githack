import { describe, expect, it } from 'vitest';
import { ledgerStoreFromEnv } from '../../mcp/source.ts';
import { sciSparkline } from '../src/board.ts';
import { GitLab } from '../src/gitlab.ts';
import { emptyLedger } from '../src/ledger.ts';
import { candidateIssue, countLines, diffStats } from '../src/mr.ts';
import { GitLabLedgerStore } from '../src/store.ts';

describe('review regressions', () => {
  it('counts content lines that start with ++ or --', () => {
    expect(countLines('@@ -1 +1,2 @@\n+++i;\n+x\n---y')).toEqual({ added: 2, removed: 1 });
  });

  it('a rename also reports its old path', () => {
    const stats = diffStats([
      { old_path: 'app/src/auth/k.ts', new_path: 'app/src/legacy/k.ts', deleted_file: false, diff: '' },
    ]);
    expect(stats.map((s) => s.path)).toEqual(['app/src/legacy/k.ts', 'app/src/auth/k.ts']);
  });

  it('settle only trusts the closing issue reference', () => {
    expect(candidateIssue('Here lies fax, see #3 for history.\n\nCloses #12')).toBe(12);
    expect(candidateIssue('see #3')).toBeUndefined();
  });

  it('ledger store updates an existing empty audit.jsonl instead of re-creating it', async () => {
    const files: Record<string, string> = { 'ledger.json': '{}', 'audit.jsonl': '' };
    const commits: { actions: { action: string; file_path: string }[] }[] = [];
    const fake = {
      getFile: async (path: string) => files[path],
      branchExists: async () => true,
      commit: async (body: (typeof commits)[number]) => {
        commits.push(body);
        return { id: 'x' };
      },
    } as unknown as GitLab;
    await new GitLabLedgerStore(fake, 'main').save(emptyLedger(), [], 'test');
    expect(commits[0].actions.map((a) => a.action)).toEqual(['update', 'update']);
  });

  it('ledger store surfaces load errors instead of returning an empty ledger', async () => {
    const fake = { getFile: async () => Promise.reject(new Error('GitLab GET → 401')) } as unknown as GitLab;
    await expect(new GitLabLedgerStore(fake, 'main').load()).rejects.toThrow('401');
  });
});

describe('wave-3 review regressions', () => {
  it('listIssues follows pages until a short page', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      const page = Number(/page=(\d+)$/.exec(url)?.[1]);
      const body = page === 1 ? [{ iid: 1 }, { iid: 2 }] : [{ iid: 3 }];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const gl = new GitLab({ apiUrl: 'http://x/api/v4', projectId: '1', token: 't' }, fetcher);
    const issues = await gl.listIssues('labels=a&per_page=2');
    expect(issues.map((i) => i.iid)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
  });

  it('sparkline shows no % change from a zero baseline', () => {
    const svg = sciSparkline([
      { at: '2026-10-27T00:00:00Z', sha: 'a', gramsPer1kRequests: 0 },
      { at: '2026-10-27T01:00:00Z', sha: 'b', gramsPer1kRequests: 0.01 },
    ]);
    expect(svg).not.toContain('%');
    expect(svg).not.toContain('NaN');
  });

  it('MCP refuses a missing LEDGER_FILE instead of answering from an empty ledger', () => {
    expect(() => ledgerStoreFromEnv({ LEDGER_FILE: 'does/not/exist.json' })).toThrow('does not exist');
  });
});
