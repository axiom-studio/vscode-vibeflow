# Session lifecycle in the VS Code extension

This doc explains how the extension shows and manages agent sessions: which agents Agent Fleet lists, the three artifacts a running session owns, the status states the Agent Fleet renders, and what each right-click menu action does to those artifacts.

Agents launch only through the VibeFlow CLI.
The extension does not start agents itself; it lists the agents the CLI is running and offers actions on them.

For the platform-wide concept of a session (state machine, persona routing, gate flow), see `axiomcloud/docs/VibeFlow/docs/agent-sessions.md` — that's the canonical source of truth.
This doc covers only the extension's local behavior.

## Which agents Agent Fleet lists

Agent Fleet follows the CLI's own rule for its session list: an entry in the CLI's `<cli root>/sessions.json` whose tmux session is alive.
The backend's session records only enrich those rows (status, latest activity), matched by `vibeflow_session_id` or by session name.
A backend session with no live CLI pane is not listed, and a live CLI agent the backend has not seen yet shows as **running in CLI**.

Rows group by project, current project first, across every project the CLI runs agents for.
Each row is the persona, with the branch and latest activity as its description.
Clicking an agent in another project offers to switch to that project, then opens its chat.
The status-bar agent count is the current project's share of the fleet.

The tmux probe uses the CLI's socket, resolved the way the CLI resolves it: the config's `tmux_socket` if set, otherwise `vibeflow` for the default CLI root, otherwise `vibeflow-` plus the first 8 hex characters of the SHA-256 of the custom root (`vibeflow.cli.rootPath`).

## The three artifacts of a running session

A session lives in three places at once:

1. **Backend record** — row in axiomcloud's `vibeflow_sessions` table.
   Carries `session_id`, `persona_key`, `git_branch`, `agent_type` (provider), `working_directory`, `last_message`, plus the `active`/`stale` flags driven by Redis heartbeat.

2. **Local agent process** — the running coding agent (claude / codex / gemini / cursor / …) that polls `wait_for_work` and does the actual work.
   It runs under tmux on the CLI's socket, owned by the CLI.

3. **Sidecar file** — `.vibeflow-session-{persona}` in the session's workspace or worktree directory.
   Written by the agent itself immediately after `session_init` returns the `session_id`.
   The extension only reads this file (in `SessionReattacher` and `ProjectDetector`); we don't write it.

   **The sidecar is session-ID memory, not process state.**
   Per `vibeflow-cli/internal/vibeflowcli/tui.go:619` — *"Session file is intentionally kept so the session ID can be reused on next launch."*
   On the next launch of the same persona in the same directory, the agent reads this file and passes the stored ID to `session_init`, which resumes the same session (preserving prompt-version cache, context debt, log continuity).

## The status states

Each row derives a single status by combining the backend's view (`session.active`/`stale`) with the local tmux probe.

| Status | Pane | Backend.active | What it means | Icon |
|--------|------|----------------|---------------|------|
| `active` | alive | true, !stale | Running normally | `●` green |
| `stale` | alive | true, stale | Heartbeat slow but flowing | `●` amber |
| `stalled` | alive | false | Pane up, no heartbeat — agent left `wait_for_work` without re-entering it (polling-contract violation) | `⚠` amber |
| `ghost` | dead | true | Backend cache stale; rare race after a kill | `✗` red |
| `inactive` | dead | false | Fully exited / cleaned up | `○` gray |

Because the fleet lists only agents whose CLI pane is alive, `ghost` and `inactive` rows are rare: they appear only while the probe and the backend disagree about a pane.
See `src/sessions/sessionStatus.ts:deriveSessionStatus` for the full predicate.

Each row's tooltip names the status and, for `stalled` / `ghost`, includes a one-liner explanation.

## Right-click menu actions

The Agent Fleet's right-click menu offers these actions.
Their teardown behavior is intentionally split so the user can pick what to keep:

| Action | Backend record | Local agent | Sidecar | Worktree | Available when |
|--------|----------------|-------------|---------|----------|----------------|
| **Focus Terminal** | — | reveal pane | — | — | `activeSession` |
| **Restart Session** | killed + reborn | killed + reborn | kept (resumes same id) | preserved | `activeSession` |
| **Kill Session** | deleted | terminated (tmux pane) | **kept** for resume | asks whether to remove it | `activeSession` |
| **Kill Session & Forget** | deleted | terminated | **deleted** | asks whether to remove it | active or inactive |
| **Delete Session** | deleted | killed defensively (ghost case) | kept | asks whether to remove it | `inactiveSession` only |
| **View Session Details** | — | — | — | — | active or inactive |
| **Copy Session ID** | — | — | — | — | active or inactive |

