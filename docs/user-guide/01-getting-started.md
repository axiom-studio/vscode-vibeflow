# Getting Started with VibeFlow

**Who this is for**: You just installed the VibeFlow extension in VS Code, you've never used it before, and you want a calm, opinionated walkthrough that gets you from zero to "an agent did a thing for me" in about ten minutes. VS Code basics assumed; nothing else.

**TL;DR**: Install the extension → run **VibeFlow: Setup** (3 steps: server, API key, project) → click **+ Launch Session** in the Agent Fleet view → pick *Developer + Claude + Vanilla* for your first run → type a question in the Session Chat panel, click **Convert to work item**, watch the agent claim and answer it.

> Unfamiliar word? Every new term is bolded the first time and defined in [07-glossary.md](07-glossary.md).

---

## 1. Before you begin

You'll need three things up front. Take a minute to confirm each one — getting them ready now saves a lot of "why is this not working?" later.

| What | Why |
|------|-----|
| **VS Code 1.93.0 or later** | The extension's minimum engine version. Check via *Code → About* (mac) or *Help → About* (Windows/Linux). |
| **A VibeFlow Cloud account** | This is where your projects, work items, agent sessions, and API keys live. Sign up from your VibeFlow Cloud account dashboard — the team that pointed you at this extension can share the right link. |
| **An API key for at least one AI provider** | The agent itself runs against an AI model. You only need **one** of: **Claude** (Anthropic), **Codex** (OpenAI), **Gemini** (Google), or **Cursor**. Pick whichever you already have access to. |

**Optional (and skippable for your first run)**: the standalone `vibeflow-cli` binary. Most people never need it — the extension manages agent sessions on its own. You can wire it in later from **Settings → CLI Interface → Install Latest** if you ever want a terminal-only workflow.

That's the full prerequisite list. If anything above is missing, pause here and grab it before continuing — the setup wizard will refuse to finish without an API key, and the launch wizard won't proceed without at least one provider key.

---

## 2. Install the extension

1. Open VS Code.
2. Open the **Extensions** view (`Cmd+Shift+X` / `Ctrl+Shift+X`).
3. Search for `VibeFlow`. The one you want is published by **AxiomStudio** — display name **VibeFlow for VS Code**.
4. Click **Install**.

You'll see VS Code reload some views, and a walkthrough titled **Get Started with VibeFlow** will pop open automatically. That walkthrough is the in-IDE companion to this doc — five short steps that link directly into the relevant commands. You're welcome to click through it as you read this page; the two are designed to overlap.

**You'll see next**: a VibeFlow icon in the **Activity Bar** (the leftmost icon strip — Explorer, Search, Source Control, etc.). That icon is your entry point to everything.

---

## 3. The Setup wizard (3 steps, about 90 seconds)

If the walkthrough's **Sign in** step didn't auto-launch the wizard, run it manually: open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run **VibeFlow: Setup**.

The wizard has exactly three steps. Each one shows a Quick Pick or an input box at the top of VS Code.

### Step 1 — Server URL

