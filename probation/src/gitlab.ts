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
  updated_at?: string;
}

export interface MrDiff {
  new_path: string;
  old_path: string;
  deleted_file: boolean;
  diff: string;
}

export interface Project {
  id: number;
  path_with_namespace: string;
  web_url: string;
  default_branch: string;
  visibility: string;
  /** Only present when requested with ?license=true; null when GitLab detects no license. */
  license?: { key: string; name: string } | null;
  only_allow_merge_if_pipeline_succeeds?: boolean;
  remove_source_branch_after_merge?: boolean;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
  is_project_label?: boolean;
}

export interface PipelineSchedule {
  id: number;
  description: string;
  ref: string;
  cron: string;
  cron_timezone: string;
  active: boolean;
  /** Only on GET of a single schedule, and only for Maintainers or the schedule owner. */
  variables?: { key: string; value: string; variable_type?: string }[];
}

export interface ProtectedTag {
  name: string;
  create_access_levels: { access_level: number | null; access_level_description?: string }[];
}

export interface CiVariable {
  key: string;
  /** null for hidden (masked_and_hidden) variables. */
  value: string | null;
  protected: boolean;
  masked: boolean;
  hidden?: boolean;
  environment_scope: string;
  variable_type: string;
}

export interface TokenInfo {
  id: number;
  name: string;
  scopes: string[];
  active: boolean;
  revoked: boolean;
  expires_at: string | null;
  user_id: number;
}

export interface PagesSettings {
  url: string;
  deployments: { url: string; created_at: string }[];
}

// --- Demo conductor (scripts/demo.ts) shapes. Fields from doc/api/pipelines.md, jobs.md, merge_requests.md. ---

export interface Pipeline {
  id: number;
  iid?: number;
  status: string;
  /** push, web, schedule, merge_request_event, parent_pipeline, … */
  source?: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
  updated_at?: string;
}

export interface Job {
  id: number;
  name: string;
  stage: string;
  status: string;
  allow_failure?: boolean;
  web_url: string;
  pipeline: { id: number };
  started_at?: string | null;
  finished_at?: string | null;
}

/** A trigger job (bridge); downstream_pipeline is null until the child pipeline is created. */
export interface TriggerJob extends Job {
  downstream_pipeline: Pipeline | null;
}

/** GET of a single MR adds the source HEAD sha and head_pipeline (the list endpoint has neither). */
export interface MergeRequestDetail extends MergeRequest {
  sha: string;
  head_pipeline?: Pipeline | null;
  merge_when_pipeline_succeeds?: boolean;
  created_at?: string;
}

export interface MrApprovals {
  approved: boolean;
  user_has_approved?: boolean;
  approved_by: { user: { username: string } }[];
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
        // GitLab's rate limiter says how long to wait (Retry-After, seconds); otherwise back off 2, 4, 8 s.
        const retryAfter = Number(res.headers.get('retry-after') ?? Number.NaN);
        await new Promise((r) =>
          setTimeout(r, retryAfter >= 0 ? Math.min(retryAfter, 60) * 1000 : 1000 * 2 ** attempt),
        );
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
      sha: sha || undefined,
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

