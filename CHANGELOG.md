# Changelog

## 1.3.2 (2026-07-31)

Automatic CLI update checks, Kiro support in MCP setup, and two chat fixes.

### Added

- **The extension now checks for VibeFlow CLI updates on its own.** Previously you had to run **Check for CLI Update** by hand; it now checks every 12 hours in the background and offers a one-click install when a newer release is out. You are only notified when there is genuinely something newer — never when you are already up to date, and a version you dismiss stays dismissed. Tune or disable it with **`vibeflow.cli.updateCheckIntervalHours`** (`0` turns it off; values under 1 are raised to 1).
- **Kiro CLI can now be set up from the extension.** It appears in the MCP bootstrap picker alongside Codex, Gemini CLI, Cursor, Claude CLI and Claude Desktop, with the same bootstrapped/not-bootstrapped status and removal support. Requires a VibeFlow CLI new enough to support Kiro.

### Changed

- **The extension now reports which editor you use, so your organization can see how many IDE seats are in use.** While you are signed in, three values are sent at most once every 24 hours: the editor you are running (VS Code, Cursor, Windsurf, VSCodium, Kiro, or other), its version, and the extension version. Nothing else — no editor content, file names, paths, workspace or repository names, project data, or record of what you did — and nothing at all while you are signed out. See the **Data collection** section of the README and the [privacy policy](https://axiomstudio.ai/privacy).

### Fixed

- **Long file paths no longer spill outside the chat bubble.** File references in an agent's message now wrap inside the bubble instead of running past its edge and over the next panel.
- **The chat no longer says "Working" when an agent is actually waiting on you.** When an agent asks a question, that message now shows only **Agent needs your input** and its reply box — the animated "Working…" indicator is reserved for when the agent is genuinely busy, and there is now one such indicator rather than several.

## 1.3.1 (2026-07-24)

Cloud Runners polish, a CLI-first agent-launch flow, and correctly scoped notifications.

### Added

- **Resizable Cloud Runners columns** — drag any column's edge to set its width; your widths persist across reloads.
- **Active-step indicator in the Manage wizard** — a numbered stepper highlights where you are (Authenticate → Configure → Launch).
- **Loading states** on **Start authentication** and **Submit code**, so you get immediate feedback while the request is in flight.

### Changed

- **The VibeFlow CLI is now the default way to launch agents.** Onboarding and the walkthrough guide you to it, and the Agent Fleet stays live — click any agent on the left to open its chat. Prefer per-persona VS Code terminals? Turn off **Use VibeFlow CLI** under **Settings → Connection**.
- **Simpler settings** — CLI setup (enable + binary install) now lives on the **Connection** tab; the separate **CLI Interface** tab and the **Sticky Models** tab have been removed.
- **Configure step** — the coding (workspace) agent is now optional and can be deselected, and **Project** is shown read-only as your current project.
- **Cleaner runner list** — one primary action per row (**Manage**, or **Authenticate** when the runner needs sign-in), plus a green dot and a capitalized label for running runners.

### Fixed

- **Notifications are scoped to your own sessions** — "work item complete" toasts no longer fire for other users' or teammates' items.
- **The Status cell no longer clips its label** (the truncated "Ma" action button on narrow columns).

## 1.3.0 (2026-07-23)

The Cloud Runners release — provision, authenticate, configure, and launch cloud-hosted agent runners (Claude, Codex, Cursor) directly from the IDE, and manage the git providers they clone with. The Cloud Runners surface appears when your organization has the feature enabled.

### Added

- **Cloud Runners.** A new Browse section to see your project's cloud-hosted agent runners and their status, and to start, stop, and delete them.
- **Create a runner** from the Work Items **+** menu or the **New Runner** button on the Cloud Runners page — pick the agent (Claude, Codex, or Cursor), API-key or OAuth authentication with the per-agent login method (e.g. Claude subscription / Console / third-party), an optional git provider, and repositories with a branch — ending in a review-before-deploy step.
- **Manage wizard** — **Authenticate** the agent, then **Configure** personas, model, session type, working directory, branch, and worktree, and **Launch** a session on the pod. The Configure form pre-fills from the runner's last saved configuration.
- **Streamlined Authenticate step** — a clickable **Open sign-in page** link plus **Copy** buttons for the sign-in link and the device code, with copied confirmation.
- **Per-agent model selection** with presets and a custom model id.
- **Workspace + advisory personas** — choose exactly one code-writing agent plus any number of advisory personas.
- **Clone repositories into a running pod** from the Manage screen, re-injecting git credentials so push access is restored after a restart.
- **Pod terminal** — open an interactive terminal into the runner pod.
- **Bulk actions** — select multiple runners and start, stop, or delete them at once.
- **At-a-glance runner list** — a health indicator, the owner's email, a one-click contextual action in the status cell, and an automatically refreshing table, with a live runner count on the Browse nav row.
- **Git Configuration** — add and manage account-level git providers (PAT or SSH) from **Settings → Git Configuration** and a **Git Providers** page in Browse. Providers you created in the web are available here too.

### Fixed

- **OAuth sign-in, launch confirmation, and provisioning status now display correctly** for cloud runners.
- **The pod terminal shows large command output without dropping lines.**
- **Clearer error when a repository URL doesn't match the selected git provider** — SSH providers need an SSH URL, PAT/OAuth providers need an HTTPS URL.
- **Deleting a git provider no longer shows a false failure.**

## 1.2.1 (2026-07-04)

### Added

- **Brainstorms in the Documents tree.** The Documents view now includes a **Brainstorms** node, so brainstorm sessions appear alongside your other documents instead of being hidden.

## 1.2.0 (2026-07-03)

A Session-Chat and Browse release — richer chat with avatars, live "working" feedback, and clickable references; clearer signalling when an agent is waiting on you; and paginated Browse tables that stay fast on large projects.

### Added

- **Avatars in Session Chat.** Persona and user avatars now sit beside each message bubble, shown on every headered row for a clearer at-a-glance conversation.
- **Live "working" feedback.** Sending a message shows a working bubble immediately, and sessions surface a live working indicator so you can see when an agent is actively responding.
- **Prompts awaiting input stand out.** When an agent is waiting on your answer, its message is highlighted and the editor tab shows a beacon icon — so you notice it even from another tab.
- **Clickable references in chat.** Issue and todo references render as clickable chips, and commit hashes become links that open the commit — falling back to the remote when it isn't available locally.
- **Paginated Browse tables.** Todos, Issues, Backlog, Security Review, and Pending QA now load incrementally with a **Load more** control, so large projects stay responsive.
- **Configurable CLI launch arguments.** Settings → CLI Interface lets you pass optional launch arguments when opening the CLI, with the launch command logged and a warning when a terminal is reused.

### Changed

- Chat now pins to the bottom instantly when you send, instead of animating, so new messages appear without a scroll lag.

### Fixed

- **Chat scroll no longer jumps** when you've scrolled up to read history.
- **Commit-hash clicks resolve against the session's own repository**, and plain prompt ids and digit runs are no longer mistaken for commit chips.
- **Failed chat attachments now retry** instead of staying broken.
- **Browse review queues load correctly** — corrected the route segments that returned 404 on Security Review and Pending QA, and query/sort now apply to paged tickets.
- **Sessions stay live without a local tmux**, trusting backend liveness instead.
- **Project-view notifications are scoped to your own sessions.**
- **Switching projects reliably closes the previous project's tabs** across all switch paths.
- **CLI launch settings persist and take effect** before the CLI opens.

### Internal

- Cleared npm audit advisories (root + webview dev tooling), and the `check` gate now runs webview tests.

## 1.1.3 (2026-07-01)

A performance and responsiveness release — lighter background polling, a faster session chat, and snappier typing.

### Performance

- **Lighter, smarter background polling.** Every view now shares one refresh timer instead of each running its own, polling **pauses while the editor window is unfocused**, and redundant requests are de-duplicated — so the extension does far less background work.
- **Configurable refresh rate.** Settings → Session Defaults now has a **Refresh rate** card with independent **Live** and **Background** intervals, so you can trade freshness for fewer API calls.
- **Faster session chat.** Chat history loads 20 messages at a time (both the initial view and older history), each refresh fetches only what's new, and the activity log no longer refetches its full contents every tick.
- **Snappier typing.** Fixed chat typing lag that grew with conversation length.

### Added

- **Close old tabs on project switch.** Switching the active project now offers to close the previous project's open VibeFlow tabs.
- **Polling debug log.** Enable `vibeflow.debug.polling` to watch poll activity — including pause/resume on window focus — in a new **"VibeFlow Polling"** output channel.

## 1.1.2 (2026-06-28)

A settings and CLI-integration polish release.

### Added

- **Configure MCP for your coding agents.** A new control under **Settings → Connection** wires the VibeFlow MCP server into your installed coding agents (Claude, Codex, Cursor, Gemini, Claude Desktop) so they can read and update VibeFlow work items — reusing your saved API key and server URL, with no re-entry. Each agent shows whether it's configured, and **Install Latest** now sets this up automatically.
- **Integration Status overview.** The Connection tab shows an at-a-glance summary — API key, the VibeFlow CLI (with its version), and per-agent MCP status.
- **CLI version & updates.** Settings → CLI Interface now shows the installed CLI version with a **Check for Updates** action, plus a **Browse…** picker for the binary path.

### Changed

- MCP setup and integration status now live on the **Connection** tab, next to your API key, so first-time setup reads as one flow.

### Fixed

- When the configured CLI binary path no longer exists, Settings now says exactly that — naming the stale path and pointing you at Browse / Install Latest — instead of a misleading "not installed".

## 1.1.0 (2026-06-25)

A big feature release. Two brand-new collaboration surfaces — a live Brainstorm workspace and a real-time Agent Topology — land alongside a top-to-bottom redesign of the work-management views (Kanban, Dashboard, the Work Item detail panel, and a new Browse sidebar) and a refreshed Session Chat. The extension now also runs in Cursor and other VS Code–compatible editors. (Covers everything since the last published notes, 1.0.3.)

### Added

- **Brainstorm workspace.** A dedicated panel to start, watch, and steer multi-agent brainstorms in real time. Kick one off from a topic, follow the round-by-round discussion as it converges live, see honest convergence and token-usage indicators, and step in with lifecycle controls and deep links. Open it from the Agent Fleet toolbar.
- **Live Agent Topology.** The Dashboard now has an **Explain ↔ Live** toggle. *Live* lays out your actual running agents as a team per branch, with work visibly flowing between personas — animated hand-offs, breathing activity rings, and staleness cues — plus a "huddle" badge when a team is brainstorming. Click any agent to jump straight into its chat session.
- **Browse sidebar.** A new Browse section with one-click access to Todos, Issues, Features, Backlog, Security Review, and Pending QA — each showing a live count.
- **Work-item table views.** Todos, Security Review, Pending QA and more now open as fast, cloud-style tables with instant search, group-by, status-filter pills, inline status changes, and security/QA badges — replacing the older tree lists. Click any row to open its detail panel in a new editor tab.
- **Pull Requests view.** A sidebar list of the project's pull requests.
- **Cursor and multi-editor support.** The extension now installs and runs in Cursor and other VS Code–compatible editors, with documentation tailored to each.

### Changed

- **Work Item detail panel — full redesign.** A modern layout with an at-a-glance header (status, priority, branch, and review gates), a full-width description and metadata area, a grouped easy-to-scan Timeline with relative dates, and an Execution Logs view that renders formatted Markdown in full by default. The review tab is now labelled **QA & Security** since it surfaces both gates.
- **Kanban board overhaul.** All eight workflow columns are shown, with a column-visibility control and smooth horizontal/vertical scrolling; live auto-refresh on a configurable interval with a visible countdown; instant drag feedback that reliably persists; in-board search, type tabs, and a feature filter; per-column info popovers; and the board can now be embedded right under the Dashboard topology behind a toggle.
- **Dashboard queue insight.** Hover any persona to see exactly which work items make up its badge, and click through to open them. Badge counts are now accurate across every persona.
- **Session Chat redesign.** A refreshed persona-conversation layout with a vibrant per-persona color palette, a smoother skeleton loading state, a clearer tmux-attach button, and tidier handling of split diffs and chat-first (no-rail) mode.
- **Guided first run.** New users are now greeted by a Welcome view and walked through setup before the workspace unlocks, so connecting for the first time is a clear, guided path.

### Fixed

- Work-item tables now surface real load failures instead of showing a misleading empty list.
- The Browse → Todos list now loads correctly.
- The Work Item **Change status** action always offers the correct next transitions.
- Server URL validation now accepts IPv6 loopback addresses.
- Brainstorm robustness: duplicate-start protection, clearer error messages, and graceful handling of long topics.

### Security

- Local Gemini credentials are now kept out of version control automatically.

## 1.0.3 (2026-05-26)

A reliability + UX pass on the Session Chat panel. Most of the effort went into fixing the rough edges that surfaced as people actually used chat-first sessions for multi-turn work. Plus a quality push (test scaffolding, integration tests, a meaningful refactor of `sessionCommands.ts`) and a new user-facing documentation suite.

### Fixed — Session Chat

- **Chat upload now works end-to-end.** Two bugs in series: the upload was hitting `POST /attachments` with category `'chat_attachment'`, which isn't in the backend's allowlist — replaced with `'general'`. Then once the chain unblocked, the host read `attachment.asset?.id` from the response but the backend only populates `.asset` in LIST responses (POST returns `attachment.attachment_id` directly). Fixed both; uploads land cleanly now.
- **Stuck "Working…" forever.** Chat polled with `after_id: state.newestId`, which only returns prompts with `id > newestId` — but the agent updates the SAME row in place (`response_text` fills in, id unchanged). `ChatCursor` now tracks `pendingIds: Set<number>` and re-fetches the recent window when something's pending. Webview's `mergeAppend` switched from dedupe-and-drop to upsert-by-id so the chip transitions in place from "Working…" to the agent's actual response.
- **Chat-first multi-turn.** `resolveHeadlessBacking()`'s `'auto'` default mapped to `'vscode'`, which uses `claude --print` (one-shot — agent exits after the single response). Now `'auto'` probes tmux availability and prefers it when available, since the tmux-backed path runs the interactive TUI inside a detached pane and survives multiple turns. The Settings UI labels and `enumDescriptions` were updated to reflect the new behavior.
- **Tmux "duplicate session" on relaunch.** A chat-first relaunch with the previous tmux pane still alive (which is the whole point of tmux backing) hit `tmux new-session: duplicate session`. Now pre-checks `tmuxBacking.hasSession(name)` and reuses the existing pane with a friendly "Reusing existing…" message + kill command.
- **GFM tables in agent responses.** Markdown tables rendered as unstyled HTML (no borders, no header bolding) because `sessionChat.css` had table rules scoped to `.msg-content` only. Extended the selectors to also cover `.msg-response`; added `width: max-content` / `max-width: 100%` for natural wrapping and `vertical-align: top` for cleaner multi-line cells.
- **Commit-hash auto-link no longer false-positives on UUID fragments.** The 7-hex-char fragment of a UUID prompt id (e.g. `80998aa-42ec-…`) was being rendered as a clickable commit hash. Tightened `RE_COMMIT` to reject `-<hex>` adjacency in both lookbehind and lookahead.
- **Commit hashes inside inline backticks are now clickable.** `` `b0dd753` `` in chat prose used to render as a plain code span; now it's a clickable button that opens the commit-details editor, mirroring the bare-hex behavior.
- **Commit-diff click now works in monorepos / subfolder-open setups.** `openCommitDiff` used strict `r.rootUri.fsPath === folder.uri.fsPath` to find the git repo, which failed silently when the workspace folder ≠ repo root. Replaced with a 4-rule cascade: exact match → workspace-inside-repo → repo-inside-workspace → single-repo trust. Click → VS Code's native Commit Details editor opens for real instead of the terminal-fallback prompt.
- **Bare-basename chat links fall back to Quick Open.** When the agent references a deeply-nested file by just its basename (e.g. `SessionPanelManager.ts` intending `src/views/sessions/SessionPanelManager.ts`), the workspace-relative open used to fail with "Could not open" toast. Now falls back to `workbench.action.quickOpen` prefilled with the basename — user picks from a fuzzy-matched list in 1-2 keystrokes.
- **Vibeflow-doc filenames no longer render as broken file links.** Agent-emitted references like "Updated context: vscode-extension-v2-context.md" were being matched by the path tokenizer and rendered as clickable links that fail (the file lives in the VibeFlow backend, not the workspace). The path tokenizer now skips filenames matching known vibeflow conventions (`*-context.md`, `*-architecture.md`, `prd-*.md`, `arch-*.md`); they render as plain text instead.
- **Hidden the agent-readable `_Agents:_` attachment footer from the visible transcript.** The footer is metadata for sibling agents, not the user — it leaked into the chat as a stylized italic block. Now stripped from the user-visible body while still flowing through to other agents via the wire payload.
- **Reattach prompt no longer offers to spawn duplicates for tmux-backed sessions.** `SessionReattacher.detectPhantoms` checked the backend's live-session list but not tmux — so a tmux-backed session whose pane was still running looked like a phantom and the reattach prompt would have spawned a SECOND agent process for the same session id. Now skips phantoms whose `buildHeadlessTmuxName(...)` is reported alive by `tmuxBacking.hasSession`.
- **Autonomous-agent hint suppressed in chat-first mode.** The "agent is running autonomously — won't reply to plain chat" stale-pending hint was added pre-WorkingIndicator era when `pending` looked like a bug. In chat-first mode the agent DOES reply via `response_text` — the hint is actively wrong there. Still shows in vanilla / vibeflow (terminal-driven) modes where it remains accurate.
- **Gemini external-auth detection now covers gcloud ADC + legacy creds.** `detectExternalAuth` only checked `~/.gemini/credentials`, but the matching error message told users to run `gcloud auth application-default login` — which writes to `~/.config/gcloud/application_default_credentials.json`, a path the detect didn't look at. Users following the help text hit "no API key found" anyway. Now checks all three paths in priority order: gemini-cli's own credentials → gcloud ADC → gcloud legacy. The empty-Enter path on the wizard's GEMINI_API_KEY prompt finally works for users who logged in via Google account.

### Changed — Session Chat

- **Side rail hidden in chat-first mode.** The right-side rail (Current Task + Activity ledger) is work-item-driven; chat-first agents don't claim work items, so the rail rendered empty placeholders. The entire rail + its "Show details / Hide details" toggle are now skip-rendered in chat-first mode and the grid collapses from `1fr 340px` to `1fr` so the chat fills the whole panel. Vanilla + vibeflow modes get the rail as before.
- **Chat input snappier on long transcripts.** A perf triplet that targets the most likely lag sources without behavior change: (1) `React.memo` on `MessageBubble` (the transcript was rendered as a plain `messages.map(...)` with zero memoization, re-running `react-markdown` + `rehype-highlight` on every keystroke); (2) `useDeferredValue` on the messages array so the textarea draft paints before the transcript catch-up; (3) 200ms debounce on the `@mention` picker's host fetch so a fast typist doesn't fire one REST round-trip per keystroke. Bisectable per-commit if any of them regresses.

### Added — Project Quality

- **Vitest unit-test scaffold + first cohort.** 146 tests across 8 files — pure-function modules with the highest regression-risk (`serverUrl`, `nonce`, `html`, `personas`, `mentionParser`, `chatRenderer`, `feedStateController`, plus three exported helpers from `sessionCommands.ts`). `yarn test` runs in ~200ms; `yarn test:coverage` shows ≥90% branch on every self-contained cohort file. `yarn check` (the CI gate) now runs typecheck + lint + unit tests + the existing build-time security guards in one shot.
- **Integration-test cohort via `@vscode/test-electron`.** New `src/test/integration/` runner + mocha bootstrap + activation suite. Asserts that the extension activates within 60s, every advertised `vibeflow.*` command registers, every advertised view registers, and the #1947 cached-serverUrl preflight survives the OK branch. `yarn test:integration` downloads a real VS Code build and runs the suite in headless Electron — deliberately separate from `yarn check` so the 30s cold-run + 210 MB download doesn't slow the pre-commit gate.

### Internal — Architecture

- **`sessionCommands.ts` split from 1472 LOC to 819 LOC.** Helpers + lifecycle commands extracted to focused modules under `src/commands/launchWizard/` (providers, project-status formatter, `.mcp.json` writer + git-ignore guard) and `src/commands/sessionLifecycle.ts` (kill/delete/restart/focus). All four new modules are under 400 LOC; lint went from 4 errors → 0/0. Pure mechanical extraction — zero behavior change. The `launchSession` wizard itself stayed put pending a future attended decomposition pass that needs an end-to-end wizard walkthrough harness.
- **`mentionParser` dedup.** The webview-side `mentionParser.ts` was a near-verbatim copy of the host file; webview now re-exports from the host canonical via a 17-line shim (using the same cross-tree-relative import pattern the codebase already uses for `webview-ui/src/components/comments/types.ts` and similar). Eliminates the dual-life maintenance trap.

### Added — Documentation

- **User-facing documentation suite at `docs/user-guide/`** — 8 docs covering Getting Started, Feature Tour, Workflows & Flows (with Mermaid diagrams), Chat-First Mode, Settings Reference, Troubleshooting, FAQ, and a Glossary. Repo-root `README.md` now points at the suite index.

### Chore

- **`.vscodeignore` tightened.** Excludes the integration-test compile output (`out/**`), test configs (`tsconfig.test*.json`, `vitest.config.ts`), internal `TESTING.md`, and dev scripts (`scripts/**`). Cuts the published `.vsix` size roughly in half — internal test JS is no longer dead weight in the marketplace download.

## 1.0.2 (2026-05-20)

Onboarding-focused patch release. Post-1.0.1 beta feedback surfaced a chain of UX dead-ends in the wizard, the Agent Fleet tree, and the CLI handoff — all fixed here. Plus a polish pass on the editor-area panels (Settings, Dashboard, Kanban, Compliance) that had been accumulating in the working tree since 1.0.1.

### Fixed — Launch wizard & onboarding

- **Launch wizard preflight gates** (#2174) — the PROVIDER picker and per-persona override picker now tag missing-binary providers (`· $(error) not installed`) and abort with an actionable error if a tagged provider is selected. New `PROVIDER_BINARIES` table mirrors the canonical mapping in `SettingsPanel.ts`, including cursor's two-name `cursor-agent`/`agent` fallback. Codex/Gemini API-key inputs now validate against a conservative min-length floor (catches `abc123` / empty / whitespace fakes) and reject empty input with a clear remediation hint pointing at Settings → Providers. `clearWhichBinaryCache()` runs at wizard entry so install-then-relaunch works in the same VS Code session.

- **Empty-Enter detects external auth** (#2179) — self-correction to #2174. New `detectExternalAuth(envName)` helper checks `process.env[envName]` for any provider, plus `~/.gemini/credentials` for Gemini. When external auth is present, the wizard surfaces an info message ("Using GEMINI_API_KEY from your shell environment") and proceeds without setting the env var — the spawned terminal inherits parent env via `vscode.window.createTerminal`'s default merge. Only aborts with a clear error when no auth is configured anywhere.

- **CLI handoff PID-lock guard** (#2181) — when `vibeflow.cli.enabled=true` AND an external vibeflow-cli is already holding `~/.vibeflow-cli/vibeflow.pid`, the launcher now shows a modal warning ("Quit your existing vibeflow-cli and rerun the step…") + Retry/Cancel buttons instead of silently dropping the user to a bare shell. New `getRunningCliPid()` helper mirrors the Go-side `pidlock.go` semantics via `process.kill(pid, 0)`.

- **`.mcp.json` writes use extension's own token first** (#2184) — `ensureMcpConfig` previously sourced the bearer token ONLY from `~/.vibeflow-cli/config.yaml`; extension users without the CLI installed got a silent skip and the spawned agent had zero VibeFlow MCP tools. Now resolves extension secret store first (via new `VibeFlowClient.getToken()`), CLI config as fallback, and shows a loud error when neither source has a token. Side-benefit: closes the CLI-vs-extension auth-identity hijack — when both are signed in as different users, the agent now boots with the extension's identity (the one the user actually sees in Agent Fleet).

### Fixed — Agent Fleet tree

- **Pending sessions stall sweep + Dismiss** (#2175) — a tester reported pending session rows stuck in `starting... (1009s)` forever when `session_init` never returned. New `PENDING_STALL_THRESHOLD_MS = 120s`; `fetchAndRefresh` now transitions stuck `starting` entries to `failed` after the threshold (preserves any prior `markFailed`-captured stderr). Failed rows gain a Dismiss action (inline × on hover + right-click menu) so users can clear them without `Reload Window`.

- **Cancel action on `starting` rows** (#2178) — previously the right-click menu for `pendingSessionStarting` rows was empty (no way to stop a stuck pending launch). New `vibeflow.cancelStartingPending` command sends SIGTERM to the child via the new `SessionStreamRegistry.killByHandleId()` helper, then removes the UI row. Surfaced as both an inline stop button on hover and a right-click context menu entry.

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
