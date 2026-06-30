import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vitest config for the webview React surface (#3258). The host
 * workspace has its own vitest config at the repo root scoped to
 * `src/**` (vscode-free pure functions). This one is jsdom-based and
 * scoped to `webview-ui/src/**` so React components can be rendered in
 * isolation from the extension host — the "future phase" TESTING.md:12
 * and :89 describe.
 *
 * - `css: false` makes the components' `import './*.css'` /
 *   `import 'highlight.js/styles/github-dark.css'` no-ops so jsdom
 *   doesn't have to parse stylesheets we never assert on.
 * - `globals: true` gives RTL its automatic per-test cleanup.
 * - The react plugin (not tailwind) is reused so JSX + Fast-Refresh-free
 *   transforms match the production build.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    css: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
