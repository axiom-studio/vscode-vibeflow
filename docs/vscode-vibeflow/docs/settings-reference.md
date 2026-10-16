# Settings Reference

**Who this is for**: You've seen a setting key and want the full story: what it does, valid values, default, when to change it.

**TL;DR**: VibeFlow ships **14** settings.
Most have sensible defaults.
This is the authoritative list, pulled straight from `package.json`.
If a setting isn't here, it doesn't exist.

Agents launch only through the VibeFlow CLI, so the extension has no provider, terminal, or worktree settings: those choices are made in the CLI.
Older keys such as `vibeflow.defaultProvider`, `vibeflow.session.terminalMode`, `vibeflow.session.headlessBacking`, and `vibeflow.worktree.*` are no longer read; leftover values in `settings.json` are ignored.

---

## Where to change settings

Two options that write to the same place.

**The VibeFlow Settings panel (friendlier).** Run **`VibeFlow: Settings`** (`Cmd/Ctrl+Shift+V S`) or click the **gear icon** in the Agent Fleet title bar.
Tabs:

| Tab | What's on it |
|---|---|
| **Connection** | **Account** (server URL + Test Connection, API key + Test Key), **VibeFlow CLI** (install, update, binary path override), **MCP for coding agents** |
| **Git Configuration** | Git providers for Cloud Runners (only in builds with Cloud Runners enabled) |
| **Display** | Refresh rate (live + background), chat diff view, notifications |
| **Project** | Project notifications and per-repository Vera review settings — only shown to the project owner and org admins |
| **About** | Version, links |

**VS Code's `settings.json`.** Run **`Preferences: Open User Settings (JSON)`** (or *Workspace* Settings for per-repo config):

```jsonc
{
  "vibeflow.polling.interval": 60,
  "vibeflow.chat.diffView": "split",
  "vibeflow.notifications.workItemComplete": false
}
```

Workspace settings (`.vscode/settings.json`) override user settings.

---

## Connection

### `vibeflow.serverUrl`

| Field | Value |
|---|---|
| **Key** | `vibeflow.serverUrl` |
| **Type** | `string` |
| **Default** | `https://cloud.axiomstudio.ai` |

**What it does**: The URL of the VibeFlow server the extension talks to.
Every MCP call, dashboard fetch, and login round-trip flows through here.

**When to change it**: You're on a self-hosted or staging VibeFlow deployment.

**Gotchas**: Include the scheme; no trailing slash.
HTTPS is required except for `localhost` / `127.0.0.1` / `[::1]`.
In the Settings panel the field saves on Enter or when it loses focus, and **Test Connection** saves and tests what you typed.
A successful Test Connection also writes the URL (with your API key and current project) into the CLI's `config.yaml`, so the CLI talks to the same server.

---

## VibeFlow CLI

### `vibeflow.cli.binaryPath`

| Field | Value |
|---|---|
| **Key** | `vibeflow.cli.binaryPath` |
| **Type** | `string` |
| **Default** | `""` (empty, uses `PATH` lookup) |

**What it does**: Absolute path to the `vibeflow` CLI binary.
Overrides `PATH` lookup when set.

**When to change it**: Your CLI lives outside the `PATH` VS Code sees (for example `/opt/homebrew/bin` on Apple Silicon).

**Gotchas**: Must be *absolute* (e.g. `/usr/local/bin/vibeflow`, not `~/bin/vibeflow`).
**Install Latest** (Settings → Connection → VibeFlow CLI) sets it for you.
In the Settings panel it sits under **Advanced: binary path override**, with a **Browse…** button.

### `vibeflow.cli.mcpName`

| Field | Value |
|---|---|
| **Key** | `vibeflow.cli.mcpName` |
| **Type** | `string` |
| **Default** | `""` (empty, flag omitted) |

**What it does**: An optional MCP name passed to the CLI as `--mcp <value>` when the extension opens it.

**When to change it**: Your workflow needs the CLI pointed at a specific MCP server by name.

**Gotchas**: Not shown in the Settings panel; set it in `settings.json`.
If the CLI terminal is already open, the extension reuses it and warns that the new value isn't applied until you close that terminal.

