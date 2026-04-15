import * as vscode from 'vscode';
import type { AuthService } from '../auth/AuthService.js';
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
 * HTTP client for the VibeFlow REST API.
 * Token sourced from AuthService (Secrets API).
 */
export class VibeFlowClient {
  private baseUrl: string;

  constructor(private readonly auth: AuthService) {
    const config = vscode.workspace.getConfiguration('vibeflow');
    this.baseUrl = config.get<string>('serverUrl', 'https://cloud.axiomstudio.ai');
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
      return await this.request<VibeFlowSession[]>(
        `/rest/v1/vibeflow/projects/${projectId}/sessions`,
      );
    } catch {
      // Sessions endpoint may not exist as REST — return empty
      return [];
    }
  }

  async sessionInit(params: {
    projectName: string;
    workingDirectory: string;
    gitBranch: string;
    gitRemoteUrl: string;
    persona: string;
    agentType: string;
  }): Promise<{ sessionId: string; projectId: number }> {
    return this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({
        tool: 'session_init',
        arguments: {
          project_name: params.projectName,
          working_directory: params.workingDirectory,
          git_branch: params.gitBranch,
          git_remote_url: params.gitRemoteUrl,
          persona: params.persona,
          agent_type: params.agentType,
          agent_model: 'vscode-extension',
        },
      }),
    });
  }

  async killSession(sid: number): Promise<void> {
    await this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({
        tool: 'session_kill',
        arguments: { sid },
      }),
    });
  }

  // --- Features ---

  async listFeatures(projectId: number): Promise<VibeFlowFeature[]> {
    return this.request<VibeFlowFeature[]>(
      `/rest/v1/vibeflow/projects/${projectId}/features`,
    );
  }

  async createFeature(projectId: number, name: string, priority: string): Promise<void> {
    await this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({
        tool: 'create_feature',
        arguments: { project_id: projectId, name, priority },
      }),
    });
  }

  // --- Todos ---

  async listTodos(featureId: number): Promise<VibeFlowTodo[]> {
    return this.request<VibeFlowTodo[]>(
      `/rest/v1/vibeflow/features/${featureId}/todos`,
    );
  }

  async createTodo(featureId: number, title: string, priority: string, targetBranch: string): Promise<void> {
    await this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({
        tool: 'create_todo',
        arguments: { feature_id: featureId, title, priority, target_branch: targetBranch },
      }),
    });
  }

  async updateTodoStatus(todoId: number, status: string): Promise<void> {
    await this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({
        tool: 'update_todo_status',
        arguments: { id: todoId, status },
      }),
    });
  }

  // --- Issues ---

  async listIssues(projectId: number): Promise<VibeFlowIssue[]> {
    return this.request<VibeFlowIssue[]>(
      `/rest/v1/vibeflow/projects/${projectId}/issues`,
    );
  }

  async createIssue(projectId: number, title: string, priority: string, targetBranch: string): Promise<void> {
    await this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({
        tool: 'create_issue',
        arguments: { project_id: projectId, title, priority, target_branch: targetBranch },
      }),
    });
  }

  async updateIssueStatus(issueId: number, status: string): Promise<void> {
    await this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({
        tool: 'update_issue_status',
        arguments: { id: issueId, status },
      }),
    });
  }

  // --- QA & Security Review ---

  async qaVerify(type: 'todo' | 'issue', id: number): Promise<void> {
    const tool = type === 'todo' ? 'verify_todo_qa' : 'verify_issue_qa';
    await this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({ tool, arguments: { id } }),
    });
  }

  async qaReject(type: 'todo' | 'issue', id: number, comment: string): Promise<void> {
    const tool = type === 'todo' ? 'reject_todo_qa' : 'reject_issue_qa';
    await this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({ tool, arguments: { id, rejection_comment: comment } }),
    });
  }

  async securityVerify(type: 'todo' | 'issue', _id: number): Promise<void> {
    await this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({ tool: 'verify_security_review', arguments: { entity_type: type, entity_id: _id } }),
    });
  }

  async securityReject(type: 'todo' | 'issue', _id: number, comment: string): Promise<void> {
    await this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({ tool: 'reject_security_review', arguments: { entity_type: type, entity_id: _id, rejection_comment: comment } }),
    });
  }

  // --- Branch Review Status ---

  async checkBranchReviewStatus(projectId: number, branch: string): Promise<{ ready: boolean; needsQA: number; needsSecurity: number }> {
    return this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({ tool: 'check_branch_review_status', arguments: { project_id: projectId, branch } }),
    });
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
    return this.request<VibeFlowComment>('/rest/v1/vibeflow/comments', {
      method: 'POST',
      body: JSON.stringify({
        entity_type: input.entityType,
        entity_id: input.entityId,
        project_id: input.projectId,
        section_heading: input.sectionHeading,
        content: input.content,
      }),
    });
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
    await this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({
        tool: 'prompt_user',
        arguments: {
          project_id: projectId,
          session_id: sessionId,
          prompt_text: promptText,
        },
      }),
    });
  }

  // --- PR Creation ---

  async createPR(projectId: number, params: { title: string; head: string; base: string }): Promise<{ url?: string }> {
    return this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({
        tool: 'create_pr',
        arguments: { project_id: projectId, title: params.title, head: params.head, base: params.base },
      }),
    });
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
