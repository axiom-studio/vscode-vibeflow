// Activation-order suite — runtime sibling of `scripts/check-security-guards.mjs`.
//
// The #1947 invariant is: validateServerUrl(cachedServerUrl) must be
// called BEFORE tryAutoConnect during activation, and tryAutoConnect
// must be SKIPPED when the cached URL is insecure (so the bearer token
// never rides a plain-HTTP transport silently).
//
// PRIMARY DEFENSE: `scripts/check-security-guards.mjs` runs at every
// `yarn build` and pattern-asserts the actual source-code shape of
// extension.ts:1311-1328 (validateServerUrl(cachedServerUrl) followed
// by gated tryAutoConnect within 1200 chars). That's the durable
// regression guard against another `e0ef3ad`-style silent removal.
//
// THIS RUNTIME TEST: a smoke that the extension survives activation
// under the default (valid HTTPS) config — which exercises the OK
// branch of the preflight. The REJECT branch is not exercised here
// because re-running activate() with a mutated config requires
// reload-window or extension-host churn that doesn't play nicely
// with @vscode/test-electron's single-process model.
//
// Why bother if the static guard already exists: the static and runtime
// checks cover complementary failure modes — static catches "source is
// wrong", runtime catches "effect is wrong" (e.g. preflight ran but
// somehow tryAutoConnect fired anyway, which would happen if the
// gating branch logic regresses without the structural pattern moving).

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'AxiomStudio.vscode-vibeflow';

suite('Activation order (#1947 invariant)', function () {
  this.timeout(60_000);

  test('extension survives activation under the default serverUrl (preflight OK branch exercised)', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `Extension ${EXTENSION_ID} not present`);
    await ext!.activate();

    const config = vscode.workspace.getConfiguration('vibeflow');
    const serverUrl = config.get<string>('serverUrl', '');
    assert.ok(
      serverUrl.length > 0,
      'serverUrl config must be readable post-activation',
    );
    assert.ok(
      serverUrl.startsWith('https://') ||
        serverUrl.startsWith('http://localhost') ||
        serverUrl.startsWith('http://127.0.0.1') ||
        serverUrl.startsWith('http://[::1]'),
      `serverUrl in the test config must satisfy validateServerUrl (got ${serverUrl}); ` +
        'if this trips, the test workspace vibeflow.serverUrl was overridden to an insecure value',
    );

    // Extension is still alive — the preflight didn't crash + tryAutoConnect
    // either ran cleanly or was skipped (both acceptable here since we're
    // not asserting on the connection outcome, just on activation survival).
    assert.strictEqual(
      ext!.isActive,
      true,
      'extension must remain active after default-config activation',
    );

    // The REJECT-branch assertion (insecure serverUrl → tryAutoConnect
    // skipped + warning surfaced) requires re-running activate() with
    // a mutated config, which @vscode/test-electron's single-process
    // model doesn't support cleanly. That branch is guarded by:
    //   - the unit cohort's `src/auth/serverUrl.test.ts` (validates
    //     every reject branch of validateServerUrl itself)
    //   - the build-time `scripts/check-security-guards.mjs` (asserts
    //     the preflight CALLS validateServerUrl and gates on its result)
    // Together with this smoke, the three layers cover: "validator is
    // correct" + "preflight calls validator + gates" + "extension
    // survives the OK branch". The only remaining gap is "the gate
    // actually blocks tryAutoConnect on the reject branch at runtime",
    // which would need a deactivate/reactivate harness — filed as a
    // future enhancement.
  });
});