### `vibeflow.cli.rootPath`

| Field | Value |
|---|---|
| **Key** | `vibeflow.cli.rootPath` |
| **Type** | `string` |
| **Default** | `""` (empty, flag omitted) |

**What it does**: An optional root path passed to the CLI as `--root <value>` when the extension opens it.

**When to change it**: You keep a separate CLI root (its own `config.yaml` and `sessions.json`).

**Gotchas**: Not shown in the Settings panel; set it in `settings.json`.
The extension follows it everywhere: Agent Fleet reads `<root>/sessions.json`, the tmux probe uses the CLI's socket for that root, and the Connection mirror writes `<root>/config.yaml`.

### `vibeflow.cli.updateCheckIntervalHours`

| Field | Value |
|---|---|
| **Key** | `vibeflow.cli.updateCheckIntervalHours` |
| **Type** | `number` (hours) |
| **Default** | `12` |

**What it does**: How often the extension checks GitHub for a newer VibeFlow CLI release.
You are notified only when a newer version exists, never when you're up to date.

**When to change it**: Set `0` to turn the check off (for example on an air-gapped machine).

**Gotchas**: Values below 1 are raised to 1.
**`VibeFlow: Check for CLI Updates`** (or **Check for Updates** in Settings) checks right away regardless.

---

## Sessions

### `vibeflow.session.reattachMode`

| Field | Value |
|---|---|
| **Key** | `vibeflow.session.reattachMode` |
| **Type** | `string` (enum) |
| **Default** | `vanilla` |
| **Valid values** | `vanilla`, `vibeflow` |

**What it does**: When you reopen VS Code, the extension can reattach to still-alive sessions it finds through `.vibeflow-session-{persona}` files in your workspace.
This setting picks *which permission mode* the reattach uses when the session's own launch mode wasn't recorded.

| Value | Behavior |
|---|---|
| `vanilla` | Safe per-action permission prompts. The agent asks before each file edit, shell command, git op. |
| `vibeflow` | Reattach in **YOLO mode** (skip-permissions) with no prompts. |

**When to change it**: You routinely run agents in YOLO mode and want reattaches to preserve that.

**Gotchas**: `vibeflow` is **risky**.
Reattached sessions get full permission with no prompts.
Only set it if (a) your prior session was YOLO and (b) you trust the agent to keep running unattended.

---

## Notifications

### `vibeflow.notifications.agentPrompts`

| Field | Value |
|---|---|
| **Key** | `vibeflow.notifications.agentPrompts` |
| **Type** | `boolean` |
| **Default** | `true` |

**What it does**: When an agent needs your input, VS Code shows a notification toast in addition to the Activity Feed entry and status-bar badge.
This toggle controls the toast only.

**When to change it**: Toasts are noisy and you'd rather watch the Activity Feed yourself.

**Gotchas**: Turning this off does **not** hide prompts.
They still appear in the Activity Feed and the status-bar item.
You're only muting the toast.

### `vibeflow.notifications.workItemComplete`

| Field | Value |
|---|---|
| **Key** | `vibeflow.notifications.workItemComplete` |
| **Type** | `boolean` |
| **Default** | `true` |

**What it does**: Shows a toast when an agent transitions a work item to `done`.

**When to change it**: You run multiple agents and the drip of "todo #X done" toasts is distracting.
Turn off; the Work Items view still updates.

**Gotchas**: Doesn't affect prompts, errors, or Vera review toasts, just the "work item complete" toast.

---

## Polling

### `vibeflow.polling.interval`

| Field | Value |
|---|---|
| **Key** | `vibeflow.polling.interval` |
| **Type** | `number` (seconds) |
| **Default** | `30` |

**What it does**: The background refresh interval: the sidebar trees (Agent Fleet, Work Items, Pull Requests, …), branch-review status, dashboard, compliance, and tickets.
Polling pauses while the window is unfocused.

**When to change it**: Bump up (`60`–`120`) on a low-powered laptop or metered connection.
Bump down (`10`–`15`) when actively shepherding agents.

