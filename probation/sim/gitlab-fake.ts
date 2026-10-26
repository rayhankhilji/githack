// gitlab-fake — an in-memory GitLab REST API for end-to-end tests of the Probation CLIs.
// Implements exactly the endpoints probation/src/gitlab.ts calls, with GitLab's shapes, status codes and
// error messages where the CLIs depend on them (404s, 400 on commit action conflicts, scoped labels).
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MrDiff } from '../src/gitlab.ts';

export interface FakeIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  labels: string[];
  state: 'opened' | 'closed';
  web_url: string;
  created_at: string;
  closed_at: string | null;
}

export interface FakeMr {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  state: 'opened' | 'closed' | 'merged';
  draft: boolean;
  labels: string[];
  author: { username: string };
  web_url: string;
  sha: string;
  source_branch: string;
  target_branch: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  merge_when_pipeline_succeeds: boolean;
  created_at: string;
}

export interface FakeCommit {
  id: string;
  branch: string;
  start_branch?: string;
  message: string;
  actions: { action: string; file_path: string }[];
}

export interface FakeState {
  projectId: string;
  defaultBranch: string;
  baseUrl: string;
  projectToken: string;
  userToken: string;
  /** Files per branch: branch → path → content. */
  branches: Map<string, Map<string, string>>;
  issues: FakeIssue[];
  mrs: FakeMr[];
  diffs: Map<number, MrDiff[]>;
  notes: { noteable: 'issue' | 'mr'; iid: number; body: string }[];
  commits: FakeCommit[];
  merges: { iid: number; sha?: string; auto_merge?: boolean; should_remove_source_branch?: boolean }[];
  reverts: { sha: string; branch: string; id: string }[];
  releases: Record<string, unknown>[];
  flows: { token: string; body: Record<string, unknown> }[];
  requests: { method: string; path: string; status: number }[];
  /** Failure injection: return a status (e.g. 500) to fail a request before it is handled. */
  fail?: (method: string, path: string) => number | undefined;
}

export interface FakeGitLab {
  url: string;
  state: FakeState;
  close(): Promise<void>;
}

class HttpError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(String(status));
    this.status = status;
    this.body = body;
  }
}

let shaCounter = 0;
const newSha = () => createHash('sha1').update(`fake-${++shaCounter}`).digest('hex');
const now = () => new Date().toISOString();

// GitLab scoped labels: `a::b` and `a::c` share scope `a`; adding one removes the other.
const scopeOf = (label: string) => {
  const i = label.lastIndexOf('::');
  return i > 0 ? label.slice(0, i) : undefined;
};

