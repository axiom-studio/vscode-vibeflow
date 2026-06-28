import * as vscode from 'vscode';
import type { VibeFlowClient } from '../../api/client.js';
import type { VibeFlowDocument, VibeFlowContext, VibeFlowReference } from '../../api/types.js';
import type { PollingCoordinator, Disposer } from '../../core/PollingCoordinator.js';

interface DocumentNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  collapsibleState: vscode.TreeItemCollapsibleState;
  children?: DocumentNode[];
  contextValue?: string;
  command?: vscode.Command;
}

const TYPE_CONFIG: { key: VibeFlowDocument['type']; label: string; icon: string }[] = [
  { key: 'prd', label: 'PRDs', icon: 'file-text' },
  { key: 'architecture', label: 'Architecture', icon: 'file-code' },
  { key: 'style_guide', label: 'Style Guides', icon: 'paintcan' },
  { key: 'design_system', label: 'Design System', icon: 'symbol-color' },
  { key: 'general', label: 'General', icon: 'file' },
];

/**
 * Documents TreeView — surfaces three classes of project content matching
 * the axiomcloud UI's left-rail layout:
 *
 *   1. **Documents** — typed (PRD, architecture, style guide, design system,
 *      general). Same shape as the existing tree.
 *   2. **Contexts (Memory)** — flat markdown notes. Rotation archives
 *      (rows where parent_context_id is set) are filtered out so only
 *      live roots surface, mirroring `VibeFlowContexts.jsx` treeGroups.
 *   3. **References (Confluence)** — read-only pointers to upstream
 *      Confluence pages, fetched via the `/projects/{id}/references`
 *      REST endpoint.
 *
 * Categories with no rows collapse to nothing instead of showing as
 * empty branches (parity with the prior behavior for Documents).
 */
