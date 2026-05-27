# VibeFlow for VS Code Documentation

Welcome to the user guide for the VibeFlow VS Code extension. The extension brings a full multi-persona AI engineering team directly into your IDE: Developer, Architect, Principal Engineer, Product Manager, Project Manager, UX Designer, QA Lead, Security Lead, and Customer agents that share context, write code, review each other, and ship work through a governed lifecycle.

## What is the VibeFlow extension?

VibeFlow is a backend platform (Projects, Features, Todos, Issues, Documents, Contexts, Governance, Compliance) plus the agents that act on it. The VS Code extension is the live cockpit. From inside the IDE you can:

- See every running agent session in the **Agent Fleet** view, grouped by branch.
- Read and write work items in the **Work Items** and **Project Items** views.
- Watch real-time agent activity (claims, status transitions, commits, prompts) in the **Activity Feed**.
- Open a **Session Chat** panel to talk to a chat-first agent the way you'd talk to Copilot Chat, with @-mentions, file drop, clickable commit hashes, and inline diffs.
- Govern AI-generated changes through **security review** and **QA verification** gates before they ship.
- See the agents collaborate on a **Dashboard** (React Flow topology + metrics) or a **Kanban Board** organized by status.

If you already know what VibeFlow is from the cloud product, the extension is the same workflow, with the IDE wired in as a first-class surface.

![VibeFlow Dashboard — agent topology and live project metrics inside VS Code](/images/vscode-1.webp)

## How it works

1. **Install + connect**: the extension's 3-step Setup wizard asks for a server URL, an API key, and a project. Auto-detects the project from your workspace's git remote.
2. **Launch a session**: pick a persona, branch, and provider (Claude, Codex, Gemini, Cursor). A terminal opens with the agent inside, or a chat panel if you picked chat-first mode.
3. **Agents poll for work**: each persona's session calls `wait_for_work` against the backend, picks up work items targeted at its role and branch, and starts implementing.
4. **You stay in the loop**: agents ask for input through prompts that show up in the Activity Feed and as VS Code notifications. You can answer inline, convert chat messages into tracked todos, or drive the conversation in chat-first mode.
5. **Code lands**: every commit is recorded against the work item with author, files changed, and lines added. Branch review status surfaces in the status bar so you know when a branch is ready for a PR.
6. **Governance gates**: after a Developer agent marks an item done, the Security Lead persona inspects the diff, then the QA Lead verifies acceptance. Both pass, the item is closed.

![VibeFlow Kanban Board — track work items across your entire team](/images/vscode-2.webp)

## Documentation sections

| Section | When to read it |
|---------|----------------|
| [Getting Started](getting-started.md) | First install. Install, sign in, first session in ~5 minutes. |
| [Feature Tour](feature-tour.md) | Once you're set up. A guided lap of every view, panel, and command. |
| [Workflows and Flow Diagrams](workflows-and-flows.md) | When you want to understand how the pieces fit together. Sequence and state diagrams in Mermaid. |
| [Chat-First Mode](chat-first-mode.md) | When you've heard "chat-first" and want the deep dive. What it is, when to use it, and why it differs from vanilla. |
| [Settings Reference](settings-reference.md) | Every key, type, default, and gotcha. |
| [Troubleshooting](troubleshooting.md) | When something broke. Symptom, cause, and fix for the ~16 most common problems. |
| [Glossary](glossary.md) | Every VibeFlow-specific word defined for non-technical readers. |
| [FAQ](faq.md) | ~27 questions across 8 sections. |

## Conventions used across the docs

- The `VibeFlow:` prefix marks every command (e.g. `VibeFlow: Launch Session`). Run any of them via the Command Palette (`Cmd/Ctrl+Shift+P`).
- The `vibeflow.` prefix marks every setting key (e.g. `vibeflow.serverUrl`). Find them via the Settings panel or `settings.json`.
- View names are capitalized: Agent Fleet, Work Items, Project Items, Documents, Activity Feed.
- Persona names are capitalized, with the character name in parentheses on first mention: Developer (Kai), Architect (Morgan), Principal Engineer (Kai), Product Manager (Priya), Project Manager (Casey), UX Designer (Sage), QA Lead (Quinn), Security Lead (Sophie), Customer (Riley).
- Issue references look like `#NNNN` and link back to specific incidents in the troubleshooting and flow docs.

## Where these docs live

These pages ship in the repository, not in the published `.vsix`. The marketplace tile, the in-VS-Code walkthrough, and the repo's top-level README cover the essentials for new users browsing the marketplace.

## Found a mistake?

Open an issue at the [VibeFlow extension repository](https://bitbucket.org/axiom-studio/vscode-vibeflow) or run `VibeFlow: Report an Issue…` from the Command Palette. The pre-populated report includes version + diagnostic info.

---

*Last updated 2026-05-24. Generated as part of the VibeFlow extension's user documentation initiative (feature #418, todo #1982).*
