# Workflows and Flow Diagrams

**Who this is for**: Anyone who's installed the extension and wants to understand *how the pieces fit together*. What happens in what order, what calls what, what state moves where. This is the doc for "but **why** is it asking me that?"

**TL;DR**: Seven end-to-end flows that cover most VibeFlow usage. Sequence and state diagrams in Mermaid (GitHub and VS Code render them natively).
Agents run in the VibeFlow CLI; the extension manages the project, shows the agents, and reviews their work.

> See [glossary.md](glossary.md) for any unfamiliar term.

---

## 1. New-user onboarding (first 5 minutes)

You install the extension. VS Code reloads. Here's what happens next, in order:

```mermaid
sequenceDiagram
    actor User
    participant Editor as VS Code
    participant Ext as VibeFlow Extension
    participant Server as VibeFlow Cloud
    participant Secrets as VS Code Secrets API
    participant CLI as VibeFlow CLI config

    User->>Editor: Install extension
    Editor->>Ext: activate()
    Ext->>Editor: Register views (Project dropdown, Agent Fleet, Work Items,<br/>Browse, Pull Requests, Documents, Activity Feed)
    Ext->>Editor: Show "Get Started with VibeFlow" walkthrough
    User->>Ext: Click "Sign in" step
    Ext->>Ext: Run VibeFlow: Setup wizard
    Note over Ext: 3 steps: Server URL → API Key → Project

    Ext->>User: Step 1 — Server URL?
    User->>Ext: https://cloud.axiomstudio.ai (default)
    Ext->>Ext: validateServerUrl() — HTTPS required
    Ext->>User: Step 2 — Paste API key
    User->>Ext: ak_live_…
    Ext->>Secrets: store API key
    Ext->>Server: GET /projects (auth check)
    Server-->>Ext: list of projects
    Ext->>User: Step 3 — Pick a project
    User->>Ext: vscode-vibeflow
    Ext->>Ext: ProjectDetector caches project_id<br/>(also reads git remote URL for auto-detect next time)
    Ext-->>User: ✅ "Connected to vscode-vibeflow"

    User->>Ext: Settings → Connection → Install Latest (CLI)
    User->>Ext: Settings → Connection → Test Connection
    Ext->>Server: probe the saved server URL
    Ext->>CLI: write server_url, api_token, default_project<br/>into config.yaml (atomic, mode 0600)
```

**What you see**: walkthrough, then "Sign in" link, then three Quick Picks, then a "Connected" toast; then the CLI install and a "Reachable" result in Settings. A few minutes total.

**What can go wrong**: an invalid API key returns 401 from the server; the wizard surfaces the error and lets you re-paste. A non-HTTPS server URL is rejected by `validateServerUrl`. See [troubleshooting.md](troubleshooting.md) for symptoms and fixes.

---

## 2. Launch agents (the most common action)

Agents launch only through the VibeFlow CLI.
**VibeFlow: Launch Session** (`Cmd/Ctrl+Shift+V L`), **Open CLI** in the Agent Fleet title bar, and the empty-fleet row all open it:

```mermaid
sequenceDiagram
    actor User
    participant Ext as VibeFlow Extension
    participant Term as VS Code Terminal
    participant CLI as VibeFlow CLI
    participant Agent as Agent (tmux pane)
    participant Server as VibeFlow Cloud

    User->>Ext: Launch Session
    alt Native Windows window
        Ext-->>User: "VibeFlow CLI needs WSL on Windows" + Reopen Folder in WSL
    else macOS / Linux / Remote-WSL
        Ext->>Term: open "VibeFlow CLI" (reuse it if already open)
        Term->>CLI: vibeflow [--mcp …] [--root …]
        User->>CLI: pick persona(s), provider, branch, permissions
        CLI->>Agent: start the agent in tmux
        Agent->>Server: session_init + session_register
        CLI->>CLI: record the session in sessions.json
    end
    loop every background poll
        Ext->>CLI: read sessions.json + list live tmux sessions
        Ext->>Server: GET /sessions/active (all projects)
        Ext-->>User: Agent Fleet rows = live CLI agents,<br/>enriched with server status
    end
```

**What you see**: the CLI opens in an editor-area terminal; once an agent starts, it appears in Agent Fleet under its project — the same list the CLI shows.

**Why the CLI**: one launcher for every editor and the terminal, with sessions that survive closing VS Code (they live in tmux).
Provider, branch, worktree, and permission choices all live in the CLI.

---

## 3. Talking to an agent