export function addLabels(current: string[], add: string[]): string[] {
  let out = [...current];
  for (const label of add) {
    const scope = scopeOf(label);
    if (scope) out = out.filter((l) => l === label || scopeOf(l) !== scope);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

const splitLabels = (value: unknown): string[] =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : Array.isArray(value)
      ? value.map(String)
      : [];

function applyLabelParams(labels: string[], body: Record<string, unknown>): string[] {
  let out = body.labels !== undefined ? addLabels([], splitLabels(body.labels)) : labels;
  const remove = new Set(splitLabels(body.remove_labels));
  out = out.filter((l) => !remove.has(l));
  return addLabels(out, splitLabels(body.add_labels));
}

function paginate<T>(items: T[], query: URLSearchParams, res: ServerResponse): T[] {
  const perPage = Math.min(Number(query.get('per_page') ?? 20) || 20, 100);
  const page = Math.max(Number(query.get('page') ?? 1) || 1, 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  res.setHeader('x-total', String(items.length));
  res.setHeader('x-total-pages', String(totalPages));
  res.setHeader('x-page', String(page));
  res.setHeader('x-per-page', String(perPage));
  res.setHeader('x-next-page', page < totalPages ? String(page + 1) : '');
  return items.slice((page - 1) * perPage, page * perPage);
}

const byLabels = (labels: string[], query: URLSearchParams) =>
  splitLabels(query.get('labels') ?? '').every((l) => labels.includes(l));

const out = <T extends { labels: string[] }>(o: T): T => ({ ...o, labels: [...o.labels].sort() });

function issueBy(state: FakeState, iid: string): FakeIssue {
  const issue = state.issues.find((i) => i.iid === Number(iid));
  if (!issue) throw new HttpError(404, { message: '404 Issue Not Found' });
  return issue;
}

function mrBy(state: FakeState, iid: string): FakeMr {
  const mr = state.mrs.find((m) => m.iid === Number(iid));
  if (!mr) throw new HttpError(404, { message: '404 Merge Request Not Found' });
  return mr;
}

function addNote(state: FakeState, noteable: 'issue' | 'mr', iid: number, body: Record<string, unknown>) {
  if (typeof body.body !== 'string' || !body.body) throw new HttpError(400, { error: 'body is missing' });
  state.notes.push({ noteable, iid, body: body.body });
  return {
    id: state.notes.length,
    body: body.body,
    author: { username: 'probation-bot' },
    noteable_iid: iid,
  };
}

export function createIssue(
  state: FakeState,
  input: {
    title: string;
    description?: string;
    labels?: string[];
    iid?: number;
    state?: 'opened' | 'closed';
  },
): FakeIssue {
  const iid = input.iid ?? Math.max(0, ...state.issues.map((i) => i.iid)) + 1;
  const issue: FakeIssue = {
    id: 1000 + iid,
    iid,
    project_id: Number(state.projectId),
    title: input.title,
    description: input.description ?? '',
    labels: addLabels([], input.labels ?? []),
    state: input.state ?? 'opened',
    web_url: `${state.baseUrl}/demo/tallybook/-/issues/${iid}`,
    created_at: now(),
    closed_at: input.state === 'closed' ? now() : null,
  };
  state.issues.push(issue);
  return issue;
}

/** What the Undertaker flow does: open an MR with its diffs. */
export function createMr(
  state: FakeState,
  input: {
    title: string;
    description?: string;
    labels?: string[];
    author?: string;
    diffs: MrDiff[];
  },
): FakeMr {
  const iid = Math.max(0, ...state.mrs.map((m) => m.iid)) + 1;
  const mr: FakeMr = {
    id: 5000 + iid,
    iid,
    project_id: Number(state.projectId),
    title: input.title,
    description: input.description ?? '',
    state: 'opened',
    draft: /^(Draft:|\[Draft\]|\(Draft\))/i.test(input.title),
    labels: addLabels([], input.labels ?? []),
    author: { username: input.author ?? 'ai-undertaker-bot' },
    web_url: `${state.baseUrl}/demo/tallybook/-/merge_requests/${iid}`,
    sha: newSha(),
    source_branch: `undertaker/bury-${iid}`,
    target_branch: state.defaultBranch,
    merged_at: null,
    merge_commit_sha: null,
    merge_when_pipeline_succeeds: false,
    created_at: now(),
  };
  state.mrs.push(mr);
  state.diffs.set(iid, input.diffs);
  return mr;
}

/** What GitLab does when the MR pipeline succeeds and auto-merge fires (or a human clicks Merge). */
export function mergeMr(state: FakeState, iid: number): string {
  const mr = mrBy(state, String(iid));
  if (mr.state !== 'opened') throw new Error(`!${iid} is ${mr.state}`);
  const sha = newSha();
  mr.state = 'merged';
  mr.merged_at = now();
  mr.merge_commit_sha = sha;
  state.commits.push({
    id: sha,
    branch: mr.target_branch,
    message: `Merge branch '${mr.source_branch}' into '${mr.target_branch}'`,
    actions: [],
  });
  // Closing patterns in the description close issues when the MR merges into the default branch.
  if (mr.target_branch === state.defaultBranch) {
    for (const m of mr.description.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) {
      const issue = state.issues.find((i) => i.iid === Number(m[1]));
      if (issue && issue.state === 'opened') {
        issue.state = 'closed';
        issue.closed_at = now();
      }
    }
  }
  return sha;
}

export function closeMr(state: FakeState, iid: number): void {
  mrBy(state, String(iid)).state = 'closed';
}

export function fileOn(state: FakeState, branch: string, path: string): string | undefined {
  return state.branches.get(branch)?.get(path);
}

function commitFiles(state: FakeState, body: Record<string, unknown>) {
  const branch = String(body.branch ?? '');
  const startBranch = body.start_branch === undefined ? undefined : String(body.start_branch);
  const actions = (body.actions ?? []) as {
    action: string;
    file_path: string;
    content?: string;
    encoding?: string;
  }[];
  if (!branch) throw new HttpError(400, { error: 'branch is missing' });
  if (!body.commit_message) throw new HttpError(400, { error: 'commit_message is missing' });
  if (!actions.length) throw new HttpError(400, { error: 'actions is empty' });
  let files: Map<string, string>;
  const existing = state.branches.get(branch);
  if (existing) {
    if (startBranch && startBranch !== branch)
      throw new HttpError(400, {
        message: `A branch called '${branch}' already exists. Switch to that branch in order to make changes`,
      });
    files = new Map(existing);
  } else {
    const from = state.branches.get(startBranch ?? branch);
    if (!from)
      throw new HttpError(400, { message: 'You can only create or edit files when you are on a branch' });
    files = new Map(from);
  }
  for (const a of actions) {
    const content =
      a.encoding === 'base64' ? Buffer.from(a.content ?? '', 'base64').toString('utf8') : (a.content ?? '');
    if (a.action === 'create') {
      if (files.has(a.file_path))
        throw new HttpError(400, { message: 'A file with this name already exists' });
      files.set(a.file_path, content);
    } else if (a.action === 'update' || a.action === 'delete') {
      if (!files.has(a.file_path))
        throw new HttpError(400, { message: "A file with this name doesn't exist" });
      if (a.action === 'update') files.set(a.file_path, content);
      else files.delete(a.file_path);
    } else throw new HttpError(400, { error: 'actions[action] does not have a valid value' });
  }
  // All or nothing, like a real commit.
  state.branches.set(branch, files);
  const id = newSha();
  state.commits.push({
    id,
    branch,
    start_branch: startBranch,
    message: String(body.commit_message),
    actions: actions.map((a) => ({ action: a.action, file_path: a.file_path })),
  });
  return { id, short_id: id.slice(0, 8), title: String(body.commit_message).split('\n')[0] };
}

function route(
  state: FakeState,
  method: string,
  seg: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
  token: string,
  res: ServerResponse,
): [number, unknown] {
  const notFound = new HttpError(404, { error: '404 Not Found' });
  if (seg.join('/') === 'ai/duo_workflows/workflows' && method === 'POST') {
    // Flows started by bots (project access tokens) are ignored by design; the fake makes that loud.
    if (token !== state.userToken) throw new HttpError(403, { message: '403 Forbidden' });
    if (body.ai_catalog_item_consumer_id !== undefined && !body.project_id)
      throw new HttpError(400, { error: 'project_id is missing' });
    state.flows.push({ token, body });
    const id = 900 + state.flows.length;
    return [
      201,
      {
        id,
        status: 'created',
        web_url: `${state.baseUrl}/demo/tallybook/-/automate/agent-sessions/${id}`,
        workload: { id: 7000 + id, message: null },
      },
    ];
  }
  if (seg[0] !== 'projects' || seg.length < 3) throw notFound;
  if (seg[1] !== state.projectId) throw new HttpError(404, { message: '404 Project Not Found' });
  const [a, b, c, d] = seg.slice(2);
  const key = `${method} ${[a, b && '*', c, d && '*'].filter(Boolean).join('/')}`;

  if (a === 'merge_requests') {
    if (key === 'GET merge_requests') {
      const st = query.get('state') ?? 'all';
      const list = state.mrs
        .filter((m) => st === 'all' || m.state === st)
        .filter((m) => byLabels(m.labels, query))
        .sort((x, y) => y.iid - x.iid);
      return [200, paginate(list, query, res).map(out)];
    }
    const mr = mrBy(state, b);
    if (key === 'GET merge_requests/*') return [200, out(mr)];
    if (key === 'PUT merge_requests/*') {
      if (typeof body.title === 'string') {
        mr.title = body.title;
        mr.draft = /^(Draft:|\[Draft\]|\(Draft\))/i.test(mr.title);
      }
      if (typeof body.description === 'string') mr.description = body.description;
      mr.labels = applyLabelParams(mr.labels, body);
      if (body.state_event === 'close' && mr.state === 'opened') mr.state = 'closed';
      return [200, out(mr)];
    }
    if (key === 'GET merge_requests/*/diffs')
      return [200, paginate(state.diffs.get(mr.iid) ?? [], query, res)];
    if (key === 'POST merge_requests/*/notes') return [201, addNote(state, 'mr', mr.iid, body)];
    if (key === 'PUT merge_requests/*/merge') {
      if (mr.state !== 'opened' || mr.draft) throw new HttpError(405, { message: '405 Method Not Allowed' });
      if (body.sha && body.sha !== mr.sha)
        throw new HttpError(409, { message: 'SHA does not match HEAD of source branch' });
      state.merges.push({
        iid: mr.iid,
        sha: body.sha as string | undefined,
        auto_merge: body.auto_merge as boolean | undefined,
        should_remove_source_branch: body.should_remove_source_branch as boolean | undefined,
      });
      // The calling pipeline is still running, so GitLab sets auto-merge rather than merging now.
      if (body.auto_merge) mr.merge_when_pipeline_succeeds = true;
      else mergeMr(state, mr.iid);
      return [200, out(mr)];
    }
    throw notFound;
  }

  if (a === 'issues') {
    if (key === 'GET issues') {
      const st = query.get('state') ?? 'all';
      const list = state.issues
        .filter((i) => st === 'all' || i.state === st)
        .filter((i) => byLabels(i.labels, query))
        .sort((x, y) => y.iid - x.iid);
      return [200, paginate(list, query, res).map(out)];
    }
    if (key === 'POST issues') {
      if (!body.title) throw new HttpError(400, { error: 'title is missing' });
      const issue = createIssue(state, {
        title: String(body.title),
        description: body.description === undefined ? '' : String(body.description),
        labels: splitLabels(body.labels),
      });
      return [201, out(issue)];
    }
    const issue = issueBy(state, b);
    if (key === 'GET issues/*') return [200, out(issue)];
    if (key === 'PUT issues/*') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.description === 'string') issue.description = body.description;
      issue.labels = applyLabelParams(issue.labels, body);
      if (body.state_event === 'close' && issue.state === 'opened') {
        issue.state = 'closed';
        issue.closed_at = now();
      }
      if (body.state_event === 'reopen') {
        issue.state = 'opened';
        issue.closed_at = null;
      }
      return [200, out(issue)];
    }
    if (key === 'POST issues/*/notes') return [201, addNote(state, 'issue', issue.iid, body)];
    throw notFound;
  }

  if (a === 'repository') {
    if (method === 'GET' && b === 'files' && c) {
      const ref = query.get('ref');
      if (!ref) throw new HttpError(400, { error: 'ref is missing' });
      const content = fileOn(state, ref, c);
      if (content === undefined) throw new HttpError(404, { message: '404 File Not Found' });
      return [
        200,
        {
          file_name: c.split('/').pop(),
          file_path: c,
          size: Buffer.byteLength(content),
          encoding: 'base64',
          content: Buffer.from(content).toString('base64'),
          ref,
        },
      ];
    }
    if (method === 'GET' && b === 'branches' && c) {
      if (!state.branches.has(c)) throw new HttpError(404, { message: '404 Branch Not Found' });
      return [200, { name: c, default: c === state.defaultBranch, protected: c === state.defaultBranch }];
    }
    if (b === 'commits') {
      if (method === 'POST' && !c) return [201, commitFiles(state, body)];
      if (method === 'GET' && c && d === 'merge_requests')
        return [200, state.mrs.filter((m) => m.merge_commit_sha === c || m.sha === c).map(out)];
      if (method === 'POST' && c && d === 'revert') {
        const branch = String(body.branch ?? '');
        if (!state.commits.some((x) => x.id === c))
          throw new HttpError(404, { message: '404 Commit Not Found' });
        if (!state.branches.has(branch)) throw new HttpError(404, { message: '404 Branch Not Found' });
        if (state.reverts.some((r) => r.sha === c))
          throw new HttpError(400, {
            message:
              'Sorry, we cannot revert this commit automatically. This commit may already have been reverted.',
            error_code: 'empty',
          });
        const id = newSha();
        state.reverts.push({ sha: c, branch, id });
        state.commits.push({ id, branch, message: `Revert "${c.slice(0, 8)}"`, actions: [] });
        return [201, { id, short_id: id.slice(0, 8), title: `Revert "${c.slice(0, 8)}"` }];
      }
    }
    throw notFound;
  }

  if (key === 'POST releases') {
    if (!body.tag_name) throw new HttpError(400, { error: 'tag_name is missing' });
    state.releases.push(body);
    return [201, { ...body, created_at: now() }];
  }
  throw notFound;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch {
        resolve(Object.fromEntries(new URLSearchParams(text)));
      }
    });
  });
}

