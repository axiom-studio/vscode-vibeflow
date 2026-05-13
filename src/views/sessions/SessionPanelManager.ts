import * as vscode from 'vscode';
import * as path from 'path';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowSession, VibeFlowTodo, VibeFlowIssue, VibeFlowPrompt } from '../../api/types.js';
import { getNonce } from '../../utils/nonce.js';
import { escapeHtml } from '../../utils/html.js';
import { assertNever, type SessionPanelClientMessage, type SessionPanelHostMessage } from '../../core/webviewMessages.js';
import type { SessionStreamRegistry } from '../../sessions/SessionStreamRegistry.js';
import type { NormalizedAgentEvent } from '../../sessions/providerAdapters/types.js';
import { parsePathReference, isValidCommitHash } from './chatRenderer.js';

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
   * Set of session ids that currently have a live stream-json subscription
   * (todo #1620). When live, the panel skips REST backfill polling for
   * THAT session — chat events come from the local stream tail instead.
   * Initial transcript fetch still uses REST (history before stream
   * started).
   */
  private streamLive = new Set<string>();
  /**
   * Pending `prompt_user` tool_use events waiting on a matching
   * `tool_result` to resolve the server-assigned `prompt_id`. Indexed
   * by `toolUseId`. Once the result arrives, we synthesize a
   * VibeFlowPrompt with the canonical prompt_id and chatAppend it.
   */
  private pendingPromptUser = new Map<string, { sessionId: string; promptText: string }>();
  /**
   * Subscriptions to the stream registry — disposed when the panel
   * manager itself is disposed.
   */
  private streamSubscriptions: vscode.Disposable[] = [];

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
    private readonly streamRegistry?: SessionStreamRegistry,
  ) {
    if (this.streamRegistry) {
      this.streamSubscriptions.push(
        this.streamRegistry.onEvent(payload => this.handleStreamEvent(payload)),
        this.streamRegistry.onExit(payload => this.handleStreamExit(payload)),
      );
    }
  }

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

    // If a stream for this session is already live (e.g., the agent
    // started before the panel opened), mark it so pollChatUpdates
    // skips REST backfill once the initial transcript is fetched.
    if (this.streamRegistry?.getBySessionId(key)) {
      this.streamLive.add(key);
    }

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
        case 'chatOpenPath': {
          // Defensive re-validation: the webview tokenizer emitted this,
          // but treat the message payload as untrusted and re-parse via
          // the same pure function before resolving (todo #1613, #4-2).
          const parsed = parsePathReference(`${msg.payload.path}${msg.payload.line ? `:${msg.payload.line}${msg.payload.column ? `:${msg.payload.column}` : ''}` : ''}`);
          if (!parsed) { break; }
          await this.openWorkspaceRelativePath(parsed.path, parsed.line, parsed.column);
          break;
        }
        case 'chatOpenCommit': {
          // Defensive re-validation (todo #1613, #4-5).
          if (!isValidCommitHash(msg.payload.hash)) { break; }
          await this.openCommitDiff(msg.payload.hash);
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
        // Initial transcript fetch always uses REST — the stream-json
        // tail only sees events from when it started; history before
        // that comes from the server. After this fetch, we mark the
        // panel initialized and (if a stream is live for this session)
        // hand new-event delivery off to the local stream.
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
      } else if (this.streamLive.has(sessionId)) {
        // Stream is driving new events sub-millisecond — skip the
        // REST backfill poll. If the stream dies, handleStreamExit
        // clears `streamLive` and the next tick falls through to the
        // after_id branch below.
        return;
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
   * Pre-populate the chat textarea of a session's panel. Used by the
   * `vibeflow.chat.askSelection` command (todo #1613, sub-feature 1)
   * to seed a fenced-code-block prompt from an editor selection. If
   * the panel isn't open, opens it first. Returns false if no
   * session is available to receive the prefill.
   */
  prefillChat(sessionId: string, text: string): boolean {
    const panel = this.panels.get(sessionId);
    if (!panel) { return false; }
    panel.reveal();
    this.postToWebview(panel, { type: 'chatPrefill', payload: { text, focus: true } });
    return true;
  }

  /**
   * Return the session ids of every currently-open chat panel.
   * Used by the askSelection command to pick a target when more
   * than one panel is open (todo #1613).
   */
  getOpenSessionIds(): string[] {
    return Array.from(this.panels.keys());
  }

  /**
   * Resolve a workspace-relative path against the active workspace
   * folder and open it at the given line/column (1-indexed in the
   * payload, converted to 0-indexed `Position` for VS Code). If no
   * workspace is open, falls back to opening as an absolute path
   * only if it resolves cleanly inside the editor's known roots
   * (defense-in-depth — never let a chat message open `/etc/passwd`).
   *
   * Failures surface as a notification, NOT a thrown exception, so
   * a malformed agent message doesn't break the panel.
   */
  private async openWorkspaceRelativePath(rel: string, line?: number, column?: number): Promise<void> {
    if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
      // Absolute path — reject. Only workspace-relative is allowed.
      // (A real path inside `/Users/...` could still be opened via
      // the user's own File → Open; we just don't follow links to
      // arbitrary disk locations from chat messages.)
      vscode.window.showWarningMessage(`Chat link rejected (absolute path): ${rel}`);
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage('Open a folder to follow chat links.');
      return;
    }
    const absolute = path.join(folder.uri.fsPath, rel);
    // Containment check: the joined path must still be inside the
    // workspace folder. `path.relative` of an escape attempt
    // (e.g. `../../etc/passwd`) returns a path starting with `..`.
    const relCheck = path.relative(folder.uri.fsPath, absolute);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      vscode.window.showWarningMessage(`Chat link rejected (escapes workspace): ${rel}`);
      return;
    }
    const uri = vscode.Uri.file(absolute);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      if (line && line > 0) {
        const zeroLine = Math.max(0, line - 1);
        const zeroCol = column && column > 0 ? Math.max(0, column - 1) : 0;
        const pos = new vscode.Position(zeroLine, zeroCol);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`Could not open ${rel}: ${msg}`);
    }
  }

  /**
   * Open a git commit diff via VS Code's built-in `git.viewChange`
   * command (the Source Control extension registers it). Falls back
   * to showing the commit details in a Quick Pick + offering a
   * terminal command if the git extension isn't available.
   *
   * Hash is validated upstream via `isValidCommitHash` — we still
   * pass it as an arg (never interpolated into a shell command).
   */
  private async openCommitDiff(hash: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage('Open a folder to view commit diffs.');
      return;
    }
    // Try VS Code git extension API first.
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (gitExt) {
      try {
        const api = (gitExt.isActive ? gitExt.exports : await gitExt.activate())?.getAPI?.(1);
        const repo = api?.repositories?.find((r: { rootUri: { fsPath: string } }) => r.rootUri.fsPath === folder.uri.fsPath);
        if (repo) {
          // The built-in `git.viewCommit` command renders a commit's
          // tree of changed files. Args shape: (repository, hash).
          await vscode.commands.executeCommand('git.viewCommit', repo, hash);
          return;
        }
      } catch {
        // Fall through to the terminal fallback.
      }
    }
    // Fallback: surface a Quick Pick with the diff command.
    const pick = await vscode.window.showInformationMessage(
      `Show diff for commit ${hash.slice(0, 8)}?`,
      'Open in terminal',
      'Cancel',
    );
    if (pick === 'Open in terminal') {
      const term = vscode.window.createTerminal({ name: `git show ${hash.slice(0, 8)}`, cwd: folder.uri.fsPath });
      // Hash is validated; still pass via shell-quoting discipline
      // (no interpolation of arbitrary user input).
      term.sendText(`git show --stat ${hash}`, true);
      term.show();
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Stream-json subscription (todo #1620, doc #285).
  //
  // For chat-first / headless sessions, the agent CLI runs in
  // stream-json mode under SessionStreamRegistry's lifetime. We tail
  // its `tool_use` and `tool_result` events to render chat content
  // sub-millisecond after the agent emits it — bypassing the 5s REST
  // polling cadence WITHOUT bypassing the server (every tool_use is
  // ALSO a network call to cloud.axiomstudio.ai, which is what
  // populates the canonical vibeflow_prompts row that axiomcloud's
  // web UI reads. We just learn about it earlier via the local pipe).
  //
  // De-duplication strategy: when a session has a live stream, REST
  // backfill polling for THAT session is paused (see `pollChatUpdates`
  // below). Initial transcript fetch still uses REST (history before
  // the stream started). When the stream dies, REST polling resumes
  // automatically on the next tick.
  // ─────────────────────────────────────────────────────────────────────

  private handleStreamEvent(payload: {
    agentSessionId?: string;
    event: NormalizedAgentEvent;
  }): void {
    if (!payload.agentSessionId) { return; }
    const sessionId = payload.agentSessionId;

    // Mark stream live on first session_init event we see.
    if (payload.event.kind === 'session_init') {
      this.streamLive.add(sessionId);
    }

    const panel = this.panels.get(sessionId);
    if (!panel) {
      // Panel for this session isn't open yet. Stream events still arrive
      // — when the panel opens later, it'll pick up state via the
      // initial REST fetch in `pollChatUpdates`. Drop the event here
      // (the AgentActivityOutputChannel still renders it for the
      // Output channel).
      return;
    }

    const event = payload.event;

    if (event.kind === 'tool_use') {
      if (event.toolName === 'prompt_user') {
        // Hold the prompt_text until the matching tool_result arrives
        // with the server-assigned prompt_id. Typical latency:
        // 100-500ms (one MCP roundtrip).
        const input = event.input as { prompt_text?: string } | null | undefined;
        const promptText = typeof input?.prompt_text === 'string' ? input.prompt_text : '';
        if (promptText) {
          this.pendingPromptUser.set(event.toolUseId, { sessionId, promptText });
        }
      } else if (event.toolName === 'respond_to_prompt') {
        const input = event.input as { prompt_id?: string; response_text?: string } | null | undefined;
        if (typeof input?.prompt_id === 'string') {
          this.postToWebview(panel, {
            type: 'chatAppend',
            payload: {
              messages: [this.synthesizeFromRespondToPrompt(sessionId, input)],
            },
          });
        }
      }
    } else if (event.kind === 'tool_result') {
      const pending = this.pendingPromptUser.get(event.toolUseId);
      if (pending) {
        this.pendingPromptUser.delete(event.toolUseId);
        const promptId = this.extractPromptIdFromToolResult(event.content);
        if (promptId) {
          this.postToWebview(panel, {
            type: 'chatAppend',
            payload: {
              messages: [this.synthesizeFromPromptUser(pending.sessionId, promptId, pending.promptText)],
            },
          });
        }
      }
    }
    // Other event kinds (agent_text, api_retry, turn_complete, error,
    // unknown) flow only to the AgentActivityOutputChannel — they are
    // operational narration, not chat content.
  }

  private handleStreamExit(payload: { agentSessionId?: string }): void {
    if (!payload.agentSessionId) { return; }
    this.streamLive.delete(payload.agentSessionId);
    // Clear any pending tool_use entries for this session — the
    // tool_result will never arrive.
    for (const [toolUseId, pending] of this.pendingPromptUser) {
      if (pending.sessionId === payload.agentSessionId) {
        this.pendingPromptUser.delete(toolUseId);
      }
    }
    // Surface a soft notice so the user knows realtime is down.
    // Polling automatically resumes on the next refreshPanel tick.
    const panel = this.panels.get(payload.agentSessionId);
    if (panel) {
      this.postToWebview(panel, {
        type: 'chatError',
        payload: { message: 'Agent stream closed — falling back to 5s polling. Relaunch the session for realtime.' },
      });
    }
  }

  private synthesizeFromPromptUser(sessionId: string, promptId: string, promptText: string): VibeFlowPrompt {
    const now = new Date().toISOString();
    return {
      id: -1, // canonical id arrives via REST polling later (if the panel ever falls back)
      created_at: now,
      updated_at: now,
      organization_id: '',
      project_id: this.projectId ?? 0,
      session_id: sessionId,
      prompt_id: promptId,
      prompt_text: promptText,
      response_text: '',
      status: 'pending',
      responded_at: null,
      source: 'agent',
    };
  }

  private synthesizeFromRespondToPrompt(
    sessionId: string,
    input: { prompt_id?: string; response_text?: string },
  ): VibeFlowPrompt {
    const now = new Date().toISOString();
    return {
      id: -1,
      created_at: now,
      updated_at: now,
      organization_id: '',
      project_id: this.projectId ?? 0,
      session_id: sessionId,
      prompt_id: input.prompt_id ?? '',
      prompt_text: '', // the original user→agent prompt text isn't in this tool_use; REST polling fills it
      response_text: typeof input.response_text === 'string' ? input.response_text : '',
      status: 'responded',
      responded_at: now,
      source: 'user', // we're seeing a response to a user→agent prompt
    };
  }

  /**
   * Tool-result content shape varies by provider; we look for a
   * `prompt_id` field in common locations. Returns undefined if the
   * tool didn't return one (in which case the chat-append is dropped
   * — REST polling at 5s will surface it eventually).
   */
  private extractPromptIdFromToolResult(content: unknown): string | undefined {
    if (!content) { return undefined; }
    if (typeof content === 'string') {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        return typeof parsed.prompt_id === 'string' ? parsed.prompt_id : undefined;
      } catch { return undefined; }
    }
    if (typeof content === 'object') {
      const obj = content as Record<string, unknown>;
      if (typeof obj.prompt_id === 'string') { return obj.prompt_id; }
      // Some providers wrap the result in a content-blocks array.
      const blocks = (obj as { content?: unknown }).content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (typeof block === 'object' && block !== null) {
            const b = block as Record<string, unknown>;
            if (typeof b.text === 'string') {
              try {
                const parsed = JSON.parse(b.text) as Record<string, unknown>;
                if (typeof parsed.prompt_id === 'string') { return parsed.prompt_id; }
              } catch { /* skip non-JSON block */ }
            }
          }
        }
      }
    }
    return undefined;
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
    // Workspace folder fsPath for drag-to-attach path normalization
    // (todo #1613, sub-feature 3). The webview converts dropped file
    // URIs into workspace-relative paths when they fall inside this
    // folder; absolute paths are kept as-is. Empty string when no
    // folder is open (drag-to-attach degrades to filename-only).
    const workspaceFsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

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
    /* IDE-superpower segment styles (todo #1613). All renderers
       html-escape segment content before insertion — these styles
       only affect the wrapper tag chosen by the tokenizer. */
    .vf-chat-msg-body pre { margin: 6px 0; padding: 8px 10px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1)); border-radius: 3px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
    .vf-chat-msg-body pre code { background: transparent; padding: 0; }
    .vf-chat-msg-body code { padding: 1px 4px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
    .vf-chat-msg-body a.vf-chat-path, .vf-chat-msg-body a.vf-chat-commit { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
    .vf-chat-msg-body a.vf-chat-path:hover, .vf-chat-msg-body a.vf-chat-commit:hover { text-decoration: underline; }
    .vf-chat-msg-body a.vf-chat-commit { font-family: var(--vscode-editor-font-family); }
    /* Drag-to-attach drop-target highlight (todo #1613, #4-3) */
    .vf-chat-input-bar.vf-drop-target { outline: 2px dashed var(--vscode-focusBorder); outline-offset: -2px; }
  </style>
</head>
<body data-persona-label="${escapeHtml(personaName)}" data-workspace-folder="${escapeHtml(workspaceFsPath)}">
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
      } else if (action === 'chatOpenPath') {
        e.preventDefault();
        const p = btn.dataset.path;
        if (!p) { return; }
        const line = btn.dataset.line ? Number(btn.dataset.line) : undefined;
        const column = btn.dataset.column ? Number(btn.dataset.column) : undefined;
        vscode.postMessage({ type: 'chatOpenPath', payload: { path: p, line, column } });
      } else if (action === 'chatOpenCommit') {
        e.preventDefault();
        const h = btn.dataset.hash;
        if (!h) { return; }
        vscode.postMessage({ type: 'chatOpenCommit', payload: { hash: h } });
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

    // Drag-to-attach (todo #1613, sub-feature 3). Drops on the
    // input bar insert markdown references at the textarea cursor:
    //   [filename](workspace-relative-path)
    // The agent reads via its own tools — no upload, no MCP
    // roundtrip, no attachment table mutation. We are already
    // local; the agent has the same filesystem view.
    //
    // VS Code Explorer drops deliver paths via the
    // text/uri-list MIME (one URI per line). Falls back to
    // text/plain when the source uses that instead.
    const workspaceFolder = document.body.dataset.workspaceFolder || '';
    const inputBar = document.querySelector('.vf-chat-input-bar');
    if (inputBar instanceof HTMLElement) {
      inputBar.addEventListener('dragover', (e) => {
        // Required to allow drop.
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'link';
          e.preventDefault();
          inputBar.classList.add('vf-drop-target');
        }
      });
      inputBar.addEventListener('dragleave', () => {
        inputBar.classList.remove('vf-drop-target');
      });
      inputBar.addEventListener('drop', (e) => {
        e.preventDefault();
        inputBar.classList.remove('vf-drop-target');
        if (!e.dataTransfer) { return; }
        const uriList = e.dataTransfer.getData('text/uri-list');
        const plain = e.dataTransfer.getData('text/plain');
        const raw = uriList || plain;
        if (!raw) { return; }
        const lines = raw.split(/\\r?\\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
        const refs = lines.map(line => buildPathReference(line, workspaceFolder)).filter(Boolean);
        if (refs.length === 0) { return; }
        insertAtCursor(refs.join(' '));
      });
    }

    function buildPathReference(line, workspace) {
      let fsPath = line;
      // file:// URI handling. URI decode (percent-escapes for spaces etc).
      if (fsPath.startsWith('file://')) {
        try { fsPath = decodeURIComponent(fsPath.replace(/^file:\\/\\//, '')); }
        catch (_) { return ''; }
      }
      // Strip Windows drive-letter normalization quirk: file:///C:/foo
      // decodes to /C:/foo — drop the leading slash if followed by
      // drive-letter.
      if (/^\\/[A-Za-z]:/.test(fsPath)) { fsPath = fsPath.slice(1); }
      // Make workspace-relative when inside the workspace folder.
      let display = fsPath;
      if (workspace && fsPath.startsWith(workspace + '/')) {
        display = fsPath.slice(workspace.length + 1);
      } else if (workspace && fsPath === workspace) {
        display = '.';
      }
      // Basename for the markdown link label.
      const slash = display.lastIndexOf('/');
      const base = slash >= 0 ? display.slice(slash + 1) : display;
      if (!base) { return ''; }
      // Escape closing brackets so the link parser doesn't break on
      // paths containing ']' (rare but possible).
      const label = base.replace(/\\]/g, '\\\\]');
      const href = display.replace(/\\)/g, '\\\\)');
      return '[' + label + '](' + href + ')';
    }

    function insertAtCursor(text) {
      const ta = document.getElementById('vf-chat-textarea');
      if (!(ta instanceof HTMLTextAreaElement)) { return; }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      // Add a leading space if the cursor isn't at a whitespace
      // boundary, and a trailing space so the next char isn't glued.
      const leading = (start > 0 && !/\\s$/.test(before)) ? ' ' : '';
      const trailing = (after.length === 0 || !/^\\s/.test(after)) ? ' ' : '';
      ta.value = before + leading + text + trailing + after;
      const caret = before.length + leading.length + text.length + trailing.length;
      ta.setSelectionRange(caret, caret);
      ta.focus();
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

    // ---------------------------------------------------------
    // JS port of chatRenderer.ts (todo #1613). The host-side TS
    // module is the source of truth; this JS mirrors it inside
    // the nonced webview script because CSP forbids cross-process
    // module loading at runtime. If you change a regex below,
    // change it in src/views/sessions/chatRenderer.ts too.
    //
    // Security invariant: every segment's textual content is
    // passed through escHtml before being inserted as innerHTML.
    // The segment shape only picks the wrapper tag and
    // data-action — untrusted strings never become markup.
    // ---------------------------------------------------------
    const RE_CODE_FENCE = /\`\`\`([a-zA-Z0-9_+-]*)\\n([\\s\\S]*?)\`\`\`/g;
    const RE_INLINE_CODE = /\`([^\`\\n]+)\`/g;
    const RE_BOLD = /\\*\\*([^*\\n]+)\\*\\*/g;
    const RE_ITALIC = /(?<![*\\w])\\*([^*\\n]+)\\*(?!\\w)/g;
    const RE_LINK = /\\[([^\\]\\n]+)\\]\\(([^()\\s]+)\\)/g;
    const RE_PATH = /(?<![A-Za-z0-9_/\\\\.-])(\\.{0,2}\\/?[A-Za-z0-9_./-]+\\.[A-Za-z0-9]{1,8})(?::(\\d{1,6})(?::(\\d{1,6}))?)?(?![A-Za-z0-9_/\\\\.-])/g;
    const RE_COMMIT = /(?<![#A-Za-z0-9])(?<!0x)\\b([a-f0-9]{7,40})\\b(?![A-Za-z0-9])/g;

    function tokenize(input) {
      if (!input) { return []; }
      const out = [];
      const fenceRe = new RegExp(RE_CODE_FENCE.source, RE_CODE_FENCE.flags);
      let lastIndex = 0;
      let m;
      while ((m = fenceRe.exec(input)) !== null) {
        if (m.index > lastIndex) { pushInline(input.slice(lastIndex, m.index), out); }
        out.push({ kind: 'codeBlock', text: m[2], language: m[1] || undefined });
        lastIndex = m.index + m[0].length;
      }
      if (lastIndex < input.length) { pushInline(input.slice(lastIndex), out); }
      return mergePlain(out);
    }

    function collect(text, re, hits, priority, build) {
      const r = new RegExp(re.source, re.flags);
      let m;
      while ((m = r.exec(text)) !== null) {
        if (m[0].length === 0) { r.lastIndex++; continue; }
        hits.push({ start: m.index, end: m.index + m[0].length, seg: build(m), priority });
      }
    }

    function pushInline(text, out) {
      if (!text) { return; }
      const hits = [];
      collect(text, RE_INLINE_CODE, hits, 5, m => ({ kind: 'inlineCode', text: m[1] }));
      collect(text, RE_LINK, hits, 4, m => ({ kind: 'link', label: m[1], href: m[2] }));
      collect(text, RE_BOLD, hits, 3, m => ({ kind: 'bold', text: m[1] }));
      collect(text, RE_ITALIC, hits, 2, m => ({ kind: 'italic', text: m[1] }));
      collect(text, RE_PATH, hits, 1, m => ({
        kind: 'path', raw: m[0], path: m[1],
        line: m[2] ? Number(m[2]) : undefined,
        column: m[3] ? Number(m[3]) : undefined,
      }));
      collect(text, RE_COMMIT, hits, 1, m => ({ kind: 'commitHash', hash: m[1] }));
      hits.sort((a, b) => a.start - b.start || b.priority - a.priority);
      let cursor = 0;
      for (const hit of hits) {
        if (hit.start < cursor) { continue; }
        if (hit.start > cursor) { out.push({ kind: 'plain', text: text.slice(cursor, hit.start) }); }
        out.push(hit.seg);
        cursor = hit.end;
      }
      if (cursor < text.length) { out.push({ kind: 'plain', text: text.slice(cursor) }); }
    }

    function mergePlain(segs) {
      const out = [];
      for (const s of segs) {
        const prev = out[out.length - 1];
        if (s.kind === 'plain' && prev && prev.kind === 'plain') { prev.text += s.text; }
        else { out.push(s); }
      }
      return out;
    }

    function renderSegments(text) {
      const segs = tokenize(String(text || ''));
      const parts = [];
      for (const s of segs) {
        if (s.kind === 'plain') {
          parts.push(escHtml(s.text));
        } else if (s.kind === 'bold') {
          parts.push('<strong>' + escHtml(s.text) + '</strong>');
        } else if (s.kind === 'italic') {
          parts.push('<em>' + escHtml(s.text) + '</em>');
        } else if (s.kind === 'inlineCode') {
          parts.push('<code>' + escHtml(s.text) + '</code>');
        } else if (s.kind === 'codeBlock') {
          const lang = s.language ? ' data-lang="' + escHtml(s.language) + '"' : '';
          parts.push('<pre' + lang + '><code>' + escHtml(s.text) + '</code></pre>');
        } else if (s.kind === 'link') {
          // External-link rendering: only http/https schemes are honored
          // (no javascript:/data:/file: URIs). Renders as plain text
          // otherwise — defense-in-depth against link smuggling.
          const href = s.href;
          const safe = /^https?:\\/\\//i.test(href);
          if (safe) {
            parts.push('<a href="' + escHtml(href) + '" target="_blank" rel="noopener noreferrer">' + escHtml(s.label) + '</a>');
          } else {
            parts.push(escHtml(s.label) + ' (' + escHtml(href) + ')');
          }
        } else if (s.kind === 'path') {
          const dataLine = s.line ? ' data-line="' + escHtml(s.line) + '"' : '';
          const dataCol = s.column ? ' data-column="' + escHtml(s.column) + '"' : '';
          parts.push('<a class="vf-chat-path" data-action="chatOpenPath" data-path="' + escHtml(s.path) + '"' + dataLine + dataCol + '>' + escHtml(s.raw) + '</a>');
        } else if (s.kind === 'commitHash') {
          parts.push('<a class="vf-chat-commit" data-action="chatOpenCommit" data-hash="' + escHtml(s.hash) + '">' + escHtml(s.hash.slice(0, 8)) + '</a>');
        }
      }
      return parts.join('');
    }

    function renderMessage(m) {
      const isAgent = m.source === 'agent';
      const author = isAgent ? personaLabel : userLabel;
      const cls = 'vf-chat-msg ' + (isAgent ? 'vf-chat-msg-agent' : 'vf-chat-msg-user');
      const status = (isAgent && m.status === 'pending') ? '<span class="vf-chat-msg-status">awaiting reply</span>' : '';
      let body = '<div class="vf-chat-msg-body">' + renderSegments(m.prompt_text) + '</div>';
      if (m.response_text) {
        body += '<div class="vf-chat-msg-response">' + renderSegments(m.response_text) + '</div>';
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
      } else if (msg.type === 'chatPrefill') {
        const ta = document.getElementById('vf-chat-textarea');
        if (ta instanceof HTMLTextAreaElement) {
          ta.value = msg.payload.text;
          if (msg.payload.focus) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        }
      }
    });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    for (const sub of this.streamSubscriptions) { sub.dispose(); }
    this.streamSubscriptions = [];
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    this.pollTimers.clear();
    this.chatState.clear();
    this.streamLive.clear();
    this.pendingPromptUser.clear();
  }
}
