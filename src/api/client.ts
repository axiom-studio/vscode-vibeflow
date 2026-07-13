import * as vscode from 'vscode';
import type { AuthService } from '../auth/AuthService.js';
import { validateServerUrl } from '../auth/serverUrl.js';
import { VibeFlowMcpClient } from './mcpClient.js';
import type {
  VibeFlowProject,
  VibeFlowSession,
  VibeFlowFeature,
  VibeFlowTodo,
  VibeFlowIssue,
  VibeFlowDocument,
  VibeFlowContext,
  VibeFlowReference,
  VibeFlowComment,
  CreateCommentInput,
  BranchReviewStatus,
  VibeFlowSwimlaneResult,
  VibeFlowWorkSummary,
  VibeFlowComplianceFinding,
  VibeFlowPrompt,
  ListSessionPromptsResponse,
  VibeFlowAttachment,
  VibeFlowSecurityReview,
  VibeFlowQAReview,
  VibeFlowBrainstormSession,
  VibeFlowPullRequest,
  BrainstormDetailResponse,
  BrainstormRoundResponse,
  StartBrainstormBody,
  FeatureFlags,
  GitProviderView,
  CreateGitProviderRequest,
  CloudRunnerView,
  GlobalCloudRunnerView,
  CreateRunnerRequest,
  RunnerStatus,
  RunnerOAuthStart,
  RunnerRepo,
  RunnerHealth,
} from './types.js';
import { cloudRunnersEnabled, unwrapList, unwrapStatusEnvelope, summarizeResponseShape, redactSecretsDeep, isSensitiveBodyPath } from './cloudRunners.js';
import { cloudRunnerTrace } from '../util/cloudRunnerLog.js';

/**
 * HTTP client for the VibeFlow REST API + MCP client for write operations.
 * Token sourced from AuthService (Secrets API).
 */
export class VibeFlowClient {
  private baseUrl: string;
  private mcp: VibeFlowMcpClient;

  constructor(private readonly auth: AuthService) {
    const config = vscode.workspace.getConfiguration('vibeflow');
    this.baseUrl = config.get<string>('serverUrl', 'https://cloud.axiomstudio.ai');
    this.mcp = new VibeFlowMcpClient(auth);
  }

  /**
   * Disconnect MCP client (call on logout/dispose).
   */
  async disconnectMcp(): Promise<void> {
    await this.mcp.disconnect();
  }

  isAuthenticated(): boolean {
    return this.auth.getState() === 'authenticated';
  }

  /**
   * The bearer token the extension is currently authenticated with —
   * sourced from VS Code's secret store via AuthService. Callers that
   * need to write tokens into files (e.g. `.mcp.json` for the spawned
   * agent) should prefer this over re-reading the CLI config so the
   * extension's identity, not the CLI's, owns the spawned agent.
   * Returns undefined when the user hasn't run VibeFlow: Setup yet.
   */
  getToken(): string | undefined {
    return this.auth.getToken();
  }

  /**
   * Server origin without trailing slash. Used by webviews that need to
   * load asset URLs (avatars, icons) hosted alongside the API.
   */
  getBaseUrl(): string {
    const liveUrl = vscode.workspace.getConfiguration('vibeflow')
      .get<string>('serverUrl', this.baseUrl);
    return liveUrl.replace(/\/+$/, '');
  }

  /**
   * Live server origin after applying the same bearer-transport guard used by
   * REST requests. Socket clients use this before attaching Authorization to
   * an Upgrade handshake.
   */
  getValidatedBaseUrl(): string {
    const liveUrl = this.getBaseUrl();
    const check = validateServerUrl(liveUrl);
    if (!check.ok) {
      throw new Error(`Refusing to send bearer over insecure transport: ${check.message ?? 'invalid serverUrl'}`);
    }
    return liveUrl;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const token = this.auth.getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }

    // #1947 Layer 2 — live-read + validate before every authenticated request.
    // Constructor-cached `this.baseUrl` could be a stale pre-#1745 HTTP value,
    // and a Settings-panel update of `vibeflow.serverUrl` should take effect on
    // the next request without a window reload. Validate the LIVE value, refuse
    // to attach the bearer if the scheme is insecure, and fetch against the
    // live URL too. Original fix commit: 00c6041; restored after regression in
    // commit e0ef3ad. scripts/check-security-guards.mjs prevents silent removal.
    const liveUrl = this.getBaseUrl();
    const check = validateServerUrl(liveUrl);
    if (!check.ok) {
      throw new Error(`Refusing to send bearer over insecure transport — ${check.message ?? 'invalid serverUrl'}`);
    }

    // Opt-in Cloud Runners trace (#3396/#3400): one-line summaries at info,
    // full headers/payload/response at TRACE level. Credential VALUES never
    // reach the log — the bearer is masked and secret body fields are
    // redacted via redactSecretsDeep (apiKey/accessToken/sshPrivateKey/…).
    // Free-text content endpoints (exec/tmux-input/oauth-submit) skip body
    // logging entirely (#3401) — typed secrets can't be redacted by key name.
    const method = (options?.method ?? 'GET').toUpperCase();
    const trace = path.includes('/cloud-runners') || path.includes('/git-providers');
    const sensitiveBody = trace && isSensitiveBodyPath(path);
    if (trace) {
      cloudRunnerTrace(`→ ${method} ${path}`);
      cloudRunnerTrace(`  headers: { Content-Type: application/json, Authorization: Bearer *** }`, 'trace');
      if (typeof options?.body === 'string') {
        if (sensitiveBody) {
          cloudRunnerTrace(`  body: <content omitted — may contain typed secrets, ${options.body.length} bytes>`, 'trace');
        } else {
          try {
            cloudRunnerTrace(`  body: ${JSON.stringify(redactSecretsDeep(JSON.parse(options.body)))}`, 'trace');
          } catch {
            cloudRunnerTrace(`  body: <non-JSON, ${options.body.length} bytes>`, 'trace');
          }
        }
      }
    }

