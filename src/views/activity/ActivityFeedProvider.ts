import * as vscode from 'vscode';
import type { ActivityEntry, WebviewToExtensionMessage } from '../../api/types.js';
import { getNonce } from '../../utils/nonce.js';

/**
 * Activity Feed WebviewView — serves the React app from webview-ui/dist
 * and handles bidirectional postMessage communication.
 */
export class ActivityFeedProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private pendingEntries: ActivityEntry[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist'),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      switch (message.type) {
        case 'ready':
          // Flush any entries that arrived before the webview was ready
          if (this.pendingEntries.length > 0) {
            this.postMessage({ type: 'activityEntries', payload: this.pendingEntries });
            this.pendingEntries = [];
          }
          break;
        case 'respondToPrompt':
          // Open Quick Pick for prompt response
          this.handlePromptResponse(message.payload.promptId);
          break;
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /**
   * Push a single activity entry to the webview.
   * If the webview isn't ready yet, buffer the entry.
   */
  pushEntry(entry: ActivityEntry): void {
    if (this.view) {
      this.postMessage({ type: 'activityEntry', payload: entry });
    } else {
      this.pendingEntries.push(entry);
    }
  }

  /**
   * Push multiple entries at once (e.g., initial load).
   */
  pushEntries(entries: ActivityEntry[]): void {
    if (this.view) {
      this.postMessage({ type: 'activityEntries', payload: entries });
    } else {
      this.pendingEntries.push(...entries);
    }
  }

  private postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private async handlePromptResponse(promptId: string): Promise<void> {
    const response = await vscode.window.showInputBox({
      prompt: `Respond to agent prompt (${promptId})`,
      placeHolder: 'Type your response...',
    });
    if (response !== undefined) {
      // In production, this would call the MCP respond_to_prompt tool.
      // For the spike, just show confirmation.
      vscode.window.showInformationMessage(`Response sent: "${response}"`);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, 'assets', 'index.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, 'assets', 'index.css'),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>Activity Feed</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

