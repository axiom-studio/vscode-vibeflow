import * as vscode from 'vscode';

const SECRET_KEY_TOKEN = 'vibeflow.authToken';
const SECRET_KEY_REFRESH = 'vibeflow.refreshToken';

export type AuthState = 'authenticated' | 'unauthenticated';

/**
 * Manages VibeFlow authentication.
 * Tokens stored in VSCode Secrets API (encrypted, per-machine).
 * Supports OAuth browser flow and direct token paste.
 */
export class AuthService implements vscode.Disposable {
  private readonly _onDidChangeState = new vscode.EventEmitter<AuthState>();
  readonly onDidChangeState = this._onDidChangeState.event;

  private token: string | undefined;
  private refreshToken: string | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * Restore token from secrets on activation.
   */
  async initialize(): Promise<void> {
    this.token = await this.secrets.get(SECRET_KEY_TOKEN);
    this.refreshToken = await this.secrets.get(SECRET_KEY_REFRESH);
    if (this.token) {
      this.scheduleRefresh();
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
   * Login via Quick Pick — user chooses OAuth or token paste.
   */
  async login(): Promise<boolean> {
    const method = await vscode.window.showQuickPick(
      [
        { label: '$(globe) Login with Browser', description: 'OAuth flow (recommended)', value: 'oauth' as const },
        { label: '$(key) Paste API Token', description: 'For CI, Remote SSH, Dev Containers', value: 'token' as const },
      ],
      { placeHolder: 'Choose login method' },
    );

    if (!method) {
      return false;
    }

    if (method.value === 'oauth') {
      return this.loginOAuth();
    }
    return this.loginToken();
  }

  /**
   * OAuth browser flow.
   * Opens the VibeFlow auth page in the default browser.
   * The callback is handled by VibeFlowUriHandler.
   */
  private async loginOAuth(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('vibeflow');
    const serverUrl = config.get<string>('serverUrl', 'https://cloud.axiomstudio.ai');
    const callbackUri = await vscode.env.asExternalUri(
      vscode.Uri.parse(`${vscode.env.uriScheme}://axiom-studio.vscode-vibeflow/callback`),
    );

    const authUrl = `${serverUrl}/auth/vscode?redirect_uri=${encodeURIComponent(callbackUri.toString())}`;

    await vscode.env.openExternal(vscode.Uri.parse(authUrl));
    vscode.window.showInformationMessage('VibeFlow: Complete login in your browser...');
    return true; // Actual token arrives via URI handler callback
  }

  /**
   * Direct token paste — for environments where OAuth redirect doesn't work.
   */
  private async loginToken(): Promise<boolean> {
    const token = await vscode.window.showInputBox({
      prompt: 'Paste your VibeFlow API token',
      placeHolder: 'vf_...',
      password: true,
      ignoreFocusOut: true,
    });

    if (!token) {
      return false;
    }

    await this.setToken(token);
    vscode.window.showInformationMessage('VibeFlow: Logged in successfully');
    return true;
  }

  /**
   * Called by the URI handler when OAuth callback arrives.
   */
  async handleOAuthCallback(token: string, refresh?: string): Promise<void> {
    await this.setToken(token, refresh);
    vscode.window.showInformationMessage('VibeFlow: Logged in successfully');
  }

  /**
   * Clear stored credentials and sign out.
   */
  async logout(): Promise<void> {
    this.token = undefined;
    this.refreshToken = undefined;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    await this.secrets.delete(SECRET_KEY_TOKEN);
    await this.secrets.delete(SECRET_KEY_REFRESH);
    this._onDidChangeState.fire('unauthenticated');
    vscode.window.showInformationMessage('VibeFlow: Logged out');
  }

  private async setToken(token: string, refresh?: string): Promise<void> {
    this.token = token;
    await this.secrets.store(SECRET_KEY_TOKEN, token);
    if (refresh) {
      this.refreshToken = refresh;
      await this.secrets.store(SECRET_KEY_REFRESH, refresh);
    }
    this.scheduleRefresh();
    this._onDidChangeState.fire('authenticated');
  }

  /**
   * Schedule token refresh 5 minutes before expiry.
   * Parses JWT exp claim to determine timing.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    if (!this.token) {
      return;
    }

    const expiresIn = this.getTokenExpiresIn(this.token);
    if (expiresIn <= 0) {
      return;
    }

    // Refresh 5 minutes before expiry, minimum 30 seconds
    const refreshIn = Math.max(expiresIn - 5 * 60_000, 30_000);
    this.refreshTimer = setTimeout(() => this.refreshAccessToken(), refreshIn);
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      return;
    }

    try {
      const config = vscode.workspace.getConfiguration('vibeflow');
      const serverUrl = config.get<string>('serverUrl', 'https://cloud.axiomstudio.ai');

      const response = await fetch(`${serverUrl}/rest/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: this.refreshToken }),
      });

      if (!response.ok) {
        // Refresh failed — force re-login
        await this.logout();
        vscode.window.showWarningMessage('VibeFlow: Session expired. Please log in again.');
        return;
      }

      const data = await response.json() as { access_token: string; refresh_token?: string };
      await this.setToken(data.access_token, data.refresh_token);
    } catch {
      // Network error — will retry on next schedule
    }
  }

  /**
   * Parse JWT to get expiry time in milliseconds from now.
   * Returns 0 if token is not a valid JWT or has no exp claim.
   */
  private getTokenExpiresIn(token: string): number {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return 0;
      }
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (typeof payload.exp !== 'number') {
        return 0;
      }
      return payload.exp * 1000 - Date.now();
    } catch {
      return 0;
    }
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this._onDidChangeState.dispose();
  }
}
