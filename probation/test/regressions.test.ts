import { describe, expect, it } from 'vitest';
import type { GitLab } from '../src/gitlab.ts';
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
