import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { DetectedProject, ProjectDetector } from '../../project/ProjectDetector.js';
import { sortProjects, switchToProject } from '../../commands/projectCommands.js';
import { getNonce } from '../../utils/nonce.js';

/** What the dropdown pane shows. Names travel as data and are rendered with textContent. */
export type ProjectSelectorState =
  | { kind: 'signedOut' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; projects: { id: number; name: string }[]; activeId: number | undefined; branch: string };

type ProjectSelectorMessage =
  | { type: 'ready' }
  | { type: 'switch'; projectId: number }
  | { type: 'signIn' }
  | { type: 'retry' };

/**
 * Project dropdown at the top of the VibeFlow sidebar (#4044, replaces the
 * one-row Project tree of #4030). Tree views cannot render a dropdown, so
 * this is a small plain-HTML webview view. Agent Fleet below it spans every
 * project; the views under that are scoped to the project picked here.
 * Switching runs the same path as the "Switch Project" QuickPick.
 */
export class ProjectSelectorView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly _onDidChangeProject = new vscode.EventEmitter<void>();
  readonly onDidChangeProject = this._onDidChangeProject.event;
  private project: DetectedProject | undefined;
  private view: vscode.WebviewView | undefined;
  private projects: { id: number; name: string; gitRemoteUrl: string }[] | undefined;
  private loadSeq = 0;

  constructor(private readonly deps: {
    client: VibeFlowClient;
    detector: ProjectDetector;
    onSwitched: (project: DetectedProject) => void;
  }) {}

  setProject(project: DetectedProject | undefined): void {
    this.project = project;
    this._onDidChangeProject.fire();
    void this.load();
  }

  getProject(): DetectedProject | undefined {
    return this.project;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = renderHtml(getNonce());
    view.webview.onDidReceiveMessage((msg: ProjectSelectorMessage) => this.handle(msg));
    view.onDidChangeVisibility(() => { if (view.visible) { void this.load(); } });
    view.onDidDispose(() => { if (this.view === view) { this.view = undefined; } });
  }

  private async handle(msg: ProjectSelectorMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
      case 'retry':
        await this.load();
        return;
      case 'signIn':
        await vscode.commands.executeCommand('vibeflow.setup');
        return;
      case 'switch': {
        const picked = this.projects?.find(p => p.id === msg.projectId);
        if (picked) {
          await switchToProject(this.deps, { projectId: picked.id, projectName: picked.name, gitRemoteUrl: picked.gitRemoteUrl });
        }
        // A switch reconnects views and calls setProject; on a failure or a
        // no-op, re-post so the dropdown shows the project that is active.
        this.postReady();
        return;
      }
    }
  }

  /** Fetch the project list (one request) and show it; only the latest load posts. */
  private async load(): Promise<void> {
    if (!this.view) { return; }
    if (!this.deps.client.isAuthenticated()) {
      this.post({ kind: 'signedOut' });
      return;
    }
    const seq = ++this.loadSeq;
    if (!this.projects) { this.post({ kind: 'loading' }); }
    try {
      const projects = sortProjects(await this.deps.client.listProjects());
      if (seq !== this.loadSeq) { return; }
      this.projects = projects.map(p => ({ id: p.id, name: p.name, gitRemoteUrl: p.git_remote_url ?? '' }));
      this.postReady();
    } catch (err) {
      if (seq !== this.loadSeq) { return; }
      this.post({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private postReady(): void {
    if (!this.projects) { return; }
    this.post({
      kind: 'ready',
      projects: this.projects.map(({ id, name }) => ({ id, name })),
      activeId: this.project?.projectId,
      branch: this.project?.gitBranch ?? '',
    });
  }

  private post(state: ProjectSelectorState): void {
    void this.view?.webview.postMessage(state);
  }

  dispose(): void {
    this._onDidChangeProject.dispose();
  }
}

function renderHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { margin: 0; padding: 6px 12px 8px 20px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  select { width: 100%; box-sizing: border-box; padding: 3px 6px; font: inherit;
    color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 2px; outline: none; }
  select:focus { border-color: var(--vscode-focusBorder); }
  .meta { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 0.92em; min-height: 1.2em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { font: inherit; padding: 3px 10px; border: none; border-radius: 2px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <select id="project" aria-label="VibeFlow project" hidden></select>
  <button id="action" hidden></button>
  <div id="meta" class="meta"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const select = document.getElementById('project');
  const action = document.getElementById('action');
  const meta = document.getElementById('meta');
  let onAction = null;
  action.addEventListener('click', () => onAction && vscode.postMessage(onAction));
  select.addEventListener('change', () => {
    const id = Number(select.value);
    if (id) { select.disabled = true; meta.textContent = 'Switching…'; vscode.postMessage({ type: 'switch', projectId: id }); }
  });
  function show(button, text) {
    select.hidden = true; action.hidden = !button; meta.textContent = text;
    if (button) { action.textContent = button.label; onAction = button.msg; }
  }
  window.addEventListener('message', ({ data: s }) => {
    if (s.kind === 'signedOut') { show({ label: 'Sign in', msg: { type: 'signIn' } }, ''); return; }
    if (s.kind === 'loading') { show(null, 'Loading projects…'); return; }
    if (s.kind === 'error') { show({ label: 'Retry', msg: { type: 'retry' } }, 'Could not load projects: ' + s.message); return; }
    if (s.projects.length === 0) { show(null, 'No projects for your account yet.'); return; }
    action.hidden = true; select.hidden = false; select.disabled = false;
    select.replaceChildren();
    if (s.activeId === undefined || !s.projects.some(p => p.id === s.activeId)) {
      const none = new Option('Select a project…', '', true, true);
      none.disabled = true;
      select.add(none);
    }
    for (const p of s.projects) { select.add(new Option(p.name, String(p.id), false, p.id === s.activeId)); }
    meta.textContent = s.branch ? 'Branch: ' + s.branch : '';
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
