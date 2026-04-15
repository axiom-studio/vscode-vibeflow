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
      stream.button({ command: 'vibeflow.login', title: 'Login to VibeFlow' });
      return;
    }

    const project = this.detector.getCachedProject();
    if (!project) {
      stream.markdown('**No project detected.** Open a workspace with a git remote linked to a VibeFlow project.\n');
      return;
    }

    switch (request.command) {
      case 'status':
        await this.handleStatus(project, stream);
        break;
      case 'create':
        await this.handleCreate(project, request, stream);
        break;
      case 'review':
        await this.handleReview(project, stream);
        break;
      case 'summary':
        await this.handleSummary(project, stream);
        break;
      case 'launch':
        await this.handleLaunch(request, stream);
        break;
      default:
        await this.handleFreeform(project, request, stream);
        break;
    }
  }

  private async handleStatus(
    project: DetectedProject,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    stream.markdown(`## ${project.projectName}\n\n`);

    try {
      const [features, issues, sessions] = await Promise.all([
        this.client.listFeatures(project.projectId),
        this.client.listIssues(project.projectId),
        this.client.listSessions(project.projectId),
      ]);

      // Active sessions (those with a live heartbeat in Redis)
      const activeSessions = sessions.filter(s => s.active && !s.stale);
      if (activeSessions.length > 0) {
        stream.markdown(`### Active Sessions (${activeSessions.length})\n\n`);
        stream.markdown('| Persona | Branch | Last Activity |\n|---------|--------|---------------|\n');
        for (const s of activeSessions) {
          const when = s.last_message_at ? new Date(s.last_message_at).toLocaleTimeString() : '—';
          stream.markdown(`| ${s.persona_name ?? s.persona_key} | ${s.git_branch} | ${when} |\n`);
        }
        stream.markdown('\n');
      }

      // Features
      if (features.length > 0) {
        stream.markdown('### Features\n\n');
        stream.markdown('| Feature | Status | Priority |\n|---------|--------|----------|\n');
        for (const f of features) {
          stream.markdown(`| ${f.name} | ${f.status} | ${f.priority} |\n`);
        }
        stream.markdown('\n');
      }

      // Open Issues
      const openIssues = issues.filter(i => i.status !== 'done');
      if (openIssues.length > 0) {
        stream.markdown('### Open Issues\n\n');
        stream.markdown('| # | Title | Status | Priority |\n|---|-------|--------|----------|\n');
        for (const i of openIssues) {
          stream.markdown(`| ${i.id} | ${i.title} | ${i.status} | ${i.priority} |\n`);
        }
        stream.markdown('\n');
      }

      if (features.length === 0 && openIssues.length === 0 && activeSessions.length === 0) {
        stream.markdown('No activity found.\n');
      }

      stream.button({ command: 'vibeflow.createWorkItem', title: 'Create Work Item' });
      stream.button({ command: 'vibeflow.refresh', title: 'Refresh' });
    } catch (err) {
      stream.markdown(`**Error**: ${err}\n`);
    }
  }

  private async handleReview(
    project: DetectedProject,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    stream.markdown('## Items Needing Review\n\n');

    try {
      const [features, issues] = await Promise.all([
        this.client.listFeatures(project.projectId),
        this.client.listIssues(project.projectId),
      ]);

      // Get todos for all features — filter for done + not reviewed
      const allTodos = [];
      for (const f of features) {
        const todos = await this.client.listTodos(f.id);
        for (const t of todos) {
          allTodos.push({ ...t, featureName: f.name });
        }
      }

      const needsQA = [
        ...allTodos.filter(t => t.status === 'done' && !t.qaVerified),
        ...issues.filter(i => i.status === 'done' && !i.qaVerified),
      ];

      const needsSecurity = [
        ...allTodos.filter(t => t.status === 'done' && !t.securityReviewed),
        ...issues.filter(i => i.status === 'done' && !i.securityReviewed),
      ];

      if (needsQA.length > 0) {
        stream.markdown(`### QA Review (${needsQA.length})\n\n`);
        stream.markdown('| # | Title | Type |\n|---|-------|------|\n');
        for (const item of needsQA) {
          const type = 'featureName' in item ? 'todo' : 'issue';
          stream.markdown(`| ${item.id} | ${item.title} | ${type} |\n`);
        }
        stream.markdown('\n');
      }

      if (needsSecurity.length > 0) {
        stream.markdown(`### Security Review (${needsSecurity.length})\n\n`);
        stream.markdown('| # | Title | Type |\n|---|-------|------|\n');
        for (const item of needsSecurity) {
          const type = 'featureName' in item ? 'todo' : 'issue';
          stream.markdown(`| ${item.id} | ${item.title} | ${type} |\n`);
        }
        stream.markdown('\n');
      }

      if (needsQA.length === 0 && needsSecurity.length === 0) {
        stream.markdown('All done items are reviewed. Nothing pending.\n');
      }
    } catch (err) {
      stream.markdown(`**Error**: ${err}\n`);
    }
  }

  private async handleSummary(
    project: DetectedProject,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    stream.markdown(`## Work Summary — ${project.projectName}\n\n`);

    try {
      const [features, issues, sessions] = await Promise.all([
        this.client.listFeatures(project.projectId),
        this.client.listIssues(project.projectId),
        this.client.listSessions(project.projectId),
      ]);

      const doneFeatures = features.filter(f => f.status === 'done').length;
      const activeSessions = sessions.filter(s => s.active && !s.stale).length;
      const doneIssues = issues.filter(i => i.status === 'done').length;
      const openIssues = issues.filter(i => i.status !== 'done').length;

      stream.markdown('| Metric | Count |\n|--------|-------|\n');
      stream.markdown(`| Features | ${features.length} (${doneFeatures} done) |\n`);
      stream.markdown(`| Issues | ${issues.length} (${doneIssues} done, ${openIssues} open) |\n`);
      stream.markdown(`| Active Sessions | ${activeSessions} / ${sessions.length} |\n`);
      stream.markdown('\n');

      stream.button({ command: 'vibeflow.openDashboard', title: 'Open Dashboard' });
    } catch (err) {
      stream.markdown(`**Error**: ${err}\n`);
    }
  }

  private async handleLaunch(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    const prompt = request.prompt.trim().toLowerCase();

    // Parse persona from natural language
    const personas = ['developer', 'architect', 'principal_engineer', 'security_lead', 'qa_lead', 'product_manager', 'project_manager', 'ux_designer', 'customer'];
    const matchedPersona = personas.find(p => prompt.includes(p.replace('_', ' ')) || prompt.includes(p));

    if (matchedPersona) {
      stream.markdown(`Launching **${matchedPersona}** session...\n\n`);
      stream.markdown('Use the button below to complete the launch wizard:\n\n');
    } else {
      stream.markdown('Launch a new agent session.\n\nExamples:\n');
      stream.markdown('- `@vibeflow /launch developer on main`\n');
      stream.markdown('- `@vibeflow /launch architect on feature/auth`\n\n');
    }

    stream.button({ command: 'vibeflow.launchSession', title: 'Launch Session' });
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

    const lower = prompt.toLowerCase();
    let itemType: 'issue' | 'todo' | 'feature' = 'issue';
    if (lower.includes('feature')) {
      itemType = 'feature';
    } else if (lower.includes('todo') || lower.includes('enhancement') || lower.includes('add')) {
      itemType = 'todo';
    }

    stream.markdown(
      `I'd create a **${itemType}** from: "${prompt}"\n\n` +
      `Project: **${project.projectName}** (branch: ${project.gitBranch})\n\n`,
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
      await this.handleStatus(project, stream);
      return;
    }

    if (prompt.includes('review') || prompt.includes('qa') || prompt.includes('security')) {
      await this.handleReview(project, stream);
      return;
    }

    if (prompt.includes('summary') || prompt.includes('stats') || prompt.includes('metrics')) {
      await this.handleSummary(project, stream);
      return;
    }

    stream.markdown(
      `I can help with **${project.projectName}**. Available commands:\n\n` +
      '- `/status` — project status, sessions, features, issues\n' +
      '- `/create <description>` — create a work item\n' +
      '- `/review` — items needing QA or security review\n' +
      '- `/summary` — work summary and metrics\n' +
      '- `/launch` — launch an agent session\n\n' +
      'Or ask me anything about the project.\n',
    );
  }
}