export class DocumentsTreeProvider implements vscode.TreeDataProvider<DocumentNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<DocumentNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private client: VibeFlowClient | undefined;
  private projectId: number | undefined;
  private documents: VibeFlowDocument[] = [];
  private contexts: VibeFlowContext[] = [];
  private references: VibeFlowReference[] = [];
  private pollSub: Disposer | undefined;

  constructor(private readonly coordinator: PollingCoordinator) {}

  refresh(): void {
    this.fetchAndRefresh();
  }

  connect(client: VibeFlowClient, projectId: number): void {
    this.client = client;
    this.projectId = projectId;
    this.startPolling();
    this.fetchAndRefresh();
  }

  private startPolling(): void {
    this.stopPolling();
    const config = vscode.workspace.getConfiguration('vibeflow');
    const interval = config.get<number>('polling.interval', 30) * 1000;
    this.pollSub = this.coordinator.subscribe(interval, () => this.fetchAndRefresh());
  }

  private stopPolling(): void {
    this.pollSub?.dispose();
    this.pollSub = undefined;
  }

  private async fetchAndRefresh(): Promise<void> {
    if (!this.client || !this.projectId) {
      this._onDidChangeTreeData.fire();
      return;
    }

    // Fetch all three sources in parallel — partial failure leaves the
    // affected list stale rather than blanking the tree (matches the
    // pre-existing documents-only behavior).
    const [docsR, ctxR, refsR] = await Promise.allSettled([
      this.client.listDocuments(this.projectId),
      this.client.listContexts(this.projectId),
      this.client.listReferences(this.projectId),
    ]);
    if (docsR.status === 'fulfilled') { this.documents = docsR.value; }
    if (ctxR.status === 'fulfilled') { this.contexts = ctxR.value; }
    if (refsR.status === 'fulfilled') { this.references = refsR.value; }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DocumentNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, element.collapsibleState);
    item.id = element.id;
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.contextValue = element.contextValue;
    if (element.iconId) {
      item.iconPath = new vscode.ThemeIcon(element.iconId);
    }
    if (element.command) {
      item.command = element.command;
    }
    return item;
  }

  getChildren(element?: DocumentNode): DocumentNode[] {
    if (!element) {
      return this.buildRootTree();
    }
    return element.children ?? [];
  }

  private buildRootTree(): DocumentNode[] {
    const docCategories = this.buildDocumentCategories();
    const contextsNode = this.buildContextsNode();
    const referencesNode = this.buildReferencesNode();

    const roots: DocumentNode[] = [...docCategories];
    if (contextsNode) { roots.push(contextsNode); }
    if (referencesNode) { roots.push(referencesNode); }
    return roots;
  }

  private buildDocumentCategories(): DocumentNode[] {
    return TYPE_CONFIG.map(cat => {
      const docs = this.documents.filter(d => d.type === cat.key);
      return {
        id: `cat-${cat.key}`,
        label: cat.label,
        description: `${docs.length}`,
        iconId: cat.icon,
        collapsibleState: docs.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
        contextValue: 'docCategory',
        children: docs.map(d => ({
          id: `doc-${d.id}`,
          label: d.title,
          iconId: 'file',
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          contextValue: 'document',
          command: {
            command: 'vibeflow.openDocumentViewer',
            title: 'Open Document',
            arguments: [d.id, d.title],
          },
        })),
      };
    }).filter(cat => (cat.children?.length ?? 0) > 0 || this.documents.length === 0);
  }

  /**
   * Top-level "Contexts (Memory)" node. Filters to live roots (parent
   * context id is null) so rotation archives don't pad the count — those
   * are surfaced in the axiomcloud UI as nested archives, but the tree
   * here keeps it flat to avoid two layers of nesting under one branch.
   */
  private buildContextsNode(): DocumentNode | undefined {
    const liveContexts = this.contexts.filter(c => c.parent_context_id == null);
    if (liveContexts.length === 0 && this.contexts.length === 0) {
      // Hide the section entirely if nothing is loaded — matches the
      // collapse-empty behavior the document categories already use.
      return undefined;
    }
    return {
      id: 'cat-contexts',
      label: 'Contexts',
      description: `${liveContexts.length}`,
      tooltip: 'Memory: project notes the agents read and rotate.',
      iconId: 'book',
      collapsibleState: liveContexts.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
      contextValue: 'contextCategory',
      children: liveContexts.map(c => ({
        id: `ctx-${c.id}`,
        label: c.title,
        iconId: 'note',
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        contextValue: 'context',
        command: {
          command: 'vibeflow.openContextViewer',
          title: 'Open Context',
          arguments: [c.id, c.title],
        },
      })),
    };
  }

  /**
   * Top-level "References" node. Wire shape from
   * `axiomcloud/handlers/vibeflow_atlassian.go` (ListReferences). Each leaf
   * carries the page title as label, the space name as description, and a
   * fetch-error marker glyph in the description when Confluence sync
   * failed. Click → `openReferenceViewer` (read-only — the canonical page
   * is in Confluence).
   */
  private buildReferencesNode(): DocumentNode | undefined {
    if (this.references.length === 0) { return undefined; }
    return {
      id: 'cat-references',
      label: 'References',
      description: `${this.references.length}`,
      tooltip: 'Confluence pages imported as read-only references.',
      iconId: 'link-external',
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      contextValue: 'referenceCategory',
      children: this.references.map(r => {
        const space = r.confluence_space_name || r.confluence_space_key;
        const version = r.last_page_version ? ` · v${r.last_page_version}` : '';
        const err = r.fetch_error ? ' · sync error' : '';
        return {
          id: `ref-${r.id}`,
          label: r.confluence_page_title,
          description: `${space}${version}${err}`,
          tooltip: r.fetch_error || r.confluence_page_url,
          iconId: r.fetch_error ? 'warning' : 'globe',
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          contextValue: 'reference',
          command: {
            command: 'vibeflow.openReferenceViewer',
            title: 'Open Reference',
            arguments: [r.id, r.confluence_page_title, r.confluence_page_url],
          },
        };
      }),
    };
  }

  dispose(): void {
    this.stopPolling();
    this._onDidChangeTreeData.dispose();
  }
}
