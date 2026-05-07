import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Position,
  MarkerType,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getVsCodeApi } from '../vscodeApi';
import type { DashboardClientMessage, DashboardHostMessage } from '../../../src/core/webviewMessages';

const vscode = getVsCodeApi() as { postMessage: (msg: DashboardClientMessage) => void };

type PersonaStatus = 'active' | 'stale' | 'inactive';

interface BranchReviewItem {
  type: 'todo' | 'issue';
  id: number;
  title: string;
  security: 'PASS' | 'PENDING';
  qa: 'PASS' | 'PENDING';
  open_findings: number;
}

interface BranchReview {
  branch: string;
  total_items: number;
  message?: string;
  overall_security?: 'PASS' | 'PENDING';
  overall_qa?: 'PASS' | 'PENDING';
  security_passed?: number;
  qa_passed?: number;
  open_findings?: number;
  total_commits?: number;
  total_lines?: string;
  items?: BranchReviewItem[];
}

interface DashboardSnapshot {
  projectId: number;
  projectName: string;
  branch: string;
  generatedAt: string;
  personaStatus: Record<string, PersonaStatus>;
  // null = no status-driven intake (project_manager tracker, customer input);
  // numbers are item counts pending action by that persona.
  personaQueues: Record<string, number | null>;
  sessions: { active: number; stale: number; total: number };
  todos: { done: number; in_progress: number; ready: number; planning: number; in_review: number };
  issues: { done: number; open: number };
  workSummary: { total_commits: number; lines_added: number; lines_deleted: number; total_seconds: number } | undefined;
  branchReview: BranchReview | undefined;
  findings: { critical: number; high: number; medium: number; low: number; informational: number; total_open: number };
  errors: string[];
}

const PERSONA_DISPLAY: Record<string, string> = {
  developer: 'Developer',
  architect: 'Architect',
  principal_engineer: 'Principal Eng',
  security_lead: 'Security',
  qa_lead: 'QA Lead',
  product_manager: 'Product Mgr',
  project_manager: 'Project Mgr',
  ux_designer: 'UX Designer',
  customer: 'Customer',
};

/**
 * Code agents share a single "git-modifying" slot per branch — only one of
 * {Architect, Developer, Principal Engineer} can run on a branch at a time,
 * enforced by GitModifyingPersonas in axiomcloud/database/vibeflow_models.go
 * and mirrored in vibeflow-cli/internal/vibeflowcli/tui_wizard.go:codeAgentKeys.
 * Advisory personas (qa_lead, security_lead, product_manager, etc.) have no
 * such limit — multiple can run alongside a code agent on the same branch.
 *
 * The diagram surfaces this rule two ways:
 *   1. The three code agents are clustered horizontally between PM and
 *      Security on the top row, signalling they occupy one shared role.
 *   2. Each code-agent node carries a `1/branch` badge.
 */
const CODE_AGENT_KEYS = new Set(['architect', 'developer', 'principal_engineer']);

/**
 * Topology layout — left-to-right pipeline. The code-agent cluster
 * (architect/developer/principal_engineer) is stacked **vertically**
 * in column 3 so it reads as a single shared slot rather than three
 * sequential boxes. Inputs feed PM from the left column. Project
 * Manager is a standalone observer (no status routing) parked above
 * the QA Lead column.
 *
 * Coordinates are tuned for a ~200px node width with ~120px gaps so
 * smoothstep edges have room to corner without colliding with nodes.
 */
const PERSONA_POSITIONS: Record<string, { x: number; y: number }> = {
  customer:           { x: 0,   y: 60  },
  ux_designer:        { x: 0,   y: 220 },
  product_manager:    { x: 220, y: 140 },
  architect:          { x: 460, y: 0   },
  developer:          { x: 460, y: 140 },
  principal_engineer: { x: 460, y: 280 },
  security_lead:      { x: 700, y: 140 },
  qa_lead:            { x: 920, y: 140 },
  project_manager:    { x: 920, y: 0   },
};