    const response = await fetch(`${liveUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...options?.headers,
      },
    });

    if (!response.ok) {
      // Surface the server's JSON error body — many endpoints (e.g. the
      // brainstorm POST, which returns 409 for ANY failure) carry the real
      // reason in `{ "error": "..." }`. Without this the caller only sees
      // "API error: 409 Conflict" and can't tell a true conflict from a
      // mislabeled DB/scoping failure. Mirrors the multipart upload path below.
      const raw = await response.text().catch(() => '');
      let detail = raw;
      try { const j = JSON.parse(raw); detail = j.error ?? j.message ?? raw; } catch { /* not JSON — keep raw */ }
      detail = (detail ?? '').toString().slice(0, 300);
      const err = new Error(`API error: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`) as Error & { status?: number; body?: string };
      err.status = response.status;
      err.body = detail;
      if (trace) { cloudRunnerTrace(`← ${response.status} ${method} ${path}  ERROR: ${detail}`, 'error'); }
      throw err;
    }

    if (trace) {
      const data = await response.json();
      cloudRunnerTrace(`← ${response.status} ${method} ${path}  ${summarizeResponseShape(data)}`);
      if (sensitiveBody) {
        // Exec output / tmux echoes can contain what was typed — shape only.
        cloudRunnerTrace(`  response: <content omitted — may echo typed secrets>`, 'trace');
      } else {
        cloudRunnerTrace(`  response: ${JSON.stringify(redactSecretsDeep(data))}`, 'trace');
      }
      return data as T;
    }
    return response.json() as Promise<T>;
  }

  // --- Projects ---

  async listProjects(): Promise<VibeFlowProject[]> {
    return this.request<VibeFlowProject[]>('/rest/v1/vibeflow/projects');
  }

  async createProject(name: string): Promise<void> {
    await this.request('/rest/v1/vibeflow/projects', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  // --- Sessions ---

  async listSessions(projectId: number): Promise<VibeFlowSession[]> {
    try {
      const data = await this.request<{ sessions: VibeFlowSession[] }>(
        `/rest/v1/vibeflow/sessions/active?project_id=${projectId}`,
      );
      return data.sessions ?? [];
    } catch {
      return [];
    }
  }

  // Note: sessionInit and sessionRegister are MCP-only tools (no REST endpoint).
  // The agent binary calls them itself via its configured MCP server.
  // The extension does NOT call these — it spawns the terminal and the agent handles init.

  /**
   * Delete a session from the server via DELETE /rest/v1/vibeflow/sessions/{session_id}.
   * Does NOT kill the local agent process — that's done by closing the terminal.
   */
  async killSession(sessionId: string): Promise<void> {
    await this.request(`/rest/v1/vibeflow/sessions/${sessionId}`, {
      method: 'DELETE',
    });
  }

  // --- Features ---

  async listFeatures(projectId: number): Promise<VibeFlowFeature[]> {
    return this.request<VibeFlowFeature[]>(
      `/rest/v1/vibeflow/projects/${projectId}/features`,
    );
  }

  async createFeature(projectId: number, name: string, priority: string): Promise<void> {
    await this.mcp.callTool('create_feature', { project_id: projectId, name, priority });
  }

  // --- Todos ---

  async listTodos(featureId: number, opts?: { status?: string }): Promise<VibeFlowTodo[]> {
    // Backend supports `?status=` (single value or comma-separated), see
    // axiomcloud/handlers/vibeflow_todos.go ListTodosByFeature. We pass the
    // filter through so callers like ActivityPoller don't have to fetch
    // every todo for every feature just to drop most of them client-side.
    const qs = opts?.status ? `?status=${encodeURIComponent(opts.status)}` : '';
    return this.request<VibeFlowTodo[]>(
      `/rest/v1/vibeflow/features/${featureId}/todos${qs}`,
    );
  }

  async getTodo(id: number): Promise<VibeFlowTodo> {
    return this.request<VibeFlowTodo>(`/rest/v1/vibeflow/todos/${id}`);
  }

  async createTodo(featureId: number, title: string, priority: string, targetBranch: string): Promise<void> {
    await this.mcp.callTool('create_todo', { feature_id: featureId, title, priority, target_branch: targetBranch });
  }

  /**
   * Transition a todo's status via REST — `PATCH /todos/{id}/status`, the same
   * Bearer path the rest of the UI uses (swimlane, etc.). Deliberately REST,
   * NOT the MCP transport: the MCP path proved unreliable in the extension
   * host, so kanban drag-to-move never persisted (#2890). `rejection_comment`
   * is required when status is 'rejected' (backend returns 400 otherwise).
   */
  async updateTodoStatus(todoId: number, status: string, opts?: { rejectionComment?: string }): Promise<void> {
    const body: Record<string, unknown> = { status };
    if (opts?.rejectionComment) { body.rejection_comment = opts.rejectionComment; }
    await this.request(`/rest/v1/vibeflow/todos/${todoId}/status`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  /**
   * Edit body fields of a todo. Status is NOT editable here — backend
   * routes that through PATCH /todos/{id}/status (see updateTodoStatus).
   * Mirrors axiomcloud handlers/vibeflow_todos.go UpdateTodo.
   */
  async updateTodo(
    todoId: number,
    fields: { title?: string; description?: string; priority?: string; target_branch?: string; feature_id?: number | null },
  ): Promise<void> {
    await this.request(`/rest/v1/vibeflow/todos/${todoId}`, {
      method: 'PUT',
      body: JSON.stringify(fields),
    });
  }

  /** Hard delete a todo. Backend has no soft-delete — this is irreversible. */
  async deleteTodo(todoId: number): Promise<void> {
    await this.request(`/rest/v1/vibeflow/todos/${todoId}`, { method: 'DELETE' });
  }

  // --- Issues ---

  async listIssues(projectId: number, opts?: { status?: string }): Promise<VibeFlowIssue[]> {
    // The handler returns the array directly when no `page` param is
    // sent (backward-compat path) and the paginated envelope when one is.
    // We stay on the array path and pass `status` through so the dashboard
    // can request only the slice it needs (e.g. status=done) without
    // pulling the full set.
    const qs = opts?.status ? `?status=${encodeURIComponent(opts.status)}` : '';
    return this.request<VibeFlowIssue[]>(
      `/rest/v1/vibeflow/projects/${projectId}/issues${qs}`,
    );
  }

  /**
   * Project-scoped todo listing with status filter. Wraps
   * `/rest/v1/vibeflow/projects/{id}/todos` which is always paginated
   * (envelope: `{ items, total_count, page, page_size, total_pages, ... }`),
   * so we walk pages until we've pulled everything matching the filter.
   * Used by the dashboard to compute "pending QA" client-side because
   * the swimlane wire shape doesn't carry `qa_verified`.
   */
  async listTodosByProject(
    projectId: number,
    opts?: { status?: string },
  ): Promise<VibeFlowTodo[]> {
    const all: VibeFlowTodo[] = [];
    const limit = 100; // Server caps at 100; smaller pages just add round-trips.
    let page = 1;
    // Bound the loop defensively — a project with >5_000 done items is
    // pathological and would dominate dashboard latency anyway.
    for (let safety = 0; safety < 50; safety++) {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (opts?.status) { params.set('status', opts.status); }
      try {
        // The backend serializes database.PaginatedResult with snake_case json
        // tags — `items` / `total_pages`, NOT `Items` / `TotalPages` (the Go
        // field names). Reading the capitalized keys yielded `undefined` →
        // every page parsed as empty → the project-todos table was always blank
        // (and the dashboard's QA-pending todo count silently 0). #3175.
        const data = await this.request<{
          items?: VibeFlowTodo[];
          total_pages?: number;
        }>(`/rest/v1/vibeflow/projects/${projectId}/todos?${params}`);
        const items = data.items ?? [];
        all.push(...items);
        if (items.length < limit) { break; }
        if (data.total_pages !== undefined && page >= data.total_pages) { break; }
        page++;
      } catch {
        break;
      }
    }
    return all;
  }

  /**
   * Fetch ONE page of project todos (unlike listTodosByProject, which walks
   * every page). Returns the page items + pagination metadata so the Browse
   * table can load-more instead of pulling the whole set. Errors propagate to
   * the caller (the tickets panel surfaces them as an error banner).
   */
  async listTodosPage(
    projectId: number,
    opts: { page: number; limit: number; status?: string; search?: string; sortBy?: string; sortOrder?: 'asc' | 'desc'; featureId?: number },
  ): Promise<{ items: VibeFlowTodo[]; totalCount: number; totalPages: number }> {
    const params = new URLSearchParams({ page: String(opts.page), limit: String(opts.limit) });
    if (opts.status) { params.set('status', opts.status); }
    if (opts.search) { params.set('search', opts.search); }
    if (opts.sortBy) { params.set('sort_by', opts.sortBy); }
    if (opts.sortOrder) { params.set('sort_order', opts.sortOrder); }
    if (opts.featureId !== undefined) { params.set('feature_id', String(opts.featureId)); }
    const data = await this.request<{ items?: VibeFlowTodo[]; total_count?: number; total_pages?: number }>(
      `/rest/v1/vibeflow/projects/${projectId}/todos?${params}`,
    );
    return { items: data.items ?? [], totalCount: data.total_count ?? 0, totalPages: data.total_pages ?? 1 };
  }

  /** One page of project issues — same envelope + contract as listTodosPage. */
  async listIssuesPage(
    projectId: number,
    opts: { page: number; limit: number; status?: string; search?: string; sortBy?: string; sortOrder?: 'asc' | 'desc'; featureId?: number },
  ): Promise<{ items: VibeFlowIssue[]; totalCount: number; totalPages: number }> {
    const params = new URLSearchParams({ page: String(opts.page), limit: String(opts.limit) });
    if (opts.status) { params.set('status', opts.status); }
    if (opts.search) { params.set('search', opts.search); }
    if (opts.sortBy) { params.set('sort_by', opts.sortBy); }
    if (opts.sortOrder) { params.set('sort_order', opts.sortOrder); }
    if (opts.featureId !== undefined) { params.set('feature_id', String(opts.featureId)); }
    const data = await this.request<{ items?: VibeFlowIssue[]; total_count?: number; total_pages?: number }>(
      `/rest/v1/vibeflow/projects/${projectId}/issues?${params}`,
    );
    return { items: data.items ?? [], totalCount: data.total_count ?? 0, totalPages: data.total_pages ?? 1 };
  }

  /**
   * One page of a review-queue view (Backlog / Security Review / Pending QA)
   * from its dedicated endpoint. Each returns todos + issues independently
   * paged, with the view's status/review filters applied server-side. `kind`
   * is the path segment: 'backlog' | 'security-pending' | 'qa-pending'.
   */
  async listReviewQueue(
    kind: 'backlog' | 'security-pending' | 'qa-pending',
    projectId: number,
    opts: { todosPage: number; issuesPage: number; pageSize: number; search?: string; sortBy?: string; sortOrder?: 'asc' | 'desc' },
  ): Promise<{
    todos: { items: VibeFlowTodo[]; totalCount: number; totalPages: number };
    issues: { items: VibeFlowIssue[]; totalCount: number; totalPages: number };
  }> {
    const params = new URLSearchParams({
      todos_page: String(opts.todosPage),
      todos_page_size: String(opts.pageSize),
      issues_page: String(opts.issuesPage),
      issues_page_size: String(opts.pageSize),
    });
    if (opts.search) { params.set('search', opts.search); }
    if (opts.sortBy) { params.set('sort_by', opts.sortBy); }
    if (opts.sortOrder) { params.set('sort_order', opts.sortOrder); }
    const data = await this.request<{
      todos?: { items?: VibeFlowTodo[]; total_count?: number; total_pages?: number };
      issues?: { items?: VibeFlowIssue[]; total_count?: number; total_pages?: number };
    }>(`/rest/v1/vibeflow/projects/${projectId}/${kind}?${params}`);
    return {
      todos: { items: data.todos?.items ?? [], totalCount: data.todos?.total_count ?? 0, totalPages: data.todos?.total_pages ?? 1 },
      issues: { items: data.issues?.items ?? [], totalCount: data.issues?.total_count ?? 0, totalPages: data.issues?.total_pages ?? 1 },
    };
  }

  async getIssue(id: number): Promise<VibeFlowIssue> {
    return this.request<VibeFlowIssue>(`/rest/v1/vibeflow/issues/${id}`);
  }

  async createIssue(projectId: number, title: string, priority: string, targetBranch: string): Promise<void> {
    await this.mcp.callTool('create_issue', { project_id: projectId, title, priority, target_branch: targetBranch });
  }

  /** Transition an issue's status via REST (`PATCH /issues/{id}/status`) — see
   *  updateTodoStatus for why this is REST, not MCP (#2890). */
  async updateIssueStatus(issueId: number, status: string, opts?: { rejectionComment?: string }): Promise<void> {
    const body: Record<string, unknown> = { status };
    if (opts?.rejectionComment) { body.rejection_comment = opts.rejectionComment; }
    await this.request(`/rest/v1/vibeflow/issues/${issueId}/status`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  // --- Brainstorm (feature 473) — all REST via request() (Bearer), NOT MCP.
  //     Brainstorm has a full REST surface (axiomcloud handlers/
  //     vibeflow_brainstorm_rest.go), so we avoid the #2890 MCP-mutation
  //     unreliability entirely. See design doc #361.

  /**
   * Project pull requests (GET /projects/{id}/prs → ListProjectPRs). Robust to
   * the response wrapper key — the server returns the rows under one of these.
   */
  async listPullRequests(projectId: number): Promise<VibeFlowPullRequest[]> {
    const r = await this.request<
      { prs?: VibeFlowPullRequest[]; pull_requests?: VibeFlowPullRequest[]; results?: VibeFlowPullRequest[] } | VibeFlowPullRequest[]
    >(`/rest/v1/vibeflow/projects/${projectId}/prs`);
    if (Array.isArray(r)) {
      return r;
    }
    return r.prs ?? r.pull_requests ?? r.results ?? [];
  }

  async listBrainstorms(projectId: number): Promise<VibeFlowBrainstormSession[]> {
    const r = await this.request<{ brainstorms: VibeFlowBrainstormSession[] }>(
      `/rest/v1/vibeflow/projects/${projectId}/brainstorms`,
    );
    return r.brainstorms ?? [];
  }

  /** Full state for one brainstorm — the poll target ({session, rounds?, progress?}). */
  async getBrainstorm(id: number): Promise<BrainstormDetailResponse> {
    return this.request<BrainstormDetailResponse>(`/rest/v1/vibeflow/brainstorms/${id}`);
  }

  async getBrainstormRound(id: number, round: number): Promise<BrainstormRoundResponse> {
    return this.request<BrainstormRoundResponse>(`/rest/v1/vibeflow/brainstorms/${id}/rounds/${round}`);
  }

  /** Start a brainstorm; the backend auto-advances to round 1 + fans out prompts. */
  async startBrainstorm(body: StartBrainstormBody): Promise<VibeFlowBrainstormSession> {
    return this.request<VibeFlowBrainstormSession>(`/rest/v1/vibeflow/brainstorms`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** End (cancel=false → finalize a document; cancel=true → drop, keep working draft). */
  async endBrainstorm(id: number, cancel: boolean): Promise<void> {
    await this.request(`/rest/v1/vibeflow/brainstorms/${id}/end`, {
      method: 'POST',
      body: JSON.stringify({ cancel, output_type: 'prd' }),
    });
  }

  async deleteBrainstorm(id: number): Promise<void> {
    await this.request(`/rest/v1/vibeflow/brainstorms/${id}`, { method: 'DELETE' });
  }

  /**
   * Edit body fields of an issue. Same shape as updateTodo.
   */
  async updateIssue(
    issueId: number,
    fields: { title?: string; description?: string; priority?: string; target_branch?: string; feature_id?: number | null },
  ): Promise<void> {
    await this.request(`/rest/v1/vibeflow/issues/${issueId}`, {
      method: 'PUT',
      body: JSON.stringify(fields),
    });
  }

  /** Hard delete an issue. Backend has no soft-delete — this is irreversible. */
  async deleteIssue(issueId: number): Promise<void> {
    await this.request(`/rest/v1/vibeflow/issues/${issueId}`, { method: 'DELETE' });
  }

  // --- QA & Security Review ---

  async qaVerify(type: 'todo' | 'issue', id: number): Promise<void> {
    const tool = type === 'todo' ? 'verify_todo_qa' : 'verify_issue_qa';
    await this.mcp.callTool(tool, { id });
  }

  async qaReject(type: 'todo' | 'issue', id: number, comment: string): Promise<void> {
    const tool = type === 'todo' ? 'reject_todo_qa' : 'reject_issue_qa';
    await this.mcp.callTool(tool, { id, rejection_comment: comment });
  }

  async securityVerify(type: 'todo' | 'issue', id: number): Promise<void> {
    await this.mcp.callTool('verify_security_review', { entity_type: type, entity_id: id });
  }

  async securityReject(type: 'todo' | 'issue', id: number, comment: string): Promise<void> {
    await this.mcp.callTool('reject_security_review', { entity_type: type, entity_id: id, rejection_comment: comment });
  }

  // --- Swimlane / Kanban ---

  /**
   * Org-wide swimlane data — returns 8 status arrays. Endpoint is org-scoped
   * (the server reads org from the auth token), so callers MUST filter the
   * returned items by project_id client-side when scoping to a workspace.
   *
   * Source: axiomcloud/handlers/vibeflow_dashboard.go:13-30.
   */
  async getSwimlane(): Promise<VibeFlowSwimlaneResult> {
    return this.request<VibeFlowSwimlaneResult>('/rest/v1/vibeflow/dashboard/swimlane');
  }

  // --- Work Summary ---

  /**
   * Aggregate metrics for a project. Counts sessions, time, commits, and
   * line changes across every todo/issue in the project.
   *
   * Source: axiomcloud/mcp/vibeflow_tools.go:6800 (vibeflowGetWorkSummaryHandler).
   */
  async getWorkSummary(projectId: number): Promise<VibeFlowWorkSummary> {
    const result = await this.mcp.callTool('get_work_summary', { project_id: projectId });
    return result as VibeFlowWorkSummary;
  }

  // --- Compliance Findings ---

  /**
   * List compliance findings for a project, optionally filtered.
   *
   * REST source: axiomcloud/handlers/vibeflow_compliance.go:234
   *   GET /rest/v1/vibeflow/compliance-findings?project_id=...
   *
   * We deliberately use REST here instead of the equivalent MCP tool. The
   * `list_compliance_findings` MCP tool returns a bare array for its
   * structured content, but the MCP SDK's response Zod schema validates
   * `structuredContent` as a record — the array fails the
   * "expected: record, received: array" check and the SDK reports
   * "Partial data" with a noisy ZodError. The REST endpoint returns the
   * same shape (a bare array) without the structured-content wrapper, so
   * it sidesteps that validation entirely. Until the backend wraps the
   * MCP tool response in `{ findings: [...] }` (or uses the existing
   * vibeflowPaginatedResponse helper), REST is the correct path.
   */
  async listComplianceFindings(
    projectId: number,
    filters?: {
      status?: string;
      severity?: string;
      framework?: string;
      work_item_type?: 'todo' | 'issue';
      work_item_id?: number;
    },
  ): Promise<VibeFlowComplianceFinding[]> {
    const params = new URLSearchParams({ project_id: String(projectId) });
    if (filters?.status) { params.set('status', filters.status); }
    if (filters?.severity) { params.set('severity', filters.severity); }
    if (filters?.framework) { params.set('framework', filters.framework); }
    if (filters?.work_item_type) { params.set('work_item_type', filters.work_item_type); }
    if (filters?.work_item_id !== undefined) { params.set('work_item_id', String(filters.work_item_id)); }
    try {
      return await this.request<VibeFlowComplianceFinding[]>(
        `/rest/v1/vibeflow/compliance-findings?${params.toString()}`,
      );
    } catch {
      return [];
    }
  }

  // --- Attachments ---

  /**
   * List attachments on a work item (todo|issue). Returns the array
   * directly per axiomcloud REST convention. Each row carries an
   * embedded `asset` blob (filename, size, content_type) when
   * `attachment_type === 'asset'` so renderers don't need a follow-up
   * fetch per file.
   *
   * Source: axiomcloud/handlers/vibeflow_attachments.go:67-93
   * (Forward lookup: attachments on an entity).
   */
  async listAttachments(
    entityType: 'todo' | 'issue',
    entityId: number,
  ): Promise<VibeFlowAttachment[]> {
    try {
      return await this.request<VibeFlowAttachment[]>(
        `/rest/v1/vibeflow/attachments?entity_type=${entityType}&entity_id=${entityId}`,
      );
    } catch {
      return [];
    }
  }

  /**
   * Two-step upload: POST /assets/upload as multipart, then POST
   * /attachments to link the new asset to a parent entity. Returns the
   * created attachment row. Backend caps at 32 MB per file
   * (handlers/vibeflow_assets.go ParseMultipartForm).
   *
   * entityType is the full axiomcloud allowlist; chat attachments
   * (#1670) parent to `project` because `prompt` isn't in the schema.
   */
  async uploadAttachment(
    entityType: 'todo' | 'issue' | 'feature' | 'project',
    entityId: number,
    fileBuffer: Uint8Array,
    fileName: string,
    contentType: string,
    category?: string,
  ): Promise<VibeFlowAttachment> {
    const token = this.auth.getToken();
    if (!token) { throw new Error('Not authenticated'); }

    // Step 1 — upload bytes. We can't reuse `request()` because it
    // hardcodes Content-Type: application/json; multipart needs the
    // browser-style FormData with auto-generated boundary.
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(fileBuffer)], { type: contentType }), fileName);
    console.log('[VibeFlow] uploadAttachment step 1: POST /assets/upload', { fileName, contentType, size: fileBuffer.byteLength });
    const uploadRes = await fetch(`${this.baseUrl}/rest/v1/vibeflow/assets/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: form,
    });
    if (!uploadRes.ok) {
      const body = await uploadRes.text().catch(() => '<unreadable>');
      console.error('[VibeFlow] uploadAttachment step 1 FAILED', { status: uploadRes.status, statusText: uploadRes.statusText, body });
      throw new Error(`Asset upload failed: ${uploadRes.status} ${uploadRes.statusText} — ${body}`);
    }
    const asset = (await uploadRes.json()) as { id: number };
    console.log('[VibeFlow] uploadAttachment step 1 OK', { assetId: asset.id });

    // Step 2 — link asset to work item.
    const linkPayload = {
      attachment_type: 'asset',
      attachment_id: asset.id,
      entity_type: entityType,
      entity_id: entityId,
      category: category ?? 'general',
    };
    console.log('[VibeFlow] uploadAttachment step 2: POST /attachments', linkPayload);
    try {
      const result = await this.request<VibeFlowAttachment>('/rest/v1/vibeflow/attachments', {
        method: 'POST',
        body: JSON.stringify(linkPayload),
      });
      console.log('[VibeFlow] uploadAttachment step 2 OK', { attachmentId: (result as { id?: number }).id });
      return result;
    } catch (err) {
      console.error('[VibeFlow] uploadAttachment step 2 FAILED', { payload: linkPayload, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /**
   * Detach a file from a work item. Deletes the attachment row only —
   * the underlying VibeflowAsset is preserved (it may be linked from
   * other entities). To purge the asset itself, call deleteAsset.
   */
  async deleteAttachment(attachmentId: number): Promise<void> {
    await this.request(`/rest/v1/vibeflow/attachments/${attachmentId}`, { method: 'DELETE' });
  }

  /**
   * Returns a Webview-safe URL for downloading an asset. The download
   * endpoint streams the file with the original content-type so an
   * `<img src="...">` will render an image attachment inline.
   *
   * **Auth note**: this URL alone is NOT enough to fetch the bytes —
   * the download endpoint requires a Bearer / x-api-key header, which
   * a raw `<img>` tag can't carry. Use `downloadAsset` host-side and
   * the AssetCache pattern to serve images into webviews (#1670).
   */
  assetDownloadUrl(assetId: number): string {
    return `${this.baseUrl}/rest/v1/vibeflow/assets/${assetId}/download`;
  }

  /**
   * Fetch raw bytes for an asset using the host-side auth token.
   * Returns the binary content; callers cache it locally so subsequent
   * renders use the on-disk copy instead of re-hitting the network.
   *
   * Backs the AssetCache module (#1670). Not exposed to webviews —
   * the auth header lives only on the host side.
   */
  async downloadAsset(assetId: number): Promise<Uint8Array> {
    if (!Number.isInteger(assetId) || assetId <= 0) {
      throw new Error(`Invalid asset id: ${assetId}`);
    }
    const token = this.auth.getToken();
    if (!token) { throw new Error('Not authenticated'); }
    const res = await fetch(`${this.baseUrl}/rest/v1/vibeflow/assets/${assetId}/download`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Asset download failed: ${res.status} ${res.statusText}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Fetch the security-review verification marker for a work item, if
   * one exists. Returns undefined when no review has been recorded yet
   * (404 from server).
   *
   * Source: axiomcloud/handlers/vibeflow_security_review.go:43-72.
   */
  async getSecurityReview(
    type: 'todo' | 'issue',
    id: number,
  ): Promise<VibeFlowSecurityReview | undefined> {
    try {
      const v = await this.request<VibeFlowSecurityReview | null>(
        `/rest/v1/vibeflow/${type}s/${id}/security/review`,
      );
      return v ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Fetch the QA verification marker, if one exists. Backend returns
   * the literal JSON `null` (not 404) when no verification has been
   * recorded — both states collapse to undefined here.
   *
   * Source: axiomcloud/handlers/vibeflow_dashboard.go:251-308.
   */
  async getQAReview(
    type: 'todo' | 'issue',
    id: number,
  ): Promise<VibeFlowQAReview | undefined> {
    try {
      const v = await this.request<VibeFlowQAReview | null>(
        `/rest/v1/vibeflow/${type}s/${id}/qa/review`,
      );
      return v ?? undefined;
    } catch {
      return undefined;
    }
  }

  // --- Branch Review Status ---

  /**
   * Returns the rich branch-review payload from the `check_branch_review_status`
   * MCP tool. Note: the MCP tool itself only takes `branch` — the server
   * derives the org from the auth token. We accept `projectId` for forward
   * compatibility but currently ignore it (matches server signature).
   */
  async checkBranchReviewStatus(projectId: number, branch: string): Promise<BranchReviewStatus> {
    void projectId;
    const result = await this.mcp.callTool('check_branch_review_status', { branch });
    return result as BranchReviewStatus;
  }

  // --- Work Item Logs ---

  async getWorkItemLogs(
    type: 'todo' | 'issue',
    id: number,
  ): Promise<{ id?: number; content: string; message_type?: string; created_at: string; source?: string }[]> {
    try {
      const data = await this.request<{ logs: string }>(
        `/rest/v1/vibeflow/${type}s/${id}/logs`,
      );
      // Server returns logs as a single concatenated string, parse into entries
      return parseLogString(data.logs ?? '');
    } catch {
      return [];
    }
  }

  /**
   * Fetch only the log entries appended AFTER `sinceChars` characters, via the
   * paginated logs endpoint (`?offset=&limit=`), so the activity feed stops
   * refetching the full, ever-growing blob every poll. Returns the parsed delta
   * entries plus the log's current total char length — the next cursor.
   *
   * `offset` is 0-indexed server-side (`offset >= total` returns empty), and
   * `sinceChars` always equals the previous `total`, i.e. an entry boundary, so
   * the returned chunk starts cleanly at a `*[...]*` marker.
   */
  async getWorkItemLogsSince(
    type: 'todo' | 'issue',
    id: number,
    sinceChars: number,
  ): Promise<{ entries: { id?: number; content: string; message_type?: string; created_at: string; source?: string }[]; totalChars: number }> {
    // ponytail: 1MB safety ceiling. Steady-state deltas are a few entries; a
    // single-poll delta >1MB drops the overflow from the live feed (the full
    // log is still available in the work-item panel). Upgrade only if real.
    const MAX_LOG_FETCH_CHARS = 1_000_000;
    const since = Math.max(0, sinceChars);
    try {
      const data = await this.request<{ logs: string; total: number }>(
        `/rest/v1/vibeflow/${type}s/${id}/logs?offset=${since}&limit=${MAX_LOG_FETCH_CHARS}`,
      );
      return { entries: parseLogString(data.logs ?? ''), totalChars: data.total ?? since };
    } catch {
      return { entries: [], totalChars: since };
    }
  }

  // --- Documents ---

  async listDocuments(projectId: number): Promise<VibeFlowDocument[]> {
    try {
      return await this.request<VibeFlowDocument[]>(
        `/rest/v1/vibeflow/documents?project_id=${projectId}`,
      );
    } catch {
      return [];
    }
  }

  async getDocument(docId: number): Promise<{ id: number; title: string; content: string }> {
    return this.request(`/rest/v1/vibeflow/documents/${docId}`);
  }

  /**
   * Create a new design document. Wire shape mirrors the `create_document`
   * MCP tool (axiomcloud/mcp/vibeflow_tools.go:2826). Backend types match
   * VibeFlowDocument['type']: prd | architecture | style_guide |
   * design_system | general.
   */
  async createDocument(args: {
    projectId: number;
    title: string;
    content: string;
    type: VibeFlowDocument['type'];
  }): Promise<void> {
    await this.mcp.callTool('create_document', {
      project_id: args.projectId,
      title: args.title,
      content: args.content,
      type: args.type,
    });
  }

  // --- Contexts (Memory) ---

  /**
   * List contexts for a project. Returns the array directly (no envelope)
   * per the axiomcloud REST contract (handlers/vibeflow_contexts.go:84).
   * The list endpoint omits body content for storage-backed rows; call
   * getContext(id) to materialize content lazily on click.
   */
  async listContexts(projectId: number): Promise<VibeFlowContext[]> {
    try {
      return await this.request<VibeFlowContext[]>(
        `/rest/v1/vibeflow/contexts?project_id=${projectId}`,
      );
    } catch {
      return [];
    }
  }

  async getContext(contextId: number): Promise<VibeFlowContext> {
    return this.request<VibeFlowContext>(`/rest/v1/vibeflow/contexts/${contextId}`);
  }

  // --- References (Confluence) ---

  /**
   * List Confluence references attached to a project. Wire shape per
   * `axiomcloud/handlers/vibeflow_atlassian.go` ListReferences endpoint
   * — returned as `{ references: [...] }`, unwrapped here. Failing
   * gracefully to `[]` matches listDocuments / listContexts behavior so
   * the tree doesn't blank when the project has no Confluence integration.
   */
  async listReferences(projectId: number): Promise<VibeFlowReference[]> {
    try {
      const data = await this.request<{ references?: VibeFlowReference[] }>(
        `/rest/v1/vibeflow/projects/${projectId}/references`,
      );
      return data.references ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Fetch the cached page content for a single reference. Server pulls
   * from Confluence on first call and caches; later calls are warm.
   * Returns the raw markdown body so the viewer can render it directly.
   */
  async getReferenceContent(
    projectId: number,
    refId: number,
  ): Promise<{ content: string; title?: string; version?: number }> {
    return this.request<{ content: string; title?: string; version?: number }>(
      `/rest/v1/vibeflow/projects/${projectId}/references/${refId}/content`,
    );
  }

  // --- Comments ---

  /**
   * List comments for a specific entity (document or context).
   * Returns plain array (axiomcloud REST convention).
   */
  async listComments(entityType: 'document' | 'context', entityId: number): Promise<VibeFlowComment[]> {
    try {
      return await this.request<VibeFlowComment[]>(
        `/rest/v1/vibeflow/comments?entity_type=${entityType}&entity_id=${entityId}`,
      );
    } catch {
      return [];
    }
  }

  /**
   * List all comments for a project (across all entities).
   */
  async listCommentsByProject(projectId: number): Promise<VibeFlowComment[]> {
    try {
      return await this.request<VibeFlowComment[]>(
        `/rest/v1/vibeflow/comments?project_id=${projectId}`,
      );
    } catch {
      return [];
    }
  }

  /**
   * Create a new comment tied to a specific section of a document/context.
   */
  async createComment(input: CreateCommentInput): Promise<VibeFlowComment> {
    const result = await this.mcp.callTool('create_comment', {
      entity_type: input.entityType,
      entity_id: input.entityId,
      project_id: input.projectId,
      section_heading: input.sectionHeading,
      content: input.content,
    });
    return result as VibeFlowComment;
  }

  /**
   * Delete a comment. Only the author can delete (403 otherwise).
   */
  async deleteComment(commentId: number): Promise<void> {
    await this.request(`/rest/v1/vibeflow/comments/${commentId}`, {
      method: 'DELETE',
    });
  }

  /**
   * Send a prompt to a specific session via the MCP prompt_user tool.
   * Used by the comment notification flow to hand off feedback to another persona.
   */
  async promptUser(projectId: number, sessionId: string, promptText: string): Promise<void> {
    await this.mcp.callTool('prompt_user', {
      project_id: projectId,
      session_id: sessionId,
      prompt_text: promptText,
    });
  }

  // --- Agent → User prompts ---

  /**
   * Fetch project-wide agent prompts that need a human response.
   *
   * The REST endpoint returns every prompt (both directions, all statuses);
   * we filter to `source === 'agent' && status === 'pending'` because those
   * are the only ones the human needs to act on. Inverse direction
   * (user→agent) flows through the agent's `wait_for_work` poll.
   *
   * Returns an empty array on any failure — prompts are non-critical UX and
   * we don't want to break the activity poll loop.
   */
  async listPendingPrompts(projectId: number): Promise<VibeFlowPrompt[]> {
    try {
      const all = await this.request<VibeFlowPrompt[]>(
        `/rest/v1/vibeflow/projects/${projectId}/prompts`,
      );
      return (all ?? []).filter(p => p.source === 'agent' && p.status === 'pending');
    } catch {
      return [];
    }
  }

  /**
   * Fetch a session's chat history with cursor pagination. Returns
   * oldest-first within the page. `before_id` scrolls older,
   * `after_id` backfills newer (mutually exclusive). Default page
   * size is 50 server-side, max 200.
   *
   * Endpoint contract mirrors axiomcloud's `api.listPrompts(projectId, sessionId, opts)`
   * in `frontend/src/services/vibeflow.js:798-806`.
   */
  async listSessionPrompts(
    projectId: number,
    sessionId: string,
    opts: { limit?: number; before_id?: number; after_id?: number } = {},
  ): Promise<ListSessionPromptsResponse> {
    const qs = new URLSearchParams();
    qs.set('session_id', sessionId);
    if (opts.limit != null) { qs.set('limit', String(opts.limit)); }
    if (opts.before_id != null) { qs.set('before_id', String(opts.before_id)); }
    if (opts.after_id != null) { qs.set('after_id', String(opts.after_id)); }
    return this.request<ListSessionPromptsResponse>(
      `/rest/v1/vibeflow/projects/${projectId}/prompts?${qs.toString()}`,
    );
  }

  /**
   * Create a user→agent prompt via REST. The agent receives this in
   * its `wait_for_work` poll as a `pending_prompts` entry. Mirrors
   * axiomcloud's `api.createPrompt` in `frontend/src/services/vibeflow.js:779-784`.
   *
   * Distinct from `promptUser` (MCP `prompt_user`), which creates an
   * agent→user prompt — appropriate for cross-persona handoffs (e.g.,
   * comment-flow notifications) but the wrong direction for chat-input
   * from a human user.
   */
  async createPrompt(
    projectId: number,
    sessionId: string,
    text: string,
  ): Promise<VibeFlowPrompt> {
    return this.request<VibeFlowPrompt>(
      `/rest/v1/vibeflow/projects/${projectId}/prompts`,
      {
        method: 'POST',
        body: JSON.stringify({ session_id: sessionId, text }),
      },
    );
  }

  /**
   * Submit the human's response to an agent-initiated prompt. Backend
   * transitions the prompt to `responded` and publishes an SSE event that
   * wakes the waiting agent's `wait_for_work` poll.
   */
  async respondToPrompt(projectId: number, promptId: string, responseText: string): Promise<void> {
    await this.request(
      `/rest/v1/vibeflow/projects/${projectId}/prompts/${encodeURIComponent(promptId)}/respond`,
      {
        method: 'PUT',
        body: JSON.stringify({ response_text: responseText }),
      },
    );
  }

  // --- PR Creation ---

  async createPR(projectId: number, params: { title: string; head: string; base: string }): Promise<{ url?: string }> {
    const result = await this.mcp.callTool('create_pr', {
      project_id: projectId,
      title: params.title,
      head: params.head,
      base: params.base,
    });
    return result as { url?: string };
  }

  // --- Cloud Runners Integration (feature #603) ---
  //
  // REST (Bearer) endpoints on the AxiomCloud API — see the "Cloud Runners
  // External Integration" API Spec (axiomcloud doc #433). `feature_cloud_runners`
  // gates the cloud-runner + git-provider routes; GET /feature-flags is NOT
  // gated and returns the org-resolved flag map. All ids in paths are LOCAL
  // ids — `studioRunnerId` is informational only and never sent by the client.

  /** Read the caller's org-resolved feature flags. Not itself feature-gated. */
  async getFeatureFlags(): Promise<FeatureFlags> {
    const data = await this.request<{ flags?: Record<string, boolean> }>('/rest/v1/feature-flags');
    return { flags: data.flags ?? {} };
  }

  /** Whether Cloud Runners is enabled for the caller's org (or globally). */
  async isCloudRunnersEnabled(): Promise<boolean> {
    return cloudRunnersEnabled(await this.getFeatureFlags());
  }

  // Git providers (account-level, per-user). Secrets are write-only — the
  // list/create responses never echo accessToken / sshPrivateKey back.

  async listGitProviders(): Promise<GitProviderView[]> {
    const data = await this.request<{ providers?: GitProviderView[] }>(
      '/rest/v1/vibeflow/git-providers',
    );
    return unwrapList<GitProviderView>(data, 'providers');
  }

  async createGitProvider(body: CreateGitProviderRequest): Promise<GitProviderView> {
    return this.request<GitProviderView>('/rest/v1/vibeflow/git-providers', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async renameGitProvider(id: number, name: string): Promise<GitProviderView> {
    return this.request<GitProviderView>(`/rest/v1/vibeflow/git-providers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  }

  async deleteGitProvider(id: number): Promise<void> {
    await this.request(`/rest/v1/vibeflow/git-providers/${id}`, { method: 'DELETE' });
  }

  // Cloud runners.

  async listCloudRunners(): Promise<GlobalCloudRunnerView[]> {
    const data = await this.request<{ runners?: GlobalCloudRunnerView[] }>(
      '/rest/v1/vibeflow/cloud-runners',
    );
    return unwrapList<GlobalCloudRunnerView>(data, 'runners');
  }

  async listProjectCloudRunners(projectId: number): Promise<CloudRunnerView[]> {
    const data = await this.request<{ runners?: CloudRunnerView[] }>(
      `/rest/v1/vibeflow/projects/${projectId}/cloud-runners`,
    );
    return unwrapList<CloudRunnerView>(data, 'runners');
  }

  async createCloudRunner(projectId: number, body: CreateRunnerRequest): Promise<CloudRunnerView> {
    return this.request<CloudRunnerView>(
      `/rest/v1/vibeflow/projects/${projectId}/cloud-runners`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  async getCloudRunner(projectId: number, id: number): Promise<CloudRunnerView> {
    const data = await this.request<unknown>(
      `/rest/v1/vibeflow/projects/${projectId}/cloud-runners/${id}`,
    );
    // Dual-shaped route (#3630): a PENDING runner returns axiomcloud's bare
    // local view; a provisioned one relays cortex's {code,status,result}
    // envelope verbatim — the runner (incl. agentType/authMode/loginMethod)
    // lives in `result`. unwrapStatusEnvelope tolerates both shapes.
    return unwrapStatusEnvelope<CloudRunnerView>(data);
  }

  async deleteCloudRunner(projectId: number, id: number): Promise<void> {
    await this.request(
      `/rest/v1/vibeflow/projects/${projectId}/cloud-runners/${id}`,
      { method: 'DELETE' },
    );
  }

  // Runner lifecycle (feature #603 management, spec #435/#436). Passthrough
  // verbs — owner/admin only (403 otherwise); local ids only.

  /** Start a stopped runner. Server optimistically sets local status `starting`. */
  async startCloudRunner(projectId: number, id: number): Promise<void> {
    await this.request(
      `/rest/v1/vibeflow/projects/${projectId}/cloud-runners/${id}/start`,
      { method: 'POST' },
    );
  }

  /** Stop an active runner. Server optimistically sets local status `stopping`. */
  async stopCloudRunner(projectId: number, id: number): Promise<void> {
    await this.request(
      `/rest/v1/vibeflow/projects/${projectId}/cloud-runners/${id}/stop`,
      { method: 'POST' },
    );
  }

  /**
   * Live Studio status for a runner. Returns `409 runner is not provisioned
   * yet` (thrown as `err.status === 409`) while `studioRunnerId == 0` — callers
   * treat that as transient and keep polling.
   */
  async getRunnerStatus(projectId: number, id: number): Promise<RunnerStatus> {
    const data = await this.request<unknown>(
      `/rest/v1/vibeflow/projects/${projectId}/cloud-runners/${id}/status`,
    );
    // Studio relays a {code, status, result, errors} envelope — the live
    // fields (authenticated/configured/podStatus) live in `result` (#437 §2).
    return unwrapStatusEnvelope<RunnerStatus>(data);
  }

  // --- Manage-workflow passthrough (feature #603, spec #435/#436 §4) ---
  // Owner/admin for mutating verbs (403 otherwise); LOCAL ids only; the manifest
  // uses `${VAULT:...}` placeholders the server resolves — never real secrets.

  private runnerBase(projectId: number, id: number): string {
    return `/rest/v1/vibeflow/projects/${projectId}/cloud-runners/${id}`;
  }

  async getRunnerOAuthStart(projectId: number, id: number): Promise<RunnerOAuthStart> {
    const data = await this.request<unknown>(`${this.runnerBase(projectId, id)}/oauth/start`);
    // cortex wraps the start payload as {code,status,result:{url,code,...}}
    // and axiomcloud relays it verbatim — without unwrapping, the OAuth URL /
    // device code never reach the Authenticate step (#3630).
    return unwrapStatusEnvelope<RunnerOAuthStart>(data);
  }

  async submitRunnerOAuth(projectId: number, id: number, code: string): Promise<void> {
    await this.request(`${this.runnerBase(projectId, id)}/oauth/submit`, {
      method: 'POST', body: JSON.stringify({ code }),
    });
  }

  async getRunnerManifest(projectId: number, id: number): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`${this.runnerBase(projectId, id)}/manifest`);
  }

  async putRunnerManifest(projectId: number, id: number, manifest: Record<string, unknown>): Promise<void> {
    await this.request(`${this.runnerBase(projectId, id)}/manifest`, {
      method: 'POST', body: JSON.stringify(manifest),
    });
  }

  async listRunnerRepos(projectId: number, id: number): Promise<RunnerRepo[]> {
    const data = await this.request<{ repos?: RunnerRepo[] }>(`${this.runnerBase(projectId, id)}/repos`);
    return unwrapList<RunnerRepo>(data, 'repos');
  }

  async cloneRunnerRepo(projectId: number, id: number, repo: { url: string; branch?: string }): Promise<void> {
    await this.request(`${this.runnerBase(projectId, id)}/repos/clone`, {
      method: 'POST', body: JSON.stringify(repo),
    });
  }

  async listRunnerAgentProjects(projectId: number, id: number): Promise<string[]> {
    const data = await this.request<{ projects?: string[] }>(`${this.runnerBase(projectId, id)}/agent/projects`);
    return unwrapList<string>(data, 'projects');
  }

  async injectRunnerGitCredentials(projectId: number, id: number, gitProviderId: number): Promise<void> {
    await this.request(`${this.runnerBase(projectId, id)}/git-credentials`, {
      method: 'POST', body: JSON.stringify({ gitProviderId }),
    });
  }

  async getRunnerHealth(projectId: number, id: number): Promise<RunnerHealth> {
    const data = await this.request<unknown>(`${this.runnerBase(projectId, id)}/health`);
    // Same Studio envelope as /status — phase/errors live in `result` (#3630).
    return unwrapStatusEnvelope<RunnerHealth>(data);
  }

  async execOnRunner(projectId: number, id: number, command: string): Promise<unknown> {
    return this.request(`${this.runnerBase(projectId, id)}/exec`, {
      method: 'POST', body: JSON.stringify({ command }),
    });
  }

  /**
   * Create a pod terminal session (`POST .../terminal/session`) — the returned
   * session id is bound over the terminal WebSocket as its first frame (#3588).
   * (The former tmux/* endpoints from spec #433 §8 no longer exist server-side.)
   */
  async createRunnerTerminalSession(projectId: number, id: number): Promise<unknown> {
    return this.request(`${this.runnerBase(projectId, id)}/terminal/session`, {
      method: 'POST', body: JSON.stringify({}),
    });
  }
}

/**
 * Parse the concatenated log string returned by the server into individual
 * entries. Backend writers in axiomcloud/mcp/vibeflow_tools.go emit one of:
 *   *[timestamp | session-id]*    — normal agent log (annotateLogEntry)
 *   *[timestamp | security_review]* — pseudo-source for security rejections
 *   *[timestamp]*                  — bare timestamp (no source field)
 *
 * The parser captures both the timestamp (group 1) and the optional source
 * field (group 2) so callers can attribute each entry to a specific session
 * or pseudo-source. Without per-entry source, the Activity Feed cannot color-
 * code by persona because a work item's `claimed_by` may not match the
 * session that wrote a given log line (multi-persona workflows).
 */
export function parseLogString(raw: string): { id?: number; content: string; message_type?: string; created_at: string; source?: string }[] {
  if (!raw.trim()) { return []; }

  const entries: { content: string; created_at: string; message_type?: string; source?: string }[] = [];
  // Split on the marker pattern; the source field is optional. Capture
  // groups: [1] timestamp, [2] source (undefined for bare-timestamp form).
  const parts = raw.split(/\n*\*\[([^|\]]+?)(?:\s*\|\s*([^\]]+?))?\]\*\n+/);

  // parts is interleaved: [pre, ts1, src1, content1, ts2, src2, content2, ...]
  // Skip parts[0] if it's empty (text before first marker).
  let i = parts[0].trim() ? 0 : 1;

  while (i < parts.length - 2) {
    const timestamp = parts[i]?.trim();
    const source = parts[i + 1]?.trim() || undefined;
    const content = parts[i + 2]?.trim();
    if (timestamp && content) {
      // Detect message type from emoji prefix
      let messageType = 'action';
      if (content.startsWith('🤔')) { messageType = 'thinking'; }
      else if (content.startsWith('👁')) { messageType = 'observation'; }
      else if (content.startsWith('⚡')) { messageType = 'action'; }
      else if (content.startsWith('📋')) { messageType = 'summary'; }
      else if (content.startsWith('📝')) { messageType = 'diff'; }
      else if (content.startsWith('✅') || content.startsWith('❌')) { messageType = 'test_result'; }

      entries.push({
        created_at: timestamp,
        content,
        message_type: messageType,
        source,
      });
    }
    i += 3;
  }

  return entries;
}
