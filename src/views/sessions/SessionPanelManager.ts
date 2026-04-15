import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowSession } from '../../api/types.js';
import { getNonce } from '../../utils/nonce.js';
import { escapeHtml } from '../../utils/html.js';

/**
 * Manages Focus View Webview Panels for individual agent sessions.
 * One panel per persona — clicking the same persona reuses the panel.
 */
export class SessionPanelManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly _client: VibeFlowClient,
  ) {
    // _client retained for future log-streaming; underscore silences unused lint
    void this._client;
  }

  /**
   * Open (or focus) a session panel for the given session.
   */
  open(session: VibeFlowSession): void {
    const key = session.session_id;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.sessionPanel',
      `${session.persona_name ?? session.persona_key}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'vibeflow-icon.svg');

    this.panels.set(key, panel);

    panel.webview.html = this.getHtml(panel.webview, session);

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'sendPrompt': {
          const text = await vscode.window.showInputBox({
            prompt: `Send message to ${session.persona_name ?? session.persona_key}`,
            placeHolder: 'Type your message...',
          });
          if (text) {
            vscode.window.showInformationMessage(`VibeFlow: Prompt sent to ${session.persona_name ?? session.persona_key}`);
          }
          break;
        }
        case 'stop':
          vscode.commands.executeCommand('vibeflow.killSession', { session });
          break;
        case 'refresh':
          this.refreshPanel(session, panel);
          break;
      }
    });

    // Poll for updates every 5s
    const timer = setInterval(() => this.refreshPanel(session, panel), 5000);
    this.pollTimers.set(key, timer);

    panel.onDidDispose(() => {
      this.panels.delete(key);
      const t = this.pollTimers.get(key);
      if (t) {
        clearInterval(t);
        this.pollTimers.delete(key);
      }
    });

    // Initial data load
    this.refreshPanel(session, panel);
  }

  private async refreshPanel(session: VibeFlowSession, panel: vscode.WebviewPanel): Promise<void> {
    // For now, just re-render with the latest session metadata.
    // Log streaming will be added once we have a stable way to link
    // sessions → active work items (needs server support).
    panel.webview.postMessage({
      type: 'update',
      payload: { session, logs: [] },
    });
  }

  private getHtml(webview: vscode.Webview, session: VibeFlowSession): string {
    const nonce = getNonce();
    const personaName = session.persona_name ?? session.persona_key;
    const model = session.agent_model ?? 'unknown';
    const branch = session.git_branch ?? 'main';
    const status = session.active ? (session.stale ? 'stale' : 'active') : 'inactive';
    const taskTitle = session.last_message ?? 'No recent activity';
    const taskStatus = session.last_message_at
      ? new Date(session.last_message_at).toLocaleTimeString()
      : '';
    const taskType = '';
    const taskId = '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px; margin: 0; }
    .header { display: flex; align-items: center; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    .header h1 { margin: 0; font-size: 1.3em; }
    .meta { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    .meta span { margin-right: 16px; }
    .section { margin-top: 16px; }
    .section h2 { font-size: 1em; margin: 0 0 8px 0; color: var(--vscode-foreground); }
    .task-card { padding: 8px 12px; border-radius: 4px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
    .task-card .title { font-weight: 600; }
    .task-card .badge { font-size: 0.8em; padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .logs { max-height: 60vh; overflow-y: auto; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
    .log-entry { padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border, transparent); white-space: pre-wrap; word-break: break-word; }
    .log-entry .time { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-right: 8px; }
    .actions { display: flex; gap: 8px; margin-top: 16px; }
    .actions button { padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9em; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-danger { background: var(--vscode-errorForeground); color: white; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(personaName)}</h1>
    <span class="meta">
      <span>${escapeHtml(model)}</span>
      <span>${escapeHtml(branch)}</span>
      <span>${escapeHtml(status)}</span>
    </span>
  </div>

  <div class="section">
    <h2>Current Task</h2>
    <div class="task-card">
      <span class="title">${taskType ? `${escapeHtml(taskType)} #${taskId}: ` : ''}${escapeHtml(taskTitle)}</span>
      ${taskStatus ? `<span class="badge">${escapeHtml(taskStatus)}</span>` : ''}
    </div>
  </div>

  <div class="section">
    <h2>Progress Ledger</h2>
    <div class="logs" id="logs">
      <div style="color: var(--vscode-descriptionForeground); padding: 16px; text-align: center;">Loading logs...</div>
    </div>
  </div>

  <div class="actions">
    <button class="btn-primary" onclick="sendMessage('sendPrompt')">Send Prompt</button>
    <button class="btn-danger" onclick="sendMessage('stop')">Stop Session</button>
    <button class="btn-secondary" onclick="sendMessage('refresh')">Refresh</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function sendMessage(type) { vscode.postMessage({ type }); }

    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.type === 'update' && msg.payload.logs) {
        const logsEl = document.getElementById('logs');
        if (msg.payload.logs.length === 0) {
          logsEl.innerHTML = '<div style="color: var(--vscode-descriptionForeground); padding: 16px; text-align: center;">No logs yet</div>';
          return;
        }
        logsEl.innerHTML = msg.payload.logs.map(log => {
          const time = new Date(log.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
          const icon = { thinking:'🤔', action:'⚡', observation:'👁', summary:'📋', diff:'📝', test_result:'🧪' }[log.message_type] || '📌';
          const lines = log.content.split('\\n').slice(0, 5).join('\\n');
          return '<div class="log-entry"><span class="time">' + time + '</span>' + icon + ' ' + escHtml(lines) + '</div>';
        }).join('');
        logsEl.scrollTop = logsEl.scrollHeight;
      }
    });

    function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    this.pollTimers.clear();
  }
}

