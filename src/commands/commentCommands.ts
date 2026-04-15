import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { CreateCommentInput, VibeFlowSession } from '../api/types.js';

const PERSONAS = [
  { key: 'developer', label: 'Developer', description: 'Code implementation' },
  { key: 'architect', label: 'Architect', description: 'System design' },
  { key: 'principal_engineer', label: 'Principal Engineer', description: 'Senior hands-on coding' },
  { key: 'security_lead', label: 'Security Lead', description: 'Security review' },
  { key: 'qa_lead', label: 'QA Lead', description: 'Quality assurance' },
  { key: 'product_manager', label: 'Product Manager', description: 'Requirements & PRDs' },
  { key: 'project_manager', label: 'Project Manager', description: 'Workflow tracking' },
  { key: 'ux_designer', label: 'UX Designer', description: 'User experience' },
  { key: 'customer', label: 'Customer', description: 'Feature requests' },
] as const;

interface Section {
  heading: string;
  lines: string[];
}

/**
 * Build the summary prompt text from draft comments.
 * Matches axiomcloud DocumentPopoutModal lines 226-262 exactly:
 *
 *   Review feedback for "{documentTitle}":
 *
 *   ### {section_heading}
 *   > {comment}
 *
 *   ### {next section}
 *   > {next comment}
 *
 * Empty drafts are skipped. Sections with empty heading use "Introduction".
 */
export function buildPromptText(
  documentTitle: string,
  drafts: Record<number, string>,
  sections: Section[],
): string {
  const summaryLines: string[] = [`Review feedback for "${documentTitle}":\n`];

  sections.forEach((section, idx) => {
    const draft = drafts[idx];
    if (draft && draft.trim()) {
      const heading = section.heading || 'Introduction';
      summaryLines.push(`### ${heading}`);
      summaryLines.push(`> ${draft.trim()}\n`);
    }
  });

  return summaryLines.join('\n');
}

/**
 * Extract non-empty drafts as CreateCommentInput payloads.
 * Matches axiomcloud's batch create flow.
 */
export function draftsToCreatePayloads(
  drafts: Record<number, string>,
  sections: Section[],
  entityType: 'document' | 'context',
  entityId: number,
  projectId: number,
): CreateCommentInput[] {
  const payloads: CreateCommentInput[] = [];
  sections.forEach((section, idx) => {
    const draft = drafts[idx];
    if (draft && draft.trim()) {
      payloads.push({
        entityType,
        entityId,
        projectId,
        sectionHeading: section.heading || 'Introduction',
        content: draft.trim(),
      });
    }
  });
  return payloads;
}

/**
 * Batch-save all drafts and return the created comments.
 * Throws on first failure (matches axiomcloud behavior).
 */
export async function saveDrafts(
  client: VibeFlowClient,
  drafts: Record<number, string>,
  sections: Section[],
  entityType: 'document' | 'context',
  entityId: number,
  projectId: number,
) {
  const payloads = draftsToCreatePayloads(drafts, sections, entityType, entityId, projectId);
  return Promise.all(payloads.map(p => client.createComment(p)));
}

/**
 * Show a Quick Pick of personas with active-session highlighting.
 * Returns the picked persona key, '_save_only' for save without notification,
 * or undefined if cancelled.
 */
export async function pickPersonaForNotification(
  sessions: VibeFlowSession[],
): Promise<string | undefined> {
  // Group sessions by persona to know which have active sessions
  const activeByPersona = new Map<string, VibeFlowSession>();
  for (const s of sessions) {
    if (s.active && !s.stale) {
      if (!activeByPersona.has(s.persona_key)) {
        activeByPersona.set(s.persona_key, s);
      }
    }
  }

  const items: (vscode.QuickPickItem & { value: string })[] = [
    {
      label: '$(save) Save only',
      description: "don't notify anyone",
      value: '_save_only',
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator, value: '' },
  ];

  for (const p of PERSONAS) {
    const active = activeByPersona.get(p.key);
    items.push({
      label: active ? `$(pulse) ${p.label}` : `$(circle-outline) ${p.label}`,
      description: active ? `active on ${active.git_branch}` : 'no active session',
      detail: p.description,
      value: p.key,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Save comments — notify a persona?',
    title: 'VibeFlow: Save Comments',
  });

  return picked?.value || undefined;
}

/**
 * Full save-and-notify flow:
 * 1. Batch-create all non-empty drafts
 * 2. If a persona was picked, build prompt text and call prompt_user
 *    against the first active session for that persona
 */
export async function saveAndNotify(
  client: VibeFlowClient,
  projectId: number,
  documentTitle: string,
  entityType: 'document' | 'context',
  entityId: number,
  drafts: Record<number, string>,
  sections: { heading: string; lines: string[] }[],
): Promise<{ saved: number; notified: string | undefined }> {
  // 1. Load active sessions for persona picker
  let sessions: VibeFlowSession[] = [];
  try {
    sessions = await client.listSessions(projectId);
  } catch {
    // Non-fatal — picker will just show all personas as inactive
  }

  // 2. Ask user which persona to notify
  const pickedPersona = await pickPersonaForNotification(sessions);
  if (!pickedPersona) {
    return { saved: 0, notified: undefined };
  }

  // 3. Save all drafts
  const created = await saveDrafts(client, drafts, sections, entityType, entityId, projectId);

  // 4. Notify if a persona was picked (not _save_only)
  if (pickedPersona !== '_save_only') {
    const activeSession = sessions.find(
      s => s.persona_key === pickedPersona && s.active && !s.stale,
    );

    if (!activeSession) {
      vscode.window.showWarningMessage(
        `VibeFlow: No active ${pickedPersona} session. Comments saved but not notified.`,
      );
      return { saved: created.length, notified: undefined };
    }

    const promptText = buildPromptText(documentTitle, drafts, sections);
    try {
      await client.promptUser(projectId, activeSession.session_id, promptText);
      vscode.window.showInformationMessage(
        `VibeFlow: Saved ${created.length} comment(s) and notified ${pickedPersona}`,
      );
      return { saved: created.length, notified: pickedPersona };
    } catch (err) {
      vscode.window.showErrorMessage(
        `VibeFlow: Saved comments but failed to notify ${pickedPersona} — ${err}`,
      );
      return { saved: created.length, notified: undefined };
    }
  }

  vscode.window.showInformationMessage(`VibeFlow: Saved ${created.length} comment(s)`);
  return { saved: created.length, notified: undefined };
}

/**
 * Delete a comment with error surfacing.
 * 403 → "Cannot delete other users' comments"
 * 404 → "Comment not found"
 */
export async function deleteCommentWithErrorHandling(
  client: VibeFlowClient,
  commentId: number,
): Promise<boolean> {
  try {
    await client.deleteComment(commentId);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('403')) {
      vscode.window.showErrorMessage('VibeFlow: Cannot delete other users\' comments');
    } else if (message.includes('404')) {
      vscode.window.showErrorMessage('VibeFlow: Comment not found');
    } else {
      vscode.window.showErrorMessage(`VibeFlow: Failed to delete comment — ${message}`);
    }
    return false;
  }
}
