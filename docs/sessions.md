# Session lifecycle in the VS Code extension

This doc explains how the extension manages agent sessions: the three
artifacts a running session owns, the five status states the Agent
Fleet renders, and what each right-click menu action does to those
artifacts.

For the platform-wide concept of a session (state machine, persona
routing, gate flow), see
`axiomcloud/docs/VibeFlow/docs/agent-sessions.md` — that's the
canonical source of truth. This doc covers only the extension's
local behavior.

## The three artifacts of a running session

A session lives in three places at once:

1. **Backend record** — row in axiomcloud's `vibeflow_sessions` table.
   Carries `session_id`, `persona_key`, `git_branch`, `agent_type`
   (provider), `working_directory`, `last_message`, plus the
   `active`/`stale` flags driven by Redis heartbeat.

2. **Local agent process** — the running coding agent (claude / codex /
   gemini / cursor) that polls `wait_for_work` and does the actual
   work. Its custody depends on how it was launched:
   - **Extension-launched** (default mode): lives in
     `TerminalRegistry`, a VS Code integrated terminal with
     `hideFromUser` honoring the terminal-mode setting.
   - **CLI-launched** (CLI mode = `vibeflow.cli.enabled` true): lives
     under tmux on the `-L vibeflow` socket. The extension's
     TerminalRegistry has no record of it.

3. **Sidecar file** — `.vibeflow-session-{persona}` in the session's
   workspace or worktree directory. Written by the agent itself
   immediately after `session_init` returns the `session_id`. The
   extension only reads this file (in `SessionReattacher` and
   `ProjectDetector`); we don't write it.

   **The sidecar is session-ID memory, not process state.** Per
   `vibeflow-cli/internal/vibeflowcli/tui.go:619` — *"Session file is
   intentionally kept so the session ID can be reused on next launch."*
   On the next launch of the same persona in the same directory, the
   agent reads this file and passes the stored ID to `session_init`,
   which resumes the same session (preserving prompt-version cache,
   context debt, log continuity).

## The five status states

The Agent Fleet derives a single status per row by combining the
backend's view (`session.active`/`stale`) with a local tmux probe
(only consulted in CLI mode — the extension owns terminals directly
otherwise).

| Status | Pane | Backend.active | What it means | Icon |
|--------|------|----------------|---------------|------|
| `active` | alive | true, !stale | Running normally | `●` green |
| `stale` | alive | true, stale | Heartbeat slow but flowing | `●` amber |
| `stalled` | alive | false | Pane up, no heartbeat — agent left `wait_for_work` without re-entering it (polling-contract violation) | `⚠` amber |
| `ghost` | dead | true | Backend cache stale; rare race after a kill | `✗` red |
| `inactive` | dead | false | Fully exited / cleaned up | `○` gray |

Outside CLI mode, only the first three apply (we trust the backend on
`active`/`stale` and skip the tmux probe). With the probe enabled,
`stalled` and `ghost` surface diagnostics that would otherwise be
invisible — see `src/views/sessions/SessionsTreeProvider.ts:deriveStatus`
for the full predicate.

Each row's tooltip names the status and, for `stalled` / `ghost`,
includes a one-liner explanation. The branch row count and the
status-bar count both treat `active` + `stale` + `stalled` as
"running" — anything with a live presence somewhere.

## Right-click menu actions

The Agent Fleet's right-click menu offers six actions. Their teardown
behavior is intentionally split so the user can pick what to keep:

| Action | Backend record | Local agent | Sidecar | Worktree | Available when |
|--------|----------------|-------------|---------|----------|----------------|
| **Focus Terminal** | — | reveal pane | — | — | `activeSession` |
| **Restart Session** | killed + reborn | killed + reborn | kept (resumes same id) | preserved | `activeSession` |
| **Kill Session** | deleted | terminated (terminal **and** tmux) | **kept** for resume | optional cleanup via `vibeflow.worktree.cleanupOnKill` | `activeSession` |
| **Kill Session & Forget** | deleted | terminated | **deleted** | optional cleanup | active or inactive |
| **Delete Session** | deleted | killed defensively (ghost case) | kept | optional cleanup | `inactiveSession` only |
| **Copy Session ID** | — | — | — | — | active or inactive |