/**
 * Per-node default handle positions. Most of the pipeline flows
 * left-to-right, so the default is `Right` source / `Left` target.
 * Customer and UX feed up-and-to-the-right into PM; setting their
 * source to `Right` keeps edges tidy because PM is to their right
 * AND below/above (smoothstep handles the dogleg cleanly).
 */
const DEFAULT_SOURCE_POSITION = Position.Right;
const DEFAULT_TARGET_POSITION = Position.Left;

/**
 * Persona handoffs derived from the status-to-persona table in
 * personas.md §"Work Item Routing":
 *   in_review → planning → ready_to_implement → architecture_review_complete
 *     → implementing → done → security_reviewed → qa_verified
 *
 * Edge semantics:
 *   - Solid: status-driven handoff in the main pipeline.
 *   - Dashed: optional/alternative path (ad-hoc inputs, the PE alternative).
 *
 * Project Manager is a tracker and is not in the status-routing table, so it
 * has no edges — it surfaces in the diagram as a standalone status node.
 */
const PERSONA_EDGES: Array<{ id: string; source: string; target: string; dashed?: boolean }> = [
  // Inputs into requirements (ad-hoc, not status-driven).
  { id: 'cust-pm',  source: 'customer',           target: 'product_manager',    dashed: true },
  { id: 'ux-pm',    source: 'ux_designer',        target: 'product_manager',    dashed: true },
  // Forward pipeline.
  { id: 'pm-arch',  source: 'product_manager',    target: 'architect' },
  { id: 'arch-dev', source: 'architect',          target: 'developer' },
  // Principal Engineer alternative — picks up at architecture_review_complete
  // OR ready_to_implement, replacing Developer+Architect on the branch.
  { id: 'arch-pe',  source: 'architect',          target: 'principal_engineer', dashed: true },
  // Both implementer paths feed the post-done review pipeline.
  { id: 'dev-sec',  source: 'developer',          target: 'security_lead' },
  { id: 'pe-sec',   source: 'principal_engineer', target: 'security_lead',      dashed: true },
  // Security gate runs first — QA only picks up where security_reviewed=true.
  { id: 'sec-qa',   source: 'security_lead',      target: 'qa_lead' },
];

/**
 * Hover-text shown on each persona's queue badge. Explains *which* statuses
 * count toward the number so users don't have to cross-reference the docs.
 * Code agents share one tooltip — the queue is shared across the cluster.
 */
const QUEUE_TOOLTIPS: Record<string, string> = {
  product_manager:    'Items in `in_review` waiting for PM triage.',
  architect:          'Shared code-agent queue: `planning` + `ready_to_implement` + `architecture_review_complete`. Only one of Architect/Developer/Principal Engineer runs per branch.',
  developer:          'Shared code-agent queue: `planning` + `ready_to_implement` + `architecture_review_complete`. Only one of Architect/Developer/Principal Engineer runs per branch.',
  principal_engineer: 'Shared code-agent queue: `planning` + `ready_to_implement` + `architecture_review_complete`. Only one of Architect/Developer/Principal Engineer runs per branch.',
  security_lead:      'Items in `done` where security_reviewed=false.',
  qa_lead:            'Items in `done` where security_reviewed=true. Upper bound — swimlane wire shape doesn\'t expose qa_verified yet, so already-verified items are still counted.',
  ux_designer:        'Items in `needs_ux_input`.',
};

const STATUS_COLOR: Record<PersonaStatus, string> = {
  active: 'var(--feed-success)',
  stale: 'var(--feed-warning)',
  inactive: 'var(--feed-muted)',
};

interface DashboardState {
  snapshot: DashboardSnapshot | undefined;
  loading: boolean;
  error: string | undefined;
}

