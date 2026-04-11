import * as vscode from 'vscode';
import type { AuthService } from './AuthService.js';

/**
 * Handles OAuth callback URIs: vscode://axiom-studio.vscode-vibeflow/callback?token=...&state=...
 * Validates the CSRF state parameter before accepting the token.
 */
export class VibeFlowUriHandler implements vscode.UriHandler {
  constructor(private readonly authService: AuthService) {}

  async handleUri(uri: vscode.Uri): Promise<void> {
    if (uri.path !== '/callback') {
      return;
    }

    const params = new URLSearchParams(uri.query);
    const token = params.get('token');
    const state = params.get('state');
    const refreshToken = params.get('refresh_token') ?? undefined;

    if (!token) {
      vscode.window.showErrorMessage('VibeFlow: Login failed — no token received');
      return;
    }

    // Validate CSRF state parameter
    if (!state || !this.authService.consumeOAuthState(state)) {
      vscode.window.showErrorMessage('VibeFlow: Login failed — invalid state parameter (possible CSRF attack)');
      return;
    }

    await this.authService.handleOAuthCallback(token, refreshToken);
  }
}
