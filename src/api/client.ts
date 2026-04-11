import * as vscode from 'vscode';
import type { AuthService } from '../auth/AuthService.js';
import type {
  VibeFlowProject,
  VibeFlowSession,
  VibeFlowFeature,
  VibeFlowTodo,
  VibeFlowIssue,
  VibeFlowDocument,
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
    const data = await this.request<{ projects: VibeFlowProject[] }>(
      '/rest/v1/vibeflow/projects',
    );
    return data.projects ?? [];
  }

  // --- Sessions ---

  async listSessions(projectId: number): Promise<VibeFlowSession[]> {
    const data = await this.request<{ sessions: VibeFlowSession[] }>(
      `/rest/v1/vibeflow/projects/${projectId}/sessions`,
    );
    return data.sessions ?? [];
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
    const data = await this.request<{ features: VibeFlowFeature[] }>(
      `/rest/v1/vibeflow/projects/${projectId}/features`,
    );
    return data.features ?? [];
  }

  // --- Todos ---

  async listTodos(featureId: number): Promise<VibeFlowTodo[]> {
    const data = await this.request<{ todos: VibeFlowTodo[] }>(
      `/rest/v1/vibeflow/features/${featureId}/todos`,
    );
    return data.todos ?? [];
  }

  // --- Issues ---

  async listIssues(projectId: number): Promise<VibeFlowIssue[]> {
    const data = await this.request<{ issues: VibeFlowIssue[] }>(
      `/rest/v1/vibeflow/projects/${projectId}/issues`,
    );
    return data.issues ?? [];
  }

  // --- Documents ---

  async listDocuments(projectId: number): Promise<VibeFlowDocument[]> {
    const data = await this.request<{ documents: VibeFlowDocument[] }>(
      `/rest/v1/vibeflow/projects/${projectId}/documents`,
    );
    return data.documents ?? [];
  }
}
