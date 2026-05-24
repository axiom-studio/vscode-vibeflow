// Codicon per project status — mirrors FEATURE_STATUS_ICON in
// views/projectItems/ProjectItemsTreeProvider.ts so the picker reads with
// the same iconography users see in the sidebar. QuickPick descriptions
// support the `$(codicon-name)` inline syntax; uppercasing + space
// substitution gives the trailing token a "tag" feel without HTML/CSS.
export const PROJECT_STATUS_CODICON: Record<string, string> = {
  in_review: 'search',
  needs_pm_input: 'search',
  needs_ux_input: 'search',
  planning: 'zap',
  ready_to_implement: 'checklist',
  architecture_review_complete: 'checklist',
  implementing: 'zap',
  done: 'check',
  archived: 'archive',
  rejected: 'archive',
};

export function formatProjectStatusTag(status: string): string {
  const icon = PROJECT_STATUS_CODICON[status] ?? 'tag';
  const label = (status || 'unknown').replace(/_/g, ' ').toUpperCase();
  return `$(${icon}) ${label}`;
}
