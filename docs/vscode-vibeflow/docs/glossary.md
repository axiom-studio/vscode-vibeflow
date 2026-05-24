# Glossary

**Who this is for**: Anyone reading the rest of the user guide. New terms appear in **bold** the first time; every one of them is defined here.

**TL;DR**: VibeFlow has its own vocabulary. This page is the cheat sheet.

---

## Core concepts

### Agent
A long-running AI process that thinks and writes code on your behalf. VibeFlow runs **multiple** agents at once, each playing a different role (see *persona*).

### Persona
The role an agent plays. VibeFlow ships with nine: **Developer** (Kai), **Architect** (Morgan), **Principal Engineer** (Kai), **Product Manager** (Priya), **Project Manager** (Casey), **UX Designer** (Sage), **QA Lead** (Quinn), **Security Lead** (Sophie), and **Customer** (Riley). You launch one agent *per persona*. They poll independently for work that matches their role.

> *Code agents* (Developer, Architect, Principal Engineer) write source code. *Advisory agents* (everyone else) write specs, reviews, and comments. They don't commit code.

### Session
One running agent instance. A session has a **persona**, a **branch** (the git branch it operates on), and a **provider** (which model backs it). Sessions are what the **Agent Fleet** view lists.

### Provider
The underlying AI provider behind an agent. Today VibeFlow supports **Claude** (Anthropic), **Codex** (OpenAI), **Gemini** (Google), and **Cursor**. Each requires its own API key. You don't need all four; pick the one you have access to.

### Project
A VibeFlow project. Maps roughly to one of your code repositories. Created on the **VibeFlow Cloud** server. Identified by a name (e.g. `vscode-vibeflow`) plus a numeric ID. The extension auto-detects which project applies to your current workspace by reading the git remote URL.

### MCP (Model Context Protocol)
The protocol agents use to talk to the VibeFlow Cloud server. When an agent calls `list_features` or `create_todo`, it's making an MCP tool call under the hood. You almost never need to think about this. It's wired automatically when a session launches.

### `.mcp.json`
A file the extension writes into your workspace so the launched agent knows how to reach the VibeFlow Cloud server. It contains your API token, so it's git-ignored automatically and written with `mode 0o600`. If the workspace is a git repo and `.mcp.json` can't be ignored, the extension refuses to write it.

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

## Sessions & terminals

### Terminal mode
Where the agent's terminal output goes. Three values: **hybrid** (code agents visible, advisory agents hidden), **all** (every agent visible), **none** (every agent hidden). Default is **hybrid**.

### Hybrid mode
The default. Developer, Architect, and Principal Engineer terminals are visible in VS Code's terminal pane. Advisory agents (QA, Security, PM, etc.) run hidden in the background because their output is mostly diagnostic. You'll see their work via the chat panel and execution logs.

### Chat-First Mode
A session mode where you talk to the agent through the **Session Chat** panel instead of a terminal. The agent runs hidden in the background; the chat panel is the only UI. You must explicitly opt in at launch time (a consent modal appears) because chat-first uses **YOLO mode** under the hood.

### YOLO mode
"You Only Live Once." A session mode where the agent runs with `--dangerously-skip-permissions`. It executes file edits, shell commands, and git operations without asking for permission. Trade safety for speed. Required for chat-first; optional for hybrid. The first time you turn it on, a modal asks for explicit consent.

### Vanilla mode
The opposite of YOLO. The agent asks permission for every action that could change the world. Slower but safe. Default for hybrid sessions.

### Headless backing
Where a chat-first session physically runs when there's no visible terminal. Two options: **tmux** (the agent survives an IDE restart and can be attached to from any terminal) or **vscode** (the agent dies if you close the window). Default is **auto**: tmux when it's installed, vscode otherwise.

### Reattach
When you reopen VS Code, the extension looks for `.vibeflow-session-{persona}` files in the workspace root, reads the session IDs they contain, asks the server "are these still alive?", and reconnects the UI to the still-alive ones. Killed sessions don't auto-reattach.

---

## Views, panels, and commands

