import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getVsCodeApi } from '../vscodeApi';

const vscode = getVsCodeApi();

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

/** Static topology layout — same positions as the Phase 4 PRD wireframe. */
const PERSONA_POSITIONS: Record<string, { x: number; y: number }> = {
  product_manager:   { x: 50,  y: 50 },
  architect:         { x: 250, y: 50 },
  qa_lead:           { x: 450, y: 50 },
  security_lead:     { x: 650, y: 50 },
  ux_designer:       { x: 50,  y: 200 },
  developer:         { x: 250, y: 200 },
  principal_engineer:{ x: 450, y: 200 },
  project_manager:   { x: 650, y: 200 },
  customer:          { x: 350, y: 350 },
};

/** Conventional persona handoffs, used as topology edges. */
const PERSONA_EDGES: Array<{ id: string; source: string; target: string; dashed?: boolean }> = [
  { id: 'pm-arch',      source: 'product_manager',  target: 'architect' },
  { id: 'arch-dev',     source: 'architect',        target: 'developer' },
  { id: 'dev-qa',       source: 'developer',        target: 'qa_lead' },
  { id: 'qa-sec',       source: 'qa_lead',          target: 'security_lead' },
  { id: 'dev-pe',       source: 'developer',        target: 'principal_engineer', dashed: true },
  { id: 'ux-pm',        source: 'ux_designer',      target: 'product_manager', dashed: true },
  { id: 'cust-pm',      source: 'customer',         target: 'product_manager', dashed: true },
  { id: 'sec-projm',    source: 'security_lead',    target: 'project_manager' },
];

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
    function onMessage(event: MessageEvent) {
      const msg = event.data;
      if (msg?.type === 'dashboardData' && msg.payload) {
        setState({ snapshot: msg.payload as DashboardSnapshot, loading: false, error: undefined });
      } else if (msg?.type === 'dashboardError' && msg.payload?.message) {
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
  const nodes: Node[] = useMemo(
    () => Object.keys(PERSONA_DISPLAY).map(key => {
      const status = personaStatus[key] ?? 'inactive';
      return {
        id: key,
        position: PERSONA_POSITIONS[key] ?? { x: 0, y: 0 },
        data: { label: <PersonaNodeLabel name={PERSONA_DISPLAY[key]} status={status} /> },
        style: nodeStyle(status),
      };
    }),
    [personaStatus],
  );

  const edges: Edge[] = useMemo(() => PERSONA_EDGES.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: personaStatus[e.source] === 'active' || personaStatus[e.target] === 'active',
    style: {
      stroke: 'var(--feed-border)',
      ...(e.dashed ? { strokeDasharray: '5,5' } : {}),
    },
  })), [personaStatus]);

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
      <Section title="Agent Topology" subtitle="Click a persona to focus its terminal">
        <div style={{ height: 380, width: '100%', borderRadius: 6, border: '1px solid var(--feed-border)', background: 'var(--vscode-editor-background)' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodeClick={onNodeClick}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            zoomOnScroll={false}
            panOnDrag={true}
          >
            <Background color="var(--feed-border)" gap={20} />
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

function PersonaNodeLabel({ name, status }: { name: string; status: PersonaStatus }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <span style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: STATUS_COLOR[status],
        flexShrink: 0,
      }} />
      {name}
    </div>
  );
}

function nodeStyle(status: PersonaStatus): React.CSSProperties {
  const color = STATUS_COLOR[status];
  return {
    background: 'var(--vscode-editor-background)',
    border: `2px solid ${color}`,
    borderRadius: 8,
    padding: '8px 14px',
    fontSize: 12,
    color: 'var(--feed-fg)',
    fontFamily: 'var(--vscode-font-family)',
    opacity: status === 'inactive' ? 0.65 : 1,
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
