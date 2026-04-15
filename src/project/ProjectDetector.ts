import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';

const execAsync = promisify(exec);

const KEY_PROJECT_ID = 'vibeflow.projectId';
const KEY_PROJECT_NAME = 'vibeflow.projectName';
const KEY_GIT_REMOTE = 'vibeflow.gitRemoteUrl';

export interface DetectedProject {
  projectId: number;
  projectName: string;
  gitRemoteUrl: string;
  gitBranch: string;
}

export interface ProjectMatchResult {
  id: number;
  name: string;
}

/**
 * Detects the VibeFlow project for the current workspace by matching
 * the git remote URL against known projects.
 */
export class ProjectDetector {
  /**
   * Use globalState so the project persists across F5 launches and survives
   * dev host windows that don't have a workspace folder loaded.
   */
  constructor(private readonly globalState: vscode.Memento) {}

  /**
   * Get the cached project from global state, if any.
   */
  getCachedProject(): DetectedProject | undefined {
    const projectId = this.globalState.get<number>(KEY_PROJECT_ID);
    const projectName = this.globalState.get<string>(KEY_PROJECT_NAME);
    const gitRemoteUrl = this.globalState.get<string>(KEY_GIT_REMOTE);
    if (projectId && projectName) {
      return { projectId, projectName, gitRemoteUrl: gitRemoteUrl ?? '', gitBranch: '' };
    }
    return undefined;
  }

  /**
   * Cache detected project in global state.
   */
  async cacheProject(project: DetectedProject): Promise<void> {
    await this.globalState.update(KEY_PROJECT_ID, project.projectId);
    await this.globalState.update(KEY_PROJECT_NAME, project.projectName);
    await this.globalState.update(KEY_GIT_REMOTE, project.gitRemoteUrl);
  }

  /**
   * Clear cached project.
   */
  async clearCache(): Promise<void> {
    await this.globalState.update(KEY_PROJECT_ID, undefined);
    await this.globalState.update(KEY_PROJECT_NAME, undefined);
    await this.globalState.update(KEY_GIT_REMOTE, undefined);
  }

  /**
   * Get the git remote URL for the current workspace.
   * Returns undefined if not a git repo or no remote configured.
   */
  async getGitRemoteUrl(): Promise<string | undefined> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return undefined;
    }

    try {
      const { stdout } = await execAsync('git remote get-url origin', {
        cwd: workspaceFolder.uri.fsPath,
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get the current git branch.
   */
  async getGitBranch(): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return 'main';
    }

    try {
      const { stdout } = await execAsync('git branch --show-current', {
        cwd: workspaceFolder.uri.fsPath,
      });
      return stdout.trim() || 'main';
    } catch {
      return 'main';
    }
  }

  /**
   * Detect vibeflow session files in the workspace root.
   * Returns persona keys for any found session files.
   */
  async detectSessionFiles(): Promise<string[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return [];
    }

    const rootPath = workspaceFolder.uri.fsPath;
    const personas: string[] = [];

    try {
      const files = await fs.promises.readdir(rootPath);
      const sessionPrefix = '.vibeflow-session-';
      for (const file of files) {
        if (file.startsWith(sessionPrefix)) {
          personas.push(file.slice(sessionPrefix.length));
        }
      }
    } catch {
      // Directory read failed — not critical
    }

    return personas;
  }

  /**
   * Run the full detection flow:
   * 1. Check workspace state cache
   * 2. Get git remote URL
   * 3. Match against projects (caller provides the match function)
   * 4. If no match, prompt user
   * 5. Cache result
   */
  async detect(
    matchFn: (remoteUrl: string) => Promise<ProjectMatchResult | undefined>,
    listFn: () => Promise<ProjectMatchResult[]>,
  ): Promise<DetectedProject | undefined> {
    // 1. Check cache
    const cached = this.getCachedProject();
    if (cached) {
      const branch = await this.getGitBranch();
      return { ...cached, gitBranch: branch };
    }

    // 2. Get git remote (optional — skip auto-match if not available)
    const remoteUrl = await this.getGitRemoteUrl();

    // 3. Try auto-match (only if remote URL is available)
    if (remoteUrl) {
      const matched = await matchFn(remoteUrl);
      if (matched) {
        const branch = await this.getGitBranch();
        const project: DetectedProject = {
          projectId: matched.id,
          projectName: matched.name,
          gitRemoteUrl: remoteUrl,
          gitBranch: branch,
        };
        await this.cacheProject(project);
        return project;
      }
    }

    // 4. No match — prompt user
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(list-flat) Select Existing Project', value: 'select' as const },
        { label: '$(add) Create New Project', value: 'create' as const },
        { label: '$(close) Skip', value: 'skip' as const },
      ],
      { placeHolder: remoteUrl ? `No VibeFlow project matched ${remoteUrl}` : 'Select a VibeFlow project' },
    );

    if (!choice || choice.value === 'skip') {
      return undefined;
    }

    if (choice.value === 'select') {
      const projects = await listFn();
      if (projects.length === 0) {
        vscode.window.showInformationMessage('VibeFlow: No projects found.');
        return undefined;
      }

      const selected = await vscode.window.showQuickPick(
        projects.map(p => ({ label: p.name, description: `ID: ${p.id}`, project: p })),
        { placeHolder: 'Select a VibeFlow project' },
      );

      if (!selected) {
        return undefined;
      }

      const branch = await this.getGitBranch();
      const project: DetectedProject = {
        projectId: selected.project.id,
        projectName: selected.project.name,
        gitRemoteUrl: remoteUrl ?? '',
        gitBranch: branch,
      };
      await this.cacheProject(project);
      return project;
    }

    // 'create' — will be handled when API client is fully wired
    vscode.window.showInformationMessage('VibeFlow: Project creation — coming soon');
    return undefined;
  }
}
