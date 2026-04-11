import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector, DetectedProject } from '../project/ProjectDetector.js';

const PARTICIPANT_ID = 'vibeflow.chat';

/**
 * Register the @vibeflow Chat Participant.
 * Gracefully no-ops if the Chat Participant API is unavailable (no Copilot).
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  client: VibeFlowClient,
  detector: ProjectDetector,
): void {
  // Chat Participant API may not be available
  if (!vscode.chat?.createChatParticipant) {
    return;
  }

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, stream, token) => {
    const handler = new ChatHandler(client, detector);
    await handler.handle(request, chatContext, stream, token);
  });

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'vibeflow-icon.svg');

  context.subscriptions.push(participant);
}

class ChatHandler {
  constructor(
    private readonly client: VibeFlowClient,
    private readonly detector: ProjectDetector,
  ) {}

  async handle(
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    if (!this.client.isAuthenticated()) {
      stream.markdown('**Not logged in.** Run `VibeFlow: Login` first.\n\n');
      stream.button({
        command: 'vibeflow.login',
        title: 'Login to VibeFlow',
      });
      return;
    }

    const project = this.detector.getCachedProject();
    if (!project) {
      stream.markdown('**No project detected.** Open a workspace with a git remote linked to a VibeFlow project.\n');
      return;
    }

    const command = request.command;

    switch (command) {
      case 'status':
        await this.handleStatus(project, request, stream);
        break;
      case 'create':
        await this.handleCreate(project, request, stream);
        break;
      default:
        await this.handleFreeform(project, request, stream);
        break;
    }
  }

  private async handleStatus(
    project: DetectedProject,
    _request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    stream.markdown(`## ${project.projectName}\n\n`);

    try {
      const [features, issues] = await Promise.all([
        this.client.listFeatures(project.projectId),
        this.client.listIssues(project.projectId),
      ]);

      // Features table
      if (features.length > 0) {
        stream.markdown('### Features\n\n');
        stream.markdown('| Feature | Status | Priority |\n|---------|--------|----------|\n');
        for (const f of features) {
          stream.markdown(`| ${f.name} | ${f.status} | ${f.priority} |\n`);
        }
        stream.markdown('\n');
      }

      // Issues table
      const openIssues = issues.filter(i => i.status !== 'done');
      if (openIssues.length > 0) {
        stream.markdown('### Open Issues\n\n');
        stream.markdown('| # | Title | Status | Priority |\n|---|-------|--------|----------|\n');
        for (const i of openIssues) {
          stream.markdown(`| ${i.id} | ${i.title} | ${i.status} | ${i.priority} |\n`);
        }
        stream.markdown('\n');
      }

      if (features.length === 0 && openIssues.length === 0) {
        stream.markdown('No features or open issues found.\n');
      }

      // Follow-ups
      stream.markdown('\n');
      stream.button({ command: 'vibeflow.createWorkItem', title: 'Create Work Item' });
      stream.button({ command: 'vibeflow.refresh', title: 'Refresh' });
    } catch (err) {
      stream.markdown(`**Error**: ${err}\n`);
    }
  }

  private async handleCreate(
    project: DetectedProject,
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    const prompt = request.prompt.trim();

    if (!prompt) {
      stream.markdown(
        'Tell me what to create. Examples:\n\n' +
        '- `@vibeflow /create a high-priority bug: login button not responding`\n' +
        '- `@vibeflow /create feature: User Dashboard`\n' +
        '- `@vibeflow /create todo: add date filter to reports table`\n',
      );
      return;
    }

    // Parse intent from natural language
    const lower = prompt.toLowerCase();
    let itemType: 'issue' | 'todo' | 'feature' = 'issue';
    if (lower.includes('feature')) {
      itemType = 'feature';
    } else if (lower.includes('todo') || lower.includes('enhancement') || lower.includes('add')) {
      itemType = 'todo';
    }

    // For now, guide the user to the Quick Pick wizard
    // Full natural language creation will be added when API client is complete
    stream.markdown(
      `I'd create a **${itemType}** from: "${prompt}"\n\n` +
      `Project: **${project.projectName}** (branch: ${project.gitBranch})\n\n` +
      `Use the command below to create it with the full wizard:\n\n`,
    );
    stream.button({ command: 'vibeflow.createWorkItem', title: `Create ${itemType}` });
  }

  private async handleFreeform(
    project: DetectedProject,
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    const prompt = request.prompt.trim().toLowerCase();

    if (prompt.includes('status') || prompt.includes('what') || prompt.includes('how')) {
      await this.handleStatus(project, request, stream);
      return;
    }

    stream.markdown(
      `I can help with **${project.projectName}**. Try these commands:\n\n` +
      '- `/status` — project status, features, and issues\n' +
      '- `/create <description>` — create a work item\n\n' +
      'Or ask me anything about the project.\n',
    );
  }
}
