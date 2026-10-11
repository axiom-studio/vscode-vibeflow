import type { VibeFlowSession } from '../../api/types.js';

/**
 * One entry of the VibeFlow CLI's session store, `<cli root>/sessions.json`
 * (vibeflow-cli internal/vibeflowcli/store.go SessionMeta). Only the fields
 * Agent Fleet reads; the CLI writes more.
 */
export interface CliSessionMeta {
  name: string;
  tmux_session: string;
  provider: string;
  project: string;
  project_id?: number;
  persona?: string;
  branch: string;
  working_dir: string;
  vibeflow_session_id?: string;
}

/**
 * Parse sessions.json leniently: the file belongs to the CLI and may be
 * missing, mid-write or from another CLI version, so anything unexpected
 * yields no local rows rather than an error.
 */
export function parseCliSessions(raw: string): CliSessionMeta[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value)) { return []; }
  return value.filter((m): m is CliSessionMeta =>
    !!m && typeof m === 'object'
    && typeof (m as CliSessionMeta).name === 'string'
    && typeof (m as CliSessionMeta).tmux_session === 'string');
}

export interface FleetProjectGroup {
  /** Stable grouping key: `id:<projectId>` or, for CLI rows without an id, `name:<project>`. */
  key: string;
  projectId: number | undefined;
  projectName: string;
  current: boolean;
  /** Sessions the server knows about. */
  sessions: VibeFlowSession[];
  /** CLI sessions the server does not (not registered yet, or stopped). */
  localOnly: CliSessionMeta[];
}

/**
 * Agent Fleet across all projects (#4032, design doc #627 §2.3): server
 * sessions plus the CLI's local sessions the server has not seen, grouped by
 * project. The current project comes first, then the rest by name.
 * O(n) in sessions + local entries.
 */
export function groupFleetByProject(
  serverSessions: readonly VibeFlowSession[],
  cliSessions: readonly CliSessionMeta[],
  currentProjectId: number | undefined,
  projectNames: ReadonlyMap<number, string>,
): FleetProjectGroup[] {
  const groups = new Map<string, FleetProjectGroup>();
  const group = (projectId: number | undefined, fallbackName: string): FleetProjectGroup => {
    const key = projectId ? `id:${projectId}` : `name:${fallbackName}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        projectId: projectId || undefined,
        projectName: (projectId && projectNames.get(projectId)) || fallbackName || `Project #${projectId}`,
        current: !!projectId && projectId === currentProjectId,
        sessions: [],
        localOnly: [],
      };
      groups.set(key, g);
    }
    return g;
  };

  // Older CLI entries carry only the project name; map it to the project id
  // when exactly one project has that name, so they join that project's group.
  const idByName = new Map<string, number | undefined>();
  for (const [id, name] of projectNames) {
    const k = name.toLowerCase();
    idByName.set(k, idByName.has(k) ? undefined : id);
  }

  const known = new Set(serverSessions.map(s => s.session_id));
  for (const s of serverSessions) {
    group(s.project_id, `Project #${s.project_id}`).sessions.push(s);
  }
  for (const m of cliSessions) {
    if (m.vibeflow_session_id && known.has(m.vibeflow_session_id)) { continue; }
    const projectId = m.project_id || (m.project ? idByName.get(m.project.toLowerCase()) : undefined);
    group(projectId, m.project || 'Unknown project').localOnly.push(m);
  }

  return [...groups.values()].sort((a, b) =>
    Number(b.current) - Number(a.current) || a.projectName.localeCompare(b.projectName));
}
