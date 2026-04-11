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
 * HTTP client for the VibeFlow MCP REST API.
 * Wraps the 72 MCP tools as typed async methods.
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

  // --- Placeholder methods (will be fully implemented when wiring TreeViews) ---

  async listProjects(): Promise<VibeFlowProject[]> {
    return this.request('/rest/v1/vibeflow/mcp', {
      method: 'POST',
      body: JSON.stringify({ tool: 'list_projects', arguments: {} }),
    });
  }

  async listSessions(_projectId: number): Promise<VibeFlowSession[]> {
    return [];
  }

  async listFeatures(_projectId: number): Promise<VibeFlowFeature[]> {
    return [];
  }

  async listTodos(_featureId: number): Promise<VibeFlowTodo[]> {
    return [];
  }

  async listIssues(_projectId: number): Promise<VibeFlowIssue[]> {
    return [];
  }

  async listDocuments(_projectId: number): Promise<VibeFlowDocument[]> {
    return [];
  }
}
