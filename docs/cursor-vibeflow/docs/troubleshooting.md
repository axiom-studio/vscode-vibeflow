# Troubleshooting

**Who this is for**: You've hit a problem with VibeFlow and you want to know what the symptom means, why it's happening, and how to fix it fast. This page is symptom-first. Use `Ctrl+F` / `Cmd+F` and search for the message or behavior you're seeing.

**TL;DR**: Most failures fall into one of three buckets: auth (API key, server URL), session plumbing (terminal, tmux, PID locks), or chat-first quirks (single-turn vs multi-turn). The fixes below are ordered by how often they hit users, most common first. If nothing here matches, jump to [Still stuck?](#still-stuck) at the bottom.

> Term unfamiliar? See [glossary.md](glossary.md). Wondering *why* something works the way it does? The flow diagrams in [workflows-and-flows.md](workflows-and-flows.md) explain the underlying choreography.

---

## I can't find Extensions, the file tree, or the VibeFlow sidebar

**What it means**: You're in Cursor's **Agents Window**, not the **Editor Window**. Since Cursor 3, the default launch surface is agent-first — chat tabs and agent management, not the classic IDE with Extensions, Explorer, and terminal.

**Fix**:

1. `Cmd/Ctrl+Shift+P` → **Open Editor Window** (or `Shift+Cmd+N` on Mac / `Shift+Ctrl+N` on Windows/Linux).
2. In that Editor Window, open your project folder (**File → Open Folder…**) if you haven't already.
3. Install VibeFlow from the Extensions panel (`Cmd/Ctrl+Shift+X`).

To make the Editor the default on startup: Cursor Settings → **Agents** → turn off **Open Agents Window on startup**. Or launch with `cursor . --classic` from a terminal. See [getting-started.md §0](getting-started.md#0-cursor-agents-window-vs-editor-window).

---

## Sessions won't start / "No sessions" in the status bar

**What it means**: No workspace folder is open, or Setup didn't link a VibeFlow project to this workspace.

**Fix**:

1. **Open a project folder** in the Editor Window (`File → Open Folder…`). VibeFlow requires a workspace root with a git repo. Sessions will not spawn without one.
2. Run **VibeFlow: Setup** and complete all three steps (server URL, API key, project).
3. Confirm the status bar shows your project name and branch, not "No sessions".

---

## "VibeFlow: Not logged in" or no projects appearing in the sidebar

**What it means**: The extension can't reach VibeFlow Cloud with a valid API key. Either the Setup wizard never finished, or your API key has been revoked or rotated server-side.

**Fix**: Open the Command Palette (`Cmd/Ctrl+Shift+P`) and run **VibeFlow: Setup**. Walk through the three steps (Server URL, API Key, Project). The new key is stored in Cursor's Secrets API and overrides the old one immediately. No reload needed.

> If you've used VibeFlow before and the wizard says "key looks valid" but the sidebar still shows nothing, hit the refresh icon at the top of **Agent Fleet** or run **VibeFlow: Refresh**. See the onboarding sequence in [section 1 of the flows doc](workflows-and-flows.md#1-new-user-onboarding-first-5-minutes) for the full handshake.

---

## "Server URL is HTTP, VibeFlow requires HTTPS"

**What it means**: `vibeflow.serverUrl` is set to a plain-`http://` URL pointing at something that isn't `localhost`, `127.0.0.1`, or `[::1]`. This is the security guard from issue #1947. Your API token would be sent in cleartext, so the extension refuses to connect.

**Fix**: Open **VibeFlow: Settings** (`Cmd/Ctrl+Shift+V S`) and change the server URL to one of:

- `https://...` for any production / staging deployment, or
- `http://localhost:...` / `http://127.0.0.1:...` / `http://[::1]:...` for local development (the loopback hosts are explicitly allowed).

Save, then re-run **VibeFlow: Refresh**. Re-running **VibeFlow: Setup** is not required if the API key is unchanged.

---

## The Setup wizard rejects my Claude / Codex / Gemini API key

**What it means**: The wizard runs paste-hygiene and minimum-length checks on every provider key (issues #2174 / #2179). Two failures are common:

1. **Stray characters**. The paste includes surrounding quotes, brackets, or trailing whitespace from a copy-paste.
2. **Below the minimum length**. Each provider's key has a known minimum (Claude `sk-ant-…` is the longest, Gemini's is shorter). A truncated paste fails the check.

**Fix**: Re-copy the key directly from the provider's dashboard. Paste it raw, with no `"…"` wrapping, no `[…]`, and no trailing newline.

**If you actually use external auth** (you have the provider CLI installed and it reads credentials from `~/.gemini/credentials`, `~/.config/codex/…`, or similar): press **Enter on an empty key field**. The wizard detects this and falls back to the provider CLI's own auth resolution.

---

## Dashboard shows "No local terminal"

**What it means**: There's no agent session currently running for the project you're viewing. This is the post-issue #1963 wording. Older builds showed a confusing blank state; the new copy tells you why and gives you the next action.

**Fix**: Click **Launch Session** in the notification (it opens the Launch Wizard), or click **Refresh** if you *just* started a session and it hasn't registered yet. The wizard flow is documented in [section 2 of the flows doc](workflows-and-flows.md#2-launch-a-session-the-most-common-action).

---

## Agent Fleet shows a session stuck in "starting…" for minutes

**What it means**: The pending-session row never transitioned to `active`. Usually the underlying terminal hit an error before the agent could call `session_init`: bad binary path, missing provider key, or a sandbox prompt the user never answered. Issues #2175 / #2178 added two safeguards.

**Fix**: You have two options:

- **Wait**. The stall sweep auto-fires at 120 seconds and flips stuck `starting` rows to `failed`. Then click the row's **Dismiss** action (the `x` icon).
- **Cancel immediately**. Right-click the row, then **Cancel Starting Session** (`vibeflow.cancelStartingPending`). Kills the pending row at once.

After dismissal, re-launch and watch the terminal output. That's where the underlying error will surface.

---

## Chat panel says "Working…" forever in chat-first mode

**What it means**: This is by far the most-reported chat-first symptom (issue #2305). It almost always means your chat-first session is using the **vscode** headless backing, which only supports a single chat turn before the agent process exits. Turn 2 has nowhere to send the message, so the panel waits forever.

**Fix**: You have two options.

- **Switch backing to tmux (recommended)**. Open **VibeFlow: Settings** and set `vibeflow.session.headlessBacking` to `tmux`. Re-launch the chat-first session. Requires `tmux` on PATH (`brew install tmux` on macOS; pre-installed on most Linux). See the chat-first sequence diagram in [section 3b](workflows-and-flows.md#3b-chat-first-session--chat-driven) for why per-turn respawn needs a persistent backing.
- **Live with single-turn**. Leave the backing at `vscode` and re-launch the session before each new message. Tedious but works without tmux.

> The default is `auto`, which picks tmux when available. If you're hitting this on auto, tmux isn't on your PATH. Install it or switch to explicit `tmux` once installed.

---

## Chat panel "Send" button does nothing in a vanilla session

**What it means**: This is intentional, not a bug (issue #2304). Vanilla agents read their instructions from work items they pull via `wait_for_work`. The Session Chat panel is a viewport, not the input. The input box is disabled with an upfront banner.

**Fix**: Click **Convert to work item** (the button next to the disabled input). It opens an ad-hoc Quick Pick that creates a todo or issue with your typed text as the description, then the agent picks it up on its next poll. See [section 3a](workflows-and-flows.md#3a-vanilla-session--terminal-driven) for the full vanilla-vs-chat-first split.

---

## Walkthrough "Launch Session" step opens a bare shell when the CLI is already running

**What it means**: An external `vibeflow-cli` process is holding the PID lock at `~/.vibeflow-cli/vibeflow.pid`. The extension's launch path detects the conflict (issue #2181) and previously degraded to a plain shell. Post-fix it shows a **Retry / Cancel** modal instead.

**Fix**: In the terminal where the external CLI is running, hit `Ctrl+C` to quit it. Then click **Retry** in the modal (or re-run the walkthrough step). The PID lock clears the moment the CLI exits.

> If you didn't intentionally start the CLI, check for a leftover process: `ps aux | grep vibeflow-cli`. Kill any orphaned `vibeflow` processes and try again.

---

## `.mcp.json` not written, agent can't call VibeFlow MCP tools

**What it means**: The agent terminal starts but every MCP tool call returns "no such tool" or "server not configured." Pre-issue-#2184 the extension only wrote `.mcp.json` if a sibling CLI config already existed. Post-fix, the extension's own stored API key is the primary source of truth.

**Fix**:

1. Confirm you're on v1.0.3 or later (check Cursor's Extensions view).
2. Verify your API key is set: **VibeFlow: Settings**, then the **Connection** tab. If the field is empty, paste your key.
3. Re-launch the session. The extension re-runs `ensureMcpConfig` on every launch and will write `.mcp.json` with `mode 0o600` into the workspace root.

> The `.mcp.json` write is guarded. If the workspace is a git repo and the file can't be gitignored (e.g. a read-only `.gitignore`), the extension refuses to write and surfaces an explanation in the output channel.

---

## Welcome walkthrough "Learn more" link goes to the wrong page

**What it means**: A typo in `package.json` line 632 sent the link to the wrong URL. Fixed in v1.0.3.

**Fix**: Update the extension from Cursor's Extensions panel. If you're already on v1.0.3+ and still seeing it, you may have a stale cached install. Reload Cursor (`Cmd/Ctrl+Shift+P`, then **Developer: Reload Window**) or fully reinstall the extension.

---

## "Auth identity mismatch", CLI and extension disagree on who you are

**What it means**: Both the `vibeflow-cli` and the extension store API tokens independently. If you signed into the CLI with one workspace's key and the extension with another's, server-side calls disagree about your identity. Surfaced more clearly post-#2184, when the extension started writing `.mcp.json` from its own credentials.

**Fix**: Pick one source of truth. **Recommended: the extension.**

1. In a terminal, run `vibeflow logout` (the CLI's logout). This clears the CLI's stored token.
2. Leave the extension's key in place (it'll continue to write `.mcp.json` per session).
3. Re-launch any active sessions so they pick up the unified config.

> If you prefer the CLI as the source of truth, do the inverse: run **VibeFlow: Logout** in the extension and sign in only via the CLI. The extension will then read the CLI's config when one exists.

---

## The agent terminal opens but the agent silently exits

**What it means**: Almost always, the provider binary isn't on `PATH` for the shell Cursor spawned. The agent process tries to exec `claude` (or `codex`, `gemini`, etc.), `exec` fails, and the terminal closes before you can read the error.

**Fix**:

1. Verify the binary works from your shell: `claude --version` (or `codex --version`, `gemini --version`).
2. If the command isn't found, install the provider CLI per its docs.
3. If the command works in your shell but not in Cursor's terminal, your `PATH` is set in a shell init file Cursor doesn't load. Either move the PATH export to `~/.zshenv` / `~/.bash_profile`, or set `vibeflow.cli.binaryPath` to an absolute path.
4. To see the actual exec error next time, set `vibeflow.session.terminalMode` to `all` once and re-launch. All terminals stay visible, including the failing one.

---

## The Activity Feed is empty even though sessions are running

**What it means**: One of three things is wrong with your view configuration, not your sessions. The feed is filtered to the *currently selected project* on the *currently signed-in workspace*.

**Fix**: Check, in order:

1. **Are you signed in?** Look at the left activity bar. The VibeFlow icon should not have an error badge, and the status bar should read **VibeFlow: Connected**. If not, run **VibeFlow: Setup**.
2. **Is a project selected?** The status bar shows the active project name. If it says "No project," run **VibeFlow: Switch Project…** (`Cmd/Ctrl+Shift+V P`) and pick one.
3. **Is the right sidebar showing the VibeFlow Monitor?** The Activity Feed lives in the right-side **VibeFlow Monitor** panel by default. If you've collapsed or moved the panel, drag it back or run `View → Open View → Activity Feed`.

If all three check out and the feed is still empty, click the **VibeFlow: Refresh** icon. Websocket reconnect.

---

## Chat-first session works the first time, breaks on the second message

**What it means**: Same root cause as the "Working… forever" entry above. You're on the `vscode` headless backing, which supports exactly one chat turn before the agent process exits. Turn 1 succeeds because the agent is still alive; turn 2 has no process to send to.

**Fix**: See [Chat panel says "Working…" forever in chat-first mode](#chat-panel-says-working-forever-in-chat-first-mode). Short version: switch `vibeflow.session.headlessBacking` to `tmux`.

---

## VibeFlow doesn't appear as an MCP server in Cursor's own AI

**What it means**: The VibeFlow extension registers itself as an MCP server via VS Code's MCP API so that other Copilot-like extensions implementing that same API can discover and call VibeFlow tools. Cursor, however, has its **own** MCP configuration system (`.cursor/mcp.json`, Cursor Settings → MCP), which is entirely separate from VS Code's MCP API. VibeFlow does **not** auto-populate Cursor's MCP config, so it won't appear in Cursor's built-in AI as an MCP server on its own.

**Fix**: If you want Cursor's *own* AI to reach VibeFlow's tools, configure Cursor's MCP separately — add a VibeFlow entry to `.cursor/mcp.json` or via Cursor Settings → MCP per Cursor's documentation. The extension won't do this for you.

> **This does not affect the agent sessions you launch.** The `.mcp.json` the extension writes into the workspace root is for the spawned agent CLI (`claude` / `codex` / `gemini` / etc.) and works identically in Cursor — your VibeFlow agents reach VibeFlow Cloud's MCP tools exactly as they do under VS Code. The editor-level MCP registration above is a *separate* mechanism, only relevant to host extensions that consume VS Code's MCP API. If you do install such a host extension and it still doesn't see `vibeflow`, fully reload Cursor (`Cmd/Ctrl+Shift+P`, then **Developer: Reload Window**) so the registration re-fires.

---

## "Three #1947 defense layers" error during `yarn build`

**What it means**: This only applies if you're building the extension from source. The `check:security-guards` script runs as part of `yarn build` and verifies that three specific HTTPS-validation call sites still exist in the codebase. If you (or a merge) deleted any one of them, the build fails.

**Fix**: Find the deleted call site in the script output (`scripts/check-security-guards.mjs` reports which guard regressed), restore it from `git log -p`, and re-run `yarn build`. This guard exists because the original #1947 fix was silently regressed in commit `e0ef3ad`. The build-time check ensures it can't happen again.

> End users will never see this. It is a contributor-only error message.

---

## Still stuck?

If none of the above match, or your symptom looks similar but the fix didn't take, file a bug:

1. Run **VibeFlow: Report an Issue…** from the Command Palette. It opens a pre-populated GitHub issue with your extension version, Cursor version, and OS pre-filled.
2. Open the VibeFlow output channel (`View → Output`, then pick **VibeFlow** from the dropdown) and paste the last 50-100 lines into the issue. The channel logs every MCP call, every session launch, every websocket transition. Usually enough for the maintainers to identify the root cause without follow-up.
3. If the bug is reproducible, include the exact steps. If it's intermittent, include the timestamp from the output channel so logs can be cross-referenced with server-side traces.

**Don't** include your API key in the bug report. The output channel redacts tokens before printing, but double-check the snippet you paste. Anything matching `ak_live_…` or `sk-ant-…` should be replaced with `REDACTED`.

---

*Found a symptom that isn't listed? Open a doc-bug issue at the VibeFlow repo. Symptom-first entries are the most-read part of the user guide, and your gap is probably someone else's gap too.*
