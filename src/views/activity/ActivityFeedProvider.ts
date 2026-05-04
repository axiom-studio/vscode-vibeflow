import * as vscode from 'vscode';
import type { ActivityEntry } from '../../api/types.js';
import { getNonce } from '../../utils/nonce.js';
import type { PromptNotifier } from '../../notifications/PromptNotifier.js';
import { assertNever, type ActivityFeedClientMessage, type ActivityFeedHostMessage, type ProgressIndicatorPayload } from '../../core/webviewMessages.js';

/**
 * Activity Feed WebviewView — serves the React app from webview-ui/dist
 * and handles bidirectional postMessage communication.
 */
export class ActivityFeedProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private pendingEntries: ActivityEntry[] = [];
  /**
   * Latest progress payload buffered for delivery on `ready`. Replaced (not
   * appended) so a late-arriving webview only ever sees the freshest snapshot.
   */
  private pendingProgress: ProgressIndicatorPayload | null = null;
  settingsHandler: ((message: unknown) => void) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly promptNotifier: PromptNotifier,
  ) {}

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

    webviewView.webview.onDidReceiveMessage((message: ActivityFeedClientMessage) => {
      switch (message.type) {
        case 'ready':
          if (this.pendingEntries.length > 0) {
            this.postMessage({ type: 'activityEntries', payload: this.pendingEntries });
            this.pendingEntries = [];
          }
          if (this.pendingProgress) {
            this.postMessage({ type: 'progressIndicator', payload: this.pendingProgress });
            this.pendingProgress = null;
          }
          break;
        case 'respondToPrompt':
          this.handlePromptResponse(message.payload.promptId);
          break;
        case 'closeSettings':
          this.postMessage({ type: 'showActivity' });
          break;
        case 'getSetting':
        case 'updateSetting':
        case 'validateServerUrl':
        case 'validateApiKey':
        case 'setApiKey':
        case 'setProviderToken':
        case 'selectProject':
        case 'refreshProjects':
          // Settings commands — delegated to extension host via event
          this.settingsHandler?.(message);
          break;
        default:
          assertNever(message);
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

  /**
   * Update the progress indicator pinned above the feed. Pass `null` to
   * clear it (no active work item with structured progress). Called by
   * ActivityPoller after each cycle so the UI tracks whichever item just
   * published progress most recently.
   */
  pushProgress(payload: ProgressIndicatorPayload | null): void {
    if (this.view) {
      this.postMessage({ type: 'progressIndicator', payload });
    } else {
      this.pendingProgress = payload;
    }
  }

  /**
   * Clear all activity entries from the feed (UI-only). The poller keeps
   * its `seenEventIds` set so only NEW events appear after a clear — the
   * intuitive semantic for a "clear feed" button.
   */
  clearFeed(): void {
    this.pendingEntries = [];
    if (this.view) {
      this.postMessage({ type: 'clearActivity' });
    }
  }

  /**
   * Toggle the webview to show the Settings panel.
   */
  showSettings(): void {
    if (this.view) {
      this.view.show(true);
      this.postMessage({ type: 'showSettings' });
    }
  }

  private postMessage(message: ActivityFeedHostMessage): void {
    this.view?.webview.postMessage(message);
  }

  private async handlePromptResponse(promptId: string): Promise<void> {
    // Look the prompt up in PromptNotifier so we can render the persona
    // name and original question in the input box, then route through the
    // shared collectAndSendResponse path that actually hits the backend.
    const prompt = this.promptNotifier.findById(promptId);
    if (!prompt) {
      vscode.window.showWarningMessage(`Prompt ${promptId} is no longer pending`);
      return;
    }
    await this.promptNotifier.collectAndSendResponse(prompt);
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

