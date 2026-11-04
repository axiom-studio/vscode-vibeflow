# VibeFlow for Cursor Documentation

Welcome to the user guide for running the VibeFlow extension inside **Cursor**. The extension brings a full multi-persona AI engineering team directly into your IDE: Developer, Architect, Principal Engineer, Product Manager, Project Manager, UX Designer, QA Lead, Security Lead, and Customer agents that share context, write code, review each other, and ship work through a governed lifecycle.

> **Same extension, different host.** Cursor is a fork of VS Code, so VibeFlow installs and runs in Cursor as a standard extension — same views, commands, panels, keybindings, status bar, and Settings UI. This guide mirrors the [VS Code edition](../../vscode-vibeflow/docs/index.md) and calls out only the handful of places where Cursor genuinely differs (installation, the Cursor name collision, and coexistence with Cursor's built-in AI).

## What is the VibeFlow extension?

VibeFlow is a backend platform (Projects, Features, Todos, Issues, Documents, Contexts, Governance, Compliance) plus the agents that act on it. Agents run in the **VibeFlow CLI**; the extension is the live cockpit. From inside Cursor you can:

- Pick the project from the dropdown at the top of the sidebar.
- See every agent the CLI is running, across all your projects, in the **Agent Fleet** view.
- Read and act on work items in the **Work Items** and **Browse** views.
- Watch real-time agent activity (claims, status transitions, commits, prompts) in the **Activity Feed**.
- Open a **Session Chat** panel to talk to an agent, with @-mentions, file drop, persona avatars, clickable commit hashes and issue/todo references, and inline diffs.
- Follow pull requests and drive **Vera** code reviews in the **Pull Requests** view and the review panel.
- Govern AI-generated changes through **security review** and **QA verification** gates before they ship.
- See the agents collaborate on a **Dashboard** (topology + metrics) or a **Kanban Board** organized by status.

If you already know what VibeFlow is from the cloud product, the extension is the same workflow, with the IDE wired in as a first-class surface.

![VibeFlow Dashboard — agent topology, metrics, and active session nodes](../assets/5-Dashboard.png)

## Running VibeFlow inside Cursor — what's different

Read this once; the rest of the guide assumes it.

- **Cursor has two windows: Agents Window and Editor Window.** Cursor 3 defaults to the Agents Window — an agent-first UI for parallel agents and chat tabs. VibeFlow's extension sidebar, Extensions marketplace, and file tree live in the **Editor Window**. If you only see agent chat tabs and no Extensions panel, run `Cmd/Ctrl+Shift+P` → **Open Editor Window** (`Shift+Cmd+N` on Mac). Full explanation in [getting-started.md §0](getting-started.md#0-cursor-agents-window-vs-editor-window).
- **Open a project folder before anything else.** VibeFlow binds to a workspace. See [getting-started.md §1](getting-started.md#1-open-a-project-folder-required).
- **You install it from Open VSX, not the VS Code Marketplace.** Cursor's built-in Extensions panel is backed by the [Open VSX Registry](https://open-vsx.org). VibeFlow is published there under publisher **`AxiomStudio`** (extension id `AxiomStudio.vscode-vibeflow`). Full steps in [getting-started.md](getting-started.md#install-the-extension).
- **The listing reads "VibeFlow".** There is a single cross-host extension, not a separate Cursor build. The `vscode` in the id is historical — it's the right extension for Cursor.
- **"Cursor" means two different things in this guide.** The **editor** you're running VibeFlow in is Cursor. Separately, **Cursor is also one of the AI providers** agents can run on (the `cursor` CLI). They're independent. Where it could be ambiguous, this guide says "the Cursor editor" or "the Cursor provider."
- **VibeFlow runs alongside Cursor's own AI, not instead of it.** Cursor's built-in Chat (`Cmd/Ctrl+L`), inline edit (`Cmd/Ctrl+K`), and Composer/Agent (`Cmd/Ctrl+I`) are a single-assistant toolset. VibeFlow is a *multi-persona, work-item-governed team*. They don't conflict; use both.
- **Two host-integration features behave differently** because Cursor's chat and MCP systems are its own: the **`@vibeflow` chat participant** and the **editor-level MCP server registration**. Details in [feature-tour.md](feature-tour.md) and [troubleshooting.md](troubleshooting.md). Agents you launch from the VibeFlow CLI are unaffected.

## How it works

1. **Install + connect**: the extension's 3-step Setup wizard asks for a server URL, an API key, and a project. It auto-detects the project from your workspace's git remote.
2. **Install the CLI**: one click in Settings → Connection. A successful **Test Connection** shares your sign-in and project with the CLI. On Windows, the CLI runs in **WSL**.
3. **Launch agents**: **VibeFlow: Launch Session** opens the VibeFlow CLI, where you pick personas, provider, and branch. The agents appear in Agent Fleet.
4. **Agents poll for work**: each agent calls `wait_for_work` against the backend, picks up work items targeted at its role and branch, and starts implementing.
5. **You stay in the loop**: agents ask for input through prompts that show up in Session Chat, the Activity Feed, and as Cursor notifications. Ask for changes in Session Chat and the agent turns them into tracked work items.
6. **Code lands and gets reviewed**: every commit is recorded against the work item. Pull requests show Vera's review state, and the review panel takes you straight to each finding.
7. **Governance gates**: after a Developer agent marks an item done, the Security Lead persona inspects the diff, then the QA Lead verifies acceptance. Both pass, the item is closed.

![VibeFlow Kanban — swimlanes by status with drag-and-drop cards](../assets/8-Kanban.png)

## Documentation sections

| Section | When to read it |
|---------|----------------|
| [Getting Started](getting-started.md) | First install. Install, sign in, install the CLI, first agent in ~10 minutes. |
| [Feature Tour](feature-tour.md) | Once you're set up. A guided lap of every view, panel, and command. |
| [Workflows and Flow Diagrams](workflows-and-flows.md) | When you want to understand how the pieces fit together. Sequence and state diagrams in Mermaid. |
| [Cloud Runners](cloud-runners.md) | Run agents on cloud-hosted machines instead of your laptop. Create, start/stop, manage, and open a terminal to a runner. |
| [Git Configuration](git-configuration.md) | The git credentials Cloud Runners use to clone and push. Adding PAT/SSH providers, managing them, diagnostics. |
| [Settings Reference](settings-reference.md) | Every key, type, default, and gotcha. |
| [Troubleshooting](troubleshooting.md) | When something broke. Symptom, cause, and fix for the most common problems. |
| [Glossary](glossary.md) | Every VibeFlow-specific word defined for non-technical readers. |
| [FAQ](faq.md) | Short answers to the questions people actually ask. |
| [Chat-First Mode](chat-first-mode.md) | Only if you still have sessions started in the extension's older chat-first mode. |

## Conventions used across the docs

- The `VibeFlow:` prefix marks every command (e.g. `VibeFlow: Launch Session`). Run any of them via the Command Palette (`Cmd/Ctrl+Shift+P`).
- The `vibeflow.` prefix marks every setting key (e.g. `vibeflow.serverUrl`). Find them via the Settings panel or `settings.json`.
- View names are capitalized: Project, Agent Fleet, Work Items, Browse, Pull Requests, Documents, Activity Feed.
- Persona names are capitalized, with the character name in parentheses on first mention: Developer (Alex), Architect (Morgan), Principal Engineer (Kai), Product Manager (Aria), Project Manager (Parker), UX Designer (Dana), QA Lead (Quinn), Security Lead (Sophie), Customer (Casey). Vera is the Code Reviewer.
- "The Cursor editor" = the IDE you're in. "The Cursor provider" = the `cursor`-backed AI option you can pick in the VibeFlow CLI.
- Issue references look like `#NNNN` and link back to specific incidents in the troubleshooting and flow docs.

## Where these docs live

These pages ship in the repository, not in the published `.vsix`. The Open VSX listing, the in-editor walkthrough, and the repo's top-level README cover the essentials for new users browsing the marketplace.

## Found a mistake?

Open an issue at the [VibeFlow extension repository](https://github.com/axiom-studio/vscode-vibeflow/issues) or run `VibeFlow: Report an Issue…` from the Command Palette. The pre-populated report includes version + diagnostic info.

---

*Cursor edition of the VibeFlow user guide. Mirrors the [VS Code edition](../../vscode-vibeflow/docs/index.md); content is identical except where Cursor's installation, naming, and built-in AI differ. Last updated 2026-10-16 for the CLI-first extension.*
