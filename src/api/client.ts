import * as vscode from 'vscode';
import type { AuthService } from '../auth/AuthService.js';
import { VibeFlowMcpClient } from './mcpClient.js';
import type {
  VibeFlowProject,
  VibeFlowSession,
  VibeFlowFeature,
  VibeFlowTodo,
  VibeFlowIssue,
  VibeFlowDocument,
  VibeFlowComment,
  CreateCommentInput,
} from './types.js';

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

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const token = this.auth.getToken();
    if (!token) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...options?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
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

  async listTodos(featureId: number): Promise<VibeFlowTodo[]> {
    return this.request<VibeFlowTodo[]>(
      `/rest/v1/vibeflow/features/${featureId}/todos`,
    );
  }

  async createTodo(featureId: number, title: string, priority: string, targetBranch: string): Promise<void> {
    await this.mcp.callTool('create_todo', { feature_id: featureId, title, priority, target_branch: targetBranch });
  }

  async updateTodoStatus(todoId: number, status: string): Promise<void> {
    await this.mcp.callTool('update_todo_status', { id: todoId, status });
  }

  // --- Issues ---

  async listIssues(projectId: number): Promise<VibeFlowIssue[]> {
    return this.request<VibeFlowIssue[]>(
      `/rest/v1/vibeflow/projects/${projectId}/issues`,
    );
  }

  async createIssue(projectId: number, title: string, priority: string, targetBranch: string): Promise<void> {
    await this.mcp.callTool('create_issue', { project_id: projectId, title, priority, target_branch: targetBranch });
  }

  async updateIssueStatus(issueId: number, status: string): Promise<void> {
    await this.mcp.callTool('update_issue_status', { id: issueId, status });
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

  // --- Branch Review Status ---

  async checkBranchReviewStatus(projectId: number, branch: string): Promise<{ ready: boolean; needsQA: number; needsSecurity: number }> {
    const result = await this.mcp.callTool('check_branch_review_status', { project_id: projectId, branch });
    return result as { ready: boolean; needsQA: number; needsSecurity: number };
  }

  // --- Work Item Logs ---

  async getWorkItemLogs(
    type: 'todo' | 'issue',
    id: number,
  ): Promise<{ id?: number; content: string; message_type?: string; created_at: string }[]> {
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
}

/**
 * Parse the concatenated log string returned by the server into individual entries.
 * Server format: "*[timestamp | session-id]*\n\nlog content\n\n*[next entry]*..."
 */
function parseLogString(raw: string): { id?: number; content: string; message_type?: string; created_at: string }[] {
  if (!raw.trim()) { return []; }

  const entries: { content: string; created_at: string; message_type?: string }[] = [];
  // Split on the timestamp marker pattern
  const parts = raw.split(/\n*\*\[([^|]+)\s*\|\s*[^\]]+\]\*\n+/);

  // parts is interleaved: [pre-text, timestamp1, content1, timestamp2, content2, ...]
  // Skip parts[0] if it's empty (text before first marker)
  let i = parts[0].trim() ? 0 : 1;

  while (i < parts.length - 1) {
    const timestamp = parts[i]?.trim();
    const content = parts[i + 1]?.trim();
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
      });
    }
    i += 2;
  }

  return entries;
}
