import * as vscode from 'vscode';
import type { VibeFlowClient } from '../api/client.js';
import type { ProjectDetector } from '../project/ProjectDetector.js';
import type { DocumentsTreeProvider } from '../views/documents/DocumentsTreeProvider.js';
import type { VibeFlowDocument } from '../api/types.js';

/**
 * Categories accepted by the `create_document` MCP tool. Order mirrors the
 * Documents tree categories so the picker reads top-down the way the user
 * sees them.
 */
const DOC_TYPES: { label: string; value: VibeFlowDocument['type']; description: string }[] = [
  { label: '$(file-text) PRD', value: 'prd', description: 'Product requirements doc' },
  { label: '$(file-code) Architecture', value: 'architecture', description: 'System / module design' },
  { label: '$(paintcan) Style Guide', value: 'style_guide', description: 'Coding or visual style guide' },
  { label: '$(symbol-color) Design System', value: 'design_system', description: 'Component / token catalog' },
  { label: '$(file) General', value: 'general', description: 'Anything else' },
];

/**
 * Multi-step Quick Pick → InputBox flow for creating a new document.
 * Backend's create_document tool wants title + content; we leave content
 * blank by default so the user can fill it in by editing the doc afterward.
 */
export async function createDocument(
  client: VibeFlowClient,
  detector: ProjectDetector,
  documentsProvider: DocumentsTreeProvider,
): Promise<void> {
  const project = detector.getCachedProject();
  if (!project) {
    vscode.window.showErrorMessage('VibeFlow: No project detected.');
    return;
  }

  if (!client.isAuthenticated()) {
    vscode.window.showErrorMessage('VibeFlow: Not logged in.');
    return;
  }

  const docType = await vscode.window.showQuickPick(DOC_TYPES, {
    placeHolder: 'Document type',
    title: 'VibeFlow: Create Document (1/2)',
  });
  if (!docType) { return; }

  const title = await vscode.window.showInputBox({
    prompt: `Title for the new ${docType.value.replace('_', ' ')}`,
    title: 'VibeFlow: Create Document (2/2)',
    placeHolder: 'e.g., Auth service architecture',
    ignoreFocusOut: true,
  });
  if (!title?.trim()) { return; }

  try {
    await client.createDocument({
      projectId: project.projectId,
      title: title.trim(),
      content: '',
      type: docType.value,
    });
    vscode.window.showInformationMessage(`VibeFlow: Created ${docType.value} "${title.trim()}"`);
    documentsProvider.refresh();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`VibeFlow: Failed to create document — ${msg}`);
  }
}
