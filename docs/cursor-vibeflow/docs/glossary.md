# Glossary

**Who this is for**: Anyone reading the rest of the user guide. New terms appear in **bold** the first time; every one of them is defined here.

**TL;DR**: VibeFlow has its own vocabulary. This page is the cheat sheet.

---

## Core concepts

### Agent
A long-running AI process that thinks and writes code on your behalf. VibeFlow runs **multiple** agents at once, each playing a different role (see *persona*). Agents run in the **VibeFlow CLI**.

### Persona
The role an agent plays. VibeFlow ships with nine team personas: **Developer** (Alex), **Architect** (Morgan), **Principal Engineer** (Kai), **Product Manager** (Aria), **Project Manager** (Parker), **UX Designer** (Dana), **QA Lead** (Quinn), **Security Lead** (Sophie), and **Customer** (Casey) — plus **Vera**, the Code Reviewer. You start one agent *per persona*. They poll independently for work that matches their role.

> *Code agents* (Developer, Architect, Principal Engineer) write source code. *Advisory agents* (everyone else) write specs, reviews, and comments. They don't commit code.

### Session
One running agent instance. A session has a **persona**, a **branch** (the git branch it operates on), and a **provider** (which model backs it). The **Agent Fleet** view lists the sessions the CLI is running.

### Provider
The AI model CLI behind an agent — for example **Claude** (Claude Code), **Codex** (OpenAI), or **Gemini** (Google). You pick it in the VibeFlow CLI when you start an agent, and the provider's own CLI handles its sign-in. The **Cursor** provider (the `cursor` CLI) is distinct from the Cursor editor you're running VibeFlow in.

### Project
A VibeFlow project. Maps roughly to one of your code repositories. Created on the **VibeFlow Cloud** server. Identified by a name (e.g. `vscode-vibeflow`) plus a numeric ID. Pick it in the sidebar's project dropdown; the extension also auto-detects it from your workspace's git remote URL.

### MCP (Model Context Protocol)
The protocol agents use to talk to the VibeFlow Cloud server. When an agent calls `list_features` or `create_todo`, it's making an MCP tool call under the hood. The CLI wires this up for the agents it starts; **Settings → Connection → MCP for coding agents** writes the same config for coding agents you run yourself.

---

## The VibeFlow CLI

### VibeFlow CLI (`vibeflow`)
The terminal app that launches and runs your agents, each in its own tmux pane. It's the only launch path: **VibeFlow: Launch Session** and **Open CLI** open it in an editor-area terminal. Install it from **Settings → Connection → VibeFlow CLI → Install Latest**. Needs macOS, Linux, or Windows through **WSL**.

### CLI root
The directory the CLI keeps its state in: `config.yaml` (server URL, API key, default project) and `sessions.json` (the agents it runs). The default root is under your home directory; `vibeflow.cli.rootPath` points the extension at a custom one.

### Connection mirror
Saving the API key or a successful **Test Connection** in Settings → Connection writes the extension's server URL, API key, and current project into the CLI's `config.yaml`, so the CLI and the extension use the same account and project.

### WSL
Windows Subsystem for Linux. The CLI needs tmux, which native Windows lacks, so on Windows you run Cursor against a WSL folder (**Reopen Folder in WSL**) and install the CLI there.

---

## Work items

### Work item
Catch-all for the three things you can track in VibeFlow: a **feature**, a **todo**, or an **issue**. Each has a numeric ID (`#123`) and a status that moves through a defined lifecycle.

### Feature
A container for related work. A feature can hold many **todos**. Example: "VSCode Extension for VibeFlow" is a feature; "Add CLI auto-download" is a todo inside it.

### Todo
A discrete piece of work *inside a feature*. Always has a parent feature. Example: "Wire Agent Fleet TreeView to live MCP API data."

### Issue
A discrete piece of work that *doesn't fit under a feature*. Typically a bug, a standalone fix, or a cross-cutting change. Issues sit at the project level. They *can* be linked to a feature for context but don't require one.

### Status
The lifecycle stage of a work item. The flow:

> `in_review` → `planning` → `ready_to_implement` → `implementing` → `done` → *security review* → *QA review*