### Why three destructive actions and not one

The split exists because **session-ID continuity is a feature, not a bug**.
Three different intents, three different artifacts to clean up:

- **Kill** — "I'm done for now, but I might come back to this work."
  Deletes the backend record and stops the running agent, but keeps the sidecar so a fresh launch can resume the same `session_id`.
  This matches the CLI's behavior (`tui.go:619`).
- **Kill & Forget** — "I'm done with this work entirely; next launch should start fresh."
  Same teardown plus sidecar deletion, so the agent's next `session_init` mints a new ID and the prior session's context cache, prompt-version hash, and log history are disassociated.
- **Delete Session** — Available only on `inactive` rows.
  Useful for cleaning up server records of agents that crashed.
  Calls the same `DELETE /sessions/{id}` backend endpoint as Kill but with the right confirmation prompt ("delete the record" vs "kill the running agent").

**Kill** also runs `tmux -L <cli socket> kill-session -t {name}`.
Without it, the tmux pane would survive the backend kill and the CLI would show a "disconnected" ghost entry (see commit `23c4710`).

### Stale sidecar cleanup

A session-ID file kept after Kill becomes "stale" the moment the backend record is deleted (the ID points at nothing).
The extension's `SessionReattacher.detectPhantoms` cleans these up automatically on the next window load, using a backend cross-check (`liveSessionIds`) — files whose `session_id` doesn't appear in `client.listSessions(projectId)` get force-deleted silently.
This mirrors the CLI's `CleanupStaleSession` path in `conflict.go`.

So the typical lifecycle is:

```
launch in CLI → Kill → sidecar lingers → window reload + cross-check → sidecar gone
                              ↓
                        if user re-launches first:
                        sidecar found → resume same session_id
```

## CLI integration

- **Launch Session** (`Ctrl/Cmd+Shift+V L`), **Open CLI** in the Agent Fleet title bar, and the empty-fleet row all open the VibeFlow CLI in an editor-area terminal.
  The CLI manages all agent sessions via tmux under its own socket.
- **Native Windows**: every CLI route shows WSL guidance instead (the CLI needs tmux); a Remote-WSL window works normally.
- **Tmux probe** — `SessionsTreeProvider` lists the CLI socket's tmux sessions on each poll to decide which agents are live and to compute `stalled` / `ghost`.
  Capped at 2s in `tmuxState.ts:getLiveTmuxSessions` so a hung tmux server can't block the poll loop.
- **Ctrl+Q / Ctrl+\\** in any terminal pass through to the shell so the CLI's tmux toggle works without VS Code stealing the keystroke (gated on `terminalFocus` in `package.json` keybindings).
- **Shared sign-in** — saving the API key or a successful Test Connection in Settings → Connection mirrors the server URL, API key, and current project into `<cli root>/config.yaml` (atomic write, mode `0600`), so the CLI needs no separate login.

## Reattach behavior on window load

When the extension activates, `SessionReattacher.detectPhantoms` scans the workspace for `.vibeflow-session-*` files.
For each file:

1. If the backend's live session list contains the `session_id` → it's a real reattach candidate.
   The user gets a single inline prompt asking how to reattach (vanilla / vibeflow / dismiss).
   Recorded launch modes (per-session, stored in `vibeflow.launchModes` globalState) win silently when present, so a YOLO-launched agent reattaches as YOLO without re-asking; otherwise `vibeflow.session.reattachMode` decides.

2. If the backend doesn't know the `session_id` → the file is force-deleted silently.
   This is the "stale-sweep" path that runs even when the user did `Kill` (which intentionally kept the file).

Reattach succeeds → the spawned terminal's agent reads the sidecar, calls `session_init(session_id: <existing>)`, and resumes.

## Quick reference: which action do I want?

- **Want to start agents** → Launch Session (opens the CLI).
- **Came back to my desk, want my agents back** → open the CLI; agents it kept running are already in Agent Fleet.
- **Agent is stuck or misbehaving, want to start over with same context** → Restart Session.
- **Done with this persona for now, might pick it up later** → Kill Session.
- **Done with this work entirely, want clean slate next time** → Kill Session & Forget.
- **Old session record lingering from a crashed agent** → Delete Session.
- **Want to find the running pane** → Focus Terminal, or open the CLI.