Default: `https://cloud.axiomstudio.ai`. For nearly every user, this is correct — press Enter to accept it. (You only change this if your team runs a self-hosted VibeFlow deployment, in which case they'll give you the exact URL. HTTPS is required for any non-localhost server, and the wizard will reject HTTP up front.)

### Step 2 — API Key

Paste your VibeFlow Cloud API key. You can find it on the **Account → API Keys** page of your VibeFlow Cloud account dashboard. The wizard immediately uses the key to call the server and list the projects you have access to — if the key is wrong, you'll see a clear "401" error and can re-paste.

The key is stored in VS Code's **Secrets API** (encrypted, per-machine). It is not written to any file, not logged, and not synced.

### Step 3 — Project

A Quick Pick of every VibeFlow project your account can see. The default selection is whichever project's git remote URL matches your current workspace — so if you opened a folder that already has a VibeFlow project on the server, you should see it pre-highlighted. Press Enter to confirm.

**You'll see next**: a "Connected to *project-name*" toast in the bottom-right. The status bar gets a `$(folder) project-name` pill — that's the **project switcher**. You can click it any time (or press `Cmd+Shift+V P` / `Ctrl+Shift+V P`) to switch projects.

> Need to re-run setup later? **VibeFlow: Setup** is always available from the Command Palette.

---

## 4. Your first launch

Time to spawn an agent. Click the VibeFlow icon in the Activity Bar — four views fold open:

- **Agent Fleet** — live agent sessions, the one you'll use most
- **Work Items** — todos and issues you (or agents) have filed
- **Project Items** — features and their nested todos, backlog-style
- **Documents** — PRDs, architecture notes, design specs

In the **Agent Fleet** view, click the **+ Launch Session** button in the view's title bar (or run **VibeFlow: Launch Session** from the Command Palette, or press `Cmd+Shift+V L` / `Ctrl+Shift+V L`). The **launch wizard** opens.

For your first session, take the safe path. Choose:

| Wizard step | Recommended for first launch | Why |
|-------------|------------------------------|-----|
| **Branch** | Your current branch (usually `main`) | The agent will only pick up work items targeting this branch — easy to reason about. |
| **Persona** | **Developer (Kai)** | The Developer persona writes code. It's the most useful "hello world" persona to start with. |
| **Provider** | **Claude** (or whichever provider you actually have a key for) | Match this to the provider key you collected in section 1. |
| **Provider key** | Paste the API key when prompted | Only asked the first time; subsequent launches reuse it from the Secrets API. |
| **Session mode** | **Vanilla** | The agent will ask permission before each file edit or shell command. Skip *VibeFlow (YOLO)* and *Chat-First* until you've done this once — both run the agent with fewer safety prompts. |
| **Terminal mode** | **Hybrid** | Default. The code-writing agent's terminal is visible; advisory agents run hidden. |
| **Worktree** | **Skip** | Only relevant when you want parallel agents on different branches. Not needed today. |

Confirm the final step and the launch begins.

**You'll see next**:

1. A new VS Code terminal opens — its title reads something like `VibeFlow: Developer · main`. The agent boots in there.
2. The agent runs `session_init` against the server. You'll see a few seconds of startup output.
3. A row appears in **Agent Fleet ▸ active sessions** for your new Developer agent — green status icon means it's healthy and polling.
4. The agent immediately starts polling for work via `wait_for_work`. If there are no work items in `ready_to_implement` for this branch, the agent sits idle — that's expected. Idle is *not* broken.

---

## 5. A 5-minute happy-path tour

Now you'll give the agent something to do and watch the full round-trip. Goal: prove that the loop — you talk, work item gets filed, agent claims, agent responds — actually works.

1. **Open the Session Chat panel.** In the **Agent Fleet** view, click your new Developer session row. The Session Chat panel opens in the editor area. (Alternatively, right-click the session ▸ **VibeFlow: View Session Details**.)
2. **Type a question** in the chat input. Something concrete and small, e.g.:
   > *what files are in this workspace?*
3. **Convert it into a work item.** Because this is a *Vanilla* session, the agent reads tracked work items, not free-form chat. Click the **Convert to work item** button next to your message. A Quick Pick asks whether to file it as a **todo** (inside a feature) or an **issue** (standalone). For this trial, pick **issue** — it's the simpler path.
4. **Watch what happens.** Within one polling cycle (default 30 seconds — configurable via `vibeflow.polling.interval`):
   - The new issue appears in the **Work Items** view with status `in_review`.
   - You promote it to `ready_to_implement` (right-click the item ▸ **VibeFlow: Change Status**, or open the Work Item panel).
   - The Developer agent's next poll returns the issue, it claims the item, and the row's status badge in **Work Items** flips through `planning → implementing → done`.
   - The agent's reasoning and any tool calls (file reads, shell output) stream into the **Session Chat** panel and the **Activity Feed** in real time.
   - When the agent finishes, you get a "Work item completed" notification (toggleable via `vibeflow.notifications.workItemComplete`).

That's the loop. Everything else in VibeFlow — multiple personas, governance gates, worktrees, chat-first mode, dashboards — is variations on this same pattern.

---

## 6. What's next

You've got a working agent. From here, branch out depending on what you want to learn next:

- **What every view does, in one page** → [02-feature-tour.md](02-feature-tour.md)
- **How the pieces fit together (with diagrams)** → [03-workflows-and-flows.md](03-workflows-and-flows.md) — the onboarding flow you just walked through is Section 1.
- **When something doesn't behave like this page promised** → [06-troubleshooting.md](06-troubleshooting.md)
- **Talking to the agent like Copilot instead of through work items** → [04-chat-first-mode.md](04-chat-first-mode.md) (read this *after* you're comfortable with Vanilla mode — Chat-First runs the agent with skip-permissions).
- **Tuning settings** → [05-settings-reference.md](05-settings-reference.md)
- **Lost on terminology** → [07-glossary.md](07-glossary.md)

Welcome aboard.
