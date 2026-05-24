import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

/**
 * Vitest config — host workspace unit tests (Phase 5-A).
 *
 * Scope: pure-function modules under `src/`. NOT webview React
 * (that needs jsdom + a separate workspace config) and NOT host
 * surfaces that import the `vscode` namespace (would require a
 * heavy fake VSCode API that fights the framework — out of unit
 * scope per TESTING.md).
 *
 * Coverage exclusions mirror the unit/non-unit boundary:
 *  - `src/extension.ts` — activation entry, VSCode API heavy
 *  - `src/views/**` — TreeView/Webview providers, VSCode API heavy
 *  - `src/notifications/**` — VSCode UI surfaces
 *  - `src/commands/**` non-helper code — VSCode commands API
 *  - generated / type-only files
 */
export default defineConfig({
  resolve: {
    alias: {
      // The `vscode` module is provided by the VS Code runtime — it
      // doesn't exist on npm. Source files that pull it in at the
      // top level (every commands/views file) would crash vitest's
      // module loader otherwise. The stub exposes the minimum
      // surface needed for the source files to be IMPORTED; tests
      // never exercise behavior through it. See the file header for
      // the test-policy reasoning.
      vscode: path.resolve(__dirname, 'src/__test_stubs__/vscode.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      // Scope coverage to the cohort files actually under unit test.
      // Including the rest of src/ would report deceptively low overall
      // because the wizard / TreeView / WebView / spawn code is covered
      // by manual + integration tests (separate phase, see TESTING.md).
      include: [
        'src/auth/serverUrl.ts',
        'src/utils/nonce.ts',
        'src/utils/html.ts',
        'src/sessions/personas.ts',
        'src/views/sessions/mentionParser.ts',
        'src/views/sessions/chatRenderer.ts',
        'src/views/activity/feedStateController.ts',
        // sessionCommands.ts exports our three pure helpers AND ~1400
        // lines of wizard code that's out of unit scope. The cohort
        // covers ONLY the helpers; full-file branch% would mislead.
        // Listed here for visibility but coverage report should be
        // read with that in mind.
        'src/commands/sessionCommands.ts',
      ],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
      ],
    },
  },
});
