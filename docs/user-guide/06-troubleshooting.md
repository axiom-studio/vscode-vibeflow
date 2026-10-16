# Troubleshooting

**Who this is for**: You've hit a problem with VibeFlow and you want to know what the symptom means, why it's happening, and how to fix it fast. This page is symptom-first. Use `Ctrl+F` / `Cmd+F` and search for the message or behavior you're seeing.

**TL;DR**: Most failures fall into one of three buckets: auth (API key, server URL, the CLI's copy of them), the VibeFlow CLI (not installed, Windows without WSL, a second CLI instance), or what Agent Fleet can see. The fixes below are ordered by how often they hit users, most common first. If nothing here matches, jump to [Still stuck?](#still-stuck) at the bottom.

> Term unfamiliar? See [07-glossary.md](07-glossary.md). Wondering *why* something works the way it does? The flow diagrams in [03-workflows-and-flows.md](03-workflows-and-flows.md) explain the underlying choreography.

---

## "VibeFlow: Not logged in" or no projects appearing in the sidebar

**What it means**: The extension can't reach VibeFlow Cloud with a valid API key. Either the Setup wizard never finished, or your API key has been revoked or rotated server-side.

**Fix**: Run **VibeFlow: Setup** from the Command Palette and walk through the three steps (Server URL, API Key, Project). The new key is stored in VS Code's Secrets API and overrides the old one immediately.
Then open **VibeFlow: Settings → Connection** and click **Test Connection**, so the CLI gets the new key too.

> If the sidebar still shows nothing, run **VibeFlow: Refresh** (`Cmd/Ctrl+Shift+V F`).

---

## "VibeFlow CLI is not installed or not on PATH"

**What it means**: **Launch Session** (or **Open CLI**) couldn't find the `vibeflow` binary: `vibeflow.cli.binaryPath` is empty or wrong, and `vibeflow` isn't on the `PATH` VS Code sees.

**Fix**: Click **Install Latest** in the message (or **VibeFlow: Settings → Connection → VibeFlow CLI → Install Latest**). It downloads the binary, verifies its checksum, and sets `vibeflow.cli.binaryPath`.
If you installed the CLI yourself, set its absolute path under **Advanced: binary path override** in the same card (common on Apple Silicon, where Homebrew installs to `/opt/homebrew/bin`).

---

## "VibeFlow CLI needs WSL on Windows"

**What it means**: You're in a native Windows window. The CLI runs agents in tmux, which Windows doesn't provide, so every CLI action (Launch Session, Open CLI, Install) shows this guidance instead.

**Fix**:

1. Install WSL ([Microsoft's guide](https://learn.microsoft.com/windows/wsl/install)) and the WSL extension in VS Code.
2. Click **Reopen Folder in WSL** in the message (or run it from the Command Palette).
3. In the WSL window, install the CLI from Settings → Connection.

---

## "VibeFlow CLI is already running externally (PID …)"

**What it means**: Another `vibeflow` CLI — usually one you started in a separate terminal app — holds the CLI's lock for this root, so a second instance can't start.

**Fix**: Quit that CLI (you don't need to stop its agents — they keep running in tmux), then click **Retry**. The agents show up in Agent Fleet either way.

> No CLI you remember starting? Look for a leftover process: `ps aux | grep vibeflow` and quit it.

---

## Agent Fleet is empty, but the CLI is running agents

**What it means**: Agent Fleet lists the CLI's live agents by reading `<cli root>/sessions.json` and asking tmux which of them are alive. If it reads a different root than the CLI uses, or tmux isn't reachable, it sees nothing.

**Fix**: Check, in order:

1. **Same CLI root.** If you start the CLI with `--root`, set the same path in `vibeflow.cli.rootPath`. The extension then reads that root's `sessions.json` and uses the CLI's tmux socket for it.
2. **Same machine.** On Windows, the extension must run in the WSL window where the CLI runs.
3. **Just started?** A brand-new agent appears on the next background refresh (`vibeflow.polling.interval`, 30 s by default), or run **VibeFlow: Refresh**.

To see each refresh, turn on `vibeflow.debug.polling` and watch the **VibeFlow Polling** output channel.

---

## The CLI is signed in to a different account or server than the extension

**What it means**: The extension and the CLI each keep a copy of the server URL and API key. The extension writes its copy into the CLI's `config.yaml` only when you save the API key or a **Test Connection** succeeds in Settings → Connection — not when you run **VibeFlow: Setup**.

**Fix**: Open **VibeFlow: Settings → Connection** and click **Test Connection**. On success, the extension writes its server URL, API key, and current project into the CLI's `config.yaml` (atomically, mode `0600`), and the next CLI launch uses them.

> Signed out on purpose? After **VibeFlow: Logout**, the extension stops re-importing the CLI's token on reload, so logging out sticks. The CLI's own credentials are left alone.

---

## The project switches back after I reload the window

**What it means**: On every window load, the extension adopts the project in the CLI's `config.yaml` (`default_project`) so both point at the same project. Switching projects in the dropdown doesn't update that file, so a reload brings back the CLI's project.

**Fix**: After switching projects, open **VibeFlow: Settings → Connection** and click **Test Connection** — that writes the current project into the CLI's config, and reloads keep it.

---

## "My `--mcp` / `--root` settings didn't apply"

**What it means**: The CLI terminal was already open. The extension reuses an open **VibeFlow CLI** terminal instead of starting a second one, so new `vibeflow.cli.mcpName` / `vibeflow.cli.rootPath` values can't apply to it; it warns you when that happens.

**Fix**: Quit the CLI in its terminal (or close the terminal), then run **Launch Session** again.

---

## "Server URL is HTTP, VibeFlow requires HTTPS"

**What it means**: `vibeflow.serverUrl` is set to a plain-`http://` URL pointing at something that isn't `localhost`, `127.0.0.1`, or `[::1]`. Your API token would be sent in cleartext, so the extension refuses to connect. The same rule applies to a server URL imported from the CLI's config.

**Fix**: Open **VibeFlow: Settings** (`Cmd/Ctrl+Shift+V S`) and change the server URL to one of:

- `https://...` for any production / staging deployment, or
- `http://localhost:...` / `http://127.0.0.1:...` / `http://[::1]:...` for local development.

Press Enter, then click **Test Connection**.

---

## The Settings panel has no Project tab

**What it means**: The Project tab (project notifications and Vera review settings) appears only for the project's owner and org admins. The extension asks the server; if the server says you can't manage the project, the tab stays hidden.

**Fix**: Ask the project owner or an org admin to change the setting, or to make you an admin. Everything else in Settings works for every member.

---

## "Request Vera Review" fails, or a review never starts

**What it means**: Either the server refused the request — you'll see its reason, for example reviews are paused or disabled for the repository, or the PR is closed — or the review is queued and waiting for a runner.

**Fix**:

- **Refused**: read the message. Owners and org admins enable reviews per repository in Settings → **Project** (or on the web).
- **Waiting for a runner**: the review panel's runner line says so. Start a **Code Reviewer** (Vera) agent in the VibeFlow CLI; it picks up the queued review.

---

## Dashboard shows "No local terminal"

**What it means**: You clicked an agent whose terminal isn't on this machine — it's running elsewhere, or it has stopped.

**Fix**: Run **Launch Session** to open the CLI and start the agent here, or click **Refresh** if you *just* started one and it hasn't registered yet.

---

## The Activity Feed is empty even though agents are running

**What it means**: The feed is filtered to the *current project* on the *signed-in account*.

**Fix**: Check, in order:

1. **Are you signed in?** The status bar should show the VibeFlow connection as connected. If not, run **VibeFlow: Setup**.
2. **Is the right project selected?** Check the project dropdown at the top of the VibeFlow sidebar. The agents you expect may be in another project — Agent Fleet shows every project's agents, the Activity Feed only the current one's.
3. **Can you see the VibeFlow Monitor?** The Activity Feed lives in the **VibeFlow Monitor** panel (bottom panel by default). If you've collapsed or moved it, run `View → Open View → Activity Feed`.

---

## Chat-first session works the first time, breaks on the second message

**What it means**: This only affects sessions started in the extension's older chat-first mode (new agents launch from the CLI). A chat-first session without tmux backing handles a single chat turn before its agent process exits, so the panel waits forever on turn 2.

**Fix**: Start the agent from the VibeFlow CLI instead, and talk to it in Session Chat as usual. See [04-chat-first-mode.md](04-chat-first-mode.md).

---

## MCP server doesn't appear in Copilot / Continue / Cody

**What it means**: The extension registers VibeFlow as an MCP server through VS Code's MCP API. Only chat extensions that read that API see it, and they see it after the registration fires on activation.

**Fix**: Reload the window (`Cmd/Ctrl+Shift+P` → **Developer: Reload Window**). If your tool reads its own MCP config file instead, add VibeFlow there per the tool's docs. For Codex, Gemini, Cursor, Claude, and Kiro, **VibeFlow: Settings → Connection → MCP for coding agents** writes the entry for you.

---

## "Three #1947 defense layers" error during `yarn build`

**What it means**: This only applies if you're building the extension from source. The `check:security-guards` script runs as part of `yarn build` and verifies that three specific HTTPS-validation call sites still exist in the codebase. If you (or a merge) deleted any one of them, the build fails.

**Fix**: Find the deleted call site in the script output (`scripts/check-security-guards.mjs` reports which guard regressed), restore it from `git log -p`, and re-run `yarn build`.

> End users will never see this. It is a contributor-only error message.

---

## Still stuck?

If none of the above match, or your symptom looks similar but the fix didn't take, file a bug:

1. Run **VibeFlow: Report an Issue…** from the Command Palette. It opens a pre-populated GitHub issue with your extension version, VS Code version, and OS pre-filled.
2. Open the output channels (`View → Output`): **VibeFlow** for the extension and **VibeFlow CLI** for every CLI launch (the exact command and why a launch was blocked). Paste the last 50-100 relevant lines into the issue.
3. If the bug is reproducible, include the exact steps. If it's intermittent, include the timestamp from the output channel so logs can be cross-referenced with server-side traces.

**Don't** include your API key in the bug report. The output channels never print it, but double-check the snippet you paste. Anything matching `ak_live_…` or `sk-ant-…` should be replaced with `REDACTED`.

---

*Found a symptom that isn't listed? Open a doc-bug issue at the VibeFlow repo. Symptom-first entries are the most-read part of the user guide, and your gap is probably someone else's gap too.*
