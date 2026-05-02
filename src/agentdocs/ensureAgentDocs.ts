import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Map provider key → agent doc filename.
 * Mirrors CLI agentdocs.go providerDocFile map.
 */
const PROVIDER_DOC_FILE: Record<string, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  cursor: 'AGENTS.md', // Cursor uses the same file as codex
  gemini: 'GEMINI.md',
};

/**
 * Ensure all agent-specific markdown files exist in workDir.
 * Mirrors CLI EnsureAllAgentDocs — writes the vibeflow session rules
 * so the agent knows to call session_init when it starts.
 *
 * Returns the list of filenames that were created or updated.
 */
export function ensureAllAgentDocs(
  extensionUri: vscode.Uri,
  workDir: string,
): string[] {
  const updated: string[] = [];
  const seenFile = new Set<string>();

  for (const providerKey of ['claude', 'codex', 'gemini', 'cursor']) {
    const docName = PROVIDER_DOC_FILE[providerKey];
    if (!docName || seenFile.has(docName)) { continue; }
    seenFile.add(docName);

    const written = ensureAgentDoc(extensionUri, workDir, docName);
    if (written) {
      updated.push(docName);
    }
  }
  return updated;
}

/**
 * Ensure a single agent doc file exists in workDir with the bundled content.
 * If the file doesn't exist, writes the full template.
 * If it exists, leaves it alone (user may have customized it).
 */
function ensureAgentDoc(
  extensionUri: vscode.Uri,
  workDir: string,
  docName: string,
): boolean {
  const destPath = path.join(workDir, docName);
  if (fs.existsSync(destPath)) {
    return false; // Don't overwrite existing files
  }

  const templatePath = path.join(
    extensionUri.fsPath,
    'media',
    'agentdocs',
    docName,
  );

  try {
    const template = fs.readFileSync(templatePath, 'utf-8');
    fs.writeFileSync(destPath, template, 'utf-8');
    return true;
  } catch {
    return false;
  }
}
