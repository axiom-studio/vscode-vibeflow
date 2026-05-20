# VibeFlow for VS Code

A full AI engineering team — **Developer**, **Architect**, **PM**, **QA**, **Security**, **Principal Engineer**, **DevOps** — inside VS Code. Shared context, persistent decisions, autonomous shipping. Not autocomplete. An AI team that knows your codebase.

Backed by the VibeFlow platform: features, todos, issues, governance, attachments, and compliance all live on a real backend that the agents read + write to. The IDE extension is the live cockpit.

## Quick start

1. **Install** from the VS Code Marketplace, or `code --install-extension vscode-vibeflow-1.0.2.vsix`
2. **Sign in** — run `VibeFlow: Setup` from the command palette and paste your API key from [cloud.axiomstudio.ai](https://cloud.axiomstudio.ai)
3. **Launch a session** — `VibeFlow: Launch Session` → pick personas, provider, branch. The agent fleet starts working.

If you already use [`vibeflow-cli`](https://github.com/axiom-studio/vibeflow-cli), the extension reads `~/.vibeflow-cli/config.yaml` on startup — or click **Install Latest** in Settings → CLI Interface to download the binary in one step.

## Features

### Agent fleet
Live tree of running agent sessions, grouped by branch. Status icons surface heartbeat health (green active, yellow stale, gray inactive). Each session gets its own integrated terminal; right-click any agent for **Kill / Restart / Focus / Copy session id / Open Session Panel**.

### Chat-first sessions with rich rendering
A dedicated chat panel per agent with markdown rendering, syntax-highlighted code blocks, inline-unified or split-view diffs, and clickable **commit hashes** + **file paths** that open in the right viewer. The transcript renders agent activity sub-millisecond after the agent emits it via a provider-agnostic stream-json transport (Claude Code, Codex, Gemini, Cursor, Qwen). Working indicator with a live time counter while the agent is thinking.

### Chat attachments
Paste a screenshot, drag-drop files, or pick via the paperclip button. Files upload to the project's asset storage, get cached locally for instant rerender, and embed inline in the transcript — images preview at full size (click to open in VS Code's image viewer), other formats become file cards that open in the appropriate editor on click. Supports images, PDFs, Office docs, archives, code/text, audio, video — anything the platform stores. Attachments include a machine-readable footer so agents can discover and fetch them via the standard MCP tools.

### @mention autocomplete
Type `@` in any chat input to surface the picker — `@document`, `@context`, `@todo`, `@issue`, `@feature`, or `@symbol` (LSP workspace-symbol). Mentions embed as `[type:id "name"]` tokens that the platform resolves server-side.

### Project Items + Work Items
Two complementary lenses on the same project:

- **Work Items** — kanban-style status grouping (In Progress / Ready / In Review / Done / Closed). The everyday work surface.
- **Project Items** — hierarchical, Jira-Backlog-style. **Features** expand to show their todos nested; **Issues** sit separately since they have no feature parent.

Click any item to open the detail panel with execution logs, QA verify/reject, security review, and PR creation.

### Compliance view
A dedicated `VibeFlow: Open Compliance` page (`Cmd+Shift+V C`) mirroring the platform's compliance dashboard — 6 top-stat tiles, framework rollups (HIPAA / SOC 2 / PCI-DSS / ISO 27001 / GDPR / CMMC / FedRAMP), a filterable findings table with expandable rows showing description / remediation / resolution commit / resolver. CSV export with OWASP CSV-injection guard.

### Activity Feed (Monitor container)
Real-time streaming of every agent action. 9 message types with per-persona color coding, react-virtuoso for smooth scroll at 500+ entries, survives sidebar collapse + extension reload (host-side replay buffer + `vscode.setState` persistence). Drag the Monitor container to the right sidebar to keep it visible alongside the editor.

### Dashboard
`VibeFlow: Open Dashboard` (`Cmd+Shift+V D`) — React Flow live topology of personas → branches → work items, composed over 7 parallel API endpoints with 30-second polling. Character-first persona nodes; click to focus the agent's terminal.

### Kanban board
`VibeFlow: Open Kanban` (`Cmd+Shift+V K`) — drag-and-drop work items between status columns. Backed by server-side reconciliation: an invalid move snaps back automatically.

### Project switcher
A `$(folder) <project-name>` pill in the status bar (priority 99, right of the connection indicator). Click to open a Quick Pick of all your projects. Also reachable via `Cmd+Shift+V P` or `VibeFlow: Switch Project…`. Auto-switch prompt when opening a folder that maps to a different VibeFlow project than the one currently active.

### CLI auto-install
Settings → CLI Interface → **Install Latest** downloads the matching `vibeflow-cli` binary from GitHub Releases for your platform, verifies the checksum, extracts to the extension's local storage, and wires the path into `vibeflow.cli.binaryPath` — no manual download/chmod/PATH editing.

### File decorations
Each file the active agent is touching gets a per-persona color badge in the Explorer. TTL sweep so old markers age out cleanly.

### Settings (8 dedicated tabs)
A real editor-area panel — **Connection**, **Providers**, **Session Defaults**, **Sticky Models**, **Worktrees**, **Notifications**, **CLI Interface**, **About**. Per-persona sticky models (Architect → Opus, Developer → Sonnet, QA → Haiku) exposed to the agent binary via `VIBEFLOW_MODEL`.

### Worktrees
Collapsible Worktrees section in the Agent Fleet sidebar lists every git worktree in the workspace with its branch, path, current marker, and dirty status. Right-click any worktree to **Open in New Window**, **Delete** (with dirty-aware confirmation), or **Create Session Here** — the last one opens the launch wizard with branch + workspace pre-filled.

### MCP Server Definition Provider
The extension registers VibeFlow MCP automatically with Copilot Agent Mode, Continue, Cody, and any tool that uses `vscode.lm.registerMcpServerDefinitionProvider`. No manual `claude mcp add` required.

### @vibeflow Chat Participant
Natural-language commands in Copilot Chat: `/status`, `/create`, `/review`, `/summary`, `/launch`, `/respond`.

## Session modes

- **Vanilla** — normal mode with per-action permission prompts (safe default)
- **VibeFlow Mode** — autonomous execution with skip-permissions (`--dangerously-skip-permissions` on Claude, `--yolo` on Codex/Gemini, `--yolo --approve-mcps` on Cursor). Use only in isolated environments.
- **Chat-first headless** — agent runs in the background via a stream-json subprocess (or optional tmux backing) instead of a foreground terminal. UI is the chat panel; sub-millisecond event streaming.

## Settings (selected)

| Setting | Default | Description |
|---------|---------|-------------|
| `vibeflow.serverUrl` | `https://cloud.axiomstudio.ai` | VibeFlow server URL (HTTPS required outside localhost) |
| `vibeflow.defaultPersona` | `developer` | Default persona for new sessions |
| `vibeflow.defaultProvider` | `claude` | Default AI provider |
| `vibeflow.session.terminalMode` | `hybrid` | Terminal visibility: `hybrid` / `all` / `none` |
| `vibeflow.session.headlessBacking` | `auto` | Chat-first session backing: `auto` (VS Code terminal) / `tmux` (Unix only; survives IDE restart) / `vscode` |
| `vibeflow.polling.interval` | `30` | UI refresh interval (seconds) |
| `vibeflow.autoDetectProject` | `true` | Auto-match git remote to project on activate + on workspace folder change |
| `vibeflow.worktree.baseDir` | `.claude/worktrees` | Subdirectory for cross-branch worktrees |
| `vibeflow.worktree.cleanupOnKill` | `ask` | Cleanup policy on session kill: `ask` / `always` / `never` |
| `vibeflow.cli.enabled` | `false` | Use the `vibeflow` CLI TUI instead of per-persona terminals |
| `vibeflow.cli.binaryPath` | (auto) | Path to the `vibeflow` binary (auto-set by **Install Latest**) |

## Requirements

- VS Code **1.93+**
- One of: `claude`, `codex`, `gemini`, or `cursor agent` on PATH
- A VibeFlow account at [cloud.axiomstudio.ai](https://cloud.axiomstudio.ai) with an API key

## Security

- API key stored in VS Code Secrets API (encrypted, per-machine)
- Provider tokens (`MCP_TOKEN`, `GEMINI_API_KEY`) stored in Secrets API; launch wizard pre-fills from there
- HTTPS required for `vibeflow.serverUrl` (HTTP allowed only for `localhost` / `127.0.0.1` / `[::1]`); validated at activation, every REST request, and MCP transport construction (regression-guarded by `scripts/check-security-guards.mjs`)
- `.mcp.json` (which embeds the bearer token) is only written when `git check-ignore` confirms the workspace will exclude it; supports negation patterns
- All worktree commands use `execFileSync` argv form (no shell), with branch-name allowlist and path-confinement against `..` traversal
- All webviews ship with strict CSP + CSPRNG nonces, `localResourceRoots` scoped to bundle root + asset cache
- Chat attachments validated host-side: declared MIME re-verified against magic bytes; executables (PE/ELF/Mach-O/Java class) rejected unconditionally; filenames sanitized; 32MB cap; binary cache cleared on logout
- Vulnerability disclosure: see [SECURITY.md](https://github.com/axiom-studio/vscode-vibeflow/blob/main/SECURITY.md)

## Support

- **Report a bug or request a feature** → [github.com/axiom-studio/vscode-vibeflow/issues](https://github.com/axiom-studio/vscode-vibeflow/issues) (also reachable in-IDE via `VibeFlow: Report an Issue…`)
- **Account / billing / non-bug questions** → [support@axiomstudio.ai](mailto:support@axiomstudio.ai)
- **Security vulnerabilities** → [security@axiomstudio.ai](mailto:security@axiomstudio.ai) ([SECURITY.md](https://github.com/axiom-studio/vscode-vibeflow/blob/main/SECURITY.md))

## License

Apache 2.0 — see [LICENSE](LICENSE)
