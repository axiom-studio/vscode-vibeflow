# VibeFlow for Cursor Documentation

Welcome to the user guide for running the VibeFlow extension inside **Cursor**. The extension brings a full multi-persona AI engineering team directly into your IDE: Developer, Architect, Principal Engineer, Product Manager, Project Manager, UX Designer, QA Lead, Security Lead, and Customer agents that share context, write code, review each other, and ship work through a governed lifecycle.

> **Same extension, different host.** Cursor is a fork of VS Code, so VibeFlow installs and runs in Cursor as a standard extension — same views, commands, panels, keybindings, status bar, and Settings UI. This guide mirrors the [VS Code edition](../../vscode-vibeflow/docs/index.md) and calls out only the handful of places where Cursor genuinely differs (installation, the Cursor name collision, and coexistence with Cursor's built-in AI).

## What is the VibeFlow extension?

VibeFlow is a backend platform (Projects, Features, Todos, Issues, Documents, Contexts, Governance, Compliance) plus the agents that act on it. The extension is the live cockpit. From inside Cursor you can:

- See every running agent session in the **Agent Fleet** view, grouped by branch.
- Read and write work items in the **Work Items** and **Project Items** views.
- Watch real-time agent activity (claims, status transitions, commits, prompts) in the **Activity Feed**.
- Open a **Session Chat** panel to talk to a chat-first agent, with @-mentions, file drop, clickable commit hashes, and inline diffs.
- Govern AI-generated changes through **security review** and **QA verification** gates before they ship.
- See the agents collaborate on a **Dashboard** (React Flow topology + metrics) or a **Kanban Board** organized by status.

If you already know what VibeFlow is from the cloud product, the extension is the same workflow, with the IDE wired in as a first-class surface.

## Running VibeFlow inside Cursor — what's different

Read this once; the rest of the guide assumes it.

- **Cursor has two windows: Agents Window and Editor Window.** Cursor 3 defaults to the Agents Window — an agent-first UI for parallel agents and chat tabs. VibeFlow's extension sidebar, Extensions marketplace, and file tree live in the **Editor Window**. If you only see agent chat tabs and no Extensions panel, run `Cmd/Ctrl+Shift+P` → **Open Editor Window** (`Shift+Cmd+N` on Mac). Full explanation in [getting-started.md §0](getting-started.md#0-cursor-agents-window-vs-editor-window).
- **Open a project folder before anything else.** VibeFlow binds to a workspace. Without an open folder, sessions will not start. See [getting-started.md §1](getting-started.md#1-open-a-project-folder-required).
- **You install it from Open VSX, not the VS Code Marketplace.** Cursor's built-in Extensions panel is backed by the [Open VSX Registry](https://open-vsx.org). VibeFlow is published there under publisher **`AxiomStudio`** (extension id `AxiomStudio.vscode-vibeflow`). Search "VibeFlow" in Cursor's Extensions panel, or install the `.vsix` directly. Full steps in [getting-started.md](getting-started.md#3-install-the-extension).
- **The listing still reads "VibeFlow"** There is a single cross-host extension, not a separate Cursor build. The `vscode` in the id and the "for VS Code" display name are historical — it's the right extension for Cursor.
- **"Cursor" means two different things in this guide.** The **editor** you're running VibeFlow in is Cursor. Separately, **Cursor is also one of VibeFlow's selectable AI providers** (the agent can run against the `cursor` CLI). They're independent: in the Cursor editor you can run agents on *any* provider (Claude, Codex, Gemini, or Cursor), and the Cursor provider works in any host editor. Where it could be ambiguous, this guide says "the Cursor editor" or "the Cursor provider."
- **VibeFlow runs alongside Cursor's own AI, not instead of it.** Cursor's built-in Chat (`Cmd/Ctrl+L`), inline edit (`Cmd/Ctrl+K`), and Composer/Agent (`Cmd/Ctrl+I`) are a single-assistant toolset. VibeFlow is a *multi-persona, work-item-governed team*. They don't conflict; use both.
- **Two host-integration features behave differently** because Cursor's chat and MCP systems are its own: the **`@vibeflow` chat participant** and the **editor-level MCP server registration**. Details in [feature-tour.md](feature-tour.md) and [troubleshooting.md](troubleshooting.md). The core wiring — the agent CLI reaching VibeFlow Cloud via the `.mcp.json` the extension writes — is unaffected and works identically in Cursor.

## How it works

1. **Open a project folder**: File → Open Folder in the Editor Window. Sessions require a workspace.
2. **Install + connect**: the extension's 3-step Setup wizard asks for a server URL, an API key, and a project. Auto-detects the project from your workspace's git remote.
3. **Launch a session**: pick a persona, branch, and provider (Claude, Codex, Gemini, Cursor). A terminal opens with the agent inside, or a chat panel if you picked chat-first mode (agent runs headless in tmux on socket `vibeflow-headless`).
4. **Agents poll for work**: each persona's session calls `wait_for_work` against the backend, picks up work items targeted at its role and branch, and starts implementing.
5. **You stay in the loop**: agents ask for input through prompts that show up in the Activity Feed and as Cursor notifications. You can answer inline, convert chat messages into tracked todos, or drive the conversation in chat-first mode.
6. **Code lands**: every commit is recorded against the work item with author, files changed, and lines added. Branch review status surfaces in the status bar so you know when a branch is ready for a PR.
7. **Governance gates**: after a Developer agent marks an item done, the Security Lead persona inspects the diff, then the QA Lead verifies acceptance. Both pass, the item is closed.

## Documentation sections

| Section | When to read it |
|---------|----------------|
| [Getting Started](getting-started.md) | First install. Install, sign in, first session in ~5 minutes. |
| [Feature Tour](feature-tour.md) | Once you're set up. A guided lap of every view, panel, and command. |
| [Workflows and Flow Diagrams](workflows-and-flows.md) | When you want to understand how the pieces fit together. Sequence and state diagrams in Mermaid. |
| [Chat-First Mode](chat-first-mode.md) | When you've heard "chat-first" and want the deep dive. What it is, when to use it, and how it relates to Cursor's own chat. |
| [Settings Reference](settings-reference.md) | Every key, type, default, and gotcha. |
| [Troubleshooting](troubleshooting.md) | When something broke. Symptom, cause, and fix for the most common problems. |
| [Glossary](glossary.md) | Every VibeFlow-specific word defined for non-technical readers. |
| [FAQ](faq.md) | Questions across 8 sections, including how VibeFlow relates to Cursor's built-in AI. |

## Conventions used across the docs

- The `VibeFlow:` prefix marks every command (e.g. `VibeFlow: Launch Session`). Run any of them via the Command Palette (`Cmd/Ctrl+Shift+P`).
- The `vibeflow.` prefix marks every setting key (e.g. `vibeflow.serverUrl`). Find them via the Settings panel or `settings.json`.
- View names are capitalized: Agent Fleet, Work Items, Project Items, Documents, Activity Feed.
- "The Cursor editor" = the IDE you're in. "The Cursor provider" = the `cursor`-backed AI option in the launch wizard.
- Persona names are capitalized, with the character name in parentheses on first mention: Developer (Kai), Architect (Morgan), Principal Engineer (Kai), Product Manager (Priya), Project Manager (Casey), UX Designer (Sage), QA Lead (Quinn), Security Lead (Sophie), Customer (Riley).
- Issue references look like `#NNNN` and link back to specific incidents in the troubleshooting and flow docs.

## Where these docs live

These pages ship in the repository, not in the published `.vsix`. The Open VSX listing, the in-editor walkthrough, and the repo's top-level README cover the essentials for new users browsing the marketplace.

## Found a mistake?

Open an issue at the [VibeFlow extension repository](https://bitbucket.org/axiom-studio/vscode-vibeflow) or run `VibeFlow: Report an Issue…` from the Command Palette. The pre-populated report includes version + diagnostic info.

---

*Cursor edition of the VibeFlow user guide. Mirrors the [VS Code edition](../../vscode-vibeflow/docs/index.md); content is identical except where Cursor's installation, naming, and built-in AI differ. Last updated 2026-06-16.*
