# Feature Tour

**Who this is for**: You've finished [Getting Started](getting-started.md), the extension is installed, you're signed in, and you have a project picked. Now you want to know what every button, view, panel, and command actually *does* before you go deeper.

**TL;DR**: VibeFlow ships four sidebar TreeViews, one bottom-panel webview, six editor-area panels, a chat participant, a status bar quartet, and 43 commands. This page walks you through them in the order you'll hit them.

> Jargon in **bold** is defined in [the glossary](glossary.md).

---

## 1. The VibeFlow Activity Bar icon

The VibeFlow icon sits in VS Code's **Activity Bar**. Click it and VS Code opens the **VibeFlow container**, which stacks four TreeViews vertically:

1. **Agent Fleet**: your running sessions
2. **Work Items**: todos and issues you can act on
3. **Project Items**: the same work, tree-shaped under features
4. **Documents**: PRDs, architecture, design specs attached to the project

The first two are expanded by default. **Project Items** and **Documents** start collapsed. Each view has a title-bar action row (icons that appear on hover), covered inline below.

---

## 2. Agent Fleet view

**What it is**: a live list of every agent session for this project. Each row represents one **session**, meaning one running agent with a persona, a branch, and a provider.

**Groups**:

- **Active sessions**. Agents alive right now (registered in the last ~60s). Branch shows in the row label; persona icon on the left.
- **Pending sessions**. Sessions being spawned (`pendingSessionStarting`) or that failed to spawn (`pendingSessionFailed`). Inline action buttons let you intervene without opening a menu.
- **Worktrees**. Git worktrees under `.claude/worktrees/` (or `vibeflow.worktree.baseDir`). Each row knows its branch so you can spawn an agent into it.

### Right-click menu (active or inactive session)