When you create a work item from chat, it lands in `in_review`. A human (or a PM agent) decides whether to promote it. Once it reaches `ready_to_implement`, an agent with that persona's intake can claim it.

### Priority
`high`, `medium`, or `low`. Agents pick `high` first, then `medium`, then `low`. Within a priority band, *issues* before *todos*.

### Claim
What happens when an agent picks up a work item. The status moves to `planning`, the agent's session ID is recorded in `claimed_by`, and other sessions know to skip it.

### Branch (target branch)
Every work item carries a `target_branch` (defaults to `main`). Sessions filter by branch so a session running on `feature/foo` only sees items targeting `feature/foo`. Prevents the wrong agent from picking up the wrong work.

---

## Sessions

### YOLO mode
"You Only Live Once." A permission mode where the agent executes file edits, shell commands, and git operations without asking. Trade safety for speed. Chosen in the CLI when you start an agent.

### Vanilla mode
The opposite of YOLO. The agent asks permission for every action that could change the world. Slower but safe.

### Chat-First Mode
An older session mode of the extension's own launcher, where the agent ran hidden and the **Session Chat** panel was its only input. New agents launch from the CLI; existing chat-first sessions keep working. See [chat-first-mode.md](chat-first-mode.md).

### Reattach
When you reopen Cursor, the extension looks for `.vibeflow-session-{persona}` files in the workspace, asks the server which of those sessions are still alive, and offers to reconnect them. Killed sessions don't auto-reattach.

### Stalled
An Agent Fleet status: the agent's tmux pane is alive but it has stopped sending heartbeats — it left its polling loop. Restart it from the row's right-click menu.

---

## Views, panels, and commands

