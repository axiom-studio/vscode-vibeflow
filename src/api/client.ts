import * as vscode from 'vscode';
import type {
  VibeFlowProject,
  VibeFlowSession,
  VibeFlowFeature,
  VibeFlowTodo,
  VibeFlowIssue,
  VibeFlowDocument,
} from './types';

/**
 * HTTP client for the VibeFlow MCP REST API.
 * Wraps the 72 MCP tools as typed async methods.
 * Token managed via VSCode Secrets API.
 */
export class VibeFlowClient {
  private baseUrl: string;
  private token: string | undefined;

  constructor() {
    const config = vscode.workspace.getConfiguration('vibeflow');
    this.baseUrl = config.get<string>('serverUrl', 'https://cloud.axiomstudio.ai');
  }

  setToken(token: string): void {
    this.token = token;
  }

  isAuthenticated(): boolean {
    return !!this.token;
  }

  // --- Placeholder methods (will be implemented with actual MCP HTTP calls) ---

  async listProjects(): Promise<VibeFlowProject[]> {
    return [];
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
