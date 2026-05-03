import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { WorkItemsTreeProvider } from './WorkItemsTreeProvider.js';
import type {
  VibeFlowTodo,
  VibeFlowIssue,
  VibeFlowComplianceFinding,
  VibeFlowAttachment,
  VibeFlowSecurityReview,
  VibeFlowComplianceTag,
} from '../../api/types.js';
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
 * Snapshot we push to the webview each refresh. Carries everything the
 * Details / Attachments / Logs tabs render. Built from parallel API calls
 * via Promise.allSettled — partial failures degrade individual sections
 * rather than blanking the panel.
 */
interface WorkItemSnapshot {
  // Header / state
  status: string;
  qa_verified: boolean;
  security_reviewed: boolean;
  // Details tab
  description: string;
  user_email: string;
  created_at: string;
  updated_at: string;
  target_branch: string;
  feature_name: string;
  claimed_by: string;
  priority: string;
  compliance_tags: VibeFlowComplianceTag[];
  // Attachments tab (count drives the tab label too)
  attachments: VibeFlowAttachment[];
  // Logs sub-tabs
  execution_logs: { content: string; message_type?: string; created_at: string }[];
  security_findings: VibeFlowComplianceFinding[];
  security_review?: VibeFlowSecurityReview;
}

/**
 * Manages Focus View Webview Panels for work item details.
 *
 * Tabs (Phase B): Details | Attachments | Logs.
 *  - Details: description (markdown), Timeline metadata, compliance tags.
 *  - Attachments: list with filename + size; upload/delete in Phase D.
 *  - Logs: sub-tabs Security Review (compliance findings) and Execution
 *    Logs (the existing log stream) with Auto-refresh + Refresh controls.
 *
 * Action toolbar lives above the tabs and gates buttons on the live
 * status / qa_verified / security_reviewed fields per the canonical
 * axiomcloud rules verified 2026-05-03.
 *
 * Phase C (Comment, Edit, Archive, Delete) and Phase D (attachment
 * upload/delete) plug into the same toolbar / Attachments tab.
 */
