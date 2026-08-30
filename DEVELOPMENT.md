# Developing VibeFlow

Contributor guide for building, testing, debugging, and packaging the extension.
User-facing documentation lives in the [README](README.md) and the [full user guide](docs/vscode-vibeflow/docs/index.md).

## Prerequisites

- **Node.js 18+** and **Yarn 1.x (classic)** — the repo uses `yarn.lock`; never `npm install`.
- **VS Code 1.93+** (the `engines.vscode` minimum) for running the extension host.
- Optional: `make` for the convenience targets below (`make help` lists them all).

## Setup and build

```bash
yarn install            # host + webview-ui deps (workspaces)
yarn build              # security guards + webview (vite) + extension bundle (esbuild)
```

`yarn build` always runs `scripts/check-security-guards.mjs` first.
It pattern-asserts security-critical source shapes (the HTTPS server-URL defense, the `.mcp.json` gitignore gate) and fails the build if a change weakens them.
This guard is non-negotiable — do not work around it; fix the change instead.

## Quality gate

```bash
yarn run check          # typecheck + eslint + host unit tests + webview tests + security guards
```

> **Use `yarn run check`, not `yarn check`.**
> `check` is a reserved yarn v1 subcommand (the built-in dependency-tree verifier), so bare `yarn check` never runs the package.json script — and it false-alarms on unrelated hoisting warnings.
> `make check` wraps the correct form.

Run the gate before every commit.
Docs-only changes still run it, as a regression tripwire.

## Tests

Three verification layers — see [TESTING.md](TESTING.md) for the full model, file layout, and the no-mocks test policy.

```bash
yarn test               # host unit tests (vitest, pure-function modules, ~½s)
yarn test:watch         # watch mode for TDD on a single module
yarn test:coverage      # v8 coverage report
yarn test:webview       # webview React tests (vitest + jsdom under webview-ui/)
yarn test:integration   # real VS Code Electron host (@vscode/test-electron + mocha)
```

Integration tests deliberately do not run inside `yarn run check` — they launch a real VS Code build (downloaded and cached under `.vscode-test/` on first run).
Run them before pushing anything that touches `activate()`, view/command registration, terminal spawning, or panel lifecycle.

> **Known issue:** current VS Code stable (1.135+) cannot be spawned by `@vscode/test-electron` 2.5.x on macOS (the `Electron` binary alias was removed).
> Until the dependency is bumped, pin a compatible build:
>
> ```bash
> VSCODE_TEST_VERSION=1.121.0 yarn test:integration
> ```

## Run and debug

Open the repo in VS Code and press **F5** (the `.vscode/launch.json` config launches an Extension Development Host with the built extension loaded).
Rebuild with `yarn build` (or keep `yarn test:watch` running for unit-level iteration) and reload the dev host window to pick up changes.

## Packaging and publishing

```bash
make package            # vsce package → vscode-vibeflow-<version>.vsix (runs yarn build via vscode:prepublish)
```

Publishing to the VS Code Marketplace and Open VSX is covered in [`docs/publishing.md`](docs/publishing.md) and the [`Makefile`](Makefile) (`make publish-all` and friends).
The `.vsix` contents are controlled by `.vscodeignore` — contributor docs (this file, `TESTING.md`), test output, and agent tooling are excluded from the package.

## Before opening a PR

1. `yarn run check` green.
2. `yarn build` green (this is what enforces the security guards).
3. New or changed behavior has tests in the right layer (see TESTING.md's "Adding a test").
4. `yarn test:integration` if you touched activation, registration, or terminal/panel lifecycle.
