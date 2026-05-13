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
import { MENTION_KINDS, type MentionKind } from './mentionParser.js';
import type { MentionItem } from '../../core/webviewMessages.js';

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
 * How recent a `done` work item's `updated_at` must be to still surface
 * in the chat panel's Activity rail. Keeps the panel showing the agent's
 * most recent commit / verification log lines for a few minutes after
 * the work item transitions to done — without this, the rail went blank
 * the moment the agent closed out its current task. 10 minutes is long
 * enough to cover "agent finished, user is still reading" and short
 * enough to keep the rail bounded by the existing 100-line cap.
 */
const RECENT_DONE_WINDOW_MS = 10 * 60 * 1000;

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
/**
 * Virtual scheme used by the `openDiff` flow. The chat's DiffBlock posts
 * reconstructed before/after text — we register a TextDocumentContentProvider
 * for this scheme so the synthetic docs can back VS Code's `vscode.diff`
 * command without writing temp files to disk.
 *
 * URI shape: `vibeflow-diff:<token>/<side>?n=<n>` where `<token>` keys into
 * `diffContents` and `<side>` is 'before' or 'after'. The `?n=` query is
 * a monotonic counter so each open gets a fresh URI (otherwise VS Code
 * caches the document and won't re-render new content).
 */
const DIFF_SCHEME = 'vibeflow-diff';

