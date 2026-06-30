import '@testing-library/jest-dom/vitest';

/**
 * Provide the VS Code webview host bridge that `getVsCodeApi()`
 * (src/vscodeApi.ts) acquires at module load. This is the same IPC shim
 * the webview runs against inside a real VS Code panel — a host-supplied
 * transport, NOT a mock of any component logic under test. Components
 * call `vscode.postMessage(...)`; we give it a no-op sink so importing a
 * component that grabs the API at module scope (e.g. SessionChatView)
 * doesn't throw in jsdom.
 *
 * `acquireVsCodeApi` may only be called once per webview; the singleton
 * in vscodeApi.ts caches it, and vitest isolates each test file's module
 * graph, so one definition here is enough.
 */
declare global {
  interface Window {
    acquireVsCodeApi: () => {
      postMessage(message: unknown): void;
      getState(): unknown;
      setState(state: unknown): void;
    };
  }
}

window.acquireVsCodeApi = () => ({
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
});
