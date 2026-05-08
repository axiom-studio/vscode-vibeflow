import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowSession, VibeFlowTodo, VibeFlowIssue } from '../../api/types.js';
import { getNonce } from '../../utils/nonce.js';
import { escapeHtml } from '../../utils/html.js';
import { assertNever, type SessionPanelClientMessage, type SessionPanelHostMessage } from '../../core/webviewMessages.js';

/**
 * Single log entry as the webview consumes it. Mirrors the shape we already
 * get back from `client.getWorkItemLogs`, plus a synthesized `source` so the
 * UI can label which work item a log line came from when a session has more
 * than one claimed item open at once.
 */
interface PanelLog {
  id?: number;
  content: string;
  message_type?: string;
  created_at: string;
  source: { type: 'todo' | 'issue'; id: number };
}

/**
 * Manages Focus View Webview Panels for individual agent sessions.
 * One panel per persona — clicking the same persona reuses the panel.
 *
 * The Progress Ledger is built by client-side correlation: we don't have a
 * `GET /sessions/{id}/logs` endpoint in the backend (axiomcloud confirmed,
 * 2026-05-02), so we list features → todos → issues, filter the ones whose
 * `claimedBy` matches the session id, and merge their logs by timestamp.
 */
export class SessionPanelManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  /**
   * Project id for the currently-connected workspace. Set by
   * `setProjectId` from extension.ts once a project is detected — before
   * that, panels can render the static metadata header but log streaming
   * and prompt sends are disabled.
   */
  private projectId: number | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: VibeFlowClient,
  ) {}

  /** Wire (or rewire) the active project. Called from `connectToProject`. */
  setProjectId(projectId: number | undefined): void {
    this.projectId = projectId;
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
    panel.webview.onDidReceiveMessage(async (msg: SessionPanelClientMessage) => {
      switch (msg.type) {
        case 'sendPrompt': {
          const personaName = session.persona_name ?? session.persona_key;
          if (this.projectId === undefined) {
            vscode.window.showWarningMessage('VibeFlow: not connected to a project');
            break;
          }
          const text = await vscode.window.showInputBox({
            prompt: `Send message to ${personaName}`,
            placeHolder: 'Type your message...',
            ignoreFocusOut: true,
          });
          if (!text) { break; }
          try {
            await this.client.promptUser(this.projectId, session.session_id, text);
            vscode.window.showInformationMessage(`VibeFlow: Prompt sent to ${personaName}`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to send prompt: ${errMsg}`);
          }
          break;
        }
        case 'stop':
          vscode.commands.executeCommand('vibeflow.killSession', { session });
          break;
        case 'refresh':
          this.refreshPanel(session, panel);
          break;
        default:
          assertNever(msg);
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
    if (this.projectId === undefined) {
      this.postToWebview(panel, { type: 'update', payload: { session, logs: [] } });
      return;
    }

    const logs = await this.collectSessionLogs(this.projectId, session.session_id);
    this.postToWebview(panel, { type: 'update', payload: { session, logs } });
  }

  /** Typed wrapper so a future drift in SessionPanelHostMessage fails the compile. */
  private postToWebview(panel: vscode.WebviewPanel, msg: SessionPanelHostMessage): void {
    panel.webview.postMessage(msg);
  }

  /**
   * Build the Progress Ledger for one session by correlating
   * `claimedBy === sessionId` across all in-flight work items in the
   * project. We mirror the same pattern ActivityPoller uses but scoped to
   * a single session and bounded to the most recent ~100 lines.
   *
   * Failures are absorbed (return what we have) — a panel that can't reach
   * the API should still render the static metadata header and try again
   * on the next 5s tick.
   */
  private async collectSessionLogs(projectId: number, sessionId: string): Promise<PanelLog[]> {
    const claimedTodos: VibeFlowTodo[] = [];
    const claimedIssues: VibeFlowIssue[] = [];

    try {
      const features = await this.client.listFeatures(projectId);
      const activeFeatures = features.filter(f =>
        f.status === 'implementing' || f.status === 'ready_to_implement',
      );
      const todoLists = await Promise.all(
        activeFeatures.map(f => this.client.listTodos(f.id).catch(() => [])),
      );
      for (const todos of todoLists) {
        for (const todo of todos) {
          if (todo.claimed_by === sessionId && todo.status === 'implementing') {
            claimedTodos.push(todo);
          }
        }
      }
    } catch {
      // Continue with whatever we collected.
    }

    try {
      const issues = await this.client.listIssues(projectId);
      for (const issue of issues) {
        if (issue.claimed_by === sessionId && issue.status === 'implementing') {
          claimedIssues.push(issue);
        }
      }
    } catch {
      // Continue.
    }

    const logBatches = await Promise.all([
      ...claimedTodos.map(t =>
        this.client.getWorkItemLogs('todo', t.id)
          .then(rows => rows.map<PanelLog>(r => ({ ...r, source: { type: 'todo' as const, id: t.id } })))
          .catch(() => [] as PanelLog[]),
      ),
      ...claimedIssues.map(i =>
        this.client.getWorkItemLogs('issue', i.id)
          .then(rows => rows.map<PanelLog>(r => ({ ...r, source: { type: 'issue' as const, id: i.id } })))
          .catch(() => [] as PanelLog[]),
      ),
    ]);

    const merged = logBatches.flat();
    // Cap at the newest 100 lines across all of this session's work items
    // (sort desc, slice), then reverse so the webview gets them in the
    // chronological order it already renders — oldest at top, newest at
    // bottom, scroll-to-bottom for tailing.
    merged.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return merged.slice(0, 100).reverse();
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
    .log-entry .src { font-size: 0.8em; padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 6px; }
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
    <button class="btn-primary" data-action="sendPrompt">Send Prompt</button>
    <button class="btn-danger" data-action="stop">Stop Session</button>
    <button class="btn-secondary" data-action="refresh">Refresh</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    // Inline onclick="" handlers are blocked by the panel's strict CSP
    // (script-src 'nonce-...' without 'unsafe-inline'). Bind via
    // addEventListener so the buttons actually fire under the nonce.
    document.querySelectorAll('button[data-action]').forEach(b => {
      b.addEventListener('click', () => vscode.postMessage({ type: b.dataset.action }));
    });

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
          const src = log.source ? ('<span class="src">' + log.source.type + ' #' + log.source.id + '</span>') : '';
          return '<div class="log-entry"><span class="time">' + time + '</span>' + src + ' ' + icon + ' ' + escHtml(lines) + '</div>';
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

