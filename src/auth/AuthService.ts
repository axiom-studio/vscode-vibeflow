import * as vscode from 'vscode';
import type { ContextProxy } from '../core/ContextProxy.js';

export type AuthState = 'authenticated' | 'unauthenticated';

/**
 * Manages VibeFlow authentication via API key (Bearer token).
 * Token stored in VSCode Secrets API (encrypted, per-machine) via
 * the central ContextProxy. No OAuth — axiomcloud uses API keys for
 * CLI/MCP/extension auth.
 */
export class AuthService implements vscode.Disposable {
  private readonly _onDidChangeState = new vscode.EventEmitter<AuthState>();
  readonly onDidChangeState = this._onDidChangeState.event;

  private token: string | undefined;

  constructor(private readonly context: ContextProxy) {}

  /**
   * Restore token from secrets on activation.
   * Does NOT validate — caller should validate after restoring.
   */
  async initialize(): Promise<void> {
    this.token = await this.context.getSecret('vibeflow.authToken');
    if (this.token) {
      this._onDidChangeState.fire('authenticated');
    }
  }

  getState(): AuthState {
    return this.token ? 'authenticated' : 'unauthenticated';
  }

  getToken(): string | undefined {
    return this.token;
  }

  /**
   * Store a validated API key. Called by the Setup command after
   * the key has been validated by successfully fetching projects.
   */
  async setToken(token: string): Promise<void> {
    this.token = token;
    await this.context.setSecret('vibeflow.authToken', token);
    this._onDidChangeState.fire('authenticated');
  }

  /**
   * Clear stored credentials and sign out.
   */
  async logout(): Promise<void> {
    this.token = undefined;
    await this.context.deleteSecret('vibeflow.authToken');
    this._onDidChangeState.fire('unauthenticated');
  }

  dispose(): void {
    this._onDidChangeState.dispose();
  }
}
