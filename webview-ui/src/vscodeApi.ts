/**
 * VSCode webview API singleton.
 *
 * acquireVsCodeApi() can only be called ONCE per webview. Calling it
 * multiple times throws "An instance of the VS Code API has already
 * been acquired". This module acquires it exactly once and exports
 * the singleton for all consumers.
 */

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi: () => VsCodeApi;
  }
}

let apiInstance: VsCodeApi | null = null;

export function getVsCodeApi(): VsCodeApi {
  if (!apiInstance) {
    apiInstance = window.acquireVsCodeApi();
  }
  return apiInstance;
}