export function DashboardView() {
  const [state, setState] = useState<DashboardState>({ snapshot: undefined, loading: true, error: undefined });

  // Mount: ask host for data + start polling.
  useEffect(() => {
    vscode.postMessage({ type: 'dashboardLoad' });
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent<DashboardHostMessage>) {
      const msg = event.data;
      if (msg?.type === 'dashboardData' && msg.payload) {
        setState({ snapshot: msg.payload as DashboardSnapshot, loading: false, error: undefined });
      } else if (msg?.type === 'dashboardError') {
        setState(s => ({ ...s, loading: false, error: msg.payload.message }));
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const refresh = useCallback(() => {
    setState(s => ({ ...s, loading: true }));
    vscode.postMessage({ type: 'dashboardRefresh' });
  }, []);

  const focusPersona = useCallback((personaKey: string) => {
    vscode.postMessage({ type: 'dashboardFocusPersona', payload: { personaKey } });
  }, []);

  const onNodeClick = useCallback((_evt: unknown, node: Node) => {
    focusPersona(node.id);
  }, [focusPersona]);

  const personaStatus = state.snapshot?.personaStatus ?? {};
  const personaQueues = state.snapshot?.personaQueues ?? {};
  const nodes: Node[] = useMemo(
    () => Object.keys(PERSONA_DISPLAY).map(key => {
      const status = personaStatus[key] ?? 'inactive';
      const isCodeAgent = CODE_AGENT_KEYS.has(key);
      const queue = personaQueues[key];
      return {
        id: key,
        position: PERSONA_POSITIONS[key] ?? { x: 0, y: 0 },
        // Explicit handle positions stop edges from picking arbitrary
        // sides and looping (which is why the previous render had
        // edges cutting through node interiors).
        sourcePosition: DEFAULT_SOURCE_POSITION,
        targetPosition: DEFAULT_TARGET_POSITION,
        data: {
          label: (
            <PersonaNodeLabel
              name={PERSONA_DISPLAY[key]}
              status={status}
              isCodeAgent={isCodeAgent}
              queue={queue === undefined ? null : queue}
              queueTooltip={QUEUE_TOOLTIPS[key]}
            />
          ),
        },
        style: nodeStyle(status, isCodeAgent),
      };
    }),
    [personaStatus, personaQueues],
  );

  const edges: Edge[] = useMemo(() => PERSONA_EDGES.map(e => {
    const isActive = personaStatus[e.source] === 'active' || personaStatus[e.target] === 'active';
    // Solid edges in the muted-foreground color stand off the dark
    // background; dashed (optional) edges drop opacity further to
    // visually de-emphasize them. Active edges get a brighter stroke
    // and the ReactFlow `animated` flow indicator.
    const stroke = isActive
      ? 'var(--feed-link)'
      : (e.dashed ? 'var(--feed-muted)' : 'var(--feed-fg)');
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      // Smoothstep gives clean orthogonal corners that respect the
      // explicit handle positions, instead of bezier curves that
      // arc across other nodes.
      type: 'smoothstep',
      animated: isActive,
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
      style: {
        stroke,
        strokeWidth: isActive ? 2 : 1.5,
        opacity: e.dashed && !isActive ? 0.5 : 1,
        ...(e.dashed ? { strokeDasharray: '4,4' } : {}),
      },
    };
  }), [personaStatus]);

  return (
    <div style={{ width: '100%', height: '100vh', background: 'var(--feed-bg)', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      <Header
        snapshot={state.snapshot}
        loading={state.loading}
        onRefresh={refresh}
      />

      {state.error && (
        <Banner kind="error" message={state.error} />
      )}
      {state.snapshot && state.snapshot.errors.length > 0 && (
        <Banner kind="warning" message={`Partial data: ${state.snapshot.errors.join(' · ')}`} />
      )}

      {/* Topology */}
      <Section
        title="Agent Topology"
        subtitle="Click a persona to focus its terminal · Architect, Developer, and Principal Engineer share one code-agent slot per branch — advisory personas have no such limit."
      >
        <div style={{ height: 460, width: '100%', borderRadius: 6, border: '1px solid var(--feed-border)', background: 'var(--vscode-editor-background)' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodeClick={onNodeClick}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            zoomOnScroll={false}
            panOnDrag={true}
            // Slightly higher minimum spacing so smoothstep edges have
            // room to corner around the code-agent cluster without
            // touching the box edges.
            defaultEdgeOptions={{ type: 'smoothstep' }}
          >
            <Background variant={BackgroundVariant.Dots} color="var(--feed-border)" gap={18} size={1.2} />
          </ReactFlow>
        </div>
      </Section>

      {/* Summary cards */}
      <Section title="Summary">
        <SummaryGrid snapshot={state.snapshot} loading={state.loading} />
      </Section>

      {/* Compliance + branch readiness */}
      <Section title="Governance">
        <GovernanceGrid snapshot={state.snapshot} loading={state.loading} />
      </Section>

      <div style={{ flex: 1 }} />
    </div>
  );
}

function PersonaNodeLabel({ name, status, isCodeAgent, queue, queueTooltip }: {
  name: string;
  status: PersonaStatus;
  isCodeAgent: boolean;
  queue: number | null;
  queueTooltip: string | undefined;
}) {
  // Two-row label keeps the title on one line and pushes badges below,
  // so the box sizes consistently regardless of which badges are
  // present. Previously badges crowded the title and Principal Engineer
  // wrapped to two lines.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: STATUS_COLOR[status],
          flexShrink: 0,
          boxShadow: status === 'active' ? `0 0 0 3px ${STATUS_COLOR[status]}33` : 'none',
        }} />
        <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{name}</span>
      </div>
      {(isCodeAgent || queueTooltip !== undefined) && (
        <div style={{ display: 'flex', gap: 5, alignItems: 'center', paddingLeft: 15 }}>
          {isCodeAgent && (
            <span
              title="One code agent per branch — Architect, Developer, and Principal Engineer share this slot."
              style={{
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: 0.3,
                padding: '1px 6px',
                borderRadius: 3,
                background: 'var(--vscode-charts-orange, #d18616)',
                color: 'var(--vscode-editor-background)',
                flexShrink: 0,
                lineHeight: 1.5,
              }}
            >
              1/branch
            </span>
          )}
          {queueTooltip !== undefined && (
            <span
              title={queueTooltip}
              style={{
                fontSize: 10,
                fontWeight: 600,
                minWidth: 16,
                padding: '1px 6px',
                borderRadius: 9,
                textAlign: 'center',
                background: queue && queue > 0
                  ? 'var(--vscode-charts-blue, #569cd6)'
                  : 'transparent',
                color: queue && queue > 0
                  ? 'var(--vscode-editor-background)'
                  : 'var(--feed-muted)',
                border: queue && queue > 0
                  ? 'none'
                  : '1px solid var(--feed-border)',
                flexShrink: 0,
                lineHeight: 1.4,
              }}
            >
              {queue === null ? '—' : queue}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function nodeStyle(status: PersonaStatus, isCodeAgent: boolean): React.CSSProperties {
  // Inactive nodes used to inherit `var(--feed-muted)` which made them
  // disappear into the dark background. Use a stronger neutral so the
  // box outline is always readable; status colors only kick in for
  // active/stale to draw the eye to live activity.
  const inactiveBorder = 'var(--vscode-charts-foreground, var(--feed-fg))';
  const color = status === 'inactive' ? inactiveBorder : STATUS_COLOR[status];
  const codeAgentTint = isCodeAgent
    ? 'rgba(209,134,22,0.06)' // very subtle orange wash so the cluster reads as a group
    : 'var(--vscode-editor-background)';
  return {
    background: codeAgentTint,
    // Slightly thicker border for code agents so the cluster reads at
    // a glance even without the badge color.
    border: `${isCodeAgent ? 2 : 1.5}px solid ${color}`,
    borderRadius: 8,
    padding: '10px 14px',
    fontSize: 12,
    color: 'var(--feed-fg)',
    fontFamily: 'var(--vscode-font-family)',
    opacity: status === 'inactive' ? 0.85 : 1,
    minWidth: 180,
    boxShadow: status === 'active' ? `0 0 0 4px ${color}22` : 'none',
  };
}

function Header({ snapshot, loading, onRefresh }: {
  snapshot: DashboardSnapshot | undefined;
  loading: boolean;
  onRefresh: () => void;
}) {
  const generated = snapshot?.generatedAt
    ? new Date(snapshot.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
  return (
    <div style={{
      padding: '10px 16px',
      borderBottom: '1px solid var(--feed-border)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--feed-fg)' }}>
          VibeFlow Dashboard
        </span>
        {snapshot?.projectName && (
          <span style={{ fontSize: 12, color: 'var(--feed-muted)' }}>
            · {snapshot.projectName} · {snapshot.branch}
          </span>
        )}
        {generated && (
          <span style={{ fontSize: 11, color: 'var(--feed-muted)', opacity: 0.7 }}>
            updated {generated}
          </span>
        )}
      </div>
      <button
        onClick={onRefresh}
        disabled={loading}
        style={{
          padding: '4px 12px',
          fontSize: 11,
          background: 'var(--feed-button-bg)',
          color: 'var(--feed-button-fg)',
          border: 'none',
          borderRadius: 4,
          cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? 'Loading…' : 'Refresh'}
      </button>
    </div>
  );
}

function Banner({ kind, message }: { kind: 'error' | 'warning'; message: string }) {
  const colors = kind === 'error'
    ? { bg: 'rgba(244,71,71,0.1)', fg: 'var(--feed-error)' }
    : { bg: 'rgba(220,150,80,0.1)', fg: 'var(--feed-warning)' };
  return (
    <div style={{
      padding: '6px 16px',
      fontSize: 11,
      background: colors.bg,
      color: colors.fg,
      borderBottom: '1px solid var(--feed-border)',
    }}>
      {message}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--feed-border)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--feed-muted)' }}>
          {title}
        </span>
        {subtitle && <span style={{ fontSize: 11, color: 'var(--feed-muted)', opacity: 0.7 }}>{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function SummaryGrid({ snapshot, loading }: { snapshot: DashboardSnapshot | undefined; loading: boolean }) {
  if (!snapshot && loading) { return <Skeleton rows={2} />; }
  if (!snapshot) { return null; }

  const totalSeconds = snapshot.workSummary?.total_seconds ?? 0;
  const linesAdded = snapshot.workSummary?.lines_added ?? 0;
  const linesDeleted = snapshot.workSummary?.lines_deleted ?? 0;
  const commits = snapshot.workSummary?.total_commits ?? 0;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      gap: 8,
    }}>
      <SummaryCard
        label="Sessions"
        value={`${snapshot.sessions.active}/${snapshot.sessions.total}`}
        sub={snapshot.sessions.stale > 0 ? `${snapshot.sessions.stale} stale` : 'active'}
      />
      <SummaryCard
        label="Todos"
        value={`${snapshot.todos.done} done`}
        sub={`${snapshot.todos.in_progress} in progress · ${snapshot.todos.ready} ready · ${snapshot.todos.in_review} in review`}
      />
      <SummaryCard
        label="Issues"
        value={`${snapshot.issues.open} open`}
        sub={`${snapshot.issues.done} done`}
      />
      <SummaryCard
        label="Commits"
        value={`${commits}`}
        sub={commits === 0 ? 'no work logged' : 'across all sessions'}
      />
      <SummaryCard
        label="Lines"
        value={`+${linesAdded} −${linesDeleted}`}
        sub={'net ' + (linesAdded - linesDeleted >= 0 ? '+' : '') + (linesAdded - linesDeleted)}
      />
      <SummaryCard
        label="Session time"
        value={formatDuration(totalSeconds)}
        sub="capped at 15min/session"
      />
    </div>
  );
}

function GovernanceGrid({ snapshot, loading }: { snapshot: DashboardSnapshot | undefined; loading: boolean }) {
  if (!snapshot && loading) { return <Skeleton rows={2} />; }
  if (!snapshot) { return null; }

  const f = snapshot.findings;
  const br = snapshot.branchReview;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      gap: 8,
    }}>
      <Card title={`Compliance findings (${f.total_open} open)`}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Pill label="critical" count={f.critical} color="var(--feed-error)" />
          <Pill label="high" count={f.high} color="var(--feed-error)" dim={f.high === 0} />
          <Pill label="medium" count={f.medium} color="var(--feed-warning)" dim={f.medium === 0} />
          <Pill label="low" count={f.low} color="var(--feed-muted)" dim={f.low === 0} />
          <Pill label="info" count={f.informational} color="var(--feed-muted)" dim={f.informational === 0} />
        </div>
      </Card>

      <Card title={`Branch — ${br?.branch ?? snapshot.branch}`}>
        {!br || br.total_items === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--feed-muted)' }}>
            {br?.message ?? 'No tracked work items on this branch.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <ReadyBadge label="Security" verdict={br.overall_security} done={br.security_passed ?? 0} total={br.total_items} />
              <ReadyBadge label="QA" verdict={br.overall_qa} done={br.qa_passed ?? 0} total={br.total_items} />
            </div>
            <div style={{ fontSize: 10, color: 'var(--feed-muted)' }}>
              {br.total_items} item(s) · {br.total_commits ?? 0} commits · {br.total_lines ?? '+0 -0'}
              {(br.open_findings ?? 0) > 0 && (
                <span style={{ color: 'var(--feed-error)', marginLeft: 6 }}>
                  · {br.open_findings} open finding{br.open_findings === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{
      padding: '10px 12px',
      borderRadius: 6,
      border: '1px solid var(--feed-border)',
      background: 'var(--vscode-editor-background)',
      minWidth: 0,
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--feed-muted)' }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2, color: 'var(--feed-fg)' }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--feed-muted)', marginTop: 2, opacity: 0.85 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      padding: '10px 12px',
      borderRadius: 6,
      border: '1px solid var(--feed-border)',
      background: 'var(--vscode-editor-background)',
      minWidth: 0,
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--feed-fg)', marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Pill({ label, count, color, dim }: { label: string; count: number; color: string; dim?: boolean }) {
  return (
    <span style={{
      fontSize: 11,
      padding: '2px 8px',
      borderRadius: 10,
      background: 'rgba(127,127,127,0.08)',
      color: dim ? 'var(--feed-muted)' : color,
      fontWeight: 600,
      opacity: dim ? 0.55 : 1,
    }}>
      {count} {label}
    </span>
  );
}

function ReadyBadge({ label, verdict, done, total }: {
  label: string;
  verdict: 'PASS' | 'PENDING' | undefined;
  done: number;
  total: number;
}) {
  const isPass = verdict === 'PASS';
  const color = isPass ? 'var(--feed-success)' : 'var(--feed-warning)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      <span style={{ fontWeight: 600 }}>{label}:</span>
      <span style={{ color }}>{verdict ?? 'UNKNOWN'}</span>
      <span style={{ color: 'var(--feed-muted)' }}>{done}/{total}</span>
    </div>
  );
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
      {Array.from({ length: rows * 3 }).map((_, i) => (
        <div key={i} style={{
          height: 60,
          borderRadius: 6,
          background: 'rgba(127,127,127,0.08)',
        }} />
      ))}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) { return '—'; }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) { return `${h}h ${m}m`; }
  if (m > 0) { return `${m}m`; }
  return `${seconds}s`;
}
