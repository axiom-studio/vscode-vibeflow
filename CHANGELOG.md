# Changelog

## Unreleased

### Added — Chat-First Mode realtime (todo #1620, doc #285)
- **Provider-agnostic stream-json transport** for chat-first sessions: spawn the agent CLI in line-delimited JSONL mode, parse native events through pure-function adapters, normalize to a single `NormalizedAgentEvent` discriminated union. Supported providers: Claude Code (`claude --print --input-format stream-json --output-format stream-json --verbose`), OpenAI Codex (`codex exec --json --yolo`), Gemini CLI / Qwen Code (`gemini|qwen -p "<init>" --output-format stream-json --yolo`), Cursor Agent (`cursor-agent -p "<init>" --output-format stream-json --yolo --approve-mcps`).
- **`SessionStreamRegistry`** — owns per-session `StreamJsonProcess` child handles, indexed by both `handleId` and provider-assigned `agentSessionId`. Aggregates `onEvent` / `onStderr` / `onParseError` / `onExit` event emitters with auto-cleanup on exit.
- **`AgentActivityOutputChannel`** — single `LogOutputChannel` ("VibeFlow Agent Activity") receiving every adapter event with session-aware prefixes (`[provider/persona@branch:sessionTail]`). Per-event-kind rendering: info for `session_init` / `tool_use`, debug for `agent_text` / `unknown`, warn for `api_retry` / stderr, error for `error` / parse failures. Credentials redacted on every write.
- **`vibeflow.openAgentActivity`** command (with `$(output)` icon) reveals the Agent Activity output channel for stream observability.
- **SessionPanelManager stream subscription** — for sessions with a live stream, `prompt_user` and `respond_to_prompt` tool_use events route directly into the embedded chat panel sub-millisecond after the agent emits them, bypassing the 5s REST polling cadence. Initial transcript fetch still uses REST (history before the stream started). When the stream dies (`onExit`), REST polling auto-resumes on the next tick and a soft "stream closed — falling back to 5s polling" notice surfaces in the chat error bar.

### Changed
- `launchSession` accepts an optional `streamRegistry` parameter. For chat-first launches with a registered provider adapter, the agent is now spawned via `StreamJsonProcess` (background, hidden) instead of the VS Code TUI Terminal. TUI launch remains the fallback when no adapter exists for the provider.