**Gotchas**: The Settings panel accepts `5`–`300` (Display → Refresh rate → **Background**).
A change applies to views opened afterwards; reload the window to apply it everywhere.

### `vibeflow.polling.liveInterval`

| Field | Value |
|---|---|
| **Key** | `vibeflow.polling.liveInterval` |
| **Type** | `number` (seconds) |
| **Default** | `5` |

**What it does**: The live refresh interval: the Activity Feed, open session chats, work-item panels, and brainstorms.
Lower is snappier and makes more API calls.

**When to change it**: Raise it if many panels are open and you want fewer API calls.

**Gotchas**: The Settings panel accepts `2`–`60` (Display → Refresh rate → **Live**).
Like the background interval, it pauses while the window is unfocused and applies to views opened afterwards.

---

## Chat

### `vibeflow.chat.diffView`

| Field | Value |
|---|---|
| **Key** | `vibeflow.chat.diffView` |
| **Type** | `string` (enum) |
| **Default** | `unified` |
| **Valid values** | `unified`, `split` |

**What it does**: How diff code blocks render in the **Session Chat** panel.

| Value | Behavior |
|---|---|
| `unified` | Added/removed lines stacked vertically with a `+`/`-` gutter. |
| `split` | Before/after in two columns aligned by hunk. |

**When to change it**: Personal preference.
Try the other if the default feels cramped.

**Gotchas**: **Purely cosmetic**.
Each diff has an **Open in Editor** button that opens VS Code's native diff editor for proper review.

### `vibeflow.chat.showTmuxAttachButton`

| Field | Value |
|---|---|
| **Key** | `vibeflow.chat.showTmuxAttachButton` |
| **Type** | `boolean` |
| **Default** | `true` |

**What it does**: Shows a button in the header of a tmux-backed chat-first Session Chat that opens the session's tmux shell in a terminal (`tmux -L vibeflow-headless attach -t <name>`), so you can watch the raw agent exchange.

**When to change it**: Turn off if you never debug chat-first sessions.

**Gotchas**: Only appears for existing chat-first sessions backed by tmux; agents launched from the CLI don't use it.

---

## Diagnostics

### `vibeflow.debug.polling`

| Field | Value |
|---|---|
| **Key** | `vibeflow.debug.polling` |
| **Type** | `boolean` |
| **Default** | `false` |

**What it does**: Logs each refresh, plus pause/resume on window focus, to the **VibeFlow Polling** output channel.

**When to change it**: A view isn't refreshing when you expect it to.

### `vibeflow.cloudRunners.debug`

| Field | Value |
|---|---|
| **Key** | `vibeflow.cloudRunners.debug` |
| **Type** | `boolean` |
| **Default** | `false` |

**What it does**: Logs Cloud Runners API calls (method, path, status, and response shape) to the **VibeFlow Cloud Runners** output channel.
Request bodies and secrets are never logged.

**When to change it**: Diagnosing a Cloud Runner or git-provider failure.

---

## Settings I rarely touch

The average user opens **`VibeFlow: Settings`** once during setup and never comes back.
These can sit at their defaults forever:

- `vibeflow.serverUrl`: only matters on a self-hosted server.
- `vibeflow.cli.binaryPath`, `vibeflow.cli.mcpName`, `vibeflow.cli.rootPath`: only for non-standard CLI installs.
- `vibeflow.session.reattachMode`: `vanilla` is the right answer unless you have a specific reason.
- `vibeflow.chat.diffView`: try the default, switch once if you don't like it, then forget about it.
- The two debug settings: only while diagnosing a problem.

---

## Common adjustments

The changes most users make in their first week:

1. **Bump `vibeflow.polling.interval` from `30` to `60`+** if background CPU/network is more than you want for a non-focus tool.
2. **Turn off `vibeflow.notifications.workItemComplete`** once you have three or more concurrent agents.
   Toasts get noisy; the Work Items view shows the same info silently.
3. **Set `vibeflow.cli.binaryPath`** (or click **Install Latest**) if **Launch Session** says the CLI can't be found.
