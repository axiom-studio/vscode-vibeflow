# VibeFlow

A full AI engineering team — **Developer**, **Architect**, **Principal Engineer**, **Product Manager**, **Project Manager**, **UX Designer**, **QA Lead**, **Security Lead**, and **Customer** — inside your editor. Shared context, persistent decisions, governed autonomous shipping. Not autocomplete. An AI team that knows your codebase.

Backed by the VibeFlow platform: features, todos, issues, governance, attachments, and compliance all live on a real backend that the agents read and write to. The editor extension is the live cockpit.

> **Runs in VS Code _and_ Cursor** (and other VS Code forks like VS Codium). It's a single cross-host extension — same views, commands, panels, keybindings, and Settings UI everywhere. The only real differences are **where you install it from** (Marketplace vs Open VSX) and a couple of Cursor-specific notes called out below.

## Install

The extension is published as **`AxiomStudio.vscode-vibeflow`** (display name **"VibeFlow"**).

**VS Code** — [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=AxiomStudio.vscode-vibeflow):
- Extensions view (`Cmd/Ctrl+Shift+X`) → search **VibeFlow** (publisher **AxiomStudio**) → Install, or
- `code --install-extension AxiomStudio.vscode-vibeflow`

**Cursor / VS Codium / other forks** — these editors use the [Open VSX Registry](https://open-vsx.org/extension/AxiomStudio/vscode-vibeflow):
- Extensions view (`Cmd/Ctrl+Shift+X`) → search **VibeFlow** → Install, or
- drag the `.vsix` onto the Extensions panel, or run **Extensions: Install from VSIX…** from the Command Palette, or `cursor --install-extension <path-to>.vsix`

> **Cursor note 1 — the listing still reads "VibeFlow."** There is one cross-host build; the `vscode` in the id is historical. It's the right extension for Cursor.
>
> **Cursor note 2 — "Cursor" means two things.** The *editor* you're in is Cursor; separately, **Cursor is one of VibeFlow's selectable AI providers** (the agent can run on the `cursor` CLI). They're independent — you can run any provider inside the Cursor editor, and the Cursor provider works in any editor.

## Quick start

1. **Install** (above).
2. **Connect** — run **`VibeFlow: Setup`** from the Command Palette: server URL → API key (from [cloud.axiomstudio.ai](https://cloud.axiomstudio.ai)) → project. The key is stored in the editor's encrypted Secrets API.
3. **Launch a session** — **`VibeFlow: Launch Session`** (`Cmd/Ctrl+Shift+V L`) → pick persona(s), provider, branch, and session mode. The agent fleet starts working.

If you already use [`vibeflow-cli`](https://github.com/axiom-studio/vibeflow-cli), the extension can hand session management to it — or click **Install Latest** in Settings → CLI Interface to download the binary in one step.

## Full user guide

A complete user-facing guide ships in the repo, in two parallel editions:

- **VS Code edition** → [`docs/vscode-vibeflow/docs/`](docs/vscode-vibeflow/docs/index.md)
- **Cursor edition** → [`docs/cursor-vibeflow/docs/`](docs/cursor-vibeflow/docs/index.md)

Each is nine documents: getting started, a feature tour of every view/panel/command, end-to-end flow diagrams, the chat-first deep dive, the full settings reference, troubleshooting, glossary, and FAQ. Publishing the extension is covered in [`docs/publishing.md`](docs/publishing.md).

## The team (9 personas)

You launch one agent **per persona**; each polls independently for work matching its role. Portraits come from the platform.

| Persona | Character | Role |
|---------|-----------|------|
| Developer | Alex | Implements todos against acceptance criteria (code agent) |
| Architect | Morgan | Plans, writes implementation todos (code agent) |
| Principal Engineer | Kai | Hard cross-cutting work, refactors, hairy bugs (code agent) |
| Product Manager | Aria | Scopes work, writes acceptance criteria |
| Project Manager | Parker | Triage, coordination |
| UX Designer | Dana | Design scoping |
| QA Lead | Quinn | Verifies acceptance (QA gate) |
| Security Lead | Sophie | Reviews diffs for security (security gate) |
| Customer | Casey | Customer-voice feedback |

A minimal team is just **Developer + Architect + QA**; you act as the rest. Code agents (Developer, Architect, Principal Engineer) write source and get visible terminals by default; advisory agents run hidden in hybrid mode.

## Features

### Agent Fleet
Live tree of running agent sessions, grouped by branch. Status icons surface heartbeat health (green active, yellow stale, gray inactive). Each session gets its own integrated terminal; right-click any agent for **Kill / Restart / Delete / Kill & Forget / Focus / Copy Session ID / Open Session Panel**.

### Session Chat with structured rendering
A dedicated chat panel per agent. **Consecutive messages from the same persona group under one header** (avatar + persona-colored name); your messages render as right-aligned bubbles, the agent's as left-aligned, persona-tinted bubbles. Agent responses get **light structural rendering** — section headers, a metadata line, and phase markers (e.g. a warning callout in amber) — on top of full markdown: syntax-highlighted code, inline-unified or split-view diffs, and clickable **commit hashes** + **file paths** that open in the right viewer. In chat-first mode the transcript streams sub-millisecond via a provider-agnostic stream-json transport. A live "Working… {elapsed}" indicator shows while the agent is thinking.

### Chat attachments
Paste a screenshot, drag-drop files, or pick via the paperclip. Files upload to the project's asset storage, cache locally for instant rerender, and embed inline — images preview at full size (click to open in the editor's image viewer), other formats become file cards. Validated host-side (magic-byte MIME check; executables rejected; 32 MB cap). Attachments carry a machine-readable footer so agents can fetch them via the standard MCP tools.

### @mention autocomplete
Type `@` in any chat input to surface the picker — `@document`, `@context`, `@todo`, `@issue`, `@feature`, or `@symbol` (LSP workspace-symbol). Mentions embed as `[type:id "name"]` tokens the platform resolves server-side.

### Work Items + Project Items
Two lenses on the same project:
- **Work Items** — flat, grouped by status (In Review / Planning / Ready to Implement / Implementing / Done / governance / Closed). The everyday action surface: change status/priority, QA verify/reject, security approve/reject.
- **Project Items** — hierarchical: **Features** expand to their nested todos; **Issues** sit at the root (no feature parent).

Click any item for the detail panel: description, execution log, comments, governance actions, and linked PR.

### Documents
Every markdown document attached to the project — PRDs, architecture notes, design specs — rendered read-only in an editor-area viewer.

### Activity Feed (Monitor panel)
Real-time stream of every agent action, color-coded by message type (thinking, action, observation, summary, commit, completion, error, prompt), virtualized for smooth scroll at 500+ entries, and resilient to sidebar collapse + extension reload (host-side replay buffer + state persistence). A pinned plan surfaces when an Architect/Principal Engineer publishes one. Drag the **VibeFlow Monitor** panel to the right sidebar to keep it visible alongside the editor.

### Dashboard
**`VibeFlow: Open Dashboard`** (`Cmd/Ctrl+Shift+V D`) — React Flow live topology of personas → branches → work items, composed over parallel API endpoints with 30-second polling. Click a persona node to focus its terminal.

### Kanban board
**`VibeFlow: Open Kanban Board`** (`Cmd/Ctrl+Shift+V K`) — drag-and-drop work items between status columns, with server-side reconciliation (an invalid move snaps back).

### Compliance
**`VibeFlow: Open Compliance`** (`Cmd/Ctrl+Shift+V C`) — findings grouped by framework: **SOC 2, ISO 27001, PCI-DSS, HIPAA, GDPR, FedRAMP, and CMMC**. Filterable findings table with expandable rows (description / remediation / resolution commit / resolver) and CSV export with an OWASP CSV-injection guard.

### Project switcher
A `$(folder) <project-name>` pill in the status bar. Click (or `Cmd/Ctrl+Shift+V P`, or **`VibeFlow: Switch Project…`**) to pick a project. Auto-detects the project from your workspace's git remote and prompts to switch when you open a folder that maps elsewhere.

### Worktrees
A collapsible Worktrees section in Agent Fleet lists every git worktree with its branch, path, current marker, and dirty status. Right-click to **Open in New Window**, **Delete** (dirty-aware confirmation), or **Create Session Here** (opens the launch wizard pre-filled with that branch).

### CLI auto-install & file decorations
Settings → CLI Interface → **Install Latest** downloads the matching `vibeflow-cli` binary from GitHub Releases, verifies the checksum, and wires the path into `vibeflow.cli.binaryPath`. Separately, each file the active agent is touching gets a per-persona color badge in the Explorer (with a TTL sweep).

### MCP server registration & @vibeflow chat participant
The extension registers VibeFlow as an MCP server via the VS Code MCP API so other Copilot-like tools can discover it, and contributes a **`@vibeflow`** chat participant with `/status`, `/create`, `/review`, `/summary`, `/launch`, `/respond`, `/compliance`. *(Cursor note: Cursor's built-in chat is a separate system and won't surface the `@vibeflow` participant or this MCP registration — Cursor uses its own MCP config. VibeFlow's own Session Chat panel works fully in Cursor regardless.)*

## Session modes

- **Vanilla** — per-action permission prompts (safe default).
- **VibeFlow (YOLO)** — autonomous, skip-permissions (`--dangerously-skip-permissions` on Claude; `--yolo` on Codex/Gemini/Qwen; `--yolo --approve-mcps` on Cursor). Consent modal once per session.
- **Chat-first headless** — the agent runs in the background (stream-json subprocess, or optional `tmux` backing) instead of a foreground terminal; the chat panel is the only surface, with sub-millisecond streaming. Always implies YOLO.

Providers: **Claude, Codex, Gemini, Cursor, Qwen**.

## Settings (all 14)

| Setting | Default | Description |
|---------|---------|-------------|
| `vibeflow.serverUrl` | `https://cloud.axiomstudio.ai` | VibeFlow server URL (HTTPS required outside `localhost`/`127.0.0.1`/`[::1]`) |
| `vibeflow.defaultProvider` | `claude` | Default AI provider the launch wizard pre-selects |
| `vibeflow.cli.enabled` | `false` | Hand session management to the `vibeflow` CLI TUI |
| `vibeflow.cli.binaryPath` | `""` | Absolute path to the `vibeflow` binary (auto-set by **Install Latest**) |
| `vibeflow.session.terminalMode` | `hybrid` | Terminal visibility: `hybrid` / `all` / `none` |
| `vibeflow.session.reattachMode` | `vanilla` | Permission mode on window-reload reattach: `vanilla` / `vibeflow` |
| `vibeflow.session.headlessBacking` | `auto` | Chat-first backing: `auto` (tmux if available, else editor terminal) / `tmux` (Unix only; survives IDE restart) / `vscode` |
| `vibeflow.chat.diffView` | `unified` | Inline diff layout in Session Chat: `unified` / `split` |
| `vibeflow.polling.interval` | `30` | UI refresh interval, seconds (5–300) |
| `vibeflow.notifications.agentPrompts` | `true` | Toast when an agent needs your input |
| `vibeflow.notifications.workItemComplete` | `true` | Toast when a work item reaches `done` |
| `vibeflow.worktree.baseDir` | `.claude/worktrees` | Workspace-relative dir for cross-branch worktrees |
| `vibeflow.worktree.autoCreate` | `false` | Auto-create a worktree when launching against a branch without one |
| `vibeflow.worktree.cleanupOnKill` | `ask` | Cleanup policy on session kill: `ask` / `always` / `never` |

Full per-setting reference (whens, gotchas, enum semantics): [VS Code](docs/vscode-vibeflow/docs/settings-reference.md) · [Cursor](docs/cursor-vibeflow/docs/settings-reference.md).

## Requirements

- **VS Code 1.93+** (the `engines.vscode` minimum). For **Cursor / forks**, a build whose bundled VS Code engine is ≥ 1.93 — check via *Cursor → About*; current releases satisfy this.
- A VibeFlow account at [cloud.axiomstudio.ai](https://cloud.axiomstudio.ai) with an API key.
- For each provider you launch: its CLI on `PATH` — one of `claude`, `codex`, `gemini`, `qwen`, or the Cursor `agent` binary.

## Security

- API key + provider tokens stored in the editor's encrypted, per-machine **Secrets API** — never written to disk in plaintext, never logged, never committed.
- **HTTPS enforced** for `vibeflow.serverUrl` (HTTP allowed only for `localhost` / `127.0.0.1` / `[::1]`); validated at activation, on every REST request, and at MCP transport construction (regression-guarded by `scripts/check-security-guards.mjs`).
- **`.mcp.json`** (which embeds the bearer token) is only written when `git check-ignore` confirms the workspace will exclude it; written with `mode 0o600`.
- Worktree commands use `execFileSync` argv form (no shell), with a branch-name allowlist and `..`-traversal path confinement.
- Webviews ship strict CSP + CSPRNG nonces, with `localResourceRoots` scoped to the bundle root + asset cache.
- Chat attachments validated host-side: declared MIME re-verified against magic bytes; executables (PE/ELF/Mach-O/Java class) rejected; filenames sanitized; 32 MB cap; binary cache cleared on logout.
- Vulnerability disclosure: [SECURITY.md](https://github.com/axiom-studio/vscode-vibeflow/blob/main/SECURITY.md).

## Development

```bash
yarn install            # install host + webview-ui deps
yarn build              # security guards + webview build + esbuild bundle
yarn test               # vitest unit tests (host pure-function modules)
yarn check              # typecheck + lint + test + security-guards
make package            # build and produce vscode-vibeflow-<version>.vsix
```

See [TESTING.md](TESTING.md) for the test-layer model and [`docs/publishing.md`](docs/publishing.md) / [`Makefile`](Makefile) for publishing to Open VSX and the VS Code Marketplace.

## Support

- **Report a bug or request a feature** → [github.com/axiom-studio/vscode-vibeflow/issues](https://github.com/axiom-studio/vscode-vibeflow/issues) (or in-editor via **`VibeFlow: Report an Issue…`**)
- **Account / billing / non-bug questions** → [support@axiomstudio.ai](mailto:support@axiomstudio.ai)
- **Security vulnerabilities** → [security@axiomstudio.ai](mailto:security@axiomstudio.ai)

## License

Apache 2.0 — see [LICENSE](LICENSE).