### Added — Opt-in tmux backing for chat-first sessions (todo #1615)
- **New config** `vibeflow.session.headlessBacking` with values `auto` (default — vscode terminal), `tmux` (opt-in; Unix only; agent survives IDE restart), `vscode` (force hidden terminal).
- **`TmuxBacking`** wraps tmux operations on a dedicated `vibeflow-headless` socket (separate from CLI mode's `vibeflow` socket): `new-session -d`, `has-session`, `kill-session`, `list-sessions`, `send-keys -l`, `capture-pane`. Verb allowlist; session names validated against `^[a-zA-Z0-9_-]+$`; env-var names and values validated; argv-form `execFile` only (no shell).
- **`detectTmuxAvailability()`** uses `tmux -V` via `execFile`; cached for the extension host lifetime; Windows returns `available: false` unconditionally.
- **Session naming**: `vibeflow-<personaSlug>-<branchSlug>-<workDirHash8>` so two worktrees of the same branch coexist without collision.
- **External observability**: a tmux-backed agent can be attached from any terminal via `tmux -L vibeflow-headless attach -t <name>`. Launch toast surfaces the exact command.
- **`killSession`** cleans up both the VS Code terminal AND any tmux-backed session at the recomputed headless name (best-effort; no-op when nothing's there).
- **Activation probe**: existing tmux-backed sessions left over from a previous IDE run are logged (not auto-reattached — the session record's `session_id` lives on the backend and is owned by the agent's `session_init`).

### Added — @mention autocomplete in chat (todo #1614)
- **Picker** in the Session Panel: type `@` to surface a kind chooser (`document` / `context` / `todo` / `issue` / `feature` / `symbol`); then `@<kind>:<query>` filters live. Arrow keys + Enter to select; Escape to dismiss; Cmd/Ctrl+Enter still sends.
- **Wire-shape parity** with axiomcloud: selected mentions embed as `[<type>:<id> "<name>"]` so the server-side `parseAttachmentRefs` resolves them without any new endpoint.
- **Workspace symbols** (IDE-only, not in axiomcloud): `@symbol:<query>` dispatches `vscode.executeWorkspaceSymbolProvider` and renders LSP results. The token id encodes `<relativePath>#<line>` so the agent can resolve the location locally.

### Added — IDE Superpowers in chat (todo #1613)
- **Chat-message renderer**: bold / italic / inline-code / triple-backtick code fences / markdown links render correctly in the Session Panel transcript. CSP-safe pipeline (pure-function tokenizer in `src/views/sessions/chatRenderer.ts` + parallel JS port inlined in the nonced webview script).
- **Clickable file paths**: `path/to/file.ts:42:7` patterns in messages become links. Click → opens the file in the editor at the line/column. Workspace-relative only — absolute paths and `..`-escape attempts are rejected at the host boundary.
- **Clickable commit hashes**: `[a-f0-9]{7,40}` patterns become links rendered as the 8-char short form. Click → invokes the built-in `git.viewCommit` if the git extension is available, otherwise offers a terminal fallback with `git show --stat <hash>`. Hash is regex-validated before any git invocation.
- **Right-click "Ask Agent About Selection"** (`vibeflow.chat.askSelection`): editor-context menu entry on any editor with a non-empty selection. Composes a fenced-code-block prompt with a workspace-relative `path:startLine-endLine` header, picks the open chat panel (Quick Pick if multiple), and seeds the textarea via the new `chatPrefill` host→webview message.
- **Drag-to-attach**: drop files from the VS Code Explorer onto the chat input bar → inserts `[filename](workspace-relative-path)` at the cursor. The agent reads via its own filesystem tools — no server roundtrip.

## 1.0.0 (2026-05-08)

First public Marketplace release.

### Highlights since 0.1.0
- **Rich Monitoring (Phase 4)**: live Dashboard, Kanban board, File Decorations, MCP Server Definition Provider, Worktree Management with TreeView + cleanup-on-kill, Pinned Plan with structured progress
- **Settings Webview** (Phase 3-D rework): 8 dedicated tabs in an editor-area panel, gear icon on every sidebar view, real Secrets-API persistence for provider tokens, dotted-key round-trip for worktree settings
- **Worktree Management** (Phase 4-6 rework): Agent Fleet TreeView gains a Worktrees section with right-click Open / Delete / Create-Session-Here, dirty/clean status in the Quick Pick + dirty-aware delete confirmation, configurable cleanup-on-kill (`ask` / `always` / `never`)
- **Security hardening**: HTTPS-required serverUrl across activation + every REST/MCP path (closes pre-#1745 cached-HTTP gap), `git check-ignore`-backed `.mcp.json` token-leak guard (handles negation idiom), CSPRNG nonces, command-injection-safe worktree commands

### Added
- Dashboard (`vibeflow.openDashboard`) — React Flow live topology over 5 parallel API endpoints, 30s polling, persona focus
- Kanban (`vibeflow.openKanban`) — drag-and-drop with server-side reconciliation, status allowlist, snap-back on rejection
- Agent File Decorations — per-persona Explorer badges with TTL sweep
- MCP Server Definition Provider — registers VibeFlow MCP for Copilot / Continue / Cody agents (`vscode.lm.registerMcpServerDefinitionProvider`)
- Worktree TreeView section — branch + path + `(current)` + `$(diff-modified)` markers, collapsed by default, with right-click commands `vibeflow.openWorktreeInNewWindow` / `vibeflow.deleteWorktreeFromTree` / `vibeflow.createSessionInWorktree`
- `vibeflow.worktree.{baseDir,autoCreate,cleanupOnKill}` configuration properties
- `LaunchSessionPrefill` option on `launchSession` so "Create Session Here" can pre-fill branch + workDir
- 6th chat command `/respond` (`@vibeflow /respond <text>`)
- `Clear` button on the Providers Settings tab next to `Set/Change`
- Provider env-token pre-fill in launch wizard from Secrets API (no re-prompt for stored MCP_TOKEN / GEMINI_API_KEY)
- `ContextProxy` typed wrapper over `globalState` + `secrets`
- `validateServerUrl` helper enforcing HTTPS-or-localhost across all WRITE + READ paths

### Changed
- Settings panel is now a dedicated editor-area Webview Panel (not a sidebar overlay), 8 tabs (Connection, Providers, Session Defaults, Sticky Models, Worktrees, Notifications, CLI Interface, About)
- Settings → Worktrees inputs round-trip via dotted config keys (`worktree.baseDir/autoCreate/cleanupOnKill`) instead of camelCase
- `setProviderToken` actually writes to `context.secrets` (was a "saved" toast no-op pre-fix); `envTokenSet` field driven by `secrets.get` per provider
- Repository URL in `package.json` from SSH form to HTTPS so the Marketplace listing renders the link
- `categories` includes `"AI"` for Marketplace discoverability

### Fixed
- **#1948**: `ensureMcpJsonIsGitIgnored` mishandled gitignore negation patterns — `!.mcp.json` re-include lines were misread as positive ignores, leaking the bearer token in monorepos using the `*` + `!.mcp.json` idiom. Fix: delegate to `git check-ignore` (canonical gitignore semantics) + post-append re-verify defends against parent-dir negation
- **#1947**: cached HTTP `serverUrl` from before the #1745 WRITE-path validation could still leak the bearer on auto-connect at activation. Three layers: extension.ts preflight before `tryAutoConnect`, `client.request()` re-reads + validates live, `mcpClient.connect()` validates before transport construction
- **#1949**: `setProviderToken` no longer fakes a "saved" toast — actually persists via `context.secrets.store`
- Settings → "Worktrees" tab values now persist (was hardcoded literals)
- Gear icon now visible on all 4 sidebar views (was only on Agent Fleet + Activity Feed)

### Removed
- `vibeflow.debug.simulateActivity` configuration property and the underlying `simulateActivity.ts` / `simulateActivity.prod-stub.ts` files (dev-only surface)
- `vibeflow.devMode.workspaceFolder` configuration property (F5-debugging hatch — DEV ONLY by description)
- "Advanced" Settings tab (had only the simulate toggle; pollInterval already lives in Session Defaults)
- esbuild `stripDevSimulator` plugin (no longer needed)
- "Auto Mode" session option from the launch wizard (Claude Code 2.1+ still prompts on every MCP tool's first use even with auto mode on, so it didn't deliver on its UX promise)

### Phase 4 — Rich Monitoring, Strategic Integration & Polish (during 0.1.x)
- Activity Feed → Monitor secondary container (draggable to right sidebar)
- Activity Feed real APIs (5s polling, 9 message types, 500-entry cap, prompt + commit detection)
- Pinned Plan V2 — structured-progress consumption (`progress_pct`, `milestone_name`, etc.) instead of summary-block text scraping
- MCP Server Definition Provider for Copilot/Continue/Cody integration
- Dashboard React Flow (snapshot composer over 5 parallel API calls + 30s polling + persona focus)
- Kanban Board (drag-and-drop with allowlist + reconciliation)
- File Decorations (per-persona Explorer badges with TTL sweep, role-tier shape symbols)
- Worktree Management v1 (Quick Pick: list / create / delete / open in new window) — security hardened against shell injection (`execFileSync` argv form, `isSafeBranchName` validation, path-confinement against `..` traversal)

### Phase 2.0 gap rework (during 0.1.x)
- Activity Feed empty states (4 spec'd states + Connection-lost banner) via `FeedStateController`
- Setup wizard "Enter Project ID" option
- Crypto nonce regression fix in document viewer (Math.random → randomBytes)
- HTTPS enforcement on serverUrl writes (#1745 — partial; activation gap closed in 1.0.0 via #1947)

## 0.1.0 (2026-04-16)

### Phase 1 — Foundation MVP
- Extension scaffold with 4 sidebar views (Agent Fleet, Work Items, Activity Feed, Documents)
- OAuth removed, API key authentication via Secrets API
- Auto-detect project from git remote URL
- CLI config integration (`~/.vibeflow-cli/config.yaml`)
- Activity Feed with react-virtuoso (500+ entry support)
- Basic @vibeflow Chat Participant (/status, /create)
- Status bar with 6 connection states

### Phase 2 — Real-Time & Rich UX
- Session lifecycle: 8-step launch wizard with persona selection
- Work Item CRUD: create/status/priority from TreeView
- Agent Session Focus Panel (per-persona editor tab)
- Work Item Detail Panel with execution logs and QA/Security actions
- Document Explorer with React markdown viewer
- Chat Participant expanded: /review, /summary, /launch, /respond
- QA Verify/Reject and Security Review workflows
- Branch review status check (pre-PR gate)
- Create PR command

### Phase 3 — Terminal-First Multi-Persona Execution
- Session visibility fix (correct API endpoint)
- Terminal-first architecture with hybrid mode (code agents visible, advisory hidden)
- Session reattachment on VSCode reload
- Settings as dedicated editor panel
- Per-persona sticky models (Architect→Opus, Dev→Sonnet, QA→Haiku)
- Document comments with section-based inline UI
- Save All & Notify with persona picker
- Typed message protocol foundation
- Comment paragraph spacing polish
- 5-step onboarding walkthrough
