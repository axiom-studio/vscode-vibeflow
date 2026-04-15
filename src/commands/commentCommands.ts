import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { CreateCommentInput } from '../api/types.js';

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