export class WorkItemPanelManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private projectId: number | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: VibeFlowClient,
    private readonly workItemsProvider: WorkItemsTreeProvider,
  ) {}

  /** Wire (or rewire) the active project. Compliance findings need it. */
  setProjectId(projectId: number | undefined): void {
    this.projectId = projectId;
  }

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
          await this.refreshSnapshot(item, panel);
          break;
        case 'qaVerify':
          await qaVerify(this.client, item.type, item.id, this.workItemsProvider);
          await this.refreshSnapshot(item, panel);
          break;
        case 'qaReject':
          await qaReject(this.client, item.type, item.id, this.workItemsProvider);
          await this.refreshSnapshot(item, panel);
          break;
        case 'securityApprove':
          await securityApprove(this.client, item.type, item.id, this.workItemsProvider);
          await this.refreshSnapshot(item, panel);
          break;
        case 'securityReject':
          await securityReject(this.client, item.type, item.id, this.workItemsProvider);
          await this.refreshSnapshot(item, panel);
          break;
        case 'refresh':
          await this.refreshSnapshot(item, panel);
          break;
      }
    });

    // Poll every 5s. Auto-refresh toggle in the webview only controls the
    // Execution Logs tail re-render — the snapshot itself always refreshes
    // so action visibility, attachment count, and finding list stay live.
    const timer = setInterval(() => this.refreshSnapshot(item, panel), 5000);
    this.pollTimers.set(key, timer);

    panel.onDidDispose(() => {
      this.panels.delete(key);
      const t = this.pollTimers.get(key);
      if (t) { clearInterval(t); this.pollTimers.delete(key); }
    });

    this.refreshSnapshot(item, panel);
  }

  /**
   * Build a fresh snapshot from the backend and post it to the webview.
   * Five parallel calls; each rejection is absorbed (we degrade the
   * specific section rather than the whole panel).
   */
  private async refreshSnapshot(item: WorkItemInfo, panel: vscode.WebviewPanel): Promise<void> {
    const [freshRes, attachmentsRes, logsRes, findingsRes, reviewRes] = await Promise.allSettled([
      item.type === 'todo' ? this.client.getTodo(item.id) : this.client.getIssue(item.id),
      this.client.listAttachments(item.type, item.id),
      this.client.getWorkItemLogs(item.type, item.id),
      this.projectId !== undefined
        ? this.client.listComplianceFindings(this.projectId, {
            work_item_type: item.type,
            work_item_id: item.id,
          })
        : Promise.resolve([] as VibeFlowComplianceFinding[]),
      this.client.getSecurityReview(item.type, item.id),
    ]);

    const fresh: VibeFlowTodo | VibeFlowIssue | undefined =
      freshRes.status === 'fulfilled' ? freshRes.value : undefined;

    const snapshot: WorkItemSnapshot = {
      status: fresh?.status ?? item.status,
      qa_verified: fresh?.qa_verified ?? false,
      security_reviewed: fresh?.security_reviewed ?? false,
      description: fresh?.description ?? '',
      user_email: fresh?.user_email ?? '',
      created_at: fresh?.created_at ?? '',
      updated_at: fresh?.updated_at ?? '',
      target_branch: fresh?.target_branch ?? '',
      feature_name: fresh?.feature_name ?? item.featureName ?? '',
      claimed_by: fresh?.claimed_by ?? item.claimedBy ?? '',
      priority: fresh?.priority ?? item.priority,
      compliance_tags: fresh?.compliance_tags ?? [],
      attachments: attachmentsRes.status === 'fulfilled' ? attachmentsRes.value : [],
      execution_logs: logsRes.status === 'fulfilled' ? logsRes.value : [],
      security_findings: findingsRes.status === 'fulfilled' ? findingsRes.value : [],
      security_review: reviewRes.status === 'fulfilled' ? reviewRes.value : undefined,
    };

    panel.webview.postMessage({ type: 'snapshot', payload: snapshot });
  }

  private getHtml(webview: vscode.Webview, item: WorkItemInfo): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: dark light; }
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px; margin: 0; }
    .header { padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    .header h1 { margin: 0 0 8px 0; font-size: 1.2em; }
    .meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 0.85em; color: var(--vscode-descriptionForeground); align-items: center; }
    .pill { padding: 1px 8px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.8em; }
    .tag { padding: 1px 8px; border-radius: 3px; background: var(--vscode-textBlockQuote-background); color: var(--vscode-foreground); font-size: 0.75em; border: 1px solid var(--vscode-panel-border); }
    .check { color: var(--vscode-terminal-ansiGreen); font-weight: 600; }

    /* Action toolbar above tabs */
    .toolbar { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
    .toolbar .group { display: flex; gap: 6px; align-items: center; }
    .toolbar .group-label { font-size: 0.75em; color: var(--vscode-descriptionForeground); margin-right: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
    button { padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em; }
    button[hidden] { display: none !important; }
    .btn-success { background: var(--vscode-terminal-ansiGreen); color: white; }
    .btn-danger { background: var(--vscode-errorForeground); color: white; }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-icon { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
    .btn-icon:hover { background: var(--vscode-toolbar-hoverBackground); }

    /* Tabs */
    .tabs { display: flex; gap: 0; margin-top: 16px; border-bottom: 1px solid var(--vscode-panel-border); }
    .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; font-size: 0.9em; }
    .tab.active { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
    .tab:not(.active) { color: var(--vscode-descriptionForeground); }
    .tab-content { display: none; padding: 16px 0; }
    .tab-content.active { display: block; }

    /* Sub-tabs (Logs) */
    .subtabs { display: flex; gap: 0; margin-bottom: 8px; }
    .subtab { padding: 4px 12px; cursor: pointer; font-size: 0.85em; color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; }
    .subtab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
    .log-controls { display: flex; gap: 12px; align-items: center; margin-left: auto; font-size: 0.85em; }
    .log-controls label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
    .log-header { display: flex; align-items: center; }

    /* Details tab */
    .details-grid { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 0.9em; margin-top: 12px; }
    .details-grid .label { color: var(--vscode-descriptionForeground); }
    .description { margin-top: 4px; padding: 12px; background: var(--vscode-textBlockQuote-background); border-radius: 4px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; max-height: 40vh; overflow-y: auto; }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 8px 0; font-size: 0.85em; }
    h2 { font-size: 1em; margin: 16px 0 8px 0; color: var(--vscode-foreground); }

    /* Logs */
    .logs { max-height: 50vh; overflow-y: auto; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
    .log-entry { padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border, transparent); white-space: pre-wrap; word-break: break-word; }
    .log-entry .time { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-right: 8px; }

    /* Findings */
    .finding { padding: 10px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 8px; }
    .finding-header { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .sev { padding: 1px 8px; border-radius: 3px; font-size: 0.7em; font-weight: 600; text-transform: uppercase; }
    .sev-critical { background: var(--vscode-errorForeground); color: white; }
    .sev-high { background: var(--vscode-charts-red, var(--vscode-errorForeground)); color: white; }
    .sev-medium { background: var(--vscode-charts-orange, var(--vscode-editorWarning-foreground)); color: white; }
    .sev-low { background: var(--vscode-charts-yellow, #d4a72c); color: black; }
    .sev-informational { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .finding-desc { margin-top: 6px; font-size: 0.9em; color: var(--vscode-descriptionForeground); white-space: pre-wrap; }

    /* Attachments */
    .attachment { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 4px; font-size: 0.9em; }
    .att-name { flex: 1; }
    .att-meta { color: var(--vscode-descriptionForeground); font-size: 0.8em; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${item.type} #${item.id}: ${escapeHtml(item.title)}</h1>
    <div class="meta">
      <span id="status-badge" class="pill">${escapeHtml(item.status)}</span>
      <span id="priority-meta">Priority: ${escapeHtml(item.priority)}</span>
      <span id="branch-meta" hidden></span>
      <span id="feature-meta" hidden></span>
      <span id="claimed-meta" hidden></span>
      <span id="qa-flag" class="check" hidden>✓ QA verified</span>
      <span id="security-flag" class="check" hidden>✓ Security reviewed</span>
      <span id="compliance-tags" style="display:flex;gap:4px;"></span>
    </div>

    <div class="toolbar">
      <div class="group">
        <span class="group-label">Status</span>
        <button class="btn-secondary" onclick="send('changeStatus')">Change…</button>
      </div>
      <div class="group">
        <span class="group-label">QA</span>
        <button id="btn-qa-verify" class="btn-success" onclick="send('qaVerify')" hidden>✓ QA Verify</button>
        <button id="btn-qa-reject" class="btn-danger" onclick="send('qaReject')" hidden>✕ QA Reject</button>
      </div>
      <div class="group">
        <span class="group-label">Security</span>
        <button id="btn-sec-verify" class="btn-success" onclick="send('securityApprove')" hidden>✓ Security Verify</button>
        <button id="btn-sec-reject" class="btn-danger" onclick="send('securityReject')" hidden>✕ Security Reject</button>
      </div>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="details">Details</div>
    <div class="tab" data-tab="attachments">Attachments <span id="attachments-count">0</span></div>
    <div class="tab" data-tab="logs">Logs</div>
  </div>

  <!-- Details -->
  <div id="tab-details" class="tab-content active">
    <h2>Description</h2>
    <div id="description" class="description empty">No description.</div>

    <h2>Timeline</h2>
    <div class="details-grid">
      <span class="label">Created</span>      <span id="meta-created"></span>
      <span class="label">Updated</span>      <span id="meta-updated"></span>
      <span class="label">Created by</span>   <span id="meta-user"></span>
      <span class="label">Claimed by</span>   <span id="meta-claimed"></span>
      <span class="label">Feature</span>      <span id="meta-feature"></span>
      <span class="label">Branch</span>       <span id="meta-branch"></span>
    </div>
  </div>

  <!-- Attachments -->
  <div id="tab-attachments" class="tab-content">
    <div id="attachments-list">
      <div class="empty">No attachments yet.</div>
    </div>
  </div>

  <!-- Logs -->
  <div id="tab-logs" class="tab-content">
    <div class="log-header">
      <div class="subtabs">
        <div class="subtab active" data-subtab="security">Security Review</div>
        <div class="subtab" data-subtab="execution">Execution Logs</div>
      </div>
      <div class="log-controls">
        <label>
          <input type="checkbox" id="auto-refresh" checked />
          Auto-refresh
        </label>
        <button class="btn-icon" onclick="send('refresh')">Refresh</button>
      </div>
    </div>
    <div id="subtab-security" class="subtab-content">
      <div id="security-summary" class="empty">No security review yet.</div>
      <div id="findings-list"></div>
    </div>
    <div id="subtab-execution" class="subtab-content" hidden>
      <div class="logs" id="execution-logs">
        <div class="empty">Loading…</div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function send(type, payload) { vscode.postMessage(payload ? { type, payload } : { type }); }

    // ----- Tab + sub-tab switching -----
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });
    document.querySelectorAll('.subtab').forEach(st => {
      st.addEventListener('click', () => {
        document.querySelectorAll('.subtab').forEach(s => s.classList.remove('active'));
        document.querySelectorAll('.subtab-content').forEach(c => { c.hidden = true; });
        st.classList.add('active');
        document.getElementById('subtab-' + st.dataset.subtab).hidden = false;
      });
    });

    // ----- Action visibility: mirrors axiomcloud TodoDetail/IssueDetail -----
    //  - QA Verify: status === 'done' && !qa_verified
    //  - QA Reject: status === 'done', text "Revoke QA" when qa_verified
    //  - Security Verify/Reject: extension-only, hidden once security_reviewed.
    function applyToolbar(snap) {
      const status = snap.status, qa = !!snap.qa_verified, sec = !!snap.security_reviewed;
      const qaVerifyBtn = document.getElementById('btn-qa-verify');
      const qaRejectBtn = document.getElementById('btn-qa-reject');
      if (status === 'done') {
        qaVerifyBtn.hidden = qa;
        qaRejectBtn.hidden = false;
        qaRejectBtn.textContent = qa ? '↩ Revoke QA' : '✕ QA Reject';
      } else {
        qaVerifyBtn.hidden = true;
        qaRejectBtn.hidden = true;
      }
      const secVerifyBtn = document.getElementById('btn-sec-verify');
      const secRejectBtn = document.getElementById('btn-sec-reject');
      secVerifyBtn.hidden = sec;
      secRejectBtn.hidden = sec;
    }

    function applyHeader(snap) {
      document.getElementById('status-badge').textContent = snap.status;
      document.getElementById('priority-meta').textContent = 'Priority: ' + snap.priority;

      const branch = document.getElementById('branch-meta');
      if (snap.target_branch) {
        branch.textContent = snap.target_branch;
        branch.className = 'tag';
        branch.hidden = false;
      } else { branch.hidden = true; }

      const feat = document.getElementById('feature-meta');
      if (snap.feature_name) {
        feat.textContent = 'Feature: ' + snap.feature_name;
        feat.hidden = false;
      } else { feat.hidden = true; }

      const claimed = document.getElementById('claimed-meta');
      if (snap.claimed_by) {
        claimed.textContent = 'Claimed: ' + snap.claimed_by;
        claimed.hidden = false;
      } else { claimed.hidden = true; }

      document.getElementById('qa-flag').hidden = !snap.qa_verified;
      document.getElementById('security-flag').hidden = !snap.security_reviewed;

      const tagsEl = document.getElementById('compliance-tags');
      tagsEl.innerHTML = (snap.compliance_tags || []).map(t =>
        '<span class="tag">' + escHtml((t.framework || '').toUpperCase()) + '</span>'
      ).join('');
    }

    function applyDetails(snap) {
      const desc = document.getElementById('description');
      if (snap.description && snap.description.trim()) {
        desc.textContent = snap.description;
        desc.classList.remove('empty');
      } else {
        desc.textContent = 'No description.';
        desc.classList.add('empty');
      }

      document.getElementById('meta-created').textContent = fmtDate(snap.created_at) || '—';
      document.getElementById('meta-updated').textContent = fmtDate(snap.updated_at) || '—';
      document.getElementById('meta-user').textContent = snap.user_email || '—';
      document.getElementById('meta-claimed').textContent = snap.claimed_by || '—';
      document.getElementById('meta-feature').textContent = snap.feature_name || '—';
      document.getElementById('meta-branch').textContent = snap.target_branch || '—';
    }

    function applyAttachments(snap) {
      const list = snap.attachments || [];
      document.getElementById('attachments-count').textContent = list.length;
      const el = document.getElementById('attachments-list');
      if (list.length === 0) {
        el.innerHTML = '<div class="empty">No attachments yet.</div>';
        return;
      }
      el.innerHTML = list.map(a => {
        const name = a.asset && a.asset.original_name ? a.asset.original_name : '(linked ' + a.attachment_type + ' #' + a.attachment_id + ')';
        const size = a.asset && a.asset.size ? humanSize(a.asset.size) : '';
        const ct = a.asset && a.asset.content_type ? a.asset.content_type : '';
        const meta = [size, ct].filter(Boolean).join(' · ');
        return '<div class="attachment">' +
          '<span class="att-name">' + escHtml(name) + '</span>' +
          (meta ? '<span class="att-meta">' + escHtml(meta) + '</span>' : '') +
        '</div>';
      }).join('');
    }

    function applyFindings(snap) {
      const findings = snap.security_findings || [];
      const review = snap.security_review;
      const summary = document.getElementById('security-summary');
      if (review) {
        summary.classList.remove('empty');
        summary.textContent = '✓ Reviewed ' + (fmtDate(review.created_at) || '') +
          (review.review_notes ? ' — ' + review.review_notes : '');
      } else if (findings.length === 0) {
        summary.classList.add('empty');
        summary.textContent = 'No security review yet.';
      } else {
        summary.classList.remove('empty');
        summary.textContent = findings.length + ' finding' + (findings.length === 1 ? '' : 's') + ' reported.';
      }
      const el = document.getElementById('findings-list');
      if (findings.length === 0) { el.innerHTML = ''; return; }
      el.innerHTML = findings.map(f => {
        const sev = (f.severity || 'informational').toLowerCase();
        const tags = (f.compliance_tags || []).map(t =>
          '<span class="tag">' + escHtml((t.framework || '').toUpperCase()) + '</span>'
        ).join(' ');
        const desc = f.description || '';
        const remed = f.remediation_notes ? '\\n\\nRemediation: ' + f.remediation_notes : '';
        return '<div class="finding">' +
          '<div class="finding-header">' +
            '<span class="sev sev-' + sev + '">' + sev + '</span>' +
            '<strong>' + escHtml(f.finding_type || 'Finding') + '</strong>' +
            '<span class="att-meta">' + escHtml(f.status || '') + '</span>' +
            tags +
          '</div>' +
          '<div class="finding-desc">' + escHtml(desc + remed) + '</div>' +
        '</div>';
      }).join('');
    }

    let lastExecutionLogs = '';
    function applyExecutionLogs(snap) {
      const logs = snap.execution_logs || [];
      // Honor the auto-refresh toggle: don't disturb the scroll position
      // while the user has it off, but DO render once if they just turned
      // it back on (lastExecutionLogs hash mismatch).
      const auto = document.getElementById('auto-refresh');
      const sig = JSON.stringify(logs.map(l => l.created_at + '|' + (l.content || '').length));
      if (!auto.checked && sig === lastExecutionLogs) { return; }
      lastExecutionLogs = sig;

      const el = document.getElementById('execution-logs');
      if (logs.length === 0) {
        el.innerHTML = '<div class="empty">No execution logs yet.</div>';
        return;
      }
      el.innerHTML = logs.map(log => {
        const time = new Date(log.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
        const icon = {thinking:'🤔',action:'⚡',observation:'👁',summary:'📋',diff:'📝',test_result:'🧪'}[log.message_type] || '📌';
        const lines = (log.content || '').split('\\n').slice(0, 5).join('\\n');
        return '<div class="log-entry"><span class="time">' + time + '</span>' + icon + ' ' + escHtml(lines) + '</div>';
      }).join('');
      el.scrollTop = el.scrollHeight;
    }

    // ----- Snapshot dispatch -----
    window.addEventListener('message', e => {
      if (e.data.type !== 'snapshot') { return; }
      const snap = e.data.payload;
      applyHeader(snap);
      applyToolbar(snap);
      applyDetails(snap);
      applyAttachments(snap);
      applyFindings(snap);
      applyExecutionLogs(snap);
    });

    // ----- Helpers -----
    function escHtml(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
    function fmtDate(s) {
      if (!s) { return ''; }
      const d = new Date(s);
      if (isNaN(d)) { return s; }
      return d.toLocaleString();
    }
    function humanSize(n) {
      if (n < 1024) { return n + ' B'; }
      if (n < 1024*1024) { return (n/1024).toFixed(1) + ' KB'; }
      if (n < 1024*1024*1024) { return (n/(1024*1024)).toFixed(1) + ' MB'; }
      return (n/(1024*1024*1024)).toFixed(2) + ' GB';
    }
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
