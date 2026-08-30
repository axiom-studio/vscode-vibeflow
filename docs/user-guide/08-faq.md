# FAQ

**Who this is for**: You've skimmed the rest of the guide. You have specific questions that didn't fit any chapter. This page is the catch-all.

**TL;DR**: Short answers to ~25 things people actually ask. Each answer points at the deeper doc when there's more to say.

> See [07-glossary.md](07-glossary.md) for any term in **bold**.

---

## Getting started

### Do I need the `vibeflow-cli` to use the extension?

No. The extension handles session launching, lifecycle, and UI on its own. The **`vibeflow-cli`** is a separate terminal-only tool that pre-dates the extension. You only need it if you set `vibeflow.cli.enabled=true` to hand off session management to the CLI's TUI. About 5% of users do that. If you've never heard of the CLI, leave the setting off. The extension is the full experience. See [05-settings-reference.md](05-settings-reference.md#cli-interface) for the handoff details.

### Do I need a VibeFlow Cloud account?

Yes. The extension is a cockpit on top of the **VibeFlow Cloud** server. Features, todos, issues, governance, compliance, and the work item queue all live there. Without an account you can install the `.vsix`, but the views will be empty and the wizards won't progress past the **Setup** step. Sign up at [cloud.axiomstudio.ai](https://cloud.axiomstudio.ai), grab an API key from **Account > API Keys**, and run `VibeFlow: Setup`.

### How is this different from GitHub Copilot / Continue / Cursor?

Copilot, Continue, and Cursor are *single-agent* autocomplete-plus tools. One model, one chat, one editor session. VibeFlow runs *multiple agents in different personas* (Developer, Architect, QA, Security, PM, etc.) that poll a shared work-item queue, hand work off to each other, and gate each other's changes through review. It's a team simulator, not an autocomplete. You can run VibeFlow *alongside* Copilot. The extension even registers as an MCP server so Copilot Chat can call VibeFlow tools via the `@vibeflow` chat participant.

### Do I need to install VS Code 1.93 or higher?

Yes. The `engines.vscode` field in `package.json` is pinned to `^1.93.0` because the extension uses APIs introduced in that release (notably the MCP Server Definition Provider and the editor-area panel APIs the chat panel relies on). Older VS Code builds won't load the extension. The Marketplace will simply refuse to install it. Update VS Code, then retry.

### Is there a free tier?

This is a question about the VibeFlow Cloud product, not the extension. Pricing lives at [cloud.axiomstudio.ai](https://cloud.axiomstudio.ai). Check there for the current tiers. The extension itself is Apache 2.0 licensed and free to install.

---

## Agents and personas

### Why are there so many personas? Can I just run one Developer?

Yes, you can run only a Developer, and many people start that way. The persona system is opt-in scope: each persona is a separate session you choose to launch. A minimal setup is *one Developer session*, and you act as everyone else (PM, QA, Security). A realistic team is *Architect + Developer + QA*. The nine-persona setup is the upper bound for teams that want full role separation and automatic review gates. Pick the subset that matches how you work. See [03-workflows-and-flows.md](03-workflows-and-flows.md#5-multi-persona-handoff) for the handoff dynamics.

### What's the difference between a Developer and a Principal Engineer?

Both are *code agents* (they write source). The Developer (Kai) implements todos against a clear acceptance-criteria spec. Head-down execution. The Principal Engineer (also Kai, different model tier by convention) takes on harder cross-cutting work: refactors, hairy bugs, architecture-sensitive changes. The PE is typically backed by a stronger model (e.g. Opus vs Sonnet) via the **Sticky Models** setting. They share an intake, but the PE picks from a higher-difficulty band.

### Does each persona need its own API key?

No. The **provider key** (Claude / Codex / Gemini / Cursor) is shared across all personas using that provider. You paste it once into the Secrets API, and the launch wizard pre-fills it from there for every subsequent session. You only need multiple provider keys if you want different personas on different providers (e.g. Architect on Claude, Developer on Codex). The **VibeFlow API key** is set once globally via **VibeFlow: Setup** and is shared by every persona.

### Can two personas work on the same branch at the same time?

Yes, and that's the normal case. Your Architect and Developer agents both target `main` (or both target `feature/foo`) and coordinate through the work-item queue. They never write to the same file at the same moment because they claim work items via `claimed_by`, and an item is claimed atomically. If you want strict isolation (Developer on `feature/foo` while you keep editing `main`), use a **worktree**. See the worktrees section below.

### Why does my Architect agent keep filing follow-up todos instead of doing the work?

Because that's the Architect's job. The Architect (Morgan) is a *code agent*, but its primary output is a plan plus a set of implementation todos for the Developer. If you want the Architect to *implement*, either give it a todo already in `ready_to_implement` status (skipping the planning gate), or run a Developer session. Architects pick items in `planning` / `architecture_review_complete` first. See [03-workflows-and-flows.md](03-workflows-and-flows.md#4-work-item-lifecycle--from-idea-to-closed) for the state machine.

---

## Work items

### What's the difference between a todo and an issue?

A **todo** lives *inside a feature* and has a `feature_id` parent. An **issue** sits at the *project level* with no feature parent, typically a bug, a standalone fix, or a cross-cutting change. Functionally they're both work items with the same lifecycle and review gates. The split is organizational: if the work fits under a planned feature, it's a todo; if it doesn't, it's an issue. Issues are picked up before todos within the same priority band (a `high` issue beats a `high` todo).

### What's the difference between a feature and a todo?

A **feature** is a container, a piece of work big enough to hold multiple todos. A **todo** is a discrete implementable unit. Example: "VSCode Extension for VibeFlow" is a feature; "Wire Agent Fleet TreeView to live MCP API data" is a todo inside it. Agents *plan* features but *implement* todos. You'll typically create features when you're scoping out an epic and todos when you're describing a concrete change.

### Who decides when a work item is "done"?

The implementing agent flips the status to `done` when it has committed code and tests pass, but `done` is *not* closed. After `done`, the item enters the review pipeline: **security review** (Sophie or you), then **QA review** (Quinn or you). Only after both gates pass does the item move to `closed`. So "done" means "the implementer thinks they're finished"; "closed" means "two human-or-agent reviewers agreed." See [03-workflows-and-flows.md](03-workflows-and-flows.md#4-work-item-lifecycle--from-idea-to-closed).

### Why do work items go through security review and QA review?

Because silent regressions and security oversights are the worst kind of bug, and AI-generated diffs are easier to miss than human-authored ones. The two gates force a human (or a dedicated review agent) to walk every diff and verify acceptance criteria before the item closes. The gates exist on purpose. Two real incidents (commits silently deleting an HTTPS guard and the @mention picker) are exactly what the gates catch in future.

### Can I skip the review gates?

The extension and CLI don't expose a "skip review" toggle. There's no command to bypass them. If you act as both Security Lead and QA Lead yourself (right-click the `done` item, **Security Approve** then **QA Verify**), you can move an item through in seconds. That's the legitimate "skip" path: you become the reviewer rather than removing the gate. If you don't review at all, the item stays in `done` indefinitely.

---

## Chat

### What's the difference between Vanilla and Chat-First mode?

**Vanilla** sessions are terminal-driven: the agent reads work items from the queue, the terminal is the primary surface, and the Session Chat panel is a read-only transcript with a disabled input. **Chat-First** sessions are chat-driven: the agent runs hidden, the chat panel input is enabled, and you steer the agent by typing. Chat-First *requires* YOLO (skip-permissions) mode, since the agent edits files without asking, so it shows a consent modal on first launch. Use Vanilla until you understand the consent model. Switch to Chat-First when you want a pair-programming feel. See [03-workflows-and-flows.md](03-workflows-and-flows.md#3-multi-turn-chat--vanilla-session-vs-chat-first-session) for the full distinction.

### Why does my chat say "Working…" and never finish?

A few known causes: the headless backing process exited without emitting a stream-json `result` event, the provider CLI is missing from PATH, or a session-state mismatch is preventing the per-turn respawn from picking up the captured `session_id`. The "Working…" indicator only clears when the stream produces a terminal event. See [06-troubleshooting.md](06-troubleshooting.md) for the symptom matrix and fixes. Chat-stuck is the most-debugged path in the codebase.

### Why is the chat input disabled when I open a vanilla session's chat panel?

By design. Vanilla agents read instructions from work items via `wait_for_work`, not from the chat panel. If the input were enabled, your typing would have no effect, because the agent isn't listening to the panel. The disabled input shows a banner explaining this and a **Convert to work item** button that opens the ad-hoc work-item Quick Pick, so your message becomes a tracked todo or issue. If you want a typeable chat input, launch the session in **Chat-First** mode instead.

### Can I use the chat panel without launching a session first?

Two answers. The per-session chat panel: no, it's bound to a running session. But VibeFlow also registers a **`@vibeflow` chat participant** in GitHub Copilot Chat. Open the Copilot Chat input, type `@vibeflow` and a slash command (`/status`, `/create`, `/review`, `/summary`, `/launch`, `/respond`, `/compliance`), and you can interact with your project without any session running. That's the no-session chat surface.

### How are @-mentions resolved?

When you type `@` in any chat input, the picker offers `@symbol` (LSP workspace-symbol from your code), `@document`, `@context`, `@todo`, `@issue`, and `@feature` (the last four come from the VibeFlow Cloud server). Picking one inserts a token of the form `[type:id "name"]`. The platform resolves the token server-side when the message reaches the agent, so the agent sees the actual document content, todo description, or symbol location rather than just the name. Symbols are local to your workspace; document/context/todo/issue/feature resolution is server-side.

---

## Worktrees

### What's a git worktree and why does VibeFlow use them?

A **worktree** is a second working directory checked out to a different branch in the same repository. VibeFlow uses worktrees so a Developer agent can work on `feature/foo` while you (or another agent) work on `main`. No `git stash`, no checkout shuffling. The worktree lives at `.claude/worktrees/<branch>` by default (configurable via `vibeflow.worktree.baseDir`). The launch wizard offers to create one if `vibeflow.worktree.autoCreate=true`. See [03-workflows-and-flows.md](03-workflows-and-flows.md#6-worktree-workflow-multi-branch-parallelism) for the full flow.

### What happens to the worktree when I kill the session?

Depends on `vibeflow.worktree.cleanupOnKill`. The default is `ask`: a modal asks whether to keep or delete the worktree. `always` deletes silently. `never` leaves it for follow-up. Gotcha: the `ask` modal does *not* warn you about uncommitted changes in the worktree. If you click delete on a worktree with dirty state, the work is gone. Recommended workflow: leave on `ask` and check `git status` in the worktree before clicking delete.

### Can I run two sessions on the same branch?

Yes. Two personas on the same branch is the normal case (Architect plus Developer both targeting `main`). What you *can't* do is run two sessions of the *same persona* on the same branch from the same session record. The extension prevents duplicate-session collisions by reattaching to the existing session instead of starting a second one. If you genuinely want two Developers in parallel, give them different branches (each in its own worktree).

---

## Security and privacy

### Where is my API key stored?

In VS Code's built-in **Secrets API**, per-machine encrypted storage scoped to the extension. The VibeFlow API key is stored under `vibeflow.apiKey`; provider keys (Claude, OpenAI, Gemini, Cursor) live alongside it. Nothing is written to disk in plaintext, nothing is logged, nothing is committed. Run **VibeFlow: Logout** to clear them all.

### Does the extension send my code to a third party?

The extension itself does not. It talks to (1) the VibeFlow Cloud server you configured in `vibeflow.serverUrl` and (2) whichever AI provider CLI you launched (Claude, Codex, Gemini, Cursor). The provider CLI sends your code to that provider's API. Which provider you use is your choice. If you want everything on-prem, point `vibeflow.serverUrl` at a self-hosted VibeFlow server and pick a provider that supports a private endpoint.

### What's the cached-serverUrl HTTPS guard?

A defense-in-depth check enforced at three layers: activation time, every REST request, and MCP transport construction. The rule: `vibeflow.serverUrl` must be HTTPS, except for `localhost`, `127.0.0.1`, and `[::1]`. A non-HTTPS remote URL is rejected so an attacker can't downgrade a stale cached URL to HTTP and intercept your bearer token. The guards are regression-protected by `scripts/check-security-guards.mjs` in the build.

### Is `.mcp.json` safe to commit?

No, and the extension goes out of its way to prevent you from doing so. `.mcp.json` contains your VibeFlow API token (so the launched agent can talk to the server). Before writing it, the extension runs `git check-ignore` to confirm the workspace will exclude the file. If `.mcp.json` is not gitignored, the extension *refuses to write it* and surfaces an error asking you to add the file to `.gitignore` first. It's also written with `mode 0o600` (owner-only read).

---

## Troubleshooting

### The extension installed but no views appeared. Now what?

Open the Activity Bar (the strip of icons on the far left of VS Code) and look for the VibeFlow icon. The views are scoped to the VibeFlow container; they don't show up in Explorer. If the icon is missing, your VS Code version may be below 1.93 (check `Help > About`). Still nothing? See [06-troubleshooting.md](06-troubleshooting.md) for the activation diagnostic checklist.

### I'm getting "401 Unauthorized" from the server.

Your API key is wrong, expired, or pointing at the wrong server. Run **VibeFlow: Setup** again, double-check the server URL (default is `https://cloud.axiomstudio.ai`; if you're self-hosting, the URL is different), and paste a fresh key from **Account > API Keys** in the VibeFlow Cloud UI. If you get 401 with a freshly-generated key, your account may not have access to the project. Check the project's member list. Full diagnosis tree in [06-troubleshooting.md](06-troubleshooting.md).

### Can I run the extension offline?

No. The extension needs network access to (1) the VibeFlow Cloud server (every API call goes there) and (2) the AI provider's API (the agent's actual thinking happens there). The views, the chat, the work-item queue: all server-backed. If your laptop is offline, the sidebar will show stale data and new sessions won't launch.

---

## Roadmap and community

### Where do I file bugs?

GitHub Issues at [github.com/axiom-studio/vscode-vibeflow/issues](https://github.com/axiom-studio/vscode-vibeflow/issues). You can also run **VibeFlow: Report an Issue…** from the Command Palette. It pre-fills a GitHub issue template with your extension version, VS Code version, and OS. For account or billing questions email `support@axiomstudio.ai`. For security vulnerabilities email `security@axiomstudio.ai` (see [SECURITY.md](https://github.com/axiom-studio/vscode-vibeflow/blob/main/SECURITY.md)).

### Can I contribute?

The repo is Apache 2.0 licensed and open for PRs at [github.com/axiom-studio/vscode-vibeflow](https://github.com/axiom-studio/vscode-vibeflow). Before opening a PR, run `yarn run check` (typecheck + lint + tests + security-guards — note `yarn run check`, not bare `yarn check`, which is yarn v1's reserved dependency-tree verifier). The security-guards script is non-negotiable and will fail the build if your change weakens the HTTPS validator, `.mcp.json` gitignore check, or worktree path-confinement. See the developer guide at [DEVELOPMENT.md](../../DEVELOPMENT.md).

### Where do I see what's planned next?

The roadmap lives on the VibeFlow Cloud product side at [cloud.axiomstudio.ai](https://cloud.axiomstudio.ai). The extension itself doesn't ship a roadmap doc. GitHub Issues with the `enhancement` label show in-flight feature work. Watching the repo on GitHub is the most reliable way to catch new releases.

---

*Question not answered? Open an issue at [github.com/axiom-studio/vscode-vibeflow/issues](https://github.com/axiom-studio/vscode-vibeflow/issues) and we'll add the answer here.*