  // Follows pages (per_page from the query, default 20) so dedupe and do-not-bury see every issue.
  async listIssues(query: string): Promise<Issue[]> {
    const perPage = Number(/per_page=(\d+)/.exec(query)?.[1] ?? 20);
    const all: Issue[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.call<Issue[]>('GET', `/projects/:id/issues?${query}&page=${page}`);
      all.push(...batch);
      if (batch.length < perPage) return all;
    }
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
  // Flows API (doc/api/duo_agent_platform_flows.md, ee/lib/api/ai/duo_workflows/workflows.rb). goal is optional
  // (defaults to the flow description), issue_id is the issue IID, ai_catalog_item_consumer_id requires project_id.
  // Needs a user token: a project access token cannot start Duo flows.
  startFlow(
    body: { goal?: string; ai_catalog_item_consumer_id: number; start_workflow: true; issue_id?: number },
    userToken: string,
  ) {
    return this.call<{
      id: number;
      status?: string;
      web_url?: string | null;
      workload?: { id: number | null; message: string | null };
    }>('POST', '/ai/duo_workflows/workflows', { project_id: this.config.projectId, ...body }, userToken);
  }

  // --- Project setup and preflight (scripts/gitlab-setup.ts, scripts/doctor.ts). Paths from doc/api/*.md. ---

  /** GET that resolves undefined on 404, for "does it exist" probes. */
  private async find<T>(path: string): Promise<T | undefined> {
    try {
      return await this.call<T>('GET', path);
    } catch (error) {
      if (String(error).includes('→ 404')) return undefined;
      throw error;
    }
  }

  /** Follows offset pagination at 100 per page (call() does not expose headers). */
  private async all<T>(path: string): Promise<T[]> {
    const sep = path.includes('?') ? '&' : '?';
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.call<T[]>('GET', `${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) return out;
    }
  }

  // doc/api/projects.md: GET /projects/:id?license=true
  getProject(license = false) {
    return this.call<Project>('GET', `/projects/:id${license ? '?license=true' : ''}`);
  }

  // doc/api/projects.md: PUT /projects/:id
  updateProject(body: {
    only_allow_merge_if_pipeline_succeeds?: boolean;
    remove_source_branch_after_merge?: boolean;
  }) {
    return this.call<Project>('PUT', '/projects/:id', body);
  }

  // doc/api/labels.md: includes ancestor group labels by default (is_project_label tells them apart).
  listLabels() {
    return this.all<Label>('/projects/:id/labels');
  }

  createLabel(body: { name: string; color: string; description: string }) {
    return this.call<Label>('POST', '/projects/:id/labels', body);
  }

  // label_id accepts the label's ID or title.
  updateLabel(name: string, body: { color: string; description: string }) {
    return this.call<Label>('PUT', `/projects/:id/labels/${encodeURIComponent(name)}`, body);
  }

  // doc/api/pipeline_schedules.md
  listPipelineSchedules() {
    return this.all<PipelineSchedule>('/projects/:id/pipeline_schedules');
  }

  getPipelineSchedule(id: number) {
    return this.call<PipelineSchedule>('GET', `/projects/:id/pipeline_schedules/${id}`);
  }

  createPipelineSchedule(body: { description: string; ref: string; cron: string; cron_timezone?: string }) {
    return this.call<PipelineSchedule>('POST', '/projects/:id/pipeline_schedules', body);
  }

  createPipelineScheduleVariable(id: number, body: { key: string; value: string }) {
    return this.call('POST', `/projects/:id/pipeline_schedules/${id}/variables`, body);
  }

  // doc/api/protected_tags.md: name may be a wildcard such as catalog-*.
  getProtectedTag(name: string) {
    return this.find<ProtectedTag>(`/projects/:id/protected_tags/${encodeURIComponent(name)}`);
  }

  protectTag(name: string, createAccessLevel: number) {
    return this.call<ProtectedTag>('POST', '/projects/:id/protected_tags', {
      name,
      create_access_level: createAccessLevel,
    });
  }

  // doc/api/project_level_variables.md: values are returned to Maintainers (null when hidden).
  listVariables() {
    return this.all<CiVariable>('/projects/:id/variables');
  }

  // doc/api/personal_access_tokens.md: "self" informs on the token making the request (also project tokens).
  tokenSelf(token = this.config.token) {
    return this.call<TokenInfo>('GET', '/personal_access_tokens/self', undefined, token);
  }

  // doc/api/pages.md: Maintainer role; 404 until the first pages deployment.
  getPages() {
    return this.find<PagesSettings>('/projects/:id/pages');
  }

  // doc/api/graphql/_index.md: POST /api/graphql with a Bearer token. GraphQL reports errors with HTTP 200.
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const url = this.config.apiUrl.replace(/\/v4\/?$/, '/graphql');
    const res = await this.fetcher(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok)
      throw new Error(`GitLab POST /api/graphql → ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length || !json.data)
      throw new Error(`GitLab GraphQL: ${json.errors?.map((e) => e.message).join('; ') ?? 'no data'}`);
    return json.data;
  }

  // --- Demo conductor (scripts/demo.ts): the clicks of RUNBOOK §5, through the API. Paths from doc/api/*.md. ---

  // doc/api/issues.md: GET /projects/:id/issues/:issue_iid
  getIssue(iid: number) {
    return this.call<Issue>('GET', `/projects/:id/issues/${iid}`);
  }

  // doc/api/merge_requests.md: the single-MR GET carries sha and head_pipeline.
  getMrDetail(iid: number) {
    return this.call<MergeRequestDetail>('GET', `/projects/:id/merge_requests/${iid}`);
  }

  // doc/api/merge_request_approvals.md: GET /projects/:id/merge_requests/:iid/approvals
  mrApprovals(iid: number) {
    return this.call<MrApprovals>('GET', `/projects/:id/merge_requests/${iid}/approvals`);
  }

  // doc/api/merge_request_approvals.md: POST …/approve; sha must match the MR HEAD (409 otherwise).
  approveMr(iid: number, sha?: string) {
    return this.call<MrApprovals>('POST', `/projects/:id/merge_requests/${iid}/approve`, {
      sha: sha || undefined,
    });
  }

  // doc/api/merge_requests.md: PUT …/merge without auto_merge merges now (405 if it cannot merge).
  acceptMr(iid: number, sha: string) {
    return this.call<MergeRequestDetail>('PUT', `/projects/:id/merge_requests/${iid}/merge`, {
      sha,
      should_remove_source_branch: true,
    });
  }

  // doc/api/pipeline_schedules.md: POST …/play answers {"message":"201 Created"}; the pipeline is created async.
  playPipelineSchedule(id: number) {
    return this.call<{ message: string }>('POST', `/projects/:id/pipeline_schedules/${id}/play`);
  }

  // doc/api/pipeline_schedules.md: GET …/pipelines (sort asc by default).
  schedulePipelines(id: number) {
    return this.call<Pipeline[]>(
      'GET',
      `/projects/:id/pipeline_schedules/${id}/pipelines?sort=desc&per_page=20`,
    );
  }

  // doc/api/pipelines.md: GET /projects/:id/pipelines (newest first; child pipelines excluded by default).
  listPipelines(query: string) {
    return this.call<Pipeline[]>('GET', `/projects/:id/pipelines?${query}`);
  }

  getPipeline(id: number) {
    return this.call<Pipeline>('GET', `/projects/:id/pipelines/${id}`);
  }

  // doc/api/jobs.md: trigger_jobs (GitLab 19.2+) replaces the deprecated bridges route; fall back on 404.
  async pipelineTriggerJobs(id: number): Promise<TriggerJob[]> {
    try {
      return await this.call<TriggerJob[]>('GET', `/projects/:id/pipelines/${id}/trigger_jobs?per_page=100`);
    } catch (error) {
      if (!String(error).includes('→ 404')) throw error;
      return this.call<TriggerJob[]>('GET', `/projects/:id/pipelines/${id}/bridges?per_page=100`);
    }
  }

  // doc/api/jobs.md: works for child pipelines too; retried jobs are left out by default.
  pipelineJobs(id: number) {
    return this.all<Job>(`/projects/:id/pipelines/${id}/jobs`);
  }

  // doc/api/jobs.md: POST /projects/:id/jobs/:job_id/play, for a job in manual status.
  playJob(id: number) {
    return this.call<Job>('POST', `/projects/:id/jobs/${id}/play`);
  }

  // doc/api/jobs.md: GET …/jobs/:job_id/trace serves the raw log (plain text, not JSON).
  async jobTrace(id: number): Promise<string> {
    const path = `/projects/:id/jobs/${id}/trace`;
    const url = `${this.config.apiUrl}${path.replace(':id', encodeURIComponent(this.config.projectId))}`;
    const res = await this.fetcher(url, { headers: { 'PRIVATE-TOKEN': this.config.token } });
    if (!res.ok) throw new Error(`GitLab GET ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.text();
  }
}
