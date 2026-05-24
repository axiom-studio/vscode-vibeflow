# Testing

## Layers

The project has three distinct verification layers. Each catches a different class of regression — picking the right layer for new work keeps coverage focused.

| Layer | Runner | What it covers | When to add to it |
|---|---|---|---|
| **Unit** | `vitest` (`yarn test`) | Pure-function modules — string parsers, state machines, regex tokenizers, key validators. No VSCode API, no DOM. Runs in Node. | Any new pure helper, any regex / validator / parser change. |
| **Build-time guard** | `node scripts/check-security-guards.mjs` (runs inside `yarn build`) | Static pattern assertions across `src/`. Today: the three-layer `validateServerUrl` defense for #1947. | A security-critical invariant that MUST hold across every commit and can be expressed as a grep / AST pattern. Catches silent removals at commit time, faster than waiting for a unit-test re-run. |
| **Integration** | `@vscode/test-electron` + `mocha` (`yarn test:integration`) | A real VS Code Electron host running this extension. Today: activation invariants (extension activates, every contributed command + view registers). Future: chat-panel postMessage round-trip, mention dispatch echo, diff overlay scheme, polling-coordinator behavior. | Anything that touches the `vscode` namespace at runtime and CAN'T be exercised by a pure-function unit test — `activate()` decomposition, view registration, panel webview lifecycle, command-registration order, polling coordinators. |
| **Future** | (jsdom + react-testing-library, dedicated workspace) | Webview React component tests in isolation from the extension host. | Webview-side UI logic that doesn't need a live host — local component behavior, hook ordering, render output. |

## Quick commands

```bash
yarn test                # vitest unit tests (~200ms)
yarn test:watch          # watch mode for TDD on a single module
yarn test:coverage       # v8 coverage report (text + summary)
yarn test:integration    # @vscode/test-electron extension-host suite (~5-30s; downloads VS Code on first run)
yarn check               # typecheck + lint + unit test + security-guards (CI gate; does NOT run integration)
```

Integration tests deliberately do NOT run inside `yarn check` — they download a ~210 MB VS Code build on first run, take 4-30s per cycle, and launch a real Electron process. Wire them into CI as a separate job, or invoke `yarn test:integration` manually before pushing changes that touch `activate()` / view registration / panel webview lifecycle.

## File layout

**Unit tests** live alongside the source they cover:

```
src/auth/serverUrl.ts
src/auth/serverUrl.test.ts        ← tests for serverUrl.ts
src/utils/nonce.ts
src/utils/nonce.test.ts
…
```

Vitest discovers them via the `src/**/*.test.ts` glob in `vitest.config.ts`. The `tsconfig.test.json` separately includes `vitest/globals` types so production typecheck (`tsc --noEmit`) doesn't pull them in.

**Integration tests** live under a dedicated folder:

```
src/test/integration/
├── runTest.ts                    ← electron launcher
├── suite/
│   ├── index.ts                  ← mocha bootstrap (TDD UI, 30s timeout default)
│   └── activation.test.ts        ← extension activates + commands + views
```

The integration cohort compiles to `out/test/` via `tsconfig.test-integration.json` (separate config — different module system, includes mocha types). Mocha runs in TDD mode (`suite`/`test`/`setup`/`teardown` globals — NOT BDD `describe`/`it`). Test files use `.test.ts` extension matching the unit cohort.

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

## Integration cohort (Phase 5-A2)

What runs today (`src/test/integration/suite/`):
- `activation.test.ts` — extension is present + activates within 60s; every advertised `vibeflow.*` command is registered; every advertised view is reachable via its generated `<viewId>.focus` command. **Catches**: any regression in `activate()` that drops a command, drops a view, or fails to fire (#1975's P5-B2 refactor will be guarded by this).
- `activation-order.test.ts` — runtime sibling of `scripts/check-security-guards.mjs` for the #1947 preflight invariant. Today: smoke-tests the OK branch (extension survives activation under the default valid serverUrl). The REJECT branch (insecure serverUrl → tryAutoConnect skipped) is documented in-file as a deferred gap — requires a deactivate/reactivate harness that doesn't play nicely with @vscode/test-electron's single-process model. The structural defense in check-security-guards.mjs covers the source-code-shape regression class; this test covers "extension didn't crash on the OK branch."

What's NOT in the cohort yet (filed as follow-ups):
- **chat-panel postMessage round-trip** — open a session chat panel, assert webview HTML mounts, `ready` → `state` round-trip works, `chatSend` returns a `messages` update. Blocked on a `setClientFactoryForTests` seam in `api/client.ts` to stub backend calls.
- **mention dispatch** — fire `chatMentionQuery` with `kind='document'`, assert `chatMentionResults` reply with `requestId` echo within 2s. Same backend-mock prerequisite as chat-panel.
- **diff overlay** — register `vibeflow-diff` scheme, open a URI, assert `TextDocumentContentProvider` returns content. Doesn't need backend mocking.
- **wizard-flow** — scripted `vscode.window.showQuickPick` + `showInputBox` stubs that feed test inputs to `vibeflow.launchSession`. Needed to make #1978 (P5-B1b wizard split) autonomously verifiable.
- **REJECT-branch activation-order** — re-activate harness that lets the test mutate config + replay activate(). Would close the only remaining gap in the #1947 runtime coverage.
- **polling-coordinator behavior** — added as part of P5-C (the polling-coordinator refactor itself); P5-A2 sets up the runner that C plugs into.

Each of these unblocks a specific bounce-class:
- chat-panel suite → unblocks #1975 (P5-B2 activate decomposition) and the not-yet-filed P5-B3 (SessionPanelManager refactor).
- mention dispatch suite → unblocks #1979 (P5-B1b wizard decomposition) if any mention-related code lives in the wizard path.
- polling-coordinator suite → unblocks P5-C.

## What's deliberately NOT covered (yet)

- **`src/views/**` non-helper code** (TreeView providers, WebView panels). They depend on the VSCode runtime API — partially reachable via integration suite, but the per-view internal state machines are not unit-testable without a real host. Integration tests cover registration; behavior tests would need richer fixtures.
- **`src/commands/**` non-helper code** (the launch wizard, QA flows). Same reason — heavy VSCode API surface. Integration suite catches command-registration regressions; wizard end-to-end is too brittle for autonomous testing today.
- **`src/extension.ts`** activation order beyond "did it activate" — the #1947 preflight invariant deserves an explicit ordering assertion; currently relies on `scripts/check-security-guards.mjs` for the structural defense and `activation.test.ts` for the "is the extension alive" smoke.
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
