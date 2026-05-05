import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector, DetectedProject } from '../project/ProjectDetector.js';
import type { PromptNotifier } from '../notifications/PromptNotifier.js';

const PARTICIPANT_ID = 'vibeflow.chat';

/**
 * Pull item-type, priority, and title out of a free-form `/create`
 * prompt. The order of the input doesn't matter; we strip the
 * type/priority tokens and use whatever's left as the title.
 *
 * Examples:
 *   "feature: User Dashboard"        → {feature, medium, "User Dashboard"}
 *   "high priority bug login broken" → {issue, high, "bug login broken"}
 *   "todo add date filter"           → {todo, medium, "add date filter"}
 */
export function parseCreatePrompt(prompt: string): {
  itemType: 'feature' | 'todo' | 'issue';
  priority: 'low' | 'medium' | 'high';
  title: string;
} {
  const lower = prompt.toLowerCase();

  const itemType: 'feature' | 'todo' | 'issue' =
    /\bfeature\b/.test(lower) ? 'feature'
      : /\b(todo|enhancement)\b/.test(lower) ? 'todo'
        : 'issue';

  const priority: 'low' | 'medium' | 'high' =
    /\bhigh(\s+priority)?\b/.test(lower) ? 'high'
      : /\blow(\s+priority)?\b/.test(lower) ? 'low'
        : 'medium';

  // Strip leading type/priority phrases + a trailing colon if present.
  // Keep the first colon's RHS when the user wrote "feature: User Dashboard".
  let title = prompt.trim();
  const colonIdx = title.indexOf(':');
  if (colonIdx >= 0 && colonIdx < 30) {
    title = title.slice(colonIdx + 1).trim();
  } else {
    title = title
      .replace(/\b(feature|todo|issue|enhancement|bug)\b/gi, '')
      .replace(/\b(high|low|medium)(\s+priority)?\b/gi, '')
      .replace(/\bpriority\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (!title) { title = prompt.trim(); }

  return { itemType, priority, title };
}

/**
 * Render a chat message's attached references as a one-line
 * acknowledgement at the top of the participant's reply. Returns
 * empty string when nothing is attached so callers can guard with
 * a falsy check.
 *
 * `ChatPromptReference.value` can be a string (literal text the user
 * dragged in), a Uri (file/folder), or a Location (Uri + Range for a
 * specific selection). We collapse Uri/Location to a workspace-
 * relative path so "scoping to: src/foo.ts" reads naturally; literal
 * strings get truncated and quoted; unknown shapes get a generic tag.
 */
function formatReferences(references: readonly vscode.ChatPromptReference[] | undefined): string {
  if (!references || references.length === 0) { return ''; }

  const labels: string[] = [];
  for (const ref of references) {
    const v = ref.value;
    if (v instanceof vscode.Uri) {
      labels.push('`' + vscode.workspace.asRelativePath(v) + '`');
    } else if (typeof v === 'object' && v && 'uri' in v && (v as { uri: unknown }).uri instanceof vscode.Uri) {
      // Location-like: show file plus optional line range.
      const loc = v as { uri: vscode.Uri; range?: { start?: { line?: number }; end?: { line?: number } } };
      const file = vscode.workspace.asRelativePath(loc.uri);
      const start = loc.range?.start?.line;
      const end = loc.range?.end?.line;
      labels.push(start !== undefined && end !== undefined
        ? `\`${file}:${start + 1}-${end + 1}\``
        : `\`${file}\``);
    } else if (typeof v === 'string') {
      const trimmed = v.trim().replace(/\s+/g, ' ');
      labels.push(trimmed.length > 60 ? `"${trimmed.slice(0, 57)}…"` : `"${trimmed}"`);
    } else {
      // Unknown shape — tag by id rather than dropping silently.
      labels.push(`[${ref.id}]`);
    }
  }

  return `_Scoping to: ${labels.join(', ')}_`;
}

/**
 * Register the @vibeflow Chat Participant.
 * Gracefully no-ops if the Chat Participant API is unavailable (no Copilot).
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  client: VibeFlowClient,
  detector: ProjectDetector,
  promptNotifier: PromptNotifier,
): void {
  if (!vscode.chat?.createChatParticipant) {
    return;
  }

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, stream, token) => {
    const handler = new ChatHandler(client, detector, promptNotifier);
    return handler.handle(request, chatContext, stream, token);
  });

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'vibeflow-icon.svg');

  // Suggest the next likely command after each turn so users discover
  // the surface without reading docs. We base suggestions on what the
  // last command produced (e.g. after /status, suggest /review).
  participant.followupProvider = {
    provideFollowups(result: vscode.ChatResult): vscode.ChatFollowup[] {
      const cmd = result.metadata && typeof result.metadata === 'object'
        ? (result.metadata as { command?: string }).command
        : undefined;
      switch (cmd) {
        case 'status':
          return [
            { prompt: 'review pending items', label: '🔍 Review', command: 'review' },
            { prompt: 'show summary', label: '📊 Summary', command: 'summary' },
          ];
        case 'review':
          return [
            { prompt: 'show open compliance findings', label: '🛡 Compliance', command: 'compliance' },
            { prompt: 'show summary', label: '📊 Summary', command: 'summary' },
          ];
        case 'create':
          return [
            { prompt: 'show project status', label: '📋 Status', command: 'status' },
            { prompt: 'launch a developer session', label: '🚀 Launch', command: 'launch' },
          ];
        case 'summary':
          return [
            { prompt: 'show project status', label: '📋 Status', command: 'status' },
            { prompt: 'review pending items', label: '🔍 Review', command: 'review' },
          ];
        case 'compliance':
          return [
            { prompt: 'review pending items', label: '🔍 Review', command: 'review' },
          ];
        default:
          return [
            { prompt: 'show project status', label: '📋 Status', command: 'status' },
            { prompt: 'review pending items', label: '🔍 Review', command: 'review' },
          ];
      }
    },
  };

  context.subscriptions.push(participant);
}

class ChatHandler {
  constructor(
    private readonly client: VibeFlowClient,
    private readonly detector: ProjectDetector,
    private readonly promptNotifier: PromptNotifier,
  ) {}

  async handle(
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult> {
    if (!this.client.isAuthenticated()) {
      stream.markdown('**Not logged in.** Run `VibeFlow: Login` first.\n\n');
      stream.button({ command: 'vibeflow.login', title: 'Login to VibeFlow' });
      return {};
    }

    const project = this.detector.getCachedProject();
    if (!project) {
      stream.markdown('**No project detected.** Open a workspace with a git remote linked to a VibeFlow project.\n');
      return {};
    }

    // Surface any references the user attached to the chat message
    // (e.g. `#file:foo.ts`, a selection, an open editor) so the
    // participant doesn't silently ignore that signal. We don't yet
    // route them into specific actions — that's a per-command
    // decision (e.g. `/create` could pre-fill a description from a
    // selection). Today it's purely an acknowledgement that the
    // user's scope was received.
    const refsLine = formatReferences(request.references);
    if (refsLine) { stream.markdown(refsLine + '\n\n'); }

    switch (request.command) {
      case 'status':
        await this.handleStatus(project, stream);
        return { metadata: { command: 'status' } };
      case 'create':
        await this.handleCreate(project, request, stream);
        return { metadata: { command: 'create' } };
      case 'review':
        await this.handleReview(project, stream);
        return { metadata: { command: 'review' } };
      case 'summary':
        await this.handleSummary(project, stream);
        return { metadata: { command: 'summary' } };
      case 'launch':
        await this.handleLaunch(request, stream);
        return { metadata: { command: 'launch' } };
      case 'respond':
        await this.handleRespond(project, request, stream);
        return { metadata: { command: 'respond' } };
      case 'compliance':
        await this.handleCompliance(project, stream);
        return { metadata: { command: 'compliance' } };
      default:
        await this.handleFreeform(project, request, stream);
        return { metadata: { command: 'freeform' } };
    }
  }

  /**
   * Show open compliance findings — anything not in 'resolved' or
   * 'accepted_risk' status. Backend wire shape:
   *   axiomcloud/database/vibeflow_models.go ComplianceFinding (line 513).
   */
  private async handleCompliance(
    project: DetectedProject,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    stream.markdown(`## Compliance Findings — ${project.projectName}\n\n`);

    try {
      const findings = await this.client.listComplianceFindings(project.projectId);
      const open = findings.filter(f => f.status !== 'resolved' && f.status !== 'accepted_risk');

      if (open.length === 0) {
        stream.markdown('No open findings. ✓\n');
        return;
      }

      // Group by severity so the user sees critical issues first.
      const order: Array<typeof open[number]['severity']> = ['critical', 'high', 'medium', 'low', 'informational'];
      for (const sev of order) {
        const rows = open.filter(f => f.severity === sev);
        if (rows.length === 0) { continue; }
        stream.markdown(`### ${sev.toUpperCase()} (${rows.length})\n\n`);
        stream.markdown('| Type | Item | Description |\n|------|------|-------------|\n');
        for (const f of rows) {
          const desc = (f.description ?? '').replace(/\|/g, '\\|').slice(0, 120);
          stream.markdown(`| ${f.work_item_type} #${f.work_item_id} | ${f.finding_type} | ${desc} |\n`);
        }
        stream.markdown('\n');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`**Error**: ${msg}\n`);
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
        ...allTodos.filter(t => t.status === 'done' && !t.qa_verified),
        ...issues.filter(i => i.status === 'done' && !i.qa_verified),
      ];

      const needsSecurity = [
        ...allTodos.filter(t => t.status === 'done' && !t.security_reviewed),
        ...issues.filter(i => i.status === 'done' && !i.security_reviewed),
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

  private async handleRespond(
    _project: DetectedProject,
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    const responseText = request.prompt.trim();
    const pending = this.promptNotifier.getPending();

    // No text → tell the user how to use it, and list pending prompts
    // so they can see the context they're responding to.
    if (!responseText) {
      stream.markdown(
        'Provide a response to send to the pending prompt.\n\n' +
        'Example: `@vibeflow /respond Use JWT tokens with 15 minute expiry`\n\n',
      );
      if (pending.length > 0) {
        stream.markdown(`### Pending prompts (${pending.length})\n\n`);
        for (const p of pending) {
          stream.markdown(`- **${p.personaName}**: ${p.text}\n`);
        }
      }
      return;
    }

    // No pending prompts to respond to.
    if (pending.length === 0) {
      stream.markdown('No pending prompts. Nothing to respond to.\n');
      return;
    }

    // Exactly one pending — send straight through.
    if (pending.length === 1) {
      const target = pending[0];
      try {
        await this.promptNotifier.respondTo(target.id, responseText);
        stream.markdown(
          `✓ Response sent to **${target.personaName}**.\n\n` +
          `> ${target.text}\n\n` +
          `Your reply: ${responseText}\n`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stream.markdown(`**Error**: ${msg}\n`);
      }
      return;
    }

    // Multiple pending — can't disambiguate from chat alone. Show
    // the list and route through the existing quick-pick command,
    // which will prompt for selection and re-collect the response
    // via input box (the chat-typed text is lost in this branch
    // because vscode.commands.executeCommand can't pre-seed an input
    // box across the participant boundary).
    stream.markdown(
      `### ${pending.length} pending prompts — pick one to respond to\n\n`,
    );
    for (const p of pending) {
      stream.markdown(`- **${p.personaName}**: ${p.text}\n`);
    }
    stream.markdown(
      '\nUse the button below to pick the prompt; you\'ll be asked to ' +
      'retype the response (chat → quick-pick can\'t carry the text).\n\n',
    );
    stream.button({ command: 'vibeflow.respondToPrompt', title: 'Respond to Prompt' });
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
        '- `@vibeflow /create high-priority bug: login button not responding`\n' +
        '- `@vibeflow /create feature: User Dashboard`\n' +
        '- `@vibeflow /create todo: add date filter to reports table`\n\n' +
        'Add `low|medium|high` anywhere in the prompt to set priority (default: medium).\n',
      );
      return;
    }

    // Parse type, priority, and title out of the natural-language prompt.
    const parsed = parseCreatePrompt(prompt);

    try {
      if (parsed.itemType === 'feature') {
        await this.client.createFeature(project.projectId, parsed.title, parsed.priority);
        stream.markdown(
          `✓ Created **feature**: "${parsed.title}" (${parsed.priority}) in **${project.projectName}**.\n`,
        );
      } else if (parsed.itemType === 'issue') {
        await this.client.createIssue(project.projectId, parsed.title, parsed.priority, project.gitBranch);
        stream.markdown(
          `✓ Created **issue**: "${parsed.title}" (${parsed.priority}, branch ${project.gitBranch}) in **${project.projectName}**.\n`,
        );
      } else {
        // Todo needs a parent feature. Chat can't drive a Quick Pick;
        // ask the user to use the wizard if there's more than one
        // feature, otherwise pick the only one.
        const features = await this.client.listFeatures(project.projectId);
        if (features.length === 0) {
          stream.markdown(
            '**No features yet.** Todos live under features. Either create the feature first ' +
            '(`@vibeflow /create feature: ...`) or use the wizard:\n',
          );
          stream.button({ command: 'vibeflow.createWorkItem', title: 'Create Work Item' });
          return;
        }
        if (features.length > 1) {
          stream.markdown(
            `**${features.length} features available** — chat can't disambiguate. Use the wizard ` +
            'to pick the parent feature:\n',
          );
          stream.button({ command: 'vibeflow.createWorkItem', title: 'Create Work Item' });
          return;
        }
        const feature = features[0];
        await this.client.createTodo(feature.id, parsed.title, parsed.priority, project.gitBranch);
        stream.markdown(
          `✓ Created **todo**: "${parsed.title}" (${parsed.priority}) under feature **${feature.name}**.\n`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`**Error creating ${parsed.itemType}**: ${msg}\n`);
    }
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
      '- `/compliance` — open compliance findings\n' +
      '- `/summary` — work summary and metrics\n' +
      '- `/launch` — launch an agent session\n' +
      '- `/respond <text>` — respond to a pending agent prompt\n\n' +
      'Or ask me anything about the project.\n',
    );
  }
}