export class SessionPanelManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private chatState = new Map<string, ChatCursor>();

  /**
   * Synthetic before/after text for each pending diff open. Keyed by a
   * URI-safe token the provider parses out of `uri.path`. Entries are
   * never deleted — the chat session is short enough that the memory
   * cost is trivial, and keeping them around lets the user reload the
   * diff editor tab without losing the content.
   */
  private diffContents = new Map<string, string>();
  private diffSequence = 0;
  /**
   * The provider + its registration disposable. Registered lazily on the
   * first `open()` call (we only need it once per workspace; the provider
   * itself is shared across all session panels).
   */
  private diffProviderDisposable?: vscode.Disposable;
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
    this.ensureDiffProviderRegistered();
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
        case 'openDiff': {
          await this.openSyntheticDiff(msg.payload);
          break;
        }
        case 'chatMentionQuery': {
          // @mention autocomplete fetch (todo #1614). Host
          // resolves the right entity list / LSP call, returns
          // the filtered top-N as MentionItem[]. requestId
          // round-trips so the webview can drop stale responses.
          const items = await this.resolveMentions(msg.payload.kind, msg.payload.query);
          this.postToWebview(panel, {
            type: 'chatMentionResults',
            payload: { requestId: msg.payload.requestId, kind: msg.payload.kind, items },
          });
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
      this.postToWebview(panel, {
        type: 'update',
        payload: toReactUpdatePayload(session, [], this.readDiffViewSetting()),
      });
      return;
    }

    const [logs] = await Promise.all([
      this.collectSessionLogs(this.projectId, session.session_id),
      this.pollChatUpdates(this.projectId, session.session_id, panel),
    ]);
    this.postToWebview(panel, {
      type: 'update',
      payload: toReactUpdatePayload(session, logs, this.readDiffViewSetting()),
    });
  }

  private readDiffViewSetting(): 'unified' | 'split' {
    const v = vscode.workspace.getConfiguration('vibeflow').get<string>('chat.diffView', 'unified');
    return v === 'split' ? 'split' : 'unified';
  }

  /**
   * Register a `vibeflow-diff:` TextDocumentContentProvider once per
   * panel-manager lifetime. The provider serves up the synthetic
   * before/after documents the chat's DiffBlock "Open in Editor" flow
   * stashes via `openSyntheticDiff` below — no temp files on disk.
   *
   * Idempotent: subsequent calls are no-ops. Registration is deferred
   * until first `open()` so we don't pay the cost when no session
   * panels have ever been opened.
   */
  private ensureDiffProviderRegistered(): void {
    if (this.diffProviderDisposable) { return; }
    const provider: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: (uri: vscode.Uri): string => {
        // URI shape: `vibeflow-diff:<token>/<side>` (we ignore the
        // ?n=<n> query — it's only there to bust VS Code's doc cache).
        const [token, side] = uri.path.replace(/^\//, '').split('/');
        const key = `${token}/${side}`;
        return this.diffContents.get(key) ?? '';
      },
    };
    this.diffProviderDisposable = vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      provider,
    );
  }

  /**
   * Materialize the chat DiffBlock's reconstructed before/after pair
   * as two virtual documents under the `vibeflow-diff:` scheme and open
   * them in VS Code's native diff editor via the built-in `vscode.diff`
   * command. The user gets the full power-review surface — scroll-sync,
   * navigate-hunks, inline edits if they save-as, etc.
   *
   * The synthetic docs are kept in `diffContents` for the rest of the
   * session so reload-from-tab still works. Memory cost is bounded by
   * panel lifetime, which is short enough to ignore.
   */
  private async openSyntheticDiff(payload: {
    title: string;
    before: string;
    after: string;
    language?: string;
    filePath?: string;
  }): Promise<void> {
    this.ensureDiffProviderRegistered();
    const token = `d${++this.diffSequence}-${Date.now().toString(36)}`;
    this.diffContents.set(`${token}/before`, payload.before);
    this.diffContents.set(`${token}/after`, payload.after);
    // Pretty path component in the URI so the diff editor's title
    // shows something meaningful instead of a hash blob.
    const tail = payload.filePath
      ? encodeURIComponent(payload.filePath.replace(/^.*\//, ''))
      : 'diff';
    const leftUri = vscode.Uri.parse(`${DIFF_SCHEME}:/${token}/before/${tail}?n=${this.diffSequence}`);
    const rightUri = vscode.Uri.parse(`${DIFF_SCHEME}:/${token}/after/${tail}?n=${this.diffSequence}`);
    try {
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, payload.title);
      // Assign languageId AFTER the diff opens so syntax highlighting
      // matches the file type. `setTextDocumentLanguage` is a no-op
      // when language is undefined.
      if (payload.language) {
        try {
          const leftDoc = await vscode.workspace.openTextDocument(leftUri);
          const rightDoc = await vscode.workspace.openTextDocument(rightUri);
          await vscode.languages.setTextDocumentLanguage(leftDoc, payload.language);
          await vscode.languages.setTextDocumentLanguage(rightDoc, payload.language);
        } catch {
          // Unknown language id — leave docs as plain text.
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`Could not open diff: ${msg}`);
    }
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
   * Resolve a @mention picker query into a list of MentionItems
   * (todo #1614). Routes by kind: vibeflow entities use the
   * existing REST list endpoints + client-side filter (lists are
   * typically <200 items); workspace symbols use VS Code's LSP
   * `vscode.executeWorkspaceSymbolProvider` command.
   *
   * Top-20 cap so the picker stays usable on huge lists. All
   * failures degrade to an empty list — the picker shows "no
   * results" rather than breaking the chat flow.
   */
  private async resolveMentions(kind: string, query: string): Promise<MentionItem[]> {
    if (this.projectId === undefined && kind !== 'symbol') { return []; }
    if (!(MENTION_KINDS as readonly string[]).includes(kind)) { return []; }
    const k = kind as MentionKind;
    const needle = query.trim().toLowerCase();
    const match = (s: string): boolean => needle === '' || s.toLowerCase().includes(needle);

    try {
      if (k === 'document') {
        const docs = await this.client.listDocuments(this.projectId!);
        return docs.filter(d => match(d.title))
          .slice(0, 20)
          .map(d => ({ id: d.id, name: d.title }));
      }
      if (k === 'context') {
        const ctxs = await this.client.listContexts(this.projectId!);
        return ctxs.filter(c => match(c.title))
          .slice(0, 20)
          .map(c => ({ id: c.id, name: c.title }));
      }
      if (k === 'feature') {
        const features = await this.client.listFeatures(this.projectId!);
        return features.filter(f => match(f.name))
          .slice(0, 20)
          .map(f => ({ id: f.id, name: f.name, detail: f.status }));
      }
      if (k === 'todo') {
        // Todos live under features; list features then merge their todos.
        // Throttled: fetch up to 10 features in parallel; client-side filter.
        const features = await this.client.listFeatures(this.projectId!);
        const todoLists = await Promise.all(
          features.slice(0, 10).map(f => this.client.listTodos(f.id).catch(() => [])),
        );
        const all = todoLists.flat();
        return all.filter(t => match(t.title))
          .slice(0, 20)
          .map(t => ({ id: t.id, name: t.title, detail: t.status }));
      }
      if (k === 'issue') {
        const issues = await this.client.listIssues(this.projectId!);
        return issues.filter(i => match(i.title))
          .slice(0, 20)
          .map(i => ({ id: i.id, name: i.title, detail: i.status }));
      }
      if (k === 'symbol') {
        // VS Code workspace symbol provider — LSP-backed, async.
        // Empty query returns the top-N most relevant symbols for
        // an empty query (which LSPs typically interpret as "no
        // results"); skip the call to avoid a wasted roundtrip.
        if (!needle) { return []; }
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          query,
        );
        if (!Array.isArray(symbols)) { return []; }
        return symbols.slice(0, 20).map(s => ({
          id: this.encodeSymbolId(s),
          name: s.name,
          detail: this.describeSymbolLocation(s),
        }));
      }
    } catch {
      // Degrade silently.
      return [];
    }
    return [];
  }

  private encodeSymbolId(s: vscode.SymbolInformation): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const file = folder ? vscode.workspace.asRelativePath(s.location.uri, false) : s.location.uri.fsPath;
    const line = s.location.range.start.line + 1;
    return `${file}#${line}`;
  }

  private describeSymbolLocation(s: vscode.SymbolInformation): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const file = folder ? vscode.workspace.asRelativePath(s.location.uri, false) : s.location.uri.fsPath;
    const line = s.location.range.start.line + 1;
    return `${file}:${line}`;
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
   * `claimedBy === sessionId` across in-flight AND recently-completed
   * work items in the project. We mirror the same pattern ActivityPoller
   * uses but scoped to a single session and bounded to the most recent
   * ~100 lines.
   *
   * Includes `done` items updated within RECENT_DONE_WINDOW_MS so the
   * rail keeps showing the agent's most recent commit / verification log
   * lines after a work item transitions to done — without this, the
   * Activity panel went blank the moment the agent closed out its
   * current task, which read like a bug.
   *
   * Failures are absorbed (return what we have) — a panel that can't reach
   * the API should still render the static metadata header and try again
   * on the next 5s tick.
   */
  /**
   * Filter predicate for the Activity rail: an item belongs to this
   * session's ledger if it was claimed by this session AND it's either
   * still in flight (`implementing`) OR recently completed
   * (`done`/`qa_verified` within RECENT_DONE_WINDOW_MS). Pre-claim
   * states like `planning` are excluded — those have no log lines yet.
   */
  private shouldIncludeForSession(
    item: { claimed_by?: string | null; status?: string; updated_at?: string },
    sessionId: string,
  ): boolean {
    if (item.claimed_by !== sessionId) { return false; }
    const status = item.status ?? '';
    if (status === 'implementing') { return true; }
    if (status === 'done' || status === 'qa_verified' || status === 'security_reviewed') {
      const updatedAt = item.updated_at ? Date.parse(item.updated_at) : NaN;
      if (Number.isNaN(updatedAt)) { return false; }
      return Date.now() - updatedAt <= RECENT_DONE_WINDOW_MS;
    }
    return false;
  }

  private async collectSessionLogs(projectId: number, sessionId: string): Promise<PanelLog[]> {
    const claimedTodos: VibeFlowTodo[] = [];
    const claimedIssues: VibeFlowIssue[] = [];

    try {
      const features = await this.client.listFeatures(projectId);
      // Broadened: include done features too, since a feature can complete
      // while its session's chat panel is still open and we want the logs
      // to keep rendering until the panel closes.
      const todoLists = await Promise.all(
        features.map(f => this.client.listTodos(f.id).catch(() => [])),
      );
      for (const todos of todoLists) {
        for (const todo of todos) {
          if (this.shouldIncludeForSession(todo, sessionId)) {
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
        if (this.shouldIncludeForSession(issue, sessionId)) {
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
    const taskTitle = session.last_message ?? '';
    const taskStatus = session.last_message_at
      ? new Date(session.last_message_at).toLocaleTimeString()
      : '';
    const diffView = this.readDiffViewSetting();
    // Avatar portraits live on the axiomcloud server (same source the
    // dashboard's agent topology uses). Pass the base URL through so the
    // chat header / message bubbles render the persona portrait instead
    // of a single-letter glyph.
    const serverUrl = this.client.getBaseUrl();

    const distUri = vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, 'assets', 'index.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, 'assets', 'index.css'),
    );

    // React shell — the panel's body just bootstraps the React bundle.
    // The Session Chat view (`webview-ui/src/components/SessionChatView.tsx`)
    // reads `data-vf-*` to seed initial state, then takes over via
    // postMessage. Replaces ~770 lines of inline HTML/CSS/JS that lived
    // here pre-#1623.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      img-src ${webview.cspSource} https: data:;
      font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>${escapeHtml(personaName)}</title>
  <style>
    html, body, #root { height: 100%; }
    body { margin: 0; padding: 0; }
  </style>
</head>
<body
  data-vf-mode="session-chat"
  data-vf-session-id="${escapeHtml(session.session_id)}"
  data-vf-persona-name="${escapeHtml(personaName)}"
  data-vf-persona-key="${escapeHtml(session.persona_key)}"
  data-vf-model="${escapeHtml(model)}"
  data-vf-branch="${escapeHtml(branch)}"
  data-vf-status="${escapeHtml(status)}"
  data-vf-task-title="${escapeHtml(taskTitle)}"
  data-vf-task-status="${escapeHtml(taskStatus)}"
  data-vf-diff-view="${escapeHtml(diffView)}"
  data-vf-server-url="${escapeHtml(serverUrl)}"
>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
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
    this.diffProviderDisposable?.dispose();
    this.diffProviderDisposable = undefined;
    this.diffContents.clear();
    this.panels.clear();
    this.pollTimers.clear();
    this.chatState.clear();
    this.streamLive.clear();
    this.pendingPromptUser.clear();
  }
}

/**
 * Shape the React-side `SessionChatView` expects on the `update` host
 * message. Strips down VibeFlowSession + PanelLog[] to the fields the
 * rail and chat view actually render. Keeps the React side narrow so
 * it doesn't need to import host types or VibeFlowSession's full shape.
 */
function toReactUpdatePayload(
  session: VibeFlowSession,
  logs: PanelLog[],
  chatDiffView: 'unified' | 'split',
): {
  session: {
    sessionId: string;
    personaName: string;
    personaKey: string;
    model: string;
    branch: string;
    status: 'active' | 'stale' | 'inactive';
    taskTitle: string;
    taskStatus: string;
  };
  logs: { text: string; time?: string; src?: string }[];
  chatDiffView: 'unified' | 'split';
} {
  const status: 'active' | 'stale' | 'inactive' = session.active
    ? (session.stale ? 'stale' : 'active')
    : 'inactive';
  return {
    session: {
      sessionId: session.session_id,
      personaName: session.persona_name ?? session.persona_key,
      personaKey: session.persona_key,
      model: session.agent_model ?? 'unknown',
      branch: session.git_branch ?? 'main',
      status,
      taskTitle: session.last_message ?? '',
      taskStatus: session.last_message_at
        ? new Date(session.last_message_at).toLocaleTimeString()
        : '',
    },
    logs: logs.map(l => ({
      text: l.content,
      time: l.created_at ? new Date(l.created_at).toLocaleTimeString() : undefined,
      src: l.source ? `${l.source.type} #${l.source.id}` : undefined,
    })),
    chatDiffView,
  };
}
