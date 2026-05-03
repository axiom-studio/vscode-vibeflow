import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { WorkItemsTreeProvider } from './WorkItemsTreeProvider.js';
import { qaVerify, qaReject, securityApprove, securityReject } from '../../commands/governanceCommands.js';
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
 * Live state we read back from the backend after any action; drives which
 * buttons render in the Actions toolbar. Kept separate from the static
 * WorkItemInfo passed by the caller because the caller's data may be stale
 * (it's whatever the tree had last).
 */
interface WorkItemState {
  status: string;
  qa_verified: boolean;
  security_reviewed: boolean;
}

/**
 * Manages Focus View Webview Panels for work item details.
 *
 * Tabbed view (Phase A): Logs | Actions. Description / Commits /
 * Attachments tabs and the header-level action toolbar (Comment / Edit /
 * Archive / Delete) land in Phase B+. Phase A scope is closing the
 * "QA/Security mocked" audit finding by routing those buttons through the
 * real governanceCommands wrappers and gating their visibility on the
 * canonical axiomcloud rules (see memory: axiomcloud work-item action
 * visibility).
 */
export class WorkItemPanelManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: VibeFlowClient,
    private readonly workItemsProvider: WorkItemsTreeProvider,
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
        case 'changeStatus':
          vscode.commands.executeCommand('vibeflow.changeStatus', item.type, item.id, item.status);
          // Status edit is handled in a separate quickpick flow; refresh on
          // return so the buttons regate to the new status.
          await this.refreshState(item, panel);
          break;
        case 'qaVerify':
          await qaVerify(this.client, item.type, item.id, this.workItemsProvider);
          await this.refreshState(item, panel);
          break;
        case 'qaReject':
          await qaReject(this.client, item.type, item.id, this.workItemsProvider);
          await this.refreshState(item, panel);
          break;
        case 'securityApprove':
          await securityApprove(this.client, item.type, item.id, this.workItemsProvider);
          await this.refreshState(item, panel);
          break;
        case 'securityReject':
          await securityReject(this.client, item.type, item.id, this.workItemsProvider);
          await this.refreshState(item, panel);
          break;
        case 'loadLogs':
          await this.sendLogs(item, panel);
          break;
      }
    });

    // Poll for log + state updates every 5s.
    const timer = setInterval(() => {
      this.sendLogs(item, panel);
      this.refreshState(item, panel);
    }, 5000);
    this.pollTimers.set(key, timer);

    panel.onDidDispose(() => {
      this.panels.delete(key);
      const t = this.pollTimers.get(key);
      if (t) { clearInterval(t); this.pollTimers.delete(key); }
    });

    // Initial state + log load.
    this.sendLogs(item, panel);
    this.refreshState(item, panel);
  }

  private async sendLogs(item: WorkItemInfo, panel: vscode.WebviewPanel): Promise<void> {
    try {
      const logs = await this.client.getWorkItemLogs(item.type, item.id);
      panel.webview.postMessage({ type: 'logs', payload: logs });
    } catch {
      // Silent
    }
  }

  /**
   * Re-fetch the current work item from the backend and push the live
   * state to the webview. The caller's WorkItemInfo may be stale (tree
   * snapshots can lag the actual record by a poll cycle), so action
   * visibility derives from this fresh state, not the constructor input.
   */
  private async refreshState(item: WorkItemInfo, panel: vscode.WebviewPanel): Promise<void> {
    try {
      const fresh = item.type === 'todo'
        ? await this.client.getTodo(item.id)
        : await this.client.getIssue(item.id);
      const state: WorkItemState = {
        status: fresh.status,
        qa_verified: fresh.qa_verified ?? false,
        security_reviewed: fresh.security_reviewed ?? false,
      };
      panel.webview.postMessage({ type: 'state', payload: state });
    } catch {
      // Silent — webview keeps its last state, retries on next poll tick.
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
    .meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 0.85em; color: var(--vscode-descriptionForeground); align-items: center; }
    .check { color: var(--vscode-terminal-ansiGreen); font-weight: 600; }
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
    .actions .group { display: flex; gap: 8px; align-items: center; }
    .actions .group-label { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-right: 4px; }
    button { padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em; }
    button[hidden] { display: none !important; }
    .btn-success { background: var(--vscode-terminal-ansiGreen); color: white; }
    .btn-danger { background: var(--vscode-errorForeground); color: white; }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .empty-actions { color: var(--vscode-descriptionForeground); font-size: 0.85em; font-style: italic; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${item.type} #${item.id}: ${escapeHtml(item.title)}</h1>
    <div class="meta">
      <span id="status-badge">${statusBadge(item.status, 'badge-background')}</span>
      <span>Priority: ${item.priority}</span>
      ${item.featureName ? `<span>Feature: ${escapeHtml(item.featureName)}</span>` : ''}
      ${item.claimedBy ? `<span>Claimed: ${escapeHtml(item.claimedBy)}</span>` : ''}
      <span id="qa-flag" class="check" hidden>✓ QA verified</span>
      <span id="security-flag" class="check" hidden>✓ Security reviewed</span>
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
      <div class="group">
        <span class="group-label">Status:</span>
        <button class="btn-secondary" onclick="send('changeStatus')">Change…</button>
      </div>
      <div class="group">
        <span class="group-label">QA:</span>
        <button id="btn-qa-verify" class="btn-success" onclick="send('qaVerify')" hidden>✓ QA Verify</button>
        <button id="btn-qa-reject" class="btn-danger" onclick="send('qaReject')" hidden>✕ QA Reject</button>
      </div>
      <div class="group">
        <span class="group-label">Security:</span>
        <button id="btn-sec-verify" class="btn-success" onclick="send('securityApprove')" hidden>✓ Security Verify</button>
        <button id="btn-sec-reject" class="btn-danger" onclick="send('securityReject')" hidden>✕ Security Reject</button>
      </div>
      <div id="empty-actions" class="empty-actions" hidden>No actions available for this status.</div>
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

    // ----- Action visibility, mirroring axiomcloud TodoDetail/IssueDetail -----
    // Rules (verified 2026-05-03 against studio/src/Pages/Vibeflow/*.jsx):
    //  - QA Verify:   status === 'done' && !qa_verified
    //  - QA Reject:   status === 'done' && !qa_verified  (text: "✕ QA Reject")
    //  - QA Revoke:   status === 'done' &&  qa_verified  (same button, text: "↩ Revoke QA")
    //  - Security Verify/Reject — extension-only convenience action (no
    //    canonical web UI); shown when !security_reviewed.
    function applyState(state) {
      const status = state.status;
      const qa = !!state.qa_verified;
      const sec = !!state.security_reviewed;

      // Header badges
      document.getElementById('status-badge').textContent = status;
      document.getElementById('qa-flag').hidden = !qa;
      document.getElementById('security-flag').hidden = !sec;

      // QA buttons — only at status 'done'.
      const qaVerifyBtn = document.getElementById('btn-qa-verify');
      const qaRejectBtn = document.getElementById('btn-qa-reject');
      if (status === 'done') {
        qaVerifyBtn.hidden = qa;                    // hide once verified
        qaRejectBtn.hidden = false;
        qaRejectBtn.textContent = qa ? '↩ Revoke QA' : '✕ QA Reject';
      } else {
        qaVerifyBtn.hidden = true;
        qaRejectBtn.hidden = true;
      }

      // Security buttons — extension-only, hide once reviewed.
      const secVerifyBtn = document.getElementById('btn-sec-verify');
      const secRejectBtn = document.getElementById('btn-sec-reject');
      secVerifyBtn.hidden = sec;
      secRejectBtn.hidden = sec;

      // Empty-state hint when nothing is actionable.
      const anyVisible = !qaVerifyBtn.hidden || !qaRejectBtn.hidden ||
                         !secVerifyBtn.hidden || !secRejectBtn.hidden;
      document.getElementById('empty-actions').hidden = anyVisible;
    }

    // Receive logs + state
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
      if (e.data.type === 'state' && e.data.payload) {
        applyState(e.data.payload);
      }
    });

    function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    // Request initial logs (state arrives via host's postMessage on open)
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