Click an agent in Agent Fleet to open its **Session Chat** panel.

```mermaid
sequenceDiagram
    actor User
    participant Panel as Session Chat Panel
    participant Server as VibeFlow Cloud
    participant Agent as Agent (in the CLI)

    User->>Panel: Type "Add a login button" + Enter
    Panel->>Server: create prompt for this session
    Agent->>Server: wait_for_work (next poll)
    Server-->>Agent: pending_prompts: "Add a login button"
    alt Question or status check
        Agent->>Server: respond_to_prompt (the answer)
    else Change request
        Agent->>Server: create_issue / create_todo, then claim it
        Agent->>Server: publish_todo_log (progress, diffs)
        Agent->>Server: respond_to_prompt (summary + commit)
    end
    Server-->>Panel: transcript updates on the live poll
    Panel-->>User: reasoning, tool calls, diffs, commit links
```

Agents work from tracked work items, so a change you ask for in chat becomes an issue or todo first — you'll see it in **Work Items** and can follow its execution log.
When an agent needs *your* decision, its message turns amber with an inline **Respond** form and the status bar badge counts it.

> **Chat-first sessions**: sessions started in the extension's older chat-first mode run hidden and treat the chat as their only input, with a fresh agent process per message.
> New agents launch from the CLI instead; see [chat-first-mode.md](chat-first-mode.md) if you still have chat-first sessions.

---

## 4. Work item lifecycle: from idea to closed

Every feature, todo, and issue moves through the same status machine. The shape:

```mermaid
stateDiagram-v2
    [*] --> in_review: Created (chat, UI, or import)
    in_review --> planning: Agent or human picks it up
    in_review --> needs_pm_input: PM persona triages
    needs_pm_input --> needs_ux_input: needs UX scoping
    needs_pm_input --> planning: PM signs off
    needs_ux_input --> planning: UX signs off
    planning --> ready_to_implement: Plan written, ready for impl
    ready_to_implement --> implementing: Agent claims it
    implementing --> done: Code committed, tests green
    done --> security_review: enters review pipeline
    security_review --> qa_review: Security Lead approved
    security_review --> ready_to_implement: Security Lead rejected
    qa_review --> closed: QA Lead approved
    qa_review --> ready_to_implement: QA Lead rejected
    closed --> [*]
```

**Where you (the human) typically step in**:
- **`in_review`**: you review what an agent or another user filed. Decide whether to promote.
- **`done` → `security_review`**: if you're acting as the Security Lead, you walk the diff and approve or reject.
- **`security_review` → `qa_review`**: if you're acting as QA Lead, you verify the AC.
- **Anywhere**: you can comment, change priority, change branch, change parent feature.

**Where agents step in**:
- `in_review → planning` (architect agents claim items in `ready_to_implement` or `architecture_review_complete`)
- `planning → ready_to_implement` (after writing a plan)
- `ready_to_implement → implementing → done` (developer agents)
- `done → security_review → qa_review` (security/QA agents auto-poll for items needing their gate)

**The review gates exist on purpose**: silent regressions caught in production are the worst kind.

---

## 5. Multi-persona handoff

A real workflow often touches multiple personas. Example: you ask for a new feature in chat. Here's what happens:

```mermaid
sequenceDiagram
    actor User
    participant Chat as Chat (Session Chat or @vibeflow)
    participant PM as PM (Aria)
    participant Arch as Architect (Morgan)
    participant Dev as Developer (Alex)
    participant Sec as Security (Sophie)
    participant QA as QA (Quinn)
    participant Server as VibeFlow Cloud

    User->>Chat: "I want a Slack notification when a build fails"
    Chat->>Server: create_todo or create_issue (in_review)
    Server-->>PM: wait_for_work returns the new item
    PM->>PM: refine scope, write acceptance criteria
    PM->>Server: status → needs_ux_input or → planning
    Server-->>Arch: wait_for_work returns it
    Arch->>Arch: design the integration, file sub-tasks
    Arch->>Server: status → ready_to_implement
    Server-->>Dev: wait_for_work returns it
    Dev->>Dev: implement + write tests + commit
    Dev->>Server: status → done + commit hash
    Server-->>Sec: wait_for_work returns it (security_reviewed=false)
    Sec->>Sec: walk the diff
    Sec->>Server: security_reviewed=true (or reject)
    Server-->>QA: wait_for_work returns it (qa_verified=false)
    QA->>QA: verify acceptance criteria
    QA->>Server: qa_verified=true (or reject)
    Server-->>User: notification — work item closed
```

