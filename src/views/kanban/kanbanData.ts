import type { VibeFlowSwimlaneItem, VibeFlowSwimlaneResult } from '../../api/types.js';

/**
 * Eight kanban columns — one per backend status — matching the swimlane wire
 * shape and the axiomcloud web board. Dragging a card to a column moves it to
 * that column's `primary` status; `primary` is also the server-side
 * drag-target allowlist (ALLOWED_PRIMARY_STATUSES) below.
 *
 * Shared by both the standalone Kanban panel (KanbanPanel) and the dashboard
 * embed (DashboardPanel) so the two stay in lockstep.
 */
export const KANBAN_COLUMNS: Array<{
  key: string;
  label: string;
  /** Status set whose items appear in this column. */
  statuses: string[];
  /** Status assigned when an item is dragged INTO this column. */
  primary: string;
}> = [
  { key: 'in_review', label: 'In Review', statuses: ['in_review'], primary: 'in_review' },
  { key: 'needs_pm_input', label: 'Needs PM Input', statuses: ['needs_pm_input'], primary: 'needs_pm_input' },
  { key: 'needs_ux_input', label: 'Needs UX Input', statuses: ['needs_ux_input'], primary: 'needs_ux_input' },
  { key: 'planning', label: 'Planning', statuses: ['planning'], primary: 'planning' },
  { key: 'architecture_review_complete', label: 'Arch Review', statuses: ['architecture_review_complete'], primary: 'architecture_review_complete' },
  { key: 'ready_to_implement', label: 'Ready', statuses: ['ready_to_implement'], primary: 'ready_to_implement' },
  { key: 'implementing', label: 'In Progress', statuses: ['implementing'], primary: 'implementing' },
  { key: 'done', label: 'Done', statuses: ['done'], primary: 'done' },
];

/** Status set valid as a drag target — enforced on both kanban hosts. */
export const ALLOWED_PRIMARY_STATUSES = new Set(KANBAN_COLUMNS.map(c => c.primary));

/** Card payload sent to the webview — flattened from VibeFlowSwimlaneItem. */
export interface KanbanCard {
  type: 'todo' | 'issue';
  id: number;
  title: string;
  status: string;
  priority: string;
  featureName?: string;
  currentPersona?: string;
  securityReviewed: boolean;
  updatedAt: string;
}

/**
 * Flatten the 8-column swimlane payload into a flat card list scoped to one
 * project. Excludes `project` and `feature` rows (those don't belong on a
 * todo/issue kanban) and items missing required fields.
 */
export function flattenForProject(
  swimlane: VibeFlowSwimlaneResult,
  projectId: number,
): KanbanCard[] {
  const cards: KanbanCard[] = [];
  const buckets: VibeFlowSwimlaneItem[][] = [
    swimlane.in_review,
    swimlane.needs_pm_input,
    swimlane.needs_ux_input,
    swimlane.planning,
    swimlane.ready_to_implement,
    swimlane.architecture_review_complete,
    swimlane.implementing,
    swimlane.done,
  ];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) { continue; }
    for (const item of bucket) {
      if (item.project_id !== projectId) { continue; }
      if (item.type !== 'todo' && item.type !== 'issue') { continue; }
      cards.push({
        type: item.type,
        id: item.id,
        title: item.name,
        status: item.status,
        priority: item.priority ?? 'medium',
        featureName: item.feature_name,
        currentPersona: item.current_persona,
        securityReviewed: !!item.security_reviewed,
        updatedAt: item.updated_at,
      });
    }
  }
  return cards;
}
