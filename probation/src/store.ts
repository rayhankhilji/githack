import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { GitLab } from './gitlab.ts';
import { emptyLedger, type Ledger, type LedgerEvent } from './ledger.ts';

// Ledger persistence. In CI it lives on the `ledger` branch (append-only audit trail with git history);
// locally and in tests it is a plain JSON file (LEDGER_FILE).
export interface LedgerStore {
  load(): Promise<Ledger>;
  save(ledger: Ledger, written: LedgerEvent[], message: string): Promise<void>;
}

export class FileLedgerStore implements LedgerStore {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<Ledger> {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Ledger) : emptyLedger();
  }

  async save(ledger: Ledger): Promise<void> {
    writeFileSync(this.path, `${JSON.stringify(ledger, null, 2)}\n`);
  }
}

export const LEDGER_BRANCH = 'ledger';

export class GitLabLedgerStore implements LedgerStore {
  private gitlab: GitLab;
  private defaultBranch: string;

  constructor(gitlab: GitLab, defaultBranch: string) {
    this.gitlab = gitlab;
    this.defaultBranch = defaultBranch;
  }

  async load(): Promise<Ledger> {
    // getFile maps 404 to undefined; any other error must fail the job, never be read as an empty ledger.
    const text = await this.gitlab.getFile('ledger.json', LEDGER_BRANCH);
    return text ? (JSON.parse(text) as Ledger) : emptyLedger();
  }

  async save(ledger: Ledger, written: LedgerEvent[], message: string): Promise<void> {
    const exists = await this.gitlab.branchExists(LEDGER_BRANCH);
    const auditFile = await this.gitlab.getFile('audit.jsonl', LEDGER_BRANCH);
    const auditNext = (auditFile ?? '') + written.map((e) => `${JSON.stringify(e)}\n`).join('');
    const hasLedger = exists && (await this.gitlab.getFile('ledger.json', LEDGER_BRANCH)) !== undefined;
    await this.gitlab.commit({
      branch: LEDGER_BRANCH,
      start_branch: exists ? undefined : this.defaultBranch,
      // [skip ci]: ledger writes must never trigger pipelines (and never loop).
      commit_message: `${message} [skip ci]`,
      actions: [
        {
          action: hasLedger ? 'update' : 'create',
          file_path: 'ledger.json',
          content: `${JSON.stringify(ledger, null, 2)}\n`,
        },
        {
          action: auditFile !== undefined ? 'update' : 'create',
          file_path: 'audit.jsonl',
          content: auditNext,
        },
      ],
    });
  }
}
