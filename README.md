# VibeFlow for VSCode

Multi-persona AI agent orchestration, project management, and governance — all from your IDE.

VibeFlow runs a fleet of specialized AI agents (Developer, Architect, Principal Engineer, QA, Security, PM, etc.) inside VSCode. Each agent gets its own integrated terminal, sticky model preference, and a live view in the sidebar. Work items, comments, governance gates, and PR creation all happen in one place.

## Quick Start

1. **Install**: `code --install-extension vscode-vibeflow-1.0.0.vsix` (or install from the Marketplace)
2. **Setup**: run `VibeFlow: Setup` from the command palette (Cmd+Shift+P) — paste your API key from [Account → API Keys](https://cloud.axiomstudio.ai)
3. **Launch**: run `VibeFlow: Launch Session` — pick personas, provider, branch, and go

If you have `vibeflow-cli` installed, the extension reads `~/.vibeflow-cli/config.yaml` on startup — no separate Setup wizard needed.

## What's in 1.0

### Agent Fleet
Live view of every running agent session, grouped by branch. Status icons surface heartbeat health (green = active, yellow = stale, gray = inactive). Click any agent to focus its terminal; right-click for Kill / Restart / Open Session Panel / Copy session id.

### Worktrees
A collapsed Worktrees section in the same sidebar lists every git worktree in the workspace with its branch, path, current marker, and dirty status. Right-click any worktree to **Open in New Window**, **Delete** (with dirty-aware confirmation), or **Create Session Here** — the last one opens the launch wizard with branch + workspace pre-filled, so the agent spawns directly inside the worktree.

### Work Items
Browse features, todos, and issues grouped by status (In Progress, Ready, In Review, Done). Click to open the detail panel with execution logs, QA verify/reject, security review, and PR creation. The same sidebar surfaces unread agent prompts as a status-bar badge.

### Activity Feed (Monitor container)
Real-time streaming of agent activity. 9 message types with per-persona color coding, react-virtuoso for smooth scrolling at 500+ entries. Drag the Monitor container to the right sidebar to keep it visible alongside the editor.

### Pinned Plan
When an agent publishes structured progress (`progress_pct`, `milestone_name`, `current_action`), the Activity Feed pins a live progress card at the top. No more scraping execution-log text.

### Dashboard (React Flow)
`VibeFlow: Open Dashboard` — live topology of personas → branches → work items, composed over 5 parallel API endpoints with 30-second polling. Click a persona node to focus its terminal.

### Kanban Board
`VibeFlow: Open Kanban` — drag-and-drop work items between status columns. Backed by server-side reconciliation: an invalid move snaps back automatically.

### File Decorations
Each file the active agent is touching gets a badge in the Explorer (per-persona color, role-tier shape). TTL sweep so the markers age out cleanly.

### Settings (8 dedicated tabs)
A real editor-area panel — Connection, Providers, Session Defaults, Sticky Models, Worktrees, Notifications, CLI Interface, About. Changes take effect immediately, no reload required.

### Per-Persona Sticky Models
Each persona remembers its preferred AI model. Architect → Opus (reasoning), Developer → Sonnet (speed), QA → Haiku (cost). Configured under Settings → Sticky Models, exposed to the agent binary via `VIBEFLOW_MODEL`.

### Document Viewer with Comments
Open PRDs and architecture docs in a React-based markdown viewer with syntax highlighting, GFM tables, and section-based inline comments. Comment on a specific section and notify a target persona — the comment lands as a session prompt for that persona.

### MCP Server Definition Provider
The extension registers VibeFlow MCP automatically with Copilot, Continue, and Cody agents through `vscode.lm.registerMcpServerDefinitionProvider`. No manual `claude mcp add` required when using those clients.

### @vibeflow Chat Participant
Natural-language commands in Copilot Chat: `/status`, `/create`, `/review`, `/summary`, `/launch`, `/respond`.

## Architecture

```
Sidebar (4 views)                    Editor Area
┌────────────────────────┐    ┌──────────────────────────────┐
│ Agent Fleet (tree)     │    │ Work Item Detail Panel        │
│  ├ branches            │    │ Session Focus Panel           │
│  └ Worktrees section   │    │ Document Viewer (React)       │
│ Work Items (tree)      │    │ Settings Panel (8 tabs)       │
│ Activity Feed (web)    │    │ Dashboard (React Flow)        │
│ Documents (tree)       │    │ Kanban Board (DnD)            │
└────────────────────────┘    └──────────────────────────────┘

Integrated Terminals (primary agent surface — hybrid by default)
┌───────────────────────┬───────────────────────┐
│ VibeFlow: Developer   │ VibeFlow: Architect   │
│ [main]                │ [main]                │
└───────────────────────┴───────────────────────┘
                                  Hidden background terminals: QA, Security, PM, …
```

## Session Modes

- **Vanilla** — normal mode with per-action permission prompts (safe default)
- **VibeFlow Mode** — autonomous execution with skip-permissions (`--dangerously-skip-permissions` on Claude, `--yolo` on Codex/Gemini, `--yolo --approve-mcps` on Cursor). Use only in isolated environments.

## Settings (selected)

| Setting | Default | Description |
|---------|---------|-------------|
| `vibeflow.serverUrl` | `https://cloud.axiomstudio.ai` | VibeFlow server URL (HTTPS required outside localhost) |
| `vibeflow.defaultPersona` | `developer` | Default persona for new sessions |
| `vibeflow.defaultProvider` | `claude` | Default AI provider |
| `vibeflow.session.terminalMode` | `hybrid` | Terminal visibility: `hybrid` / `all` / `none` |
| `vibeflow.session.reattachMode` | `vanilla` | Permission mode used when reattaching phantom sessions on window reload |
| `vibeflow.polling.interval` | `30` | UI refresh interval (seconds) |
| `vibeflow.autoDetectProject` | `true` | Auto-match git remote to project |
| `vibeflow.worktree.baseDir` | `.claude/worktrees` | Subdirectory for cross-branch worktrees |
| `vibeflow.worktree.autoCreate` | `false` | Auto-create a worktree on cross-branch launch |
| `vibeflow.worktree.cleanupOnKill` | `ask` | Cleanup policy on session kill: `ask` / `always` / `never` |
| `vibeflow.cli.enabled` | `false` | Use the `vibeflow` CLI TUI instead of per-persona terminals |

## Requirements

- VSCode 1.93+
- One of: `claude`, `codex`, `gemini`, or `cursor agent` on PATH
- A VibeFlow account at [cloud.axiomstudio.ai](https://cloud.axiomstudio.ai) with an API key

## Security

- API key stored in VSCode Secrets API (encrypted, per-machine)
- Provider tokens (`MCP_TOKEN`, `GEMINI_API_KEY`) stored in Secrets API; launch wizard pre-fills from there
- HTTPS required for `vibeflow.serverUrl` (HTTP allowed only for `localhost` / `127.0.0.1` / `[::1]`); validated at activation, every REST request, and MCP transport construction
- `.mcp.json` (which embeds the bearer token) is only written when `git check-ignore` confirms the workspace will exclude it; supports negation patterns
- All worktree commands use `execFileSync` argv form (no shell), with branch-name allowlist and path-confinement against `..` traversal
- All webviews ship with strict CSP + CSPRNG nonces, `localResourceRoots` scoped to `webview-ui/dist`

## License

Apache 2.0 — see [LICENSE](LICENSE)
