import * as vscode from 'vscode';

/**
 * Activity Feed WebviewView — real-time agent log stream.
 * Phase 1: empty state. Spike todo will add react-virtuoso + streaming.
 */
export class ActivityFeedProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.type === 'ready') {
        // Webview is ready to receive messages
      }
    });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 8px;
      margin: 0;
    }
    .empty-state {
      text-align: center;
      padding: 24px 8px;
      color: var(--vscode-descriptionForeground);
    }
    .empty-state p {
      margin: 4px 0;
    }
  </style>
</head>
<body>
  <div class="empty-state">
    <p>No activity yet</p>
    <p>Launch an agent session to see real-time logs here.</p>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: 'ready', payload: undefined });
  </script>
</body>
</html>`;
  }
}
