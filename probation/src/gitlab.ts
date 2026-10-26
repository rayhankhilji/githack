// Minimal GitLab REST client for CI jobs. Uses a project access token (GITLAB_PROBATION_TOKEN, scope api).
export interface GitLabConfig {
  apiUrl: string;
  projectId: string;
  token: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GitLabConfig {
  const apiUrl = env.CI_API_V4_URL ?? 'https://gitlab.com/api/v4';
  const projectId = env.CI_PROJECT_ID;
  const token = env.GITLAB_PROBATION_TOKEN;
  if (!projectId || !token) throw new Error('CI_PROJECT_ID and GITLAB_PROBATION_TOKEN are required');
  return { apiUrl, projectId, token };
}

export interface MergeRequest {
  iid: number;
  title: string;
  web_url: string;
  draft: boolean;
  state: string;
  labels: string[];
  author: { username: string };
  description: string;
  merged_at?: string | null;
}

export interface Issue {
  iid: number;
  title: string;
  web_url: string;
  description: string;
  labels: string[];
  state: string;
}

export interface MrDiff {
  new_path: string;
  old_path: string;
  deleted_file: boolean;
  diff: string;
}

export class GitLab {
  private config: GitLabConfig;
  private fetcher: typeof fetch;

  constructor(config: GitLabConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  private async call<T>(method: string, path: string, body?: unknown, token = this.config.token): Promise<T> {
    const url = `${this.config.apiUrl}${path.replace(':id', encodeURIComponent(this.config.projectId))}`;
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetcher(url, {
        method,
        headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
      // Retry rate limits and transient 5xx a few times; everything else is a real error.
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`GitLab ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
  }

  getMr(iid: number) {
    return this.call<MergeRequest>('GET', `/projects/:id/merge_requests/${iid}`);
  }

  async mrDiffs(iid: number): Promise<MrDiff[]> {
    const all: MrDiff[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.call<MrDiff[]>(
        'GET',
        `/projects/:id/merge_requests/${iid}/diffs?per_page=100&page=${page}`,
      );
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }

  updateMr(iid: number, body: { title?: string; add_labels?: string; remove_labels?: string }) {
    return this.call<MergeRequest>('PUT', `/projects/:id/merge_requests/${iid}`, body);
  }

  mergeMr(iid: number, sha: string) {
    return this.call('PUT', `/projects/:id/merge_requests/${iid}/merge`, {
      sha,
      auto_merge: true,
      should_remove_source_branch: true,
    });
  }

  noteMr(iid: number, body: string) {
    return this.call('POST', `/projects/:id/merge_requests/${iid}/notes`, { body });
  }

  listMrs(query: string) {
    return this.call<MergeRequest[]>('GET', `/projects/:id/merge_requests?${query}`);
  }

  mrsForCommit(sha: string) {
    return this.call<MergeRequest[]>('GET', `/projects/:id/repository/commits/${sha}/merge_requests`);
  }

  revertCommit(sha: string, branch: string) {
    return this.call<{ id: string }>('POST', `/projects/:id/repository/commits/${sha}/revert`, { branch });
  }

  listIssues(query: string) {
    return this.call<Issue[]>('GET', `/projects/:id/issues?${query}`);
  }

  createIssue(body: { title: string; description: string; labels: string }) {
    return this.call<Issue>('POST', '/projects/:id/issues', body);
  }

  updateIssue(iid: number, body: Record<string, string>) {
    return this.call<Issue>('PUT', `/projects/:id/issues/${iid}`, body);
  }

  noteIssue(iid: number, body: string) {
    return this.call('POST', `/projects/:id/issues/${iid}/notes`, { body });
  }

  async getFile(path: string, ref: string): Promise<string | undefined> {
    try {
      const file = await this.call<{ content: string }>(
        'GET',
        `/projects/:id/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
      );
      return Buffer.from(file.content, 'base64').toString('utf8');
    } catch (error) {
      if (String(error).includes('→ 404')) return undefined;
      throw error;
    }
  }

  async branchExists(branch: string): Promise<boolean> {
    try {
      await this.call('GET', `/projects/:id/repository/branches/${encodeURIComponent(branch)}`);
      return true;
    } catch (error) {
      if (String(error).includes('→ 404')) return false;
      throw error;
    }
  }

  commit(body: {
    branch: string;
    start_branch?: string;
    commit_message: string;
    actions: { action: 'create' | 'update'; file_path: string; content: string }[];
  }) {
    return this.call<{ id: string }>('POST', '/projects/:id/repository/commits', body);
  }

  createRelease(body: { tag_name: string; ref: string; name: string; description: string }) {
    return this.call('POST', '/projects/:id/releases', body);
  }

  // Duo Agent Platform Flows API. Must use a human user's token: triggers by bots are ignored by design.
  startFlow(
    body: { goal: string; ai_catalog_item_consumer_id: number; start_workflow: true; issue_id?: number },
    userToken: string,
  ) {
    return this.call<{ id: number; workload?: { pipeline_path?: string } }>(
      'POST',
      '/ai/duo_workflows/workflows',
      { project_id: this.config.projectId, ...body },
      userToken,
    );
  }
}
