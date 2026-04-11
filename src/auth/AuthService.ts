import * as vscode from 'vscode';

const SECRET_KEY_TOKEN = 'vibeflow.authToken';

export type AuthState = 'authenticated' | 'unauthenticated';

/**
 * Manages VibeFlow authentication via API key (Bearer token).
 * Token stored in VSCode Secrets API (encrypted, per-machine).
 * No OAuth — axiomcloud uses API keys for CLI/MCP/extension auth.
 */
export class AuthService implements vscode.Disposable {
  private readonly _onDidChangeState = new vscode.EventEmitter<AuthState>();
  readonly onDidChangeState = this._onDidChangeState.event;

  private token: string | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * Restore token from secrets on activation.
   * Does NOT validate — caller should validate after restoring.
   */
  async initialize(): Promise<void> {
    this.token = await this.secrets.get(SECRET_KEY_TOKEN);
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
    await this.secrets.store(SECRET_KEY_TOKEN, token);
    this._onDidChangeState.fire('authenticated');
  }

  /**
   * Clear stored credentials and sign out.
   */
  async logout(): Promise<void> {
    this.token = undefined;
    await this.secrets.delete(SECRET_KEY_TOKEN);
    this._onDidChangeState.fire('unauthenticated');
  }

  dispose(): void {
    this._onDidChangeState.dispose();
  }
}
