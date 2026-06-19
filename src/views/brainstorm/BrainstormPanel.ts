import * as vscode from 'vscode';
import { getNonce } from '../../utils/nonce.js';
import type { VibeFlowClient } from '../../api/client.js';
import { assertNever, type BrainstormClientMessage, type BrainstormHostMessage } from '../../core/webviewMessages.js';
import { composeBrainstormSnapshot, pickCurrentBrainstorm } from './brainstormData.js';

// Brainstorm moves faster than the Kanban (rounds advance live), so poll at 5s
// — matching the axiomcloud web UI (BrainstormView.jsx:66-70). SSE is cookie-only
// (Bearer can't use it), so polling is the only realtime path (design doc #361).
const POLL_INTERVAL_MS = 5_000;

/**
 * Brainstorm webview panel — a multi-persona brainstorm's live view (rounds,
 * convergence, per-persona contributions, open items). Singleton (one per
 * window) — and the backend enforces one ACTIVE brainstorm per project, so the
 * panel auto-detects the current one on open. REST + polling (feature 473).
 */
export class BrainstormPanel {
  private static instance: BrainstormPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastFetchAt = 0;
  // When the user picks a past session from the history dropdown, pin it;
  // otherwise the panel shows the active (or most-recent) brainstorm.
  private selectedId: number | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly client: VibeFlowClient,
    private readonly projectId: number,
    private readonly projectName: string,
  ) {
    this.panel = panel;
  }

  static open(
    extensionUri: vscode.Uri,
    client: VibeFlowClient,
    projectId: number,
    projectName: string,
  ): void {
    if (BrainstormPanel.instance) {
      BrainstormPanel.instance.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.brainstorm',
      `VibeFlow Brainstorm — ${projectName}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'vibeflow-icon.svg');
    panel.webview.html = renderHtml(panel.webview, extensionUri);

    const instance = new BrainstormPanel(panel, client, projectId, projectName);
    BrainstormPanel.instance = instance;
    instance.attach();
  }

  private attach(): void {
    this.panel.webview.onDidReceiveMessage((msg: BrainstormClientMessage) => this.handleMessage(msg));
    this.panel.onDidChangeViewState(e => {
      if (!e.webviewPanel.visible) { return; }
      if (Date.now() - this.lastFetchAt < 1000) { return; }
      void this.sendSnapshot();
    });
    this.panel.onDidDispose(() => this.dispose());
    // Initial load is triggered by the webview sending `brainstormLoad` on mount.
  }

  private async handleMessage(msg: BrainstormClientMessage): Promise<void> {
    switch (msg.type) {
      case 'brainstormLoad':
        await this.sendSnapshot();
        this.startPolling();
        return;
      case 'ready':
        // Cursor's service-worker-gated bootstrap can land its message listener
        // after the panel-creation-time post; re-deliver now (SessionPanelManager
        // pattern). Idempotent in VS Code.
        await this.sendSnapshot();
        return;
      case 'brainstormRefresh':
        await this.sendSnapshot();
        return;
      case 'brainstormSelectSession':
        this.selectedId = msg.payload.id;
        await this.sendSnapshot();
        return;
      case 'brainstormStart': {
        try {
          const created = await this.client.startBrainstorm(msg.payload);
          this.selectedId = created.id;
        } catch (err) {
          vscode.window.showErrorMessage(`VibeFlow: Failed to start brainstorm — ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.sendSnapshot();
        return;
      }
      case 'brainstormEnd': {
        try {
          await this.client.endBrainstorm(msg.payload.id, msg.payload.cancel);
        } catch (err) {
          vscode.window.showErrorMessage(`VibeFlow: Failed to end brainstorm — ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.sendSnapshot();
        return;
      }
      case 'brainstormDelete': {
        try {
          await this.client.deleteBrainstorm(msg.payload.id);
          if (this.selectedId === msg.payload.id) { this.selectedId = undefined; }
        } catch (err) {
          vscode.window.showErrorMessage(`VibeFlow: Failed to delete brainstorm — ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.sendSnapshot();
        return;
      }
      case 'brainstormOpenSession':
        // Open the agent's chat-first session panel (resolves raw session_id).
        await vscode.commands.executeCommand('vibeflow.openSessionPanel', msg.payload.sessionId);
        return;
      case 'brainstormOpenDocument':
        await vscode.commands.executeCommand('vibeflow.openWorkItemPanel', `document-${msg.payload.documentId}`, 'Document', '');
        return;
      default:
        assertNever(msg);
    }
  }

  /**
   * Compose one snapshot from the REST reads (list → pick current → detail →
   * each round's responses → working doc) and post it. `Promise.allSettled` /
   * per-call catches so one failed fetch degrades a field instead of blanking
   * the panel.
   */
  private async sendSnapshot(): Promise<void> {
    this.lastFetchAt = Date.now();
    const serverUrl = this.client.getBaseUrl();
    try {
      const [listR, sessionsR] = await Promise.allSettled([
        this.client.listBrainstorms(this.projectId),
        this.client.listSessions(this.projectId),
      ]);
      const list = listR.status === 'fulfilled' ? listR.value : [];
      const sessions = sessionsR.status === 'fulfilled' ? sessionsR.value : [];
      const activePersonas = sessions
        .filter(s => s.active)
        .map(s => ({ key: s.persona_key, sessionId: s.session_id }));

      const current = this.selectedId !== undefined
        ? list.find(b => b.id === this.selectedId)
        : pickCurrentBrainstorm(list);

      let detail;
      let roundResponses: Record<number, import('../../api/types.js').VibeFlowBrainstormResponse[]> | undefined;
      let documentMarkdown: string | undefined;

      if (current) {
        detail = await this.client.getBrainstorm(current.id).catch(() => undefined);
        if (detail?.rounds?.length) {
          const results = await Promise.all(
            detail.rounds.map(r => this.client.getBrainstormRound(current.id, r.round_number).catch(() => undefined)),
          );
          roundResponses = {};
          detail.rounds.forEach((r, i) => {
            const rr = results[i];
            if (rr) { roundResponses![r.round_number] = rr.responses; }
          });
        }
        const docId = detail?.session.document_id;
        if (docId) {
          const doc = await this.client.getDocument(docId).catch(() => undefined);
          documentMarkdown = doc?.content;
        }
      }

      const snapshot = composeBrainstormSnapshot({
        serverUrl, detail, roundResponses, documentMarkdown, activePersonas, history: list,
      });
      this.post({ type: 'brainstormSnapshot', payload: snapshot });
    } catch (err) {
      this.post({ type: 'brainstormError', payload: { message: err instanceof Error ? err.message : String(err) } });
    }
  }

  /** Typed wrapper so host/webview union drift fails the compile. */
  private post(msg: BrainstormHostMessage): void {
    this.panel.webview.postMessage(msg);
  }

  private startPolling(): void {
    if (this.pollTimer) { return; }
    this.pollTimer = setInterval(() => {
      // Only poll while visible — a hidden panel doesn't need to wake its tree.
      if (this.panel.visible) { void this.sendSnapshot(); }
    }, POLL_INTERVAL_MS);
  }

  private dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (BrainstormPanel.instance === this) {
      BrainstormPanel.instance = undefined;
    }
  }
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distUri = vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.css'));
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
      img-src ${webview.cspSource} https: http: data:;
      font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>Brainstorm</title>
</head>
<body data-vf-mode="brainstorm">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
