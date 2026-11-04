# Development with mise

Toolchain: Node 22.23.1 and Yarn 1.22.22.
Versions are pinned in `mise.toml`.

## Quick start

```sh
mise trust
mise install
mise tasks ls
mise run versions
```

Tasks: `deps`, `dev`, `webview`, `build`, `test`, `check`, `package`.

The deps task installs both extension and webview dependencies.
The dev task watches the extension bundle; use F5 in VS Code to launch its Extension Development Host.
Run the webview task in another terminal when needed.
The check task uses `yarn run check` to avoid Yarn Classic’s built-in check command.
The package task builds a local VSIX and does not publish it.

## Local settings

Commit `mise.toml` and this guide to share tool versions and tasks with the team.
Keep personal overrides in ignored `mise.local.toml` and private helper scripts in `.mise-local/`.
Install mise separately on each machine and run `mise install` inside this repository.
macOS and Linux shells are supported; Windows developers should use WSL for the shell-based tasks.
Native mobile builds additionally need the appropriate platform toolchain.
Keep credentials in existing local secret files or environment variables, never in committed `mise.toml`.
Task commands run without sourcing ~/.zshrc.
Project runtime versions are selected by `mise run` even without shell activation.
