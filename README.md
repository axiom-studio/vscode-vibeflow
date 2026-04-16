# VibeFlow for VSCode

Multi-persona AI agent orchestration, project management, and governance — all from your IDE.

## Quick Start

1. **Install**: `code --install-extension vscode-vibeflow-0.1.0.vsix`
2. **Setup**: Run `VibeFlow: Setup` from the command palette (Cmd+Shift+P) — paste your API key from [Account > API Keys](https://cloud.axiomstudio.ai)
3. **Launch**: Run `VibeFlow: Launch Session` — pick personas, provider, branch, and go

## Features

### Agent Fleet
See all running AI agent sessions grouped by branch. Green = active, yellow = stale heartbeat, gray = inactive. Click to focus the agent's terminal.

### Work Items
Browse features, todos, and issues grouped by status (In Progress, Ready, In Review, Done). Click to open the detail panel with execution logs and QA/Security review actions.

### Activity Feed
Real-time streaming of agent activity. 9 message types with per-persona color coding and react-virtuoso for smooth scrolling.

### Terminal-First Execution
Agents run in VSCode integrated terminals. Code agents (Developer, Architect, PE) get visible terminals; advisory agents (QA, Security, PM) run hidden in the background. Configurable via `vibeflow.session.terminalMode`.

### Document Viewer with Comments
Open PRDs and architecture docs in a React-based markdown viewer with syntax highlighting, GFM tables, and section-based inline comments. Comment on specific sections and notify other personas.

### @vibeflow Chat Participant
Natural language interface in Copilot Chat: `/status`, `/create`, `/review`, `/summary`, `/launch`, `/respond`.

### Session Modes
- **Vanilla** — normal mode with permission prompts
- **Auto Mode** — classifier-approved actions (Claude Team/Enterprise)
- **VibeFlow Mode** — full autonomous execution (`--dangerously-skip-permissions`)

### Per-Persona Sticky Models
Each persona remembers its preferred AI model. Architect defaults to Opus (reasoning), Developer to Sonnet (speed), QA to Haiku (cost).

## Architecture

```
Sidebar (4 views)                    Editor Area
┌──────────────────────┐    ┌──────────────────────────────┐
│ Agent Fleet (tree)    │    │ Work Item Detail Panel        │
│ Work Items (tree)     │    │ Session Focus Panel           │
│ Activity Feed (web)   │    │ Document Viewer (React)       │
│ Documents (tree)      │    │ Settings Panel (React)        │
└──────────────────────┘    └──────────────────────────────┘

Integrated Terminals (primary agent surface)
┌───────────────────────┬───────────────────────┐
│ VibeFlow: Developer   │ VibeFlow: Architect   │
│ [main]                │ [main]                │
└───────────────────────┴───────────────────────┘
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `vibeflow.serverUrl` | `https://cloud.axiomstudio.ai` | VibeFlow server URL |
| `vibeflow.defaultPersona` | `developer` | Default persona for new sessions |
| `vibeflow.defaultProvider` | `claude` | Default AI provider |
| `vibeflow.session.terminalMode` | `hybrid` | Terminal visibility (hybrid/all/none) |
| `vibeflow.polling.interval` | `30` | UI refresh interval (seconds) |
| `vibeflow.autoDetectProject` | `true` | Auto-match git remote to project |

## CLI Config Integration

If you have `vibeflow-cli` installed, the extension reads `~/.vibeflow-cli/config.yaml` on startup — no separate Setup wizard needed.

## Requirements

- VSCode 1.93+
- `claude` CLI (or `codex`/`gemini`/`cursor agent`) on PATH
- VibeFlow MCP server configured: `claude mcp add --transport http vibeflow https://cloud.axiomstudio.ai/rest/v1/vibeflow/mcp --header "Authorization: Bearer <key>"`

## License

Apache 2.0 — see [LICENSE](LICENSE)