### View
A pane in Cursor's sidebar. VibeFlow's sidebar holds the **Project** dropdown, **Agent Fleet**, **Work Items**, **Browse**, **Pull Requests**, and **Documents** (plus a **Welcome** view before you're set up). The **Activity Feed** lives in the separate **VibeFlow Monitor** panel.

### Project dropdown
The first pane in the VibeFlow sidebar: your projects, with the current branch below. Switching projects rescopes every view and closes the previous project's VibeFlow panels.

### Agent Fleet
The view listing exactly the agents the VibeFlow CLI is running, across all projects, grouped by project with the current one first.

### Activity Bar
Cursor's leftmost strip with the icons (Explorer, Search, Source Control…). VibeFlow adds a custom icon there.

### Activity Feed
A real-time stream of what agents are doing: claims, status transitions, commits, prompts to you. Lives in the **VibeFlow Monitor** panel (bottom panel by default).

### Session Chat panel
An editor panel where you talk to one specific agent. Shows the conversation transcript, lets you send messages, renders diffs, and makes commit hashes, file paths, and work-item references clickable.

### Work Item panel
An editor panel showing details for one work item: description, execution log, comments, and governance actions (QA verify/reject, security approve/reject).

### Walkthrough
Cursor's built-in onboarding tutorial. Opens automatically the first time you install the extension. Title: "Get Started with VibeFlow."

### Command Palette
Cursor's `Cmd/Ctrl+Shift+P` menu. Every VibeFlow action is registered there with a `VibeFlow:` prefix. Type "VibeFlow:" and you'll see all 53 commands.

### `@vibeflow` chat participant
A chat participant registered through VS Code's Chat Participant API. A host extension that consumes that API (such as GitHub Copilot Chat) surfaces it: type `@vibeflow` and run `/status`, `/create`, `/review`, `/summary`, `/launch`, `/respond`, or `/compliance`. Cursor's own built-in chat is a separate system and will not surface `@vibeflow`. VibeFlow's own **Session Chat panel** is unaffected and works fully in Cursor.

---

## Pull requests and code review

### Vera
The **Code Reviewer** persona. Reviews pull requests in rounds and posts findings, blockers first. Shows in Agent Fleet as **Vera · Code Reviewer**; a review needs a Vera agent running in the CLI to pick it up.

### Review state
Vera's label for a PR — for example **Findings to address**, **Fixes queued**, or **Reviewed** — shown on the PR's row in the **Pull Requests** view, with the round (`round 2/3`) and unresolved blockers.

### Finding
One issue Vera raised on a PR, with trigger, impact, evidence, and a `file:line` that opens in the editor. **Blockers** must be resolved (fixed, or dismissed with evidence) before the review can pass.

### Vera review panel
The editor panel for one review: summary, the review cycle, findings, and controls (re-run, pause, continue, retry PR update, dismiss/reopen findings).

### Review policy
Per-repository settings for Vera: enabled, trigger (Manual / Once when ready / Every update), maximum rounds, skip drafts, whether coding agents may fix blockers, and questions per PR. Project owners and org admins edit it in Settings → **Project**.

---

## Governance

### Governance
The framework for letting humans gate AI-generated code. Two gates after an agent marks a work item `done`: **security review** (Sophie, a Security Lead agent or human) then **QA review** (Quinn, a QA Lead agent or human). Items in `done` show up in the **Work Items** view with badges showing which gates they've passed.

### Security review
The gate after `done` and before `qa_verified`. The Security Lead persona inspects the diff for security issues (token leaks, command injection, CSP gaps, etc.). Approves or rejects with a comment. Approval flips `security_reviewed=true`.

### QA review
The gate after security. The QA Lead persona walks through the acceptance criteria, runs builds/tests if relevant, and validates that the change does what it claims. Approval flips `qa_verified=true`. Once both gates pass, the work item is fully closed.

### Branch review status
A status-bar indicator showing how many items on your current branch have passed both gates. Click it to open a checklist. Useful before opening a pull request: it tells you whether the branch's work is fully reviewed.

---

## Git plumbing

### Worktree
A separate working directory checked out to a different git branch, in the same repository. The CLI can run an agent in a worktree so a Developer agent works on `feature/foo` while you work on `main`, with no `git stash` shuffling. Agent Fleet's **Worktrees** section lists them.

---

## Authentication

### API key
The bearer token the extension uses to talk to the VibeFlow Cloud server. You set it once via the **VibeFlow: Setup** wizard or the **Settings → Connection** tab. Stored encrypted in Cursor's per-machine **Secrets API**, and mirrored into the CLI's `config.yaml` (see *Connection mirror*). Never committed; never logged.

### Secrets API
Cursor's built-in encrypted storage for sensitive values. Per-machine, per-extension. VibeFlow stores the VibeFlow API key there.

### Setup wizard
The 3-step onboarding flow (Server URL → API Key → Project) that runs the first time you install the extension. Re-runnable via **VibeFlow: Setup** in the Command Palette.

---

## Less-common terms

### Prompt
A message from an agent asking the user to make a decision. Appears as a notification plus a row in the **Activity Feed**. Use **VibeFlow: Respond to Prompt** or the inline reply box in chat to answer.

### Compliance finding
A flagged item from the Security Lead persona tied to a specific compliance framework (SOC 2, ISO 27001, PCI-DSS, HIPAA, GDPR, FedRAMP, CMMC). Visible in the **Compliance** panel. Each finding links to the work item where it was found and the framework clause it relates to.

### Brainstorm
A multi-persona brainstorm session: several agents review and refine a shared working-draft document over a few rounds before it's finalized. Brainstorms show up under the **Documents** view's **Brainstorms** category; selecting one opens its brainstorm document (the finalized write-up once the session is done, otherwise the live working draft).

### Working indicator
The right-side status-bar item (`$(sync~spin) Working …`) that shows when *your* agent sessions are actively working, with a count and elapsed time. It aggregates only your own sessions and fades out shortly after they go idle. Distinct from the in-chat **Working…** bubble, which is scoped to a single session's current turn.

### MCP server (the editor kind)
Distinct from the MCP *protocol*. VS Code exposes a separate concept of an "MCP server" that other Copilot-like extensions can discover. The VibeFlow extension registers itself as one so other AI tools in your IDE can call VibeFlow tools too. Cursor has its **own** MCP config (`~/.cursor/mcp.json`), which is separate; **Settings → Connection → MCP for coding agents** can write VibeFlow's entry there.

---

*Missing a term? Open an issue at the VibeFlow repo and we'll add it.*
