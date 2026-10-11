import { describe, expect, it } from 'vitest';
import type { VibeFlowSession } from '../../api/types.js';
import { groupFleetByProject, liveCliFleet, parseCliSessions, type CliSessionMeta } from './fleetModel.js';

function server(sessionId: string, projectId: number): VibeFlowSession {
  return {
    id: 1, session_id: sessionId, project_id: projectId, working_directory: '/w', git_branch: 'main',
    agent_type: 'claude', agent_model: 'm', persona_key: 'developer', created_at: '', active: true,
  };
}

function local(name: string, project: string, projectId?: number, vibeflowSessionId?: string): CliSessionMeta {
  return {
    name, tmux_session: `vibeflow_${name}`, provider: 'claude', project, branch: 'main', working_dir: '/w',
    ...(projectId ? { project_id: projectId } : {}),
    ...(vibeflowSessionId ? { vibeflow_session_id: vibeflowSessionId } : {}),
  };
}

describe('parseCliSessions', () => {
  it('reads the CLI store (a JSON array of SessionMeta)', () => {
    const raw = JSON.stringify([{ ...local('dev-1', 'vscode-vibeflow', 28), extra_cli_field: true }]);
    expect(parseCliSessions(raw).map(m => m.name)).toEqual(['dev-1']);
  });

  it('yields nothing for a missing, partial or foreign file instead of throwing', () => {
    expect(parseCliSessions('')).toEqual([]);
    expect(parseCliSessions('[{"name": "x"')).toEqual([]);
    expect(parseCliSessions('{"sessions": []}')).toEqual([]);
    expect(parseCliSessions('[{"name": 3}, null, "x"]')).toEqual([]);
  });
});

describe('groupFleetByProject', () => {
  const names = new Map([[28, 'vscode-vibeflow'], [7, 'axiomcloud']]);

  it('groups every project, current first, then by name', () => {
    const groups = groupFleetByProject([server('a', 7), server('b', 28), server('c', 99)], [], 28, names);
    expect(groups.map(g => [g.projectName, g.current])).toEqual([
      ['vscode-vibeflow', true],
      ['axiomcloud', false],
      ['Project #99', false],
    ]);
  });

  it('adds CLI sessions the server has not seen, and drops ones it has', () => {
    const groups = groupFleetByProject(
      [server('session-known', 28)],
      [local('dev-known', 'vscode-vibeflow', 28, 'session-known'), local('dev-new', 'vscode-vibeflow', 28)],
      28,
      names,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map(s => s.session_id)).toEqual(['session-known']);
    expect(groups[0].localOnly.map(m => m.name)).toEqual(['dev-new']);
  });

  it('joins a CLI session with only a project name to that project\'s group', () => {
    const groups = groupFleetByProject([server('a', 7)], [local('dev-old', 'AxiomCloud')], 28, names);
    expect(groups).toHaveLength(1);
    expect(groups[0].localOnly.map(m => m.name)).toEqual(['dev-old']);
  });

  // #5750: a first launch has no sessions yet but needs a parent group.
  it('seeds the current project group for pending launches', () => {
    expect(groupFleetByProject([], [], 28, names).length).toBe(0);
    expect(groupFleetByProject([], [], 28, names, true).map(g => [g.projectName, g.current])).toEqual([['vscode-vibeflow', true]]);
  });

  it('groups a CLI session with no project id under its project name', () => {
    const groups = groupFleetByProject([], [local('qa-1', 'old-project')], 28, names);
    expect(groups.map(g => [g.key, g.projectName, g.current])).toEqual([['name:old-project', 'old-project', false]]);
  });
});

describe('liveCliFleet', () => {
  it('lists only CLI sessions whose tmux session is alive, as the CLI does', () => {
    const a = local('session-a', 'p1', 1);
    const b = local('session-b', 'p1', 1);
    const fleet = liveCliFleet([], [a, b], new Set(['vibeflow_session-a']));
    expect(fleet.localOnly).toEqual([a]);
  });

  it('uses the server record for a live CLI session, matched by id or name', () => {
    const byName = server('session-a', 1);
    const byId = server('vf-2', 2);
    const fleet = liveCliFleet(
      [byName, byId, server('session-gone', 1)],
      [local('session-a', 'p1', 1), local('session-x', 'p2', 2, 'vf-2')],
      new Set(['vibeflow_session-a', 'vibeflow_session-x']),
    );
    // A server session with no live CLI pane is not part of the fleet.
    expect(fleet.sessions).toEqual([byName, byId]);
    expect(fleet.localOnly).toEqual([]);
  });
});
