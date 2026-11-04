# FAQ

**Who this is for**: You've skimmed the rest of the guide. You have specific questions that didn't fit any chapter. This page is the catch-all.

**TL;DR**: Short answers to the things people actually ask. Each answer points at the deeper doc when there's more to say.

> See [glossary.md](glossary.md) for any term in **bold**.

---

## Getting started

### Do I need the VibeFlow CLI to use the extension?

Yes, to run agents. Agents launch only through the **VibeFlow CLI**, a terminal app that runs your persona team in tmux. The extension is where you manage the project, watch and talk to the agents, and review their work; without the CLI you can still browse work items, documents, and pull requests, but you can't start an agent.
Install it from **VibeFlow: Settings → Connection → VibeFlow CLI → Install Latest**. See [getting-started.md](getting-started.md#install-the-vibeflow-cli).

### Does it work on Windows?

Through **WSL**. The CLI runs agents in tmux, which native Windows doesn't provide, so on a native Windows window every CLI action shows WSL guidance. Install WSL and the WSL extension, run **Reopen Folder in WSL**, and install the CLI there; everything works from that window.

### Do I need a VibeFlow Cloud account?

Yes. The extension is a cockpit on top of the **VibeFlow Cloud** server. Features, todos, issues, governance, compliance, and the work item queue all live there. Without an account the views stay empty and Setup can't finish. Sign up at [cloud.axiomstudio.ai](https://cloud.axiomstudio.ai), grab an API key from **Account > API Keys**, and run `VibeFlow: Setup`.

### How is this different from GitHub Copilot / Continue / Cursor?

Copilot, Continue, and Cursor are *single-agent* tools. One model, one chat, one editor session. VibeFlow runs *multiple agents in different personas* (Developer, Architect, QA, Security, PM, etc.) that poll a shared work-item queue, hand work off to each other, and gate each other's changes through review. It's a team, not an autocomplete. You can run VibeFlow *alongside* Copilot; the extension even registers a `@vibeflow` chat participant in Copilot Chat.

### Do I need VS Code 1.93 or higher?

Yes. The extension requires engine `^1.93.0` because it uses APIs introduced in that release (notably the MCP Server Definition Provider and the editor-area panel APIs). Older VS Code builds won't install it. Update VS Code, then retry.

### Is there a free tier?

This is a question about the VibeFlow Cloud product, not the extension. Pricing lives at [cloud.axiomstudio.ai](https://cloud.axiomstudio.ai). The extension itself is Apache 2.0 licensed and free to install.

---

## Agents and personas

### Why are there so many personas? Can I just run one Developer?

Yes, you can run only a Developer, and many people start that way. Each persona is a separate agent you choose to start in the CLI. A minimal setup is *one Developer*, and you act as everyone else (PM, QA, Security). A realistic team is *Architect + Developer + QA*. The nine-persona setup is the upper bound for teams that want full role separation and automatic review gates. See [workflows-and-flows.md](workflows-and-flows.md#5-multi-persona-handoff) for the handoff dynamics.

### What's the difference between a Developer and a Principal Engineer?

Both are *code agents* (they write source). The Developer (Alex) implements todos against a clear acceptance-criteria spec. Head-down execution. The Principal Engineer (Kai) takes on harder cross-cutting work: refactors, hairy bugs, architecture-sensitive changes, and is typically run on a stronger model. They share an intake, but the PE also picks up items in `architecture_review_complete`.

### Who is Vera?

Vera is the **Code Reviewer** persona. Vera reviews pull requests in rounds, posts findings (blockers first), and can let coding agents repair blockers. You see Vera's state in the **Pull Requests** view and the review in the **Vera review panel**; a review needs a Vera agent running in the CLI to pick it up. See [workflows-and-flows.md](workflows-and-flows.md#6-vera-code-review-on-a-pull-request).

### Does each persona need its own API key?

No. There are two kinds of credential:

- The **VibeFlow API key**, set once (VibeFlow: Setup, then Test Connection in Settings so the CLI shares it). Every agent uses it.
- The **AI provider's** sign-in, handled by that provider's own CLI (`claude`, `codex`, `gemini`, …) on the machine where agents run. The extension doesn't store provider keys.

### Can two personas work on the same branch at the same time?

Yes, and that's the normal case. Your Architect and Developer agents both target `main` (or both target `feature/foo`) and coordinate through the work-item queue. They claim work items atomically, so they don't pick up the same item. If you want strict isolation (Developer on `feature/foo` while you keep editing `main`), run the agent in a **worktree**. See the worktrees section below.

### Why does my Architect agent keep filing follow-up todos instead of doing the work?

Because that's the Architect's job. The Architect (Morgan)'s primary output is a plan plus a set of implementation todos for the Developer. If you want the work implemented, run a Developer (or Principal Engineer) agent. See [workflows-and-flows.md](workflows-and-flows.md#4-work-item-lifecycle-from-idea-to-closed) for the state machine.

### Agent Fleet shows agents from other projects. Is that right?

Yes. Agent Fleet shows exactly what the VibeFlow CLI is running, across every project, grouped by project with the current one first. Clicking an agent in another project offers to switch to that project and open its chat. The status-bar count and the Activity Feed stay scoped to the current project.

---

## Work items

### What's the difference between a todo and an issue?

A **todo** lives *inside a feature* and has a `feature_id` parent. An **issue** sits at the *project level* with no feature parent, typically a bug, a standalone fix, or a cross-cutting change. Functionally they're both work items with the same lifecycle and review gates. Issues are picked up before todos within the same priority band (a `high` issue beats a `high` todo).

### What's the difference between a feature and a todo?

A **feature** is a container, a piece of work big enough to hold multiple todos. A **todo** is a discrete implementable unit. Agents *plan* features but *implement* todos. Browse → **Features** shows features with their todos.

### Who decides when a work item is "done"?

The implementing agent flips the status to `done` when it has committed code and tests pass, but `done` is *not* closed. After `done`, the item enters the review pipeline: **security review** (Sophie or you), then **QA review** (Quinn or you). Only after both gates pass does the item move to `closed`. See [workflows-and-flows.md](workflows-and-flows.md#4-work-item-lifecycle-from-idea-to-closed).

### Why do work items go through security review and QA review?

Because silent regressions and security oversights are the worst kind of bug, and AI-generated diffs are easy to skim past. The two gates force a human (or a dedicated review agent) to walk every diff and verify acceptance criteria before the item closes.

### Can I skip the review gates?

There's no "skip review" toggle. If you act as both Security Lead and QA Lead yourself (right-click the `done` item, **Security Approve** then **QA Verify**), you can move an item through in seconds. That's the legitimate "skip" path: you become the reviewer rather than removing the gate.

---

## Chat

### How do I talk to an agent?

Click it in **Agent Fleet** to open its **Session Chat** panel, and type. Your message reaches the agent on its next poll. Questions get an answer in the chat; change requests become a tracked issue or todo first, which the agent then works — you can follow it in **Work Items**. When the agent needs your decision, its message turns amber with an inline **Respond** form.

### Why does my chat say "Working…" for a long time?

The agent is busy — usually working a claimed item — and answers between steps or on its next poll. Check the agent's row in Agent Fleet (latest activity) or the Activity Feed. If the agent's status is **stalled** (pane up, no heartbeat), restart it from its right-click menu. Older chat-first sessions have their own failure mode; see [troubleshooting.md](troubleshooting.md).

### Can I use chat without a running agent?

The per-agent Session Chat panel is bound to a running agent. Separately, VibeFlow registers a **`@vibeflow` chat participant** through the VS Code Chat Participant API (GitHub Copilot Chat surfaces it).
Where it's available, type `@vibeflow` and a slash command (`/status`, `/create`, `/review`, `/summary`, `/launch`, `/respond`, `/compliance`) to interact with your project without any agent running.

### How are @-mentions resolved?

When you type `@` in any chat input, the picker offers `@symbol` (LSP workspace-symbol from your code), `@document`, `@context`, `@todo`, `@issue`, and `@feature` (the last four come from the VibeFlow Cloud server). Picking one inserts a token of the form `[type:id "name"]`. The platform resolves the token server-side when the message reaches the agent, so the agent sees the actual content rather than just the name.

### What happened to chat-first mode?

Chat-first was the extension's own launcher mode where a hidden agent took the chat as its only input. New agents launch from the VibeFlow CLI, and you talk to them in the same Session Chat panel. Existing chat-first sessions keep working; see [chat-first-mode.md](chat-first-mode.md).

---

## Pull requests and code review

### Why doesn't a PR show a review state?

Only PRs Vera tracks show one. A repository has to be linked for Vera reviews (owners and org admins do that in Settings → **Project** or on the web), and the review has to be requested — automatically by the repo's trigger, or with the eye icon on the PR row. Untracked PRs show their state and branch, and clicking them opens the PR in the browser.

### Can I act on Vera's findings from VS Code?

Yes. Click a reviewed PR to open the **Vera review panel**. A finding's `file:line` opens in the editor. The panel can re-run, pause, or continue the review, retry a PR update, and dismiss or reopen findings (with evidence) — each enabled exactly when the server allows it.

---

## Worktrees

### What's a git worktree and why does VibeFlow use them?

A **worktree** is a second working directory checked out to a different branch in the same repository. It lets a Developer agent work on `feature/foo` while you (or another agent) work on `main`. No `git stash`, no checkout shuffling. The VibeFlow CLI creates and runs agents in worktrees; Agent Fleet's **Worktrees** section lists them. See [workflows-and-flows.md](workflows-and-flows.md#7-worktrees-multi-branch-parallelism).

### How do I remove a worktree?

Right-click it in **Agent Fleet ▸ Worktrees** → **Delete Worktree**. It runs `git worktree remove` after a confirmation that warns about uncommitted changes. Uncommitted work in a deleted worktree is gone, so check the dirty marker first.

---

## Security and privacy

### Where is my API key stored?

In VS Code's **Secrets API**, per-machine encrypted storage scoped to the extension. It's never logged and never committed. When you save the key or a Test Connection succeeds in Settings → Connection, it's also written into the VibeFlow CLI's `config.yaml` (mode `0600`, written atomically) so the CLI shares your sign-in. **VibeFlow: Logout** clears the extension's copy and stops it re-importing the CLI's; the CLI's own config is left alone.

### Does the extension send my code to a third party?

The extension itself does not. It talks to the VibeFlow Cloud server you configured in `vibeflow.serverUrl`. Your agents run on the provider CLI you choose (Claude, Codex, Gemini, …), and that CLI sends your code to that provider's API. If you want everything on-prem, point `vibeflow.serverUrl` at a self-hosted VibeFlow server and pick a provider that supports a private endpoint.

### What's the cached-serverUrl HTTPS guard?

A defense-in-depth check enforced at three layers: activation time, every REST request, and MCP transport construction. The rule: `vibeflow.serverUrl` must be HTTPS, except for `localhost`, `127.0.0.1`, and `[::1]`. A server URL imported from the CLI's config passes the same check. The guards are regression-protected by `scripts/check-security-guards.mjs` in the build.

### Which files contain my token? Are any safe to commit?

None are safe to commit, and none are written into your repository by the extension. Your token lives in VS Code's Secrets API, the CLI's `config.yaml` in the CLI root (mode `0600`), and the per-agent MCP config files that **MCP for coding agents** writes in your home directory (for example `~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`).

---

## Troubleshooting

### The extension installed but no views appeared. Now what?

Look for the VibeFlow icon in the Activity Bar (the strip of icons on the far left). The views live in the VibeFlow container, not in Explorer. If the icon is missing, your VS Code engine may be below 1.93. Still nothing? See [troubleshooting.md](troubleshooting.md).

### I'm getting "401 Unauthorized" from the server.

Your API key is wrong, expired, or pointing at the wrong server. Run **VibeFlow: Setup** again, double-check the server URL (default `https://cloud.axiomstudio.ai`), paste a fresh key from **Account > API Keys**, then click **Test Connection** in Settings so the CLI gets it too. If you get 401 with a freshly-generated key, your account may not have access to the project.

### Can I run the extension offline?

No. The extension needs the VibeFlow Cloud server for every view, and agents need their AI provider's API. Offline, the sidebar shows stale data and agents can't make progress.

---

## Roadmap and community

### Where do I file bugs?

GitHub Issues at [github.com/axiom-studio/vscode-vibeflow/issues](https://github.com/axiom-studio/vscode-vibeflow/issues). You can also run **VibeFlow: Report an Issue…** from the Command Palette. It pre-fills a GitHub issue template with your extension version, VS Code version, and OS. For account or billing questions email `support@axiomstudio.ai`. For security vulnerabilities email `security@axiomstudio.ai` (see [SECURITY.md](https://github.com/axiom-studio/vscode-vibeflow/blob/main/SECURITY.md)).

### Can I contribute?

The repo is Apache 2.0 licensed and open for PRs at [github.com/axiom-studio/vscode-vibeflow](https://github.com/axiom-studio/vscode-vibeflow). Before opening a PR, run `yarn run check` (typecheck + lint + tests + security-guards — note `yarn run check`, not bare `yarn check`). See [DEVELOPMENT.md](https://github.com/axiom-studio/vscode-vibeflow/blob/main/DEVELOPMENT.md).

### Where do I see what's planned next?

The roadmap lives on the VibeFlow Cloud product side at [cloud.axiomstudio.ai](https://cloud.axiomstudio.ai). GitHub Issues with the `enhancement` label show in-flight feature work. Watching the repo on GitHub is the most reliable way to catch new releases.

---

*Question not answered? Open an issue at [github.com/axiom-studio/vscode-vibeflow/issues](https://github.com/axiom-studio/vscode-vibeflow/issues) and we'll add the answer here.*