### View
A panel in VS Code's sidebar. VibeFlow ships five: **Agent Fleet**, **Work Items**, **Project Items**, **Documents** (all in the left activity bar's VibeFlow container), plus **Activity Feed** (in the right-side **VibeFlow Monitor** panel).

### Activity Bar
VS Code's leftmost strip with the icons (Explorer, Search, Source Control…). VibeFlow adds a custom icon there.

### Activity Feed
A real-time stream of what agents are doing: claims, status transitions, commits, prompts to you. Lives in the **VibeFlow Monitor** panel by default (right side of the workbench).

### Session Chat panel
An editor panel where you talk to one specific session. It opens in the main editor area, not a sidebar. Shows the conversation transcript, lets you send messages, render diffs, and click commit hashes to open the diff. The headline feature of *chat-first* mode.

### Work Item panel
An editor panel showing details for one work item: description, execution log, comments, and governance actions (QA verify/reject, security approve/reject).

### Walkthrough
VS Code's built-in 5-step onboarding tutorial. Opens automatically the first time you install the extension. Title: "Get Started with VibeFlow."

### Command Palette
VS Code's `Cmd/Ctrl+Shift+P` menu. Every VibeFlow action is registered there with a `VibeFlow:` prefix. Type "VibeFlow:" and you'll see all 43 commands.

### `@vibeflow` chat participant
A GitHub Copilot Chat participant. In Copilot Chat's input, type `@vibeflow` and you can run `/status`, `/create`, `/review`, `/summary`, `/launch`, `/respond`, or `/compliance` against your project without leaving the chat surface.

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
A separate working directory checked out to a different git branch, in the same repository. VibeFlow can create a worktree at `.claude/worktrees/<branch>` so a Developer agent can work on `feature/foo` while you work on `main` in your main checkout, with no `git stash` shuffling. Configurable via `vibeflow.worktree.*` settings.

### `vibeflow-cli`
A separate command-line tool (not the extension). It pre-existed the extension; the extension can optionally hand off session launching to the CLI via the `vibeflow.cli.enabled` setting. Most users don't need the CLI because the extension handles session lifecycle itself. The CLI exists for users who prefer a terminal-only workflow.

---

## Authentication

### API key
The bearer token the extension uses to talk to the VibeFlow Cloud server. You set it once via the **VibeFlow: Setup** wizard or the **Settings → Connection** tab. Stored encrypted in VS Code's per-machine **Secrets API**. Never committed; never logged.

### Provider key
A separate token for the AI provider (Claude API key, OpenAI key, Gemini key, etc.). Stored alongside the VibeFlow API key in the Secrets API. The launch wizard prompts for whichever provider you pick for the session.

### Secrets API
VS Code's built-in encrypted storage for sensitive values. Per-machine, per-extension. VibeFlow uses it for both the VibeFlow API key and every provider key.

### Setup wizard
The 3-step onboarding flow (Server URL → API Key → Project) that runs the first time you install the extension. Re-runnable via **VibeFlow: Setup** in the Command Palette.

---

## Less-common terms

### Prompt
A message from an agent asking the user to make a decision. Appears as a notification plus a row in the **Activity Feed**. Use **VibeFlow: Respond to Prompt** or the inline reply box in chat to answer.

### Compliance finding
A flagged item from the Security Lead persona tied to a specific compliance framework (SOC 2, ISO 27001, PCI-DSS, HIPAA). Visible in the **Compliance** panel. Each finding links to the work item where it was found and the framework clause it relates to.

### Stream-json
A communication protocol between the extension and provider CLIs (Claude, Codex, Gemini, Cursor) in chat-first mode. Lets the panel show live agent output as the agent thinks. It's provider-agnostic: adapters in `src/sessions/providerAdapters/` translate each provider's stream format into a common shape.

### MCP server (the .vsix kind)
Distinct from the MCP *protocol*. VS Code exposes a separate concept of an "MCP server" that other Copilot-like extensions can discover. The VibeFlow extension registers itself as an MCP server so other AI tools in your IDE (Copilot, Continue, Cody) can call VibeFlow tools too.

---

*Missing a term? Open an issue at the VibeFlow repo and we'll add it.*
