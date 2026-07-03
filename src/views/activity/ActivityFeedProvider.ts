import * as vscode from 'vscode';
import type { ActivityEntry } from '../../api/types.js';
import { getNonce } from '../../utils/nonce.js';
import type { PromptNotifier } from '../../notifications/PromptNotifier.js';
import { assertNever, type ActivityFeedClientMessage, type ActivityFeedHostMessage, type FeedState, type ProgressIndicatorPayload } from '../../core/webviewMessages.js';
import { openCommitDiff, openWorkItemFromChat, openWorkspaceRelativePath } from '../sessions/chatActions.js';

/**
 * Hard cap on the host-side replay buffer. Matches the webview's
 * MAX_ENTRIES (in useMessages.ts) so a remount delivers exactly what
 * the React side would have held in memory anyway.
 */
const REPLAY_BUFFER_LIMIT = 500;

/**
 * Activity Feed WebviewView — serves the React app from webview-ui/dist
 * and handles bidirectional postMessage communication.
 */
export class ActivityFeedProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /**
   * Replay buffer of every entry delivered (or buffered for delivery)
   * in this extension session. Capped at REPLAY_BUFFER_LIMIT — oldest
   * entries evict.
   *
   * Why this exists: WebviewView's React tree is disposed on sidebar
   * collapse and recreated on expand. Without a host-side history, the
   * remount comes up empty until new activity arrives, because the
   * poller's `seenEventIds` blocks it from re-fetching what it already
   * delivered (#feed-doesnt-persist). On every `ready` message we
   * replay this buffer so the webview comes up with full history.
   */
  private replayBuffer: ActivityEntry[] = [];
  /**
   * Latest progress payload buffered for delivery on `ready`. Replaced (not
   * appended) so a late-arriving webview only ever sees the freshest snapshot.
   */
  private pendingProgress: ProgressIndicatorPayload | null = null;
  /**
   * Latest empty/connection state. Replaced (not appended) — same reason
   * as `pendingProgress`: only the freshest state is meaningful on mount.
   */
  private pendingFeedState: FeedState | undefined;
  /** Re-emit the current state after the webview reports `ready` so a late
   * mount (e.g., the user revealing the panel after a state was already
   * pushed) renders the right empty state. Wired by extension.ts. */
  onReady: (() => void) | undefined;
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
    // Context retention for the sidebar pane is set via the `views`
    // contribution in package.json (`retainContextWhenHidden: true` on
    // the view definition). The host-side replayBuffer below is the
    // belt-and-suspenders fallback that also covers cold-start scenarios
    // the package.json flag can't help with (extension reload, IDE
    // restart, full webview disposal on uninstall/upgrade).

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: ActivityFeedClientMessage) => {
      switch (message.type) {
        case 'ready':
          // Replay everything we've seen this session — covers the
          // collapse/expand cycle where React state was lost. The
          // buffer is bounded so this is O(REPLAY_BUFFER_LIMIT).
          if (this.replayBuffer.length > 0) {
            this.postMessage({ type: 'activityEntries', payload: this.replayBuffer });
          }
          if (this.pendingProgress) {
            this.postMessage({ type: 'progressIndicator', payload: this.pendingProgress });
            this.pendingProgress = null;
          }
          if (this.pendingFeedState) {
            this.postMessage({ type: 'feedState', payload: this.pendingFeedState });
            this.pendingFeedState = undefined;
          }
          // Let the FeedStateController re-emit the latest state in case it
          // was already computed before the webview mounted.
          this.onReady?.();
          break;
        case 'respondToPrompt':
          this.handlePromptResponse(message.payload.promptId);
          break;
        case 'closeSettings':
          this.postMessage({ type: 'showActivity' });
          break;
        case 'runSetup':
          // Dispatched by the unauthenticated empty-state CTA. The
          // command is registered in extension.ts and runs the 3-step
          // setup wizard.
          void vscode.commands.executeCommand('vibeflow.setup');
          break;
        case 'launchSession':
          // Dispatched by the noSessions empty-state CTA.
          void vscode.commands.executeCommand('vibeflow.launchSession');
          break;
        case 'chatOpenCommit':
          void openCommitDiff(message.payload.hash);
          break;
        case 'chatOpenWorkItem':
          openWorkItemFromChat(message.payload.kind, message.payload.id);
          break;
        case 'chatOpenPath':
          void openWorkspaceRelativePath(
            message.payload.path,
            message.payload.line,
            message.payload.column,
          );
          break;
        case 'getSetting':
        case 'updateSetting':
        case 'validateServerUrl':
        case 'validateApiKey':
        case 'setApiKey':
        case 'setProviderToken':
        case 'clearProviderToken':
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
   * Push a single activity entry to the webview. Also recorded in
   * the bounded replay buffer so a webview remount can rehydrate.
   */
  pushEntry(entry: ActivityEntry): void {
    this.recordEntries([entry]);
    this.postMessage({ type: 'activityEntry', payload: entry });
  }

  /**
   * Push multiple entries at once (e.g., initial load).
   */
  pushEntries(entries: ActivityEntry[]): void {
    if (entries.length === 0) { return; }
    this.recordEntries(entries);
    this.postMessage({ type: 'activityEntries', payload: entries });
  }

  /**
   * Append to the host-side replay buffer with the REPLAY_BUFFER_LIMIT
   * cap. The buffer is the single source of truth for "what should the
   * webview show on remount?" — pendingEntries used to serve that
   * role partially but cleared after the first `ready`, which is what
   * caused the post-collapse blank feed.
   *
   * Note: `postMessage` to an un-resolved view silently no-ops (VSCode
   * handles it), so we don't need a view-presence guard here.
   */
  private recordEntries(entries: ActivityEntry[]): void {
    this.replayBuffer.push(...entries);
    if (this.replayBuffer.length > REPLAY_BUFFER_LIMIT) {
      this.replayBuffer.splice(0, this.replayBuffer.length - REPLAY_BUFFER_LIMIT);
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
   * Push the resolved empty/connection state. Replaces (does not stack)
   * any pending state — only the freshest is meaningful for a late-mounted
   * webview. The FeedStateController is the single caller and dedupes
   * before invoking, so this method does not need its own change check.
   */
  pushFeedState(state: FeedState): void {
    if (this.view) {
      this.postMessage({ type: 'feedState', payload: state });
    } else {
      this.pendingFeedState = state;
    }
  }

  /**
   * Clear all activity entries from the feed (UI-only). The poller keeps
   * its `seenEventIds` set so only NEW events appear after a clear — the
   * intuitive semantic for a "clear feed" button.
   *
   * Also clears the replay buffer, so a post-clear remount doesn't
   * resurrect what the user explicitly cleared.
   */
  clearFeed(): void {
    this.replayBuffer = [];
    this.postMessage({ type: 'clearActivity' });
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

