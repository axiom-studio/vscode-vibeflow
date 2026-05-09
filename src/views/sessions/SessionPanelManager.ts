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
 * Per-session chat cursor state for the embedded transcript (todo #1610 —
 * Chat-First Mode #1, MVP). Tracks the newest/oldest prompt ids the webview
 * has rendered so the next poll fetches with `after_id` (backfill) and the
 * "Load older" button pages with `before_id`. Mirrors axiomcloud's chat
 * cursor pattern in `VibeFlowSessions.jsx`.
 */
interface ChatCursor {
  newestId: number | null;
  oldestId: number | null;
  initialized: boolean;
}

/**
 * Page size for paginated chat-history loads. Matches axiomcloud's
 * `CHAT_PAGE_SIZE` constant in `VibeFlowSessions.jsx` (50). Server caps at 200.
 */
const CHAT_PAGE_SIZE = 50;

/**
 * Manages Focus View Webview Panels for individual agent sessions.
 * One panel per persona — clicking the same persona reuses the panel.
 *
 * The Progress Ledger is built by client-side correlation: we don't have a
 * `GET /sessions/{id}/logs` endpoint in the backend (axiomcloud confirmed,
 * 2026-05-02), so we list features → todos → issues, filter the ones whose
 * `claimedBy` matches the session id, and merge their logs by timestamp.
 *
 * The embedded Chat surface (todo #1610) reads from the same
 * `vibeflow_prompts` REST table axiomcloud's chat uses — user typing routes
 * via `client.createPrompt` (POST /prompts, source=user), agent → user
 * questions render with an inline reply form that hits `respondToPrompt`.
 * Polling reuses the existing 5s `refreshPanel` interval; WebSocket realtime
 * is deferred to todo #1612.
 */
export class SessionPanelManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private chatState = new Map<string, ChatCursor>();
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

    panel.webview.onDidReceiveMessage(async (msg: SessionPanelClientMessage) => {
      switch (msg.type) {
        case 'chatSend': {
          if (this.projectId === undefined) {
            this.postToWebview(panel, { type: 'chatError', payload: { message: 'Not connected to a project' } });
            break;
          }
          const text = msg.payload.text.trim();
          if (!text) { break; }
          try {
            const created = await this.client.createPrompt(this.projectId, session.session_id, text);
            this.postToWebview(panel, { type: 'chatAppend', payload: { messages: [created] } });
            const state = this.chatState.get(session.session_id);
            const nextNewest = state?.newestId != null && created.id <= state.newestId
              ? state.newestId
              : created.id;
            this.chatState.set(session.session_id, {
              newestId: nextNewest,
              oldestId: state?.oldestId ?? created.id,
              initialized: state?.initialized ?? true,
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.postToWebview(panel, { type: 'chatError', payload: { message: `Failed to send: ${errMsg}` } });
          }
          break;
        }
        case 'chatRespond': {
          if (this.projectId === undefined) { break; }
          const trimmed = msg.payload.text.trim();
          if (!trimmed) { break; }
          try {
            await this.client.respondToPrompt(this.projectId, msg.payload.promptId, trimmed);
            // Next 5s poll surfaces the responded status; transcript will
            // re-render the message with response_text inline.
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.postToWebview(panel, { type: 'chatError', payload: { message: `Failed to respond: ${errMsg}` } });
          }
          break;
        }
        case 'chatLoadOlder': {
          if (this.projectId === undefined) { break; }
          const state = this.chatState.get(session.session_id);
          if (!state || state.oldestId === null) { break; }
          try {
            const resp = await this.client.listSessionPrompts(this.projectId, session.session_id, {
              before_id: state.oldestId,
              limit: CHAT_PAGE_SIZE,
            });
            if (resp.prompts.length > 0) {
              this.chatState.set(session.session_id, {
                newestId: state.newestId,
                oldestId: resp.page.oldest_id ?? state.oldestId,
                initialized: state.initialized,
              });
              this.postToWebview(panel, {
                type: 'chatPrepend',
                payload: { messages: resp.prompts, hasMore: resp.page.has_more },
              });
            } else {
              this.postToWebview(panel, {
                type: 'chatPrepend',
                payload: { messages: [], hasMore: false },
              });
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.postToWebview(panel, { type: 'chatError', payload: { message: `Failed to load older: ${errMsg}` } });
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

    // Poll for updates every 5s — both work-item logs AND chat backfill.
    const timer = setInterval(() => this.refreshPanel(session, panel), 5000);
    this.pollTimers.set(key, timer);

    panel.onDidDispose(() => {
      this.panels.delete(key);
      this.chatState.delete(key);
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

    const [logs] = await Promise.all([
      this.collectSessionLogs(this.projectId, session.session_id),
      this.pollChatUpdates(this.projectId, session.session_id, panel),
    ]);
    this.postToWebview(panel, { type: 'update', payload: { session, logs } });
  }

  /**
   * Fetch chat messages for the session, dispatching the right host
   * message based on whether this is the initial load or a backfill cycle.
   * Cursor state lives in `chatState`, keyed by `session.session_id`.
   *
   * Initial cycle: fetch the latest CHAT_PAGE_SIZE messages, replace
   * transcript. Backfill cycle: fetch with `after_id = state.newestId`,
   * append any new. Empty-transcript edge: re-fetch latest each tick until
   * a message arrives, then transition to backfill mode.
   *
   * Failures are absorbed (state stays as it was) — chat polling is
   * non-critical UX and must not break the Progress Ledger refresh.
   */
  private async pollChatUpdates(projectId: number, sessionId: string, panel: vscode.WebviewPanel): Promise<void> {
    const state = this.chatState.get(sessionId);
    try {
      if (!state || !state.initialized) {
        const resp = await this.client.listSessionPrompts(projectId, sessionId, { limit: CHAT_PAGE_SIZE });
        this.chatState.set(sessionId, {
          newestId: resp.page.newest_id,
          oldestId: resp.page.oldest_id,
          initialized: true,
        });
        this.postToWebview(panel, {
          type: 'chatTranscript',
          payload: { messages: resp.prompts, hasMore: resp.page.has_more },
        });
      } else if (state.newestId !== null) {
        const resp = await this.client.listSessionPrompts(projectId, sessionId, {
          after_id: state.newestId,
          limit: 200,
        });
        if (resp.prompts.length > 0) {
          this.chatState.set(sessionId, {
            newestId: resp.page.newest_id ?? state.newestId,
            oldestId: state.oldestId ?? resp.page.oldest_id,
            initialized: true,
          });
          this.postToWebview(panel, { type: 'chatAppend', payload: { messages: resp.prompts } });
        }
      } else {
        // Initialized but transcript was empty — re-poll for first arrivals.
        const resp = await this.client.listSessionPrompts(projectId, sessionId, { limit: CHAT_PAGE_SIZE });
        if (resp.prompts.length > 0) {
          this.chatState.set(sessionId, {
            newestId: resp.page.newest_id,
            oldestId: resp.page.oldest_id,
            initialized: true,
          });
          this.postToWebview(panel, {
            type: 'chatTranscript',
            payload: { messages: resp.prompts, hasMore: resp.page.has_more },
          });
        }
      }
    } catch {
      // Absorb — chat is non-critical, we'll retry on the next 5s tick.
    }
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
    .logs { max-height: 30vh; overflow-y: auto; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
    .log-entry { padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border, transparent); white-space: pre-wrap; word-break: break-word; }
    .log-entry .time { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-right: 8px; }
    .log-entry .src { font-size: 0.8em; padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 6px; }
    .actions { display: flex; gap: 8px; margin-top: 16px; }
    .actions button { padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9em; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-danger { background: var(--vscode-errorForeground); color: white; }
    /* Chat — todo #1610 (Chat-First Mode #1, MVP). Wire-shape parity with axiomcloud's VibeFlowSessions.jsx. */
    .vf-chat { display: flex; flex-direction: column; max-height: 50vh; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
    .vf-chat-load-older { padding: 6px; text-align: center; border-bottom: 1px solid var(--vscode-panel-border); }
    .vf-chat-load-older button { background: transparent; color: var(--vscode-textLink-foreground); border: none; cursor: pointer; font-size: 0.85em; padding: 2px 8px; }
    .vf-chat-log { flex: 1; overflow-y: auto; padding: 8px; min-height: 120px; }
    .vf-chat-empty { color: var(--vscode-descriptionForeground); text-align: center; padding: 24px; font-size: 0.9em; }
    .vf-chat-msg { margin-bottom: 12px; }
    .vf-chat-msg-header { display: flex; align-items: center; gap: 6px; font-size: 0.85em; margin-bottom: 2px; }
    .vf-chat-msg-author { font-weight: 600; }
    .vf-chat-msg-time { color: var(--vscode-descriptionForeground); }
    .vf-chat-msg-status { font-size: 0.75em; padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .vf-chat-msg-body { padding: 6px 10px; border-radius: 4px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); white-space: pre-wrap; word-break: break-word; }
    .vf-chat-msg-user .vf-chat-msg-body { background: var(--vscode-list-activeSelectionBackground); }
    .vf-chat-msg-response { margin-top: 6px; padding: 6px 10px; border-radius: 4px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-textLink-foreground); white-space: pre-wrap; word-break: break-word; font-size: 0.95em; }
    .vf-chat-msg-reply-form { margin-top: 6px; display: flex; gap: 6px; }
    .vf-chat-msg-reply-form input { flex: 1; padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; font-family: inherit; font-size: 0.9em; }
    .vf-chat-msg-reply-form button { padding: 4px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; font-size: 0.85em; }
    .vf-chat-input-bar { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); align-items: flex-end; }
    .vf-chat-textarea { flex: 1; min-height: 36px; max-height: 120px; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; font-family: inherit; font-size: 0.9em; resize: vertical; }
    .vf-chat-send { padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; font-size: 0.9em; }
    .vf-chat-send:disabled { opacity: 0.6; cursor: not-allowed; }
    .vf-chat-error { margin: 6px 8px; padding: 6px 10px; background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.08)); color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground)); border-radius: 3px; font-size: 0.85em; }
  </style>
</head>
<body data-persona-label="${escapeHtml(personaName)}">
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

  <div class="section">
    <h2>Chat</h2>
    <div class="vf-chat">
      <div class="vf-chat-load-older" id="vf-chat-load-older" style="display: none;">
        <button data-action="chatLoadOlder">Load older</button>
      </div>
      <div class="vf-chat-log" id="vf-chat-log">
        <div class="vf-chat-empty">No messages yet. Send the first prompt below.</div>
      </div>
      <div id="vf-chat-error" style="display: none;" class="vf-chat-error"></div>
      <div class="vf-chat-input-bar">
        <textarea class="vf-chat-textarea" id="vf-chat-textarea" placeholder="Type a message — Cmd/Ctrl+Enter to send"></textarea>
        <button class="vf-chat-send" id="vf-chat-send" data-action="chatSend">Send</button>
      </div>
    </div>
  </div>

  <div class="actions">
    <button class="btn-danger" data-action="stop">Stop Session</button>
    <button class="btn-secondary" data-action="refresh">Refresh</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const personaLabel = document.body.dataset.personaLabel || 'Agent';
    const userLabel = 'You';

    // Inline onclick="" handlers are blocked by the panel's strict CSP
    // (script-src 'nonce-...' without 'unsafe-inline'). All buttons use
    // data-action plus a single delegated listener — same pattern as #1960.
    document.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) { return; }
      const btn = target.closest('[data-action]');
      if (!(btn instanceof HTMLElement)) { return; }
      const action = btn.dataset.action;
      if (!action) { return; }
      if (action === 'chatSend') {
        e.preventDefault();
        sendChat();
      } else if (action === 'chatRespond') {
        e.preventDefault();
        const form = btn.closest('.vf-chat-msg-reply-form');
        if (!(form instanceof HTMLElement)) { return; }
        const promptId = form.dataset.promptId;
        const input = form.querySelector('input');
        if (!promptId || !(input instanceof HTMLInputElement)) { return; }
        const text = input.value.trim();
        if (!text) { return; }
        vscode.postMessage({ type: 'chatRespond', payload: { promptId, text } });
        input.value = '';
        if (btn instanceof HTMLButtonElement) { btn.disabled = true; }
      } else if (action === 'chatLoadOlder') {
        e.preventDefault();
        if (chatOldestId !== null) {
          vscode.postMessage({ type: 'chatLoadOlder', payload: { beforeId: chatOldestId } });
        }
      } else {
        // Forward stop / refresh as bare-type messages.
        vscode.postMessage({ type: action });
      }
    });

    // Cmd/Ctrl+Enter sends from the textarea.
    const textarea = document.getElementById('vf-chat-textarea');
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          sendChat();
        }
      });
    }

    function sendChat() {
      const ta = document.getElementById('vf-chat-textarea');
      if (!(ta instanceof HTMLTextAreaElement)) { return; }
      const text = ta.value.trim();
      if (!text) { return; }
      vscode.postMessage({ type: 'chatSend', payload: { text } });
      ta.value = '';
    }

    // Webview-side cursor mirrors the host's chatState — only oldest is
    // needed here for the "Load older" button payload.
    let chatOldestId = null;
    let chatHasMore = false;

    function escHtml(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
    function fmtTime(iso) {
      try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
      catch (_) { return ''; }
    }

    function renderMessage(m) {
      const isAgent = m.source === 'agent';
      const author = isAgent ? personaLabel : userLabel;
      const cls = 'vf-chat-msg ' + (isAgent ? 'vf-chat-msg-agent' : 'vf-chat-msg-user');
      const status = (isAgent && m.status === 'pending') ? '<span class="vf-chat-msg-status">awaiting reply</span>' : '';
      let body = '<div class="vf-chat-msg-body">' + escHtml(m.prompt_text) + '</div>';
      if (m.response_text) {
        body += '<div class="vf-chat-msg-response">' + escHtml(m.response_text) + '</div>';
      } else if (isAgent && m.status === 'pending') {
        body += '<div class="vf-chat-msg-reply-form" data-prompt-id="' + escHtml(m.prompt_id) + '">' +
          '<input type="text" placeholder="Reply..." />' +
          '<button type="button" data-action="chatRespond">Reply</button>' +
          '</div>';
      }
      return '<div class="' + cls + '" data-msg-id="' + escHtml(m.id) + '">' +
        '<div class="vf-chat-msg-header">' +
          '<span class="vf-chat-msg-author">' + escHtml(author) + '</span>' +
          '<span class="vf-chat-msg-time">' + escHtml(fmtTime(m.created_at)) + '</span>' +
          status +
        '</div>' + body + '</div>';
    }

    function setLoadOlderVisible(visible) {
      const el = document.getElementById('vf-chat-load-older');
      if (el) { el.style.display = visible ? '' : 'none'; }
    }

    function showChatError(message) {
      const el = document.getElementById('vf-chat-error');
      if (!el) { return; }
      el.textContent = message;
      el.style.display = '';
    }

    function clearChatError() {
      const el = document.getElementById('vf-chat-error');
      if (el) { el.style.display = 'none'; }
    }

    function renderTranscript(messages, hasMore) {
      const log = document.getElementById('vf-chat-log');
      if (!log) { return; }
      if (messages.length === 0) {
        log.innerHTML = '<div class="vf-chat-empty">No messages yet. Send the first prompt below.</div>';
      } else {
        log.innerHTML = messages.map(renderMessage).join('');
        log.scrollTop = log.scrollHeight;
      }
      chatOldestId = messages.length > 0 ? Number(messages[0].id) : null;
      chatHasMore = !!hasMore;
      setLoadOlderVisible(chatHasMore);
    }

    function appendMessages(messages) {
      const log = document.getElementById('vf-chat-log');
      if (!log) { return; }
      const empty = log.querySelector('.vf-chat-empty');
      if (empty) { log.innerHTML = ''; }
      const html = messages.map(renderMessage).join('');
      log.insertAdjacentHTML('beforeend', html);
      log.scrollTop = log.scrollHeight;
    }

    function prependMessages(messages, hasMore) {
      const log = document.getElementById('vf-chat-log');
      if (!log) { return; }
      const prevScrollHeight = log.scrollHeight;
      const html = messages.map(renderMessage).join('');
      log.insertAdjacentHTML('afterbegin', html);
      // Preserve scroll anchor — keep the user looking at the same message
      // they were on before the prepend grew the document.
      log.scrollTop = log.scrollHeight - prevScrollHeight;
      if (messages.length > 0) {
        chatOldestId = Number(messages[0].id);
      }
      chatHasMore = !!hasMore;
      setLoadOlderVisible(chatHasMore);
    }

    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.type === 'update' && msg.payload && msg.payload.logs) {
        const logsEl = document.getElementById('logs');
        if (!logsEl) { return; }
        if (msg.payload.logs.length === 0) {
          logsEl.innerHTML = '<div style="color: var(--vscode-descriptionForeground); padding: 16px; text-align: center;">No logs yet</div>';
          return;
        }
        logsEl.innerHTML = msg.payload.logs.map(log => {
          const time = fmtTime(log.created_at);
          const icon = { thinking:'🤔', action:'⚡', observation:'👁', summary:'📋', diff:'📝', test_result:'🧪' }[log.message_type] || '📌';
          const lines = String(log.content || '').split('\\n').slice(0, 5).join('\\n');
          const src = log.source ? ('<span class="src">' + log.source.type + ' #' + log.source.id + '</span>') : '';
          return '<div class="log-entry"><span class="time">' + escHtml(time) + '</span>' + src + ' ' + icon + ' ' + escHtml(lines) + '</div>';
        }).join('');
        logsEl.scrollTop = logsEl.scrollHeight;
      } else if (msg.type === 'chatTranscript') {
        clearChatError();
        renderTranscript(msg.payload.messages, msg.payload.hasMore);
      } else if (msg.type === 'chatAppend') {
        clearChatError();
        appendMessages(msg.payload.messages);
      } else if (msg.type === 'chatPrepend') {
        clearChatError();
        prependMessages(msg.payload.messages, msg.payload.hasMore);
      } else if (msg.type === 'chatError') {
        showChatError(msg.payload.message);
      }
    });
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
    this.chatState.clear();
  }
}