**Each persona is its own session** (one agent per persona, launched from the CLI, polling independently). They never talk to each other directly. Coordination happens through the work item's status field and execution log on the server.

**You can collapse this**: not every team needs all 9 personas active. A minimal team is *Architect + Developer + QA*: three sessions, the rest implicit (you act as the PM and Security yourself).

---

## 6. Vera code review on a pull request

When a developer agent (or you) opens a PR on a repository linked for Vera reviews, the extension shows the review and lets you drive it:

```mermaid
sequenceDiagram
    actor User
    participant PRs as Pull Requests view
    participant Panel as Vera review panel
    participant Server as VibeFlow Cloud
    participant Vera as Vera (Code Reviewer in the CLI)
    participant Dev as Coding agent

    User->>PRs: eye icon → Request Vera Review
    PRs->>Server: request review (the repo's linked review settings)
    Server-->>Vera: review job (needs a runner: Vera running in the CLI)
    Vera->>Server: findings + summary for round 1
    PRs-->>User: row shows "Findings to address · round 1/3"
    Server-->>User: toast "Open Review"
    User->>Panel: open the review
    Panel-->>User: summary, review cycle, findings (blockers first)
    User->>Panel: click a finding's file:line → opens in the editor
    alt Coding agents may fix blockers
        Server-->>Dev: repair batch for the PR
        Dev->>Server: one commit + push, then complete the batch
        Server-->>Vera: next round
    else You fix it, or dismiss with evidence
        User->>Panel: Dismiss / Reopen a finding
    end
    Vera->>Server: round N clean
    PRs-->>User: row shows "Reviewed"
```

**What you see**: Vera's state on each PR row, a toast when a review finishes, and a review panel whose controls (Re-run, Pause, Continue, Retry PR update, Dismiss/Reopen) are enabled exactly when the server allows them.
Project owners and org admins set each repository's review policy (trigger, rounds, skip drafts, whether coding agents may fix blockers) in Settings → **Project**.

---

## 7. Worktrees (multi-branch parallelism)

When you want a Developer agent working on `feature/foo` while you keep working on `main`, run it in a **git worktree**: a second checkout of the repo on another branch, sharing the same `.git`.

The CLI creates and runs agents in worktrees; the extension shows them:

- **Agent Fleet ▸ Worktrees** lists every worktree with its branch, path, current marker, and dirty status.
- Right-click a worktree to **Open in New Window** (browse or edit it in a separate VS Code window) or **Delete** it (`git worktree remove`, with a confirmation that warns about uncommitted changes).
- Agents running in a worktree show their branch in Agent Fleet like any other agent.

**Why this matters**: you can have 3 Developer agents running in parallel on 3 different branches, each in its own worktree, none of them stepping on each other or on your main checkout.

**Cleanup gotcha**: deleting a worktree with uncommitted work loses that work. Check the dirty marker first.

---

## Putting it all together: a realistic day

```mermaid
gantt
    title A morning with VibeFlow
    dateFormat HH:mm
    axisFormat %H:%M

    section You
    Open VS Code, walk Activity Feed :a1, 09:00, 5m
    Review overnight QA results       :a2, 09:05, 10m
    Ask for a feature in Session Chat :a3, 09:15, 5m
    Answer the PM's clarification     :a5, 09:30, 5m
    Read Vera's review in the panel   :a6, 11:10, 10m

    section PM Agent (Aria)
    Files and refines the item        :p1, 09:20, 15m
    Pings you for clarification       :p2, 09:35, 1m

    section Architect (Morgan)
    Plans architecture                :ar1, 09:45, 25m
    Files implementation todos        :ar2, 10:10, 5m

    section Developer (Alex)
    Implements first todo             :d1, 10:20, 35m
    Commits, pushes, opens PR         :d2, 10:55, 5m

    section Vera (Code Reviewer)
    Reviews the PR                    :v1, 11:00, 10m
```

You spend ~35 minutes of human attention; the agents do the rest in parallel. The Activity Feed and the Pull Requests view show every transition above.

---

## What this doc deliberately doesn't cover

- **The CLI's own screens and keys**: see the [VibeFlow CLI README](https://github.com/axiom-studio/vibeflow-cli).
- **Compliance findings** workflow: see the **Compliance** panel.
- **Document comments + persona handoff** workflow: the comments feature is its own subsystem; see the Documents view.

---

*If a flow you care about isn't covered, open an issue at the VibeFlow repo with the question.*