- **Focus Terminal**. Jump the terminal pane to this session.
- **Kill Session**. Stop the agent. Row moves out of *Active*; the record stays.
- **Restart Session**. Kill and re-spawn with the same persona/branch/provider.
- **Delete Session**. Remove a stopped session entirely.
- **Kill Session & Forget**. Kill (if alive) *and* delete in one click. For wedged agents.
- **Copy Session ID**. Copies `session-<timestamp>-<uuid>`. For support tickets.
- **Open Session Panel** (titled *View Session Details*). Opens the [Session Chat panel](#session-chat-panel).

### Inline buttons (pending session rows)

- **×** (Cancel Starting Session). On `pendingSessionStarting`. Aborts the spawn before the terminal opens.
- **Trash** (Dismiss Failed Pending Session). On `pendingSessionFailed`. Removes the failure marker.

### Worktree rows, right-click

- **Create Session Here**. Launch wizard pre-filled with this worktree's branch.
- **Open Worktree in New Window**. Opens the worktree as a separate VS Code window.
- **Delete Worktree**. Removes the worktree (runs `git worktree remove` for you).

### Title-bar actions

- **+ Launch Session** (play icon). The entry point for spawning a new agent. Opens the launch wizard. (When `vibeflow.cli.enabled` is true this is replaced by **Open CLI**.)
- **Open Dashboard**. See [Dashboard panel](#dashboard-panel).
- **Refresh**. Force a tree refresh now.
- **Show All Agent Terminals**. Open or focus every active session's terminal at once.
- **Settings**. Opens the [Settings panel](#settings-panel).

---

## 3. Work Items view

**What it is**: a flat list of every **todo** and **issue**, grouped by **status**. Features aren't shown here. That's [Project Items](#project-items-view)'s job. This is the action-oriented surface, where you do governance, change priority, or open a work item to read its log.

### Default groups (top to bottom)

- **In Review**: newly created items awaiting promotion.
- **Planning**: claimed by a persona, plan being drafted.
- **Ready to Implement**: plan signed off, waiting for a code agent.
- **Implementing**: an agent is actively writing code.
- **Done**: agent finished; both governance gates pending.
- **Security Reviewed / QA Verified**: items partway through governance.
- **Closed**: fully verified.

Each row shows title, ID (`#1982`), priority badge, and review/security badges.

### Right-click menu

- **Open Work Item Panel**. Opens the full detail editor (see [Work Item Detail panel](#work-item-detail-panel)).
- **Change Status**. Pick a new status from a Quick Pick.
- **Change Priority**. `high` / `medium` / `low`.
- **QA Verify**. Flip `qa_verified=true` on a `done` item.
- **QA Reject**. Push it back to `implementing` with a reason.
- **Security Approve**. Flip `security_reviewed=true`.
- **Security Reject**. Push back with a reason.

> QA Verify / Reject only appear on rows in `done`. Security Approve / Reject appear on any todo or issue row. The menu hides actions that don't apply.

### Title-bar actions

- **+ Create Work Item**. Opens the create wizard (feature or issue? title? priority?).
- **Open Kanban Board**. See [Kanban Board panel](#kanban-board-panel).
- **Open Compliance**. See [Compliance panel](#compliance-panel).
- **Refresh**, **Settings**.

---

## 4. Project Items view

**What it is**: the same work as **Work Items**, but shaped hierarchically. Each **feature** is a top-level node with its todos and linked issues as children. Standalone issues appear at the root alongside features.

Use this view to understand the shape of the project; use Work Items for day-to-day action. Click any leaf to open the same Work Item Detail panel. Title-bar actions: **Refresh**, **Settings**.

---

## 5. Documents view

**What it is**: a flat list of every **document** attached to the project, plus the features and work items that have docs hanging off them. Documents are markdown: PRDs, architecture notes, design specs, runbooks, uploaded by you or authored by an agent.

Click a row to open the [Document Viewer](#document-viewer) in the editor area.

Title-bar actions: **+ Create Document** (new untitled doc, attached to a project / feature / work item), **Refresh**, **Settings**.

---

## 6. The VibeFlow Monitor panel (Activity Feed)

The **VibeFlow Monitor** is a second viewsContainer. It lives in VS Code's bottom panel (next to Terminal, Problems, Output). Drag its tab to the right side if you prefer a sidebar layout. Inside it sits one webview: the **Activity Feed**.

### The Activity Feed itself

A real-time stream of every meaningful event: session claims, status transitions, commits, comments, pending prompts. Newest at the top. The webview retains scroll position even when hidden.

### Empty states

The feed renders one of four empty states when there's nothing to show:

- **auth-needed**: you're not signed in yet. Shows a Sign In button that runs `VibeFlow: Setup`.
- **no-project**: signed in but no project linked to this workspace. Shows a Pick Project button.
- **no-sessions**: project linked but no sessions have ever run. Shows a Launch Session button.
- **healthy-empty**: sessions have run but everything is quiet right now. A soft "all caught up" indicator.

### Pinned Plan section

When an Architect or Principal Engineer publishes a **plan** to a work item, that plan pins to the top of the Activity Feed. So when you context-switch back in, "what plan am I supposed to be reviewing?" is the first thing on screen.

Title-bar actions: **Clear Activity Feed** (empties the local cache; events on the server are unchanged), **Settings**.

---

## 7. Editor-area panels

These open in VS Code's main editor area (the same place files open). They're full webviews with rich React UIs.

### Session Chat panel

**What it shows**: a transcript of one session. User messages, agent thinking, tool calls, diffs, commits, with the persona avatar on each turn.

**Who can type into it**:

- **Vanilla mode** → input disabled. The agent talks to its terminal, not to you; chat is read-only.
- **Chat-First Mode** → input is *the* interaction surface. Type, attach, paste, send.

Diffs render with a `+/-` gutter or split view (`vibeflow.chat.diffView`). Each diff has an **Open in Editor** button that opens VS Code's native diff editor. Commit hashes are clickable. Pending prompts appear as a yellow banner with a Respond button.

Open via **Open Session Panel** on an Agent Fleet row.

### Work Item Detail panel

**What it shows**: the full record for one todo or issue:

- **Header**: ID, title, priority, status, target branch.
- **Description**: rendered markdown.
- **Execution log**: the rolling log the agent appends via `publish_todo_log` (thinking, actions, observations, diffs, milestones).
- **Comments**: threaded user/agent commentary.
- **Governance actions**: QA Verify/Reject and Security Approve/Reject, gated by status.
- **Linked PR**: a hyperlinked badge once a PR is opened.

Open via **Open Work Item Panel** on a Work Items row, or click a Project Items leaf.

### Document Viewer

**What it shows**: a single markdown document, rendered with the same theme as the rest of VibeFlow. Headings, code blocks (syntax-highlighted), tables, callouts. Read-only. Edits happen via the Create Document flow or via your code agent.

Open by clicking a row in the [Documents view](#documents-view).

### Settings panel

**What it shows**: every VibeFlow setting, organised into **8 tabs**. The tabs in order (from `webview-ui/src/components/settings/SettingsView.tsx`):

1. **Connection**: server URL, API key, project picker.
2. **Providers**: which CLI binaries are on PATH, per-provider env tokens (Codex `MCP_TOKEN`, Gemini `GEMINI_API_KEY`).
3. **Session Defaults**: default provider, terminal mode, headless backing, chat diff view.
4. **Sticky Models**: per-persona pinned model (so Architect always uses Sonnet, Developer always uses Haiku, etc.).
5. **Worktrees**: base directory, auto-create-on-launch, cleanup-on-kill.
6. **Notifications**: toggle agent-prompt and work-item-complete notifications, set polling interval.
7. **CLI Interface**: toggle delegating session management to `vibeflow-cli`, set binary path.
8. **About**: extension version, install detection info, repo links.

The header carries a version badge and a **Done** button. Settings persist as soon as you change them. There's no Save button.

Open via the gear icon in any view's title bar, or run **VibeFlow: Settings**. For exhaustive per-setting documentation see [settings-reference.md](settings-reference.md).

### Dashboard panel

A visual topology of the agent fleet plus project metrics.

![VibeFlow Dashboard in VS Code — agent topology and project metrics](/images/vscode-1.webp)

- **React Flow agent topology**: session nodes, edges showing which session is on which work item / branch. Drag to pan, scroll to zoom.
- **Metrics cards**: counts by status, commits today, prompts pending, governance throughput.
- **Refresh button**: force-pull from server.

Open via **Open Dashboard** on Agent Fleet's title bar, or `Cmd/Ctrl+Shift+V D`.

### Kanban Board panel

A drag-and-drop swimlane board, one column per status. Each card is a todo or issue. Drop a card across columns to move it through the lifecycle (same MCP transition as the right-click menu).

![VibeFlow Kanban Board in VS Code — work items organized by status](/images/vscode-2.webp)

Open via **Open Kanban Board** on Work Items, or `Cmd/Ctrl+Shift+V K`.

### Compliance panel

Open **compliance findings** grouped by framework: **SOC 2**, **ISO 27001**, **PCI-DSS**, **HIPAA**. Each finding links to its source work item, framework clause, and agent evidence.

Open via **Open Compliance** on Work Items, or `Cmd/Ctrl+Shift+V C`.

---

## 8. Status Bar items

VS Code's status bar (the thin coloured strip at the very bottom of the window) carries four VibeFlow indicators:

- **VibeFlow connection status** (left side). Shows the connection state to the cloud server. A persona-prompt-count badge sits next to it: when one or more agents are waiting on a user response, this badge counts them. Click to run **VibeFlow: Respond to Prompt**.
- **Work summary** (right side). A rolling one-liner like "12 implementing, 3 done, 2 pending QA". Click to focus the Work Items view.
- **Branch review status** (right side). Shows a check (✓) when every work item targeting your current branch has passed both security and QA. A partial state shows the count outstanding. Click to open a checklist for the current branch. Handy for the "is this branch shippable?" gut check before opening a PR.
- **Project switcher**. Sits next to the connection status. Shows the linked project name. Click to run **VibeFlow: Switch Project…**.

---

## 9. The @vibeflow Chat Participant

If you use GitHub Copilot Chat (or any IDE chat that supports the participant protocol), VibeFlow registers itself as a participant. Type `@vibeflow` in the chat input and one of seven slash commands:

- **/status**: project, feature, and session status at a glance.
- **/create**: create a feature, todo, or issue from chat.
- **/review**: list items currently needing QA or security review.
- **/summary**: work summary and high-level metrics (mirrors the status bar one-liner).
- **/launch**: launch an agent session from chat (skips the wizard for power users).
- **/respond**: respond to a pending agent prompt without leaving Copilot Chat.
- **/compliance**: show open compliance findings for the current project.

The participant lives at `vibeflow.chat` in package.json and is *not sticky*, so it doesn't claim the chat scope by default.

---

## 10. Commands you'll use most often

VibeFlow registers 43 commands. Here are the ten worth memorising. Every one is reachable via `Cmd/Ctrl+Shift+P` → type "VibeFlow:". Shortcuts in parentheses where bound.

- **VibeFlow: Setup**. Runs the 3-step onboarding wizard. Re-run whenever you change server, key, or project.
- **VibeFlow: Launch Session** (`Cmd/Ctrl+Shift+V L`). Opens the launch wizard to spawn an agent.
- **VibeFlow: Create Work Item** (`Cmd/Ctrl+Shift+V N`). Quick-add a todo or issue without leaving the keyboard.
- **VibeFlow: Open Dashboard** (`Cmd/Ctrl+Shift+V D`). Agent topology and metrics.
- **VibeFlow: Open Kanban Board** (`Cmd/Ctrl+Shift+V K`). Drag-and-drop board of work items.
- **VibeFlow: Open Compliance** (`Cmd/Ctrl+Shift+V C`). Open compliance findings.
- **VibeFlow: Switch Project…** (`Cmd/Ctrl+Shift+V P`). Rebind the extension to a different project without reloading.
- **VibeFlow: Manage Worktrees**. List / create / delete git worktrees the extension is aware of.
- **VibeFlow: Create Pull Request**. Opens a PR for the current branch, populated with the work items closed on it.
- **VibeFlow: Settings** (`Cmd/Ctrl+Shift+V S`). Opens the Settings panel.

Other useful keys: `Cmd/Ctrl+Shift+V R` runs **Respond to Prompt**, `Cmd/Ctrl+Shift+V F` runs **Refresh**.

---

## 11. Where each setting lives

Every setting on the Settings panel has a dotted config key under `vibeflow.*` (e.g. `vibeflow.session.terminalMode`, `vibeflow.worktree.cleanupOnKill`). The Settings UI is the friendly face. The raw keys are available via VS Code's standard `Cmd/Ctrl+,` settings editor too. Search for `vibeflow.` to see them all.

For a per-setting reference (exhaustive descriptions, defaults, enum values, when to change each), see [the settings reference](settings-reference.md). For workflow-level context on *when* you'd reach for a given setting, see [the workflows guide](workflows-and-flows.md). For terminology, [the glossary](glossary.md).

That's the tour. From here, [the workflows guide](workflows-and-flows.md) walks you through what the pieces look like in motion.
