# Settings Reference

**Who this is for**: You've seen a setting key and want the full story: what it does, valid values, default, when to change it.

**TL;DR**: VibeFlow ships **14** settings. Most have sensible defaults. This is the authoritative list, pulled straight from `package.json`. If a setting isn't here, it doesn't exist.

---

## Where to change settings

Two options that write to the same place.

**The VibeFlow Settings panel (friendlier).** Run **`VibeFlow: Settings`** (`Cmd/Ctrl+Shift+V S`) or click the **gear icon** in the title bar of any VibeFlow sidebar view (Agent Fleet, Work Items, etc.). Tabbed, with inline descriptions and dropdowns for enums.

**VS Code's `settings.json`.** Run **`Preferences: Open User Settings (JSON)`** (or *Workspace* Settings for per-repo config):

```jsonc
{
  "vibeflow.defaultProvider": "codex",
  "vibeflow.polling.interval": 60,
  "vibeflow.worktree.autoCreate": true
}
```

Workspace settings (`.vscode/settings.json`) override user settings. Changes apply immediately.

---

## Connection

### `vibeflow.serverUrl`

| Field | Value |
|---|---|
| **Key** | `vibeflow.serverUrl` |
| **Type** | `string` |
| **Default** | `https://cloud.axiomstudio.ai` |

**What it does**: The URL of the VibeFlow Cloud server the extension talks to. Every MCP call, dashboard fetch, and login round-trip flows through here.

**When to change it**: You're on a self-hosted or staging VibeFlow deployment.

**Gotchas**: Include the scheme; no trailing slash. Changes invalidate your stored API key, so re-run **`VibeFlow: Setup`**.

---

## Providers

### `vibeflow.defaultProvider`

| Field | Value |
|---|---|
| **Key** | `vibeflow.defaultProvider` |
| **Type** | `string` |
| **Default** | `claude` |

**What it does**: Which AI provider the **Launch Session** wizard pre-selects. You can still override per session; this just sets the default.

**When to change it**: You don't have an Anthropic key but do have OpenAI, Google, or Cursor. Set this to your daily-driver provider so launches are one click less.

**Gotchas**: Free-form string in `package.json`. The **Launch Session** wizard quick-pick lists four providers: **`claude`**, **`codex`**, **`gemini`**, **`cursor`**. A fifth value, **`qwen`**, is also a valid provider (it has a working stream-json adapter) but isn't surfaced in the wizard quick-pick — you can still set it here by hand. Unrecognized values fall back to `claude`.

---

## CLI integration

### `vibeflow.cli.enabled`

| Field | Value |
|---|---|
| **Key** | `vibeflow.cli.enabled` |
| **Type** | `boolean` |
| **Default** | `false` |

**What it does**: Hands session lifecycle off to the standalone **vibeflow CLI** (a terminal TUI) instead of per-persona VS Code terminals. The sidebar still shows live agent state either way.

**When to change it**: You already use the `vibeflow` CLI and prefer its TUI.

