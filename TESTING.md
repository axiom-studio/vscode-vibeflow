# Testing

## Layers

The project has three distinct verification layers. Each catches a different class of regression — picking the right layer for new work keeps coverage focused.

| Layer | Runner | What it covers | When to add to it |
|---|---|---|---|
| **Unit** | `vitest` (`yarn test`) | Pure-function modules — string parsers, state machines, regex tokenizers, key validators. No VSCode API, no DOM. Runs in Node. | Any new pure helper, any regex / validator / parser change. |
| **Build-time guard** | `node scripts/check-security-guards.mjs` (runs inside `yarn build`) | Static pattern assertions across `src/`. Today: the three-layer `validateServerUrl` defense for #1947. | A security-critical invariant that MUST hold across every commit and can be expressed as a grep / AST pattern. Catches silent removals at commit time, faster than waiting for a unit-test re-run. |
| **Integration** | (none yet — separate phase) | Live MCP server, real VSCode extension host, real webview React mounting under jsdom. | Out of scope for the current test layer. |

## Quick commands

```bash
yarn test                # run unit tests once
yarn test:watch          # watch mode for TDD on a single module
yarn test:coverage       # v8 coverage report (text + summary)
yarn check               # typecheck + lint + test + security-guards (CI gate)
```

## File layout

Tests live alongside the source they cover:

```
src/auth/serverUrl.ts
src/auth/serverUrl.test.ts        ← tests for serverUrl.ts
src/utils/nonce.ts
src/utils/nonce.test.ts
…
```

Vitest discovers them via the `src/**/*.test.ts` glob in `vitest.config.ts`. The `tsconfig.test.json` separately includes `vitest/globals` types so production typecheck (`tsc --noEmit`) doesn't pull them in.

## What's covered today (Phase 5-A)

The Phase 5-A test cohort focuses on the highest-leverage pure-function modules — the ones whose silent breakage caused the most production pain (#1947 `validateServerUrl` regression, #1566 / #1746 `getNonce` regressions, #2326 commit-hash false-positive):

- `src/auth/serverUrl.ts` — `validateServerUrl` (every reject branch)
- `src/utils/nonce.ts` — `getNonce` entropy + alphabet
- `src/utils/html.ts` — `escapeHtml` ordering + completeness
- `src/sessions/personas.ts` — `CODE_AGENT_PERSONAS`, `isCodeAgent`, `personaDisplayName`
- `src/views/sessions/mentionParser.ts` — `parseMentionState`, `formatMentionToken`, `applyMention`, `shouldFetch`
- `src/views/sessions/chatRenderer.ts` — `parsePathReference`, `isValidCommitHash`, `tokenizeChatMessage` (smoke), `composeSelectionPrompt`
- `src/views/activity/feedStateController.ts` — state-machine transitions, debounce, threshold
- `src/commands/sessionCommands.ts` — `detectExternalAuth`, `validateProviderKey`, `buildProvidersWithAvailability`

## What's deliberately NOT covered (yet)

- **`src/views/**` non-helper code** (TreeView providers, WebView panels). They depend on the VSCode runtime API. Fighting a fake VSCode is more cost than benefit at this layer — covered by manual / integration tests in a later phase.
- **`src/commands/**` non-helper code** (the launch wizard, QA flows). Same reason — heavy VSCode API surface.
- **`src/extension.ts`** activation entry. Tested implicitly by manual launch.
- **`webview-ui/src/**`** React components. Would require jsdom + react-testing-library + a separate workspace test config — separate phase.
- **`scripts/check-security-guards.mjs`**. Already runs inside `yarn build` as a build-time guard. Migrating into vitest would change nothing structural; keep it where it lives.

## Test policy

**No mocks of modules under test.** Tests exercise real implementations. The few external boundaries that NEED to be controlled (env vars, filesystem, the missing `vscode` module) are stubbed minimally:

- **`process.env`** — set / delete with `beforeEach` / `afterEach` restore (real env, just scoped).
- **Filesystem** — real `os.tmpdir()` directories, cleaned up in `afterEach`.
- **`vscode`** — aliased in `vitest.config.ts` to `src/__test_stubs__/vscode.ts`. The stub exposes the minimum API surface required for the source files to load. Tests NEVER reach behavior through it (those code paths belong in integration tests).
- **External binaries** (for `isBinaryOnPath` tests) — use real, universally-available names (`sh`, `node`) for the available case, deliberately-bogus names for the unavailable case.

Every stub above is at a real **external boundary** — not the module under test. The project rule against test doubles is about not faking the unit you're verifying.

## Adding a test

1. Create `<file>.test.ts` next to the source file.
2. Use `vitest` globals (`describe`, `it`, `expect`).
3. If your test needs a controlled env var, follow the `beforeEach` / `afterEach` restore pattern in `src/commands/sessionCommands.test.ts`.
4. Run `yarn test` to verify; `yarn test:coverage` to confirm coverage hasn't slipped on the file you touched.
