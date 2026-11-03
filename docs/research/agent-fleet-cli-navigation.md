# Agent Fleet navigation into the CLI

Agent Fleet project labels open the project's live split view in the editor-area VibeFlow CLI terminal.
Persona labels focus the exact running agent, including when the cloud has not returned its registration.
The project arrow continues to expand or collapse the tree.
View Session Details remains available from the context menu.
Local navigation does not change the cloud Project selector.

## Launch and compatibility

The extension probes `vibeflow integration-capabilities` for `{"vscode_navigation":1}`.
A compatible binary is launched with `--client vscode --control-socket <private-path>`.
The normal standalone CLI has no control listener and keeps its existing keyboard behavior.
An older binary still opens normally; selecting an agent explains that the CLI needs updating and reopening.
An existing external CLI remains protected by the existing root-specific PID lock and the extension's handoff message.
Agents continue running when the CLI terminal closes.

Each owned terminal gets a private directory (0700) and Unix socket (0600).
The extension recovers that terminal's endpoint from its creation arguments, so it never looks up or redirects another terminal by a shared socket name.
The readiness response identifies the CLI root and tmux socket; the extension verifies both before sending a target.

## Protocol and lifecycle

Requests and responses are newline-delimited JSON with protocol version 1.
The only requests are `ping`, `project`, and `session`.
Navigation targets carry the full local `tmux_session` from `sessions.json`, never a persona label or a guessed server session ID.
Requests do not contain terminal keystrokes or shell commands.
Payload sizes and response waits are bounded.

The existing project workbench composes the live panes, with one window per project.
VS Code mode permits a one-agent workbench and refuses to replace an existing holder.
The socket handler can select and zoom panes while Bubble Tea is blocked in `ExecProcess`.
Composition, selection and restoration share a mutex.
A selected project's newly launched agents join its existing window without rebuilding other panes.
Active CLI dialogs must be completed or cancelled before external navigation.

The CLI's existing `@vibeflow_session` pane identity follows agents into the workbench.
Agent Fleet reads that identity so composed agents do not disappear when their original tmux sessions are consumed.
Stopping a composed agent targets its pane and any retained source panes, never the shared workbench.
Restore skips removed panes instead of recreating them as empty shells.
The attach child is bound to the CLI context so terminal shutdown releases it and restores the agent panes.
An unclean exit that leaves an existing workbench is reported instead of killing or replacing its panes.

## Local verification

Build the companion CLI and point the extension's **VibeFlow: CLI Binary Path** setting at it.
Close an older CLI terminal before reopening; its agents remain in tmux.
Reload the extension development window after building the extension.

```sh
# In vibeflow-cli
go build -o vibeflow ./cmd/vibeflow
go test ./...
go test -race ./internal/vibeflowcli -run '^TestVSCodeNavigation_' -count=1

# In vscode-vibeflow
yarn run check
yarn build
VIBEFLOW_CLI_TEST_BINARY=/absolute/path/to/vibeflow-cli/vibeflow yarn test:integration
```

The native VS Code integration test uses an isolated CLI root and real disposable tmux processes.
It verifies concurrent launch creates one terminal, cross-project persona focus, repeated selections, fleet visibility, stopping a composed agent with a retained history-style pane, and restoring unchanged pane/process IDs on terminal close.
A second native TreeView test verifies project, cloud-matched, foreign-project and local-only rows all route through local navigation.
The Go tests exercise the real socket, grouping, one-agent views, newly joined agents, rejected targets, concurrent focus, existing-holder protection and stopped-pane restoration.
No production agents or cloud records are mutated by these tests.