export async function start(
  options: { projectId?: string; projectToken?: string; userToken?: string } = {},
): Promise<FakeGitLab> {
  const state: FakeState = {
    projectId: options.projectId ?? '42',
    defaultBranch: 'main',
    baseUrl: '',
    projectToken: options.projectToken ?? 'glpat-fake-probation',
    userToken: options.userToken ?? 'glpat-fake-owner',
    branches: new Map([['main', new Map([['README.md', '# Tallybook\n']])]]),
    issues: [],
    mrs: [],
    diffs: new Map(),
    notes: [],
    commits: [],
    merges: [],
    reverts: [],
    releases: [],
    flows: [],
    requests: [],
  };
  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname.replace(/^\/api\/v4/, '');
    const send = (status: number, payload: unknown) => {
      state.requests.push({ method, path, status });
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    const auth = req.headers.authorization;
    const token =
      (req.headers['private-token'] as string | undefined) ??
      (auth?.startsWith('Bearer ') ? auth.slice(7) : undefined) ??
      '';
    if (token !== state.projectToken && token !== state.userToken)
      return send(401, { message: '401 Unauthorized' });
    const injected = state.fail?.(method, path);
    if (injected) {
      // Retry-After: 0 keeps the client's retry loop fast in tests.
      res.setHeader('retry-after', '0');
      return send(injected, { message: `${injected} Internal Server Error` });
    }
    try {
      const body = await readBody(req);
      // Split before decoding: file paths and branch names arrive URL-encoded as one segment.
      const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
      const [status, payload] = route(state, method, seg, url.searchParams, body, token, res);
      send(status, payload);
    } catch (error) {
      if (error instanceof HttpError) send(error.status, error.body);
      else send(500, { message: String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.baseUrl = `http://127.0.0.1:${port}`;
  return {
    url: `${state.baseUrl}/api/v4`,
    state,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
