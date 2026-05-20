# Changelog

## 1.0.2 (2026-05-20)

Onboarding-focused patch release. New-user feedback (Kevin + Ranjan from the post-1.0.1 batch) surfaced a chain of UX dead-ends in the wizard, the Agent Fleet tree, and the CLI handoff — all fixed here. Plus a polish pass on the editor-area panels (Settings, Dashboard, Kanban, Compliance) that had been accumulating in the working tree since 1.0.1.

### Fixed — Launch wizard & onboarding

- **Launch wizard preflight gates** (#2174) — the PROVIDER picker and per-persona override picker now tag missing-binary providers (`· $(error) not installed`) and abort with an actionable error if a tagged provider is selected. New `PROVIDER_BINARIES` table mirrors the canonical mapping in `SettingsPanel.ts`, including cursor's two-name `cursor-agent`/`agent` fallback. Codex/Gemini API-key inputs now validate against a conservative min-length floor (catches `abc123` / empty / whitespace fakes) and reject empty input with a clear remediation hint pointing at Settings → Providers. `clearWhichBinaryCache()` runs at wizard entry so install-then-relaunch works in the same VS Code session.

- **Empty-Enter detects external auth** (#2179) — self-correction to #2174. New `detectExternalAuth(envName)` helper checks `process.env[envName]` for any provider, plus `~/.gemini/credentials` for Gemini. When external auth is present, the wizard surfaces an info message ("Using GEMINI_API_KEY from your shell environment") and proceeds without setting the env var — the spawned terminal inherits parent env via `vscode.window.createTerminal`'s default merge. Only aborts with a clear error when no auth is configured anywhere.

- **CLI handoff PID-lock guard** (#2181) — when `vibeflow.cli.enabled=true` AND an external vibeflow-cli is already holding `~/.vibeflow-cli/vibeflow.pid`, the launcher now shows a modal warning (Ranjan's wording: "Quit your existing vibeflow-cli and rerun the step…") + Retry/Cancel buttons instead of silently dropping the user to a bare shell. New `getRunningCliPid()` helper mirrors the Go-side `pidlock.go` semantics via `process.kill(pid, 0)`.

- **`.mcp.json` writes use extension's own token first** (#2184) — `ensureMcpConfig` previously sourced the bearer token ONLY from `~/.vibeflow-cli/config.yaml`; extension users without the CLI installed got a silent skip and the spawned agent had zero VibeFlow MCP tools. Now resolves extension secret store first (via new `VibeFlowClient.getToken()`), CLI config as fallback, and shows a loud error when neither source has a token. Side-benefit: closes the CLI-vs-extension auth-identity hijack — when both are signed in as different users, the agent now boots with the extension's identity (the one the user actually sees in Agent Fleet).

### Fixed — Agent Fleet tree

- **Pending sessions stall sweep + Dismiss** (#2175) — Kevin reported pending session rows stuck in `starting... (1009s)` forever when `session_init` never returned. New `PENDING_STALL_THRESHOLD_MS = 120s`; `fetchAndRefresh` now transitions stuck `starting` entries to `failed` after the threshold (preserves any prior `markFailed`-captured stderr). Failed rows gain a Dismiss action (inline × on hover + right-click menu) so users can clear them without `Reload Window`.

- **Cancel action on `starting` rows** (#2178) — Ranjan: "how do I stop them?" — previously the right-click menu for `pendingSessionStarting` rows was empty. New `vibeflow.cancelStartingPending` command sends SIGTERM to the child via the new `SessionStreamRegistry.killByHandleId()` helper, then removes the UI row. Surfaced as both an inline stop button on hover and a right-click context menu entry.

### Added & changed — first-impression UX

- **Project status as visual tag in Launch Session picker** (#1903) — replaced the plain dim status text with `$(codicon) UPPER CASE TAG` (e.g. `$(eye) IN REVIEW`, `$(checklist) READY TO IMPLEMENT`). Mirrors the iconography from the Project Items sidebar.

- **Welcome walkthrough — "Learn more" target** (#2180) — now points at `axiomstudio.ai/vibeflow` (the product/marketing page) instead of `cloud.axiomstudio.ai` (the app login).

- **Walkthrough copy polish** (#2182) — step titles rewritten as benefit-oriented phrases ("Launch your first agent", "Stay in the loop", "Explore the workspace"); descriptions lead with WHY each step matters; sidebar-step rebuilt as a markdown bullet list of the four views; welcome step gains an `onLink:` completionEvent. Setup step embeds a CLI-vs-extension identity hint that preempts the most common auth-mismatch confusion.

- **Marketplace tile description** (#2183) — punchier outcome-first hook: "Ship faster with a full AI engineering team — Developer, Architect, QA, Security, and PM agents that know your codebase and do the work." First ~60 chars now state a complete promissory thought that survives marketplace tile truncation.

### Polish stream — editor-area panels

- **Shared icon library** — +11 new icon components (`Plug`, `Cpu`, `Sliders`, `Brain`, `Bell`, `Terminal`, `Info`, `Bug`, `CheckSquare`, `Lock`, `Check`) consumed across the polished panels. Replaces inline SVG copy-paste.
- **`body[data-vf-mode=*]` style scope** — editor-area panels (Dashboard, Settings, Kanban, Compliance, Work Item, Session Chat, Document) now remap `--feed-bg` to the editor background automatically; sidebar webviews keep the sidebar background.
- **`complianceFrameworks.ts` extraction** — framework allowlist + display labels moved to a vscode-free shared module that both host and webview consume; re-exported from `CompliancePanel.ts` for back-compat.
- **`SettingsPanel.ts` — Settings tab availability bug fixes**: `available` flag now consults `isBinaryOnPath` (was hardcoded), cursor entry accepts `agent` OR `cursor-agent`, `version` field reads from `packageJSON.version` instead of the stale `'0.1.0'` hardcoded string.
- **`KanbanPanel.ts` / `KanbanView.tsx`** — throttled mount + visibility-change dedupe (1s window) so we don't fan out two consecutive swimlane fetches; 5s spinner-safety timeout if the host doesn't respond.
- **`ConnectionTab.tsx`** — Refresh List button now shows loading state and "refreshed at <time>" stamp; new Copy Project ID action.
- **`DashboardView.tsx`** — drop unused `BranchReviewItem` interface and `items?` field (the branch-readiness card is hidden in v1.1); fix QA queue tooltip wording to reflect the actual `qa_verified=false` filter.

### Chore

- **Lint baseline cleanup** — two long-standing `no-useless-escape` errors squashed (`worktreeCommands.ts:29`, `chatRenderer.ts:64`). Baseline is now zero errors (down from three) + 1 unchanged warning.
- **Build fix** — committed `src/utils/whichBinary.ts` which had been on-disk-only since prior session; a fresh clone of origin/main would otherwise fail to compile against the #2174 import.

## 1.0.1 (2026-05-20)

First update since the 1.0.0 marketplace release. Substantial new surface area (chat-first mode, attachments, compliance, project switcher, project items pane) + a sweep of bug fixes from the post-1.0 customer feedback round.

### Highlights since 1.0.0

- **Compliance view** — dedicated `VibeFlow: Open Compliance` page mirroring axiomcloud's compliance dashboard: top-stat tiles, framework rollups, filterable findings table with expandable rows, CSV export with OWASP injection guard. Sidebar discoverability button on the Work Items tree.
- **Project Items sidebar** — new 4th sidebar pane, Jira-Backlog-style hierarchical view (Features → Todos nested, Issues separate). Complements the existing Work Items pane's kanban/status view.
- **Project switcher in the status bar** — `$(folder) <project-name>` pill at priority 99, click for Quick Pick of all projects. `Cmd+Shift+V P` keybinding. Auto-switch prompt when opening a folder mapped to a different project than the cached one.
- **Chat attachments** end-to-end: paste / drag / picker → host validates MIME + size + magic bytes → uploads to `/assets/upload` with the host's auth header → local binary cache → renders inline as `<img>` or as a click-to-open file card. Agent-readable footer appended so the receiving agent can find + fetch attachments via the standard `list_attachments` MCP tool.
- **Chat-first stream-json transport** — provider-agnostic agent runtime (Claude / Codex / Gemini / Cursor / Qwen) with sub-millisecond event streaming into the chat panel. Optional tmux backing on Unix so the agent survives IDE restart.
- **@mention autocomplete in chat** — `@document/context/todo/issue/feature/symbol` picker; mentions embed as `[type:id "name"]` tokens.
- **IDE superpowers in chat** — clickable commit hashes (open in native Commit Details view), clickable workspace paths (open at line/col), right-click "Ask Agent About Selection" composes a fenced-code-block prompt with the editor selection.
- **CLI auto-install** — Settings → CLI Interface → **Install Latest** downloads the matching binary from GitHub Releases, verifies checksums, writes the binary to extension globalStorage, wires `vibeflow.cli.binaryPath` automatically. Handles GitHub's `release-assets.githubusercontent.com` CDN.
- **Activity Feed persistence** — sidebar collapse + window reload + extension restart no longer wipe history. Three-tier durability: `retainContextWhenHidden`, host-side replay buffer (cap 500), `vscode.setState` round-trip.
- **Animated "Working… 0:42" indicator** in chat replaces the static `PENDING` status chip — matches the platform's chat UI.

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

### Added — post-1.0 customer feedback round (2026-05-15 → 2026-05-19)

- **Compliance view** (todo #1671) — `vibeflow.openCompliance` + `Cmd+Shift+V C` + sidebar discoverability button on the Work Items tree. Top-stats / framework cards / findings table / CSV export with OWASP CSV-injection guard.
- **Project Items sidebar** — new tree provider sharing data with WorkItemsTreeProvider via `onDidRefresh` event (no duplicate polling). Features expand to their todos; Issues separate; "(No Feature)" group for orphans.
- **Project switcher in status bar** (todo #1702) — `createProjectStatusBar()` at priority 99, Quick Pick for switching, `Cmd+Shift+V P` keybinding, `vibeflow.pickProject` command.
- **Auto-switch on workspace folder change** — `onDidChangeWorkspaceFolders` handler re-runs the silent git-remote → project match and prompts the user before switching mid-session.
- **CLI auto-install** (todo #1701) — `vibeflow.installCli` command + Settings → CLI Interface "Install Latest" button + replacement for the no-binary toast docs link. Downloads from GitHub Releases with hostname allowlist (`*.githubusercontent.com`), 100MB sanity cap, optional SHA-256 verification, stage-then-swap atomic install.
- **Chat attachments** (todo #1670) — full pipeline: paste / drag / picker → host MIME + magic-byte validation → `/assets/upload` with Bearer auth (key stays host-side) → cache to `globalStorageUri/asset-cache/<id>/<name>` → inline `<img>` or click-to-open file card → agent-readable markdown footer with attachment metadata so receiving agents discover via `list_attachments` MCP tool.
- **Animated "Working… {elapsed}" indicator** in chat (todo #1665) — three breathing dots + tabular-nums elapsed time, replaces the static `PENDING` chip.
- **`vibeflow.reportIssue` command** — opens the GitHub issues page with environment info (extension version, VSCode version, OS, server URL) pre-filled in the body.

### Fixed — post-1.0 customer feedback round

- **#2084** — git-hash + path click handlers were unreachable from the React-rewritten Session Chat panel; host substrate from #1613 was intact but the webview never imported the tokenizer or emitted `chatOpenCommit/Path` postMessages (same shape as #1614 mention picker regression). New `chatTokens.tsx` tokenizer + handlers in `ActivityFeedProvider` so commit hashes + paths in BOTH the chat transcript AND the Activity Feed sidebar are clickable. Also catches hashes inside markdown emphasis (`**hash**`, `*hash*`, `~~hash~~`) via additional ReactMarkdown component overrides.
- **Activity Feed didn't populate / didn't persist** — root cause was a triple-miss: no `retainContextWhenHidden`, no host-side replay buffer (`pendingEntries` drained after first `ready`), no client-side `vscode.setState` persistence, plus the poller's `seenEventIds` blocked re-fetching what it had already delivered. Fixed across three layers — `retainContextWhenHidden: true` in the view contribution, new `replayBuffer` (cap 500) replayed on every `ready`, `vscode.setState({ entries })` persistence. Also capped the poller's previously-unbounded `seenEventIds` at 5000 with FIFO eviction, and removed a dead `seenEventIds.has()` check in the log path that was guarded redundantly by `lastLogLengths`.
- **#1670 first-attempt architectural defects** — chat-attachment design that uploaded directly to `/assets` and embedded markdown `<img>` URLs was discarded after the self-review showed five compounding failures (auth headers can't ride `<img src>`, CSP can't allow `http://localhost`, `entity_type` allowlist lacks `prompt`, dataUrl validation gaps, closure-on-cursor bug). Rebuilt around a logical-token + host-cache + `webview.asWebviewUri` architecture (see postmortem doc 299 in the vibeflow project for the full breakdown).
- **CLI installer host allowlist** — GitHub migrated release-asset hosts to `release-assets.githubusercontent.com`; the original exact-match Set rejected those. Switched to a suffix predicate accepting any `*.githubusercontent.com` (still rejects impostors like `evil-githubusercontent.com.attacker.tld`).
- **Chat attachment MIME verification** falsely rejected ~half the allowlist (SVG, RTF, TIFF, BMP, AVIF, HEIC, MP3, MP4, WebM, MOV, FLAC, .doc/.xls/.ppt, ODT/ODS/ODP) because their magic-byte signatures weren't in the sniffer. Reversed the policy to accept-when-no-sniff (allowlist is the upstream gate) + added PE/ELF/Mach-O/Java-class detection to keep the "exe declared as image/png" attack path closed.
- **Chat attachment cache files** had no extension → SVG wouldn't render via `<img>` because the webview asset server couldn't pick a Content-Type and Chromium refuses to image-sniff text-shaped bytes without an explicit type. Changed cache layout to `<cacheRoot>/<id>/<safeName>` so the URL preserves the extension.
- **Chat attachment `clearAll()` race** — logout firing mid-write could leak previous-user bytes into the next session's cache. Added a generation counter; in-flight downloads check it before committing.
- **Chat attachment file-card "Open" via `<a download>`** is unreliable in VSCode webviews (intercepted unpredictably). Replaced with a `chatOpenAsset` postMessage routing through `vscode.open` which picks the right viewer based on file type. Images also bind click-to-open so a screenshot click opens the built-in image viewer at full size.
- **`fix #2042`** — surfaced `session.headlessBacking` in Settings UI + corrected the description for the `auto` value.
- **`fix #2034`** — removed hardcoded `--folder-uri` from `launch.json` (was breaking F5 dev launches).
- **Session Chat Stop button** passed wrong tree-item id; killSession lookup silently no-op'd. Now passes `session-<session_id>` directly.
- **Session Chat Activity rail** — kept recent done items + clarified Refresh button.

### Changed — post-1.0 customer feedback round

- **`uploadAttachment` entity_type** widened from `todo | issue` to `todo | issue | feature | project` (axiomcloud's full allowlist). Chat attachments parent to `project` since `prompt` isn't a valid entity type.
- **`SessionPanelManager.openCommitDiff` + `openWorkspaceRelativePath`** extracted from private methods into a shared `src/views/sessions/chatActions.ts` module so both Session Chat AND Activity Feed click handlers share one implementation (and one set of security checks).
- **Activity Feed entry-merge semantic** in `applyEntries` — `replace: true` with non-empty incoming now merges by id and sorts by timestamp (was: hard replace). Necessary to compose the new client-side `setState` rehydration with the host's replay buffer without duplicate-or-discard pathologies. Empty + `replace: true` still clears (semantics required by `clearActivity`).
- **Per-persona avatar fallback color** added to chat header to match the dashboard.

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
