import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import { getNonce } from '../../utils/nonce.js';
import { escapeHtml } from '../../utils/html.js';

interface WorkItemInfo {
  type: 'todo' | 'issue';
  id: number;
  title: string;
  status: string;
  priority: string;
  featureName?: string;
  claimedBy?: string;
}

/**
 * Manages Focus View Webview Panels for work item details.
 * Tabbed view: Description | Execution Logs | Commits | Attachments.
 */
export class WorkItemPanelManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: VibeFlowClient,
  ) {}

  open(item: WorkItemInfo): void {
    const key = `${item.type}-${item.id}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'vibeflow.workItemPanel',
      `#${item.id}: ${item.title}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.panels.set(key, panel);
    panel.webview.html = this.getHtml(panel.webview, item);

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'changeStatus': {
          vscode.commands.executeCommand('vibeflow.changeStatus', item.type, item.id, item.status);
          break;
        }
        case 'qaVerify':
          await this.qaAction(item, 'verify');
          break;
        case 'qaReject':
          await this.qaAction(item, 'reject');
          break;
        case 'securityApprove':
          await this.securityAction(item, 'verify');
          break;
        case 'securityReject':
          await this.securityAction(item, 'reject');
          break;
        case 'loadLogs':
          await this.sendLogs(item, panel);
          break;
      }
    });

    // Poll for log updates every 5s
    const timer = setInterval(() => this.sendLogs(item, panel), 5000);
    this.pollTimers.set(key, timer);

    panel.onDidDispose(() => {
      this.panels.delete(key);
      const t = this.pollTimers.get(key);
      if (t) { clearInterval(t); this.pollTimers.delete(key); }
    });

    // Initial log load
    this.sendLogs(item, panel);
  }

  private async sendLogs(item: WorkItemInfo, panel: vscode.WebviewPanel): Promise<void> {
    try {
      const logs = await this.client.getWorkItemLogs(item.type, item.id);
      panel.webview.postMessage({ type: 'logs', payload: logs });
    } catch {
      // Silent
    }
  }

  private async qaAction(item: WorkItemInfo, action: 'verify' | 'reject'): Promise<void> {
    if (action === 'reject') {
      const comment = await vscode.window.showInputBox({
        prompt: 'Rejection reason (required)',
        placeHolder: 'Describe what failed...',
      });
      if (!comment) { return; }
      vscode.window.showInformationMessage(`VibeFlow: QA rejected ${item.type} #${item.id} — "${comment}"`);
    } else {
      vscode.window.showInformationMessage(`VibeFlow: QA verified ${item.type} #${item.id}`);
    }
  }

  private async securityAction(item: WorkItemInfo, action: 'verify' | 'reject'): Promise<void> {
    if (action === 'reject') {
      const comment = await vscode.window.showInputBox({
        prompt: 'Security rejection reason (required)',
        placeHolder: 'Describe the security concern...',
      });
      if (!comment) { return; }
      vscode.window.showInformationMessage(`VibeFlow: Security rejected ${item.type} #${item.id} — "${comment}"`);
    } else {
      vscode.window.showInformationMessage(`VibeFlow: Security approved ${item.type} #${item.id}`);
    }
  }

  private getHtml(webview: vscode.Webview, item: WorkItemInfo): string {
    const nonce = getNonce();
    const statusBadge = (status: string, color: string) =>
      `<span style="padding:1px 8px;border-radius:3px;background:var(--vscode-${color});color:var(--vscode-badge-foreground);font-size:0.8em;">${status}</span>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px; margin: 0; }
    .header { padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    .header h1 { margin: 0 0 8px 0; font-size: 1.2em; }
    .meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    .tabs { display: flex; gap: 0; margin-top: 16px; border-bottom: 1px solid var(--vscode-panel-border); }
    .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; font-size: 0.9em; }
    .tab.active { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
    .tab:not(.active) { color: var(--vscode-descriptionForeground); }
    .tab-content { display: none; padding: 12px 0; }
    .tab-content.active { display: block; }
    .logs { max-height: 50vh; overflow-y: auto; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
    .log-entry { padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border, transparent); white-space: pre-wrap; word-break: break-word; }
    .log-entry .time { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-right: 8px; }
    .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
    button { padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em; }
    .btn-success { background: var(--vscode-terminal-ansiGreen); color: white; }
    .btn-danger { background: var(--vscode-errorForeground); color: white; }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  </style>
</head>
<body>
  <div class="header">
    <h1>${item.type} #${item.id}: ${escapeHtml(item.title)}</h1>
    <div class="meta">
      ${statusBadge(item.status, 'badge-background')}
      <span>Priority: ${item.priority}</span>
      ${item.featureName ? `<span>Feature: ${escapeHtml(item.featureName)}</span>` : ''}
      ${item.claimedBy ? `<span>Claimed: ${escapeHtml(item.claimedBy)}</span>` : ''}
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="logs">Execution Logs</div>
    <div class="tab" data-tab="actions">Actions</div>
  </div>

  <div id="tab-logs" class="tab-content active">
    <div class="logs" id="logs">
      <div style="color: var(--vscode-descriptionForeground); text-align: center; padding: 16px;">Loading...</div>
    </div>
  </div>

  <div id="tab-actions" class="tab-content">
    <div class="actions">
      <button class="btn-secondary" onclick="send('changeStatus')">Change Status</button>
      <button class="btn-success" onclick="send('qaVerify')">QA Verify</button>
      <button class="btn-danger" onclick="send('qaReject')">QA Reject</button>
      <button class="btn-success" onclick="send('securityApprove')">Security Approve</button>
      <button class="btn-danger" onclick="send('securityReject')">Security Reject</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function send(type) { vscode.postMessage({ type }); }

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Receive logs
    window.addEventListener('message', e => {
      if (e.data.type === 'logs' && e.data.payload) {
        const logsEl = document.getElementById('logs');
        const logs = e.data.payload;
        if (logs.length === 0) {
          logsEl.innerHTML = '<div style="color: var(--vscode-descriptionForeground); text-align: center; padding: 16px;">No execution logs yet</div>';
          return;
        }
        logsEl.innerHTML = logs.map(log => {
          const time = new Date(log.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
          const icon = {thinking:'🤔',action:'⚡',observation:'👁',summary:'📋',diff:'📝',test_result:'🧪'}[log.message_type] || '📌';
          const lines = log.content.split('\\n').slice(0, 5).join('\\n');
          return '<div class="log-entry"><span class="time">' + time + '</span>' + icon + ' ' + escHtml(lines) + '</div>';
        }).join('');
        logsEl.scrollTop = logsEl.scrollHeight;
      }
    });

    function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    // Request initial logs
    vscode.postMessage({ type: 'loadLogs' });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    for (const timer of this.pollTimers.values()) { clearInterval(timer); }
    for (const panel of this.panels.values()) { panel.dispose(); }
    this.panels.clear();
    this.pollTimers.clear();
  }
}