### Why three destructive actions and not one

The split exists because **session-ID continuity is a feature, not a
bug**. Three different intents, three different artifacts to clean up:

- **Kill** — "I'm done for now, but I might come back to this work."
  Deletes the backend record and stops the running agent, but keeps
  the sidecar so a fresh launch can resume the same `session_id`.
  This matches the CLI's behavior (`tui.go:619`).
- **Kill & Forget** — "I'm done with this work entirely; next launch
  should start fresh." Same teardown plus sidecar deletion, so the
  agent's next `session_init` mints a new ID and the prior session's
  context cache, prompt-version hash, and log history are
  disassociated.
- **Delete Session** — Available only on already-`inactive` rows.
  Useful for cleaning up server records of agents that crashed or
  ran on another machine. Calls the same `DELETE /sessions/{id}`
  backend endpoint as Kill but with the right confirmation prompt
  ("delete the record" vs "kill the running agent").

### Stale sidecar cleanup

A session-ID file kept after Kill becomes "stale" the moment the
backend record is deleted (the ID points at nothing). The
extension's `SessionReattacher.detectPhantoms` cleans these up
automatically on the next window load, using a backend cross-check
(`liveSessionIds`) — files whose `session_id` doesn't appear in
`client.listSessions(projectId)` get force-deleted silently. This
mirrors the CLI's `CleanupStaleSession` path in `conflict.go`.

So the typical lifecycle is:

```
launch → Kill → sidecar lingers → window reload + cross-check → sidecar gone
                       ↓
                 if user re-launches first:
                 sidecar found → resume same session_id
```

## CLI mode specifics

When `vibeflow.cli.enabled` is on:

- **Launch Session** → opens the vibeflow CLI in an editor-area
  terminal instead of the QuickPick wizard. The CLI manages all
  agent sessions via tmux under its own socket.
- **Kill Session** in the extension → calls `tmux -L vibeflow
  kill-session -t {name}` in addition to the usual teardown. Without
  this, the tmux pane survives the backend kill and the CLI shows a
  "disconnected" ghost entry (see commit `23c4710`).
- **Tmux probe** → `SessionsTreeProvider` queries
  `tmux -L vibeflow list-sessions -F '#{session_name}'` on each poll
  to compute `stalled` / `ghost`. Capped at 2s in
  `tmuxState.ts:getLiveTmuxSessions` so a hung tmux server can't
  block the poll loop.
- **Ctrl+Q / Ctrl+\\** in any terminal pass through to the shell so
  the CLI's tmux toggle works without VS Code stealing the keystroke.
  Gated on `terminalFocus && config.vibeflow.cli.enabled` in
  `package.json` keybindings.

## Reattach behavior on window load

When the extension activates, `SessionReattacher.detectPhantoms` scans
the workspace for `.vibeflow-session-*` files. For each file:

1. If the backend's live session list contains the `session_id` →
   it's a real reattach candidate. The user gets a single inline
   prompt asking how to reattach (vanilla / vibeflow / dismiss).
   Recorded launch modes (per-session, stored in `vibeflow.launchModes`
   globalState) win silently when present, so a YOLO-launched agent
   reattaches as YOLO without re-asking.

2. If the backend doesn't know the `session_id` → the file is force-
   deleted silently. This is the "stale-sweep" path that runs even
   when the user did `Kill` (which intentionally kept the file).

Reattach succeeds → the spawned terminal's agent reads the sidecar,
calls `session_init(session_id: <existing>)`, and resumes.

## Quick reference: which action do I want?

- **Came back to my desk, want my agents back** → no action; the
  reattach prompt fires automatically on window load.
- **Agent is stuck or misbehaving, want to start over with same
  context** → Restart Session.
- **Done with this persona for now, might pick it up later** → Kill
  Session.
- **Done with this work entirely, want clean slate next time** → Kill
  Session & Forget.
- **Old session record lingering from a crashed agent or another
  machine** → Delete Session.
- **Want to find the running pane in the terminal panel** → Focus
  Terminal (or Show All Terminals if everything's hidden via hybrid
  mode).