**Gotchas**: Requires the `vibeflow` binary on `PATH`. Install from [github.com/axiom-studio/vibeflow-cli/releases](https://github.com/axiom-studio/vibeflow-cli/releases), or run **`VibeFlow: Install Latest CLI`**. When enabled, the Agent Fleet launch button changes from "Launch Session" to "Open CLI".

### `vibeflow.cli.binaryPath`

| Field | Value |
|---|---|
| **Key** | `vibeflow.cli.binaryPath` |
| **Type** | `string` |
| **Default** | `""` (empty, uses `PATH` lookup) |

**What it does**: Absolute path to the `vibeflow` CLI binary. Overrides `PATH` lookup when set.

**When to change it**: You have multiple CLI versions or your CLI lives outside `PATH`.

**Gotchas**: Must be *absolute* (e.g. `/usr/local/bin/vibeflow`, not `~/bin/vibeflow`). Ignored unless `vibeflow.cli.enabled` is `true`. Typos fail at launch time, not save time.

---

## Sessions

### `vibeflow.session.terminalMode`

| Field | Value |
|---|---|
| **Key** | `vibeflow.session.terminalMode` |
| **Type** | `string` (enum) |
| **Default** | `hybrid` |
| **Valid values** | `hybrid`, `all`, `none` |

**What it does**: Controls which agent terminals are visible when sessions launch.

| Value | Behavior |
|---|---|
| `hybrid` | Code agents (Dev/Arch/PE) visible; advisory agents hidden. |
| `all` | Every agent terminal visible. |
| `none` | All hidden; sessions run in the background only. |

**When to change it**: Pick `all` to watch advisory agents (QA, Security, PM) live. Pick `none` if the chat panel + activity feed are enough.

**Gotchas**: Affects *new* sessions only. Use **`VibeFlow: Show All Agent Terminals`** to unhide ad-hoc.

### `vibeflow.session.reattachMode`

| Field | Value |
|---|---|
| **Key** | `vibeflow.session.reattachMode` |
| **Type** | `string` (enum) |
| **Default** | `vanilla` |
| **Valid values** | `vanilla`, `vibeflow` |

**What it does**: When you reopen VS Code, the extension reattaches to still-alive sessions (via `.vibeflow-session-{persona}` files in your workspace root). This setting picks *which permission mode* the reattach uses.

| Value | Behavior |
|---|---|
| `vanilla` | Safe per-action permission prompts. The agent asks before each file edit, shell command, git op. |
| `vibeflow` | Reattach in **YOLO mode** (`--dangerously-skip-permissions`) with no prompts. |

**When to change it**: You routinely launch in YOLO mode and want restarts to preserve that.

**Gotchas**: `vibeflow` is **risky**. Reattached sessions get full permission with no prompts. Only set it if (a) your prior session was YOLO and (b) you trust the agent to keep running unattended. No per-session override on reattach: this applies to every session that comes back.

### `vibeflow.session.headlessBacking`

| Field | Value |
|---|---|
| **Key** | `vibeflow.session.headlessBacking` |
| **Type** | `string` (enum) |
| **Default** | `auto` |
| **Valid values** | `auto`, `tmux`, `vscode` |

**What it does**: Where a **chat-first** (headless) session physically runs when there's no visible terminal. The chat panel is just UI; the agent process needs a real process tree somewhere.

| Value | Behavior |
|---|---|
| `auto` | tmux when available (Mac/Linux with tmux installed), otherwise hidden VS Code terminal. **Recommended**, since tmux is the only backing that supports multi-turn chat today. |
| `tmux` | Always tmux. Agent survives IDE restart; attach via `tmux -L vibeflow-headless attach -t <name>`. |
| `vscode` | Always hidden VS Code terminal. Agent dies with the IDE window AND handles only a single chat turn before exiting. |

**When to change it**: Force `tmux` for guaranteed multi-turn + restart survival. Force `vscode` only for debugging.

**Gotchas**: **tmux is Unix-only.** On Windows the `tmux` value is silently ignored and falls back to `vscode`. On Mac/Linux without tmux installed, install it (`brew install tmux` or your distro's package manager) before relying on chat-first.

---

## Notifications

### `vibeflow.notifications.agentPrompts`

| Field | Value |
|---|---|
| **Key** | `vibeflow.notifications.agentPrompts` |
| **Type** | `boolean` |
| **Default** | `true` |

**What it does**: When an agent needs your input, VS Code shows a notification toast in addition to the activity feed entry and status-bar badge. This toggle controls the toast only.

**When to change it**: Toasts are noisy and you'd rather poll the Activity Feed yourself.

**Gotchas**: Turning this off does **not** hide prompts. They still appear in the Activity Feed, the Agent Fleet tree, and the status-bar item. You're only muting the OS-level toast.

### `vibeflow.notifications.workItemComplete`

| Field | Value |
|---|---|
| **Key** | `vibeflow.notifications.workItemComplete` |
| **Type** | `boolean` |
| **Default** | `true` |

**What it does**: Shows a toast when an agent transitions a work item to `done`.

**When to change it**: You run multiple agents and the drip of "todo #X done" toasts is distracting. Turn off; the Work Items view still updates live.

**Gotchas**: Doesn't affect prompts, errors, or security/QA review notifications, just the "work item complete" toast.

---

## Polling

### `vibeflow.polling.interval`

| Field | Value |
|---|---|
| **Key** | `vibeflow.polling.interval` |
| **Type** | `number` (seconds) |
| **Default** | `30` |
| **Range** | `5`–`300` |

**What it does**: How often the extension re-fetches data to refresh sidebar views. Lower means snappier UI; higher means less CPU and network.

**When to change it**: Bump up (`60`–`120`) on a low-powered laptop or metered connection. Bump down (`10`–`15`) when actively shepherding agents.

**Gotchas**: Live events (agent prompts, your own actions) push instantly; this only governs full-list re-fetches. Minimum 5 seconds; lower values are rejected.

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

**When to change it**: Personal preference. Try the other if the default feels cramped.

**Gotchas**: **Purely cosmetic**. It changes the inline preview only. Each diff has an **Open in Editor** button that opens VS Code's native diff editor for proper review. Use that button when a diff matters.

---

## Worktrees

### `vibeflow.worktree.baseDir`

| Field | Value |
|---|---|
| **Key** | `vibeflow.worktree.baseDir` |
| **Type** | `string` |
| **Default** | `.claude/worktrees` |

**What it does**: Where the extension creates git **worktrees** for cross-branch agent sessions. Path is *relative to your workspace root*.

**When to change it**: The default lives under `.claude/` for historical reasons; you might prefer `.vibeflow/worktrees` or a path your `.gitignore` already covers.

**Gotchas**: Must be relative; absolute paths are rejected. Created on demand. Make sure the path is git-ignored or outside the tracked tree, otherwise `git status` floods with nested-working-tree noise.

### `vibeflow.worktree.autoCreate`

| Field | Value |
|---|---|
| **Key** | `vibeflow.worktree.autoCreate` |
| **Type** | `boolean` |
| **Default** | `false` |

**What it does**: When you launch against a branch without a worktree, auto-create one at `<workspace>/<worktree.baseDir>/<branch>` instead of prompting.

**When to change it**: You run agents on multiple branches and want to skip the "create worktree?" dialog.

**Gotchas**: Off by default, since worktrees consume disk and clutter `git worktree list`. Pair with `vibeflow.worktree.cleanupOnKill = always` for fully automatic lifecycle.

### `vibeflow.worktree.cleanupOnKill`

| Field | Value |
|---|---|
| **Key** | `vibeflow.worktree.cleanupOnKill` |
| **Type** | `string` (enum) |
| **Default** | `ask` |
| **Valid values** | `ask`, `always`, `never` |

**What it does**: What happens to a worktree when the session inside it ends (killed, completed, or crashed).

| Value | Behavior |
|---|---|
| `ask` | Prompts every time; you decide per-session. |
| `always` | Deletes the worktree automatically. |
| `never` | Keeps the worktree for follow-up work. |

**When to change it**: `always` if worktrees are ephemeral (launch, get diff, move on). `never` if you resume work in the same branch after the agent exits.

**Gotchas**: `always` permanently deletes the worktree *including any uncommitted changes the agent left behind*. Cleanup uses `git worktree remove` (destructive). If you might want the diff later, stick with `ask`.

---

## Settings I rarely touch

The average user opens **`VibeFlow: Settings`** once during setup and never comes back. These six can sit at their defaults forever:

- `vibeflow.serverUrl`: only matters on a self-hosted server.
- `vibeflow.cli.enabled`: most people use the extension's built-in session management.
- `vibeflow.cli.binaryPath`: only meaningful when `cli.enabled` is on.
- `vibeflow.session.reattachMode`: `vanilla` is the right answer unless you have a specific reason.
- `vibeflow.chat.diffView`: try the default, switch once if you don't like it, then forget about it.
- `vibeflow.worktree.baseDir`: the default path is fine for most repos.

---

## Common adjustments

The changes most users make in their first week:

1. **Switch `vibeflow.defaultProvider` from `claude` to `codex` / `gemini` / `cursor`** if you don't have an Anthropic key. Saves a click on every launch.
2. **Bump `vibeflow.polling.interval` from `30` to `60`+** if background CPU/network is more than you want for a non-focus tool.
3. **Turn on `vibeflow.worktree.autoCreate`** once you use cross-branch sessions seriously. Removes the "create worktree?" dialog.
4. **Turn off `vibeflow.notifications.workItemComplete`** once you have three or more concurrent agents. Toasts get noisy; the Work Items view shows the same info silently.

---

*Last updated: 2026-06-17*
