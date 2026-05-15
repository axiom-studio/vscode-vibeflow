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
import { AVATAR_BY_PERSONA } from '../personaAvatars';
import type { DashboardClientMessage, DashboardHostMessage } from '../../../src/core/webviewMessages';
import { EmptyState } from './_shared/EmptyState';
import { GitBranchIcon, InboxIcon, SpinnerIcon } from './_shared/icons';

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
  // Server origin so the webview can build avatar URLs.
  serverUrl: string;
  // User-customized node positions for this project (drag-and-drop layout).
  // undefined means "use PERSONA_POSITIONS defaults."
  nodePositions: Record<string, { x: number; y: number }> | undefined;
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
  principal_engineer: 'Principal Engineer',
  security_lead: 'Security Lead',
  qa_lead: 'QA Lead',
  product_manager: 'Product Manager',
  project_manager: 'Project Manager',
  ux_designer: 'UX Designer',
  customer: 'Customer',
};

/**
 * Character name shown as a subtitle under the role label, matching the
 * axiomcloud seed migrations (e.g. "Alex" for `developer`). Pure flavor —
 * makes the personas more memorable and matches the rest of the product.
 */
const CHARACTER_BY_PERSONA: Record<string, string> = {
  developer: 'Alex',
  architect: 'Morgan',
  principal_engineer: 'Kai',
  security_lead: 'Sophie',
  qa_lead: 'Quinn',
  product_manager: 'Aria',
  project_manager: 'Parker',
  ux_designer: 'Dana',
  customer: 'Casey',
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
 * personas.md §"Work Item Routing".
 *
 * Edge semantics:
 *
 *   - **Solid** edges = mandatory status gates (Code → Security → QA).
 *     The work item HAS to traverse these to ship.
 *   - **Dashed** edges = collaborative or alternative handoffs. There's
 *     no rigid handoff between, say, Customer and PM — they collaborate
 *     iteratively to produce a PRD. Same for PM → code-agent: PM hands
 *     work to whichever code agent the user picked. Exactly ONE of
 *     Architect / Developer / Principal Engineer owns the branch (per
 *     GitModifyingPersonas in axiomcloud/database/vibeflow_models.go),
 *     so we draw THREE separate dashed paths from PM rather than a
 *     sequential chain.
 *
 * All three code agents — Architect included — feed Security as a
 * mandatory gate because they're the GitModifyingPersonas. Architect
 * still produces commits (design docs / scaffolding) that go through
 * security and QA review; it doesn't get a special pass.
 *
 * Project Manager is a lifecycle tracker — no status-routing edges.
 */
const PERSONA_EDGES: Array<{ id: string; source: string; target: string; dashed?: boolean }> = [
  // Planning collaboration (Customer + UX feed PM iteratively for PRDs).
  { id: 'cust-pm',  source: 'customer',           target: 'product_manager',    dashed: true },
  { id: 'ux-pm',    source: 'ux_designer',        target: 'product_manager',    dashed: true },
  // PM hands the PRD/spec to whichever code agent the user picked. Three
  // separate dashed lines — NOT a sequential chain.
  { id: 'pm-arch',  source: 'product_manager',    target: 'architect',          dashed: true },
  { id: 'pm-dev',   source: 'product_manager',    target: 'developer',          dashed: true },
  { id: 'pm-pe',    source: 'product_manager',    target: 'principal_engineer', dashed: true },
  // Mandatory gates: every code agent → Security → QA.
  { id: 'arch-sec', source: 'architect',          target: 'security_lead' },
  { id: 'dev-sec',  source: 'developer',          target: 'security_lead' },
  { id: 'pe-sec',   source: 'principal_engineer', target: 'security_lead' },
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

  // Locally-tracked position overrides for drag persistence. Initialised
  // from `snapshot.nodePositions` (host-stored layout) and mutated on
  // drag-stop. We keep the override in component state so React re-renders
  // place the node where the user dropped it; we also forward the change
  // to the host so it survives reload. Resetting the layout clears this
  // map and re-falls-back to PERSONA_POSITIONS.
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});

  // Hydrate / reset positions from the snapshot. Re-runs only when the host
  // pushes a new layout (initial load or after Reset layout fires).
  useEffect(() => {
    setPositions(state.snapshot?.nodePositions ?? {});
  }, [state.snapshot?.nodePositions]);

  const onNodeDragStop = useCallback((_evt: unknown, node: Node) => {
    setPositions(prev => {
      const next = { ...prev, [node.id]: { x: node.position.x, y: node.position.y } };
      // Send the FULL position map (override OR default) so the host can
      // write it atomically without having to merge against its prior copy.
      const full: Record<string, { x: number; y: number }> = {};
      for (const key of Object.keys(PERSONA_DISPLAY)) {
        full[key] = next[key] ?? PERSONA_POSITIONS[key];
      }
      vscode.postMessage({ type: 'dashboardSaveNodePositions', payload: { positions: full } });
      return next;
    });
  }, []);

  const onResetLayout = useCallback(() => {
    setPositions({});
    vscode.postMessage({ type: 'dashboardResetNodePositions' });
  }, []);

  const personaStatus = state.snapshot?.personaStatus ?? {};
  const personaQueues = state.snapshot?.personaQueues ?? {};
  const serverUrl = state.snapshot?.serverUrl ?? '';
  const nodes: Node[] = useMemo(
    () => Object.keys(PERSONA_DISPLAY).map(key => {
      const status = personaStatus[key] ?? 'inactive';
      const isCodeAgent = CODE_AGENT_KEYS.has(key);
      const queue = personaQueues[key];
      const avatarPath = AVATAR_BY_PERSONA[key];
      const avatarUrl = avatarPath && serverUrl ? `${serverUrl}${avatarPath}` : undefined;
      return {
        id: key,
        position: positions[key] ?? PERSONA_POSITIONS[key] ?? { x: 0, y: 0 },
        // Explicit handle positions stop edges from picking arbitrary
        // sides and looping (which is why the previous render had
        // edges cutting through node interiors).
        sourcePosition: DEFAULT_SOURCE_POSITION,
        targetPosition: DEFAULT_TARGET_POSITION,
        data: {
          label: (
            <PersonaNodeLabel
              name={PERSONA_DISPLAY[key]}
              character={CHARACTER_BY_PERSONA[key]}
              status={status}
              isCodeAgent={isCodeAgent}
              queue={queue === undefined ? null : queue}
              queueTooltip={QUEUE_TOOLTIPS[key]}
              avatarUrl={avatarUrl}
            />
          ),
        },
        style: nodeStyle(status, isCodeAgent),
      };
    }),
    [personaStatus, personaQueues, positions, serverUrl],
  );

  const edges: Edge[] = useMemo(() => PERSONA_EDGES.map(e => {
    // An edge is "active" only when BOTH endpoints have a live session.
    // Earlier we used OR (either side active) which painted nearly the
    // whole graph blue once even one mid-pipeline persona was running —
    // e.g. with PM + Dev + Security live, every edge connecting any of
    // them lit up, including customer→PM and security→QA where the
    // counterparty was idle. Requiring both ends matches the visual
    // intent: highlight the segment of the pipeline where work can
    // actually flow right now.
    const sourceActive = personaStatus[e.source] === 'active';
    const targetActive = personaStatus[e.target] === 'active';
    const isActive = sourceActive && targetActive;

    // Inactive edges fade into the chrome so the topology reads as
    // structure first; the active path is what jumps out. Dashed edges
    // (collaborative handoffs) sit a step below solid (mandatory gates)
    // even when both are inactive, preserving the semantic distinction.
    // Theme-token-mixed via `color-mix` so the lines adapt to light /
    // dark / high-contrast instead of relying on a fixed gray that
    // disappears on dark themes and fights with light themes.
    const inactiveSolid = 'color-mix(in oklab, var(--vscode-foreground) 32%, transparent)';
    const inactiveDashed = 'color-mix(in oklab, var(--vscode-foreground) 16%, transparent)';
    const stroke = isActive
      ? 'var(--feed-link)'
      : (e.dashed ? inactiveDashed : inactiveSolid);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      // Smoothstep gives clean orthogonal corners that respect the
      // explicit handle positions, instead of bezier curves that
      // arc across other nodes.
      type: 'smoothstep',
      animated: isActive,
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 12, height: 12 },
      style: {
        stroke,
        strokeWidth: isActive ? 2.25 : 1.25,
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
        actions={
          <button
            onClick={onResetLayout}
            title="Discard your dragged layout and restore the default positions."
            className="transition-all duration-150 ease-out active:scale-[0.97] hover:bg-[var(--vscode-list-hoverBackground)]"
            style={{
              fontSize: 11,
              padding: '5px 10px',
              borderRadius: 4,
              border: '1px solid var(--feed-border)',
              background: 'transparent',
              color: 'var(--feed-muted)',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Reset layout
          </button>
        }
      >
        <div style={{ height: 460, width: '100%', borderRadius: 6, border: '1px solid var(--feed-border)', background: 'var(--vscode-editor-background)' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodeClick={onNodeClick}
            onNodeDragStop={onNodeDragStop}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            proOptions={{ hideAttribution: true }}
            // User feedback (2026-05-08): "can we let the users move the
            // blocks around?" — yes. Free-form drag for personal layout
            // preferences. Connections remain locked (the edge graph is
            // canonical, not user-editable).
            nodesDraggable={true}
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

/**
 * Persona node body. Designed as an avatar-led card with the role name on
 * the top line and the character name (Alex / Morgan / …) below, plus an
 * optional `1/branch` chip for the code-agent cluster.
 *
 * Queue count is shown as a notification dot on the avatar's top-right
 * corner instead of a separate pill — this matches how every chat / mail
 * UI does "unread count," reads as "items waiting for you," and removes
 * the previous blue `↓ N` pill that nobody knew how to interpret.
 */
function PersonaNodeLabel({ name, character, status, isCodeAgent, queue, queueTooltip, avatarUrl }: {
  name: string;
  character: string | undefined;
  status: PersonaStatus;
  isCodeAgent: boolean;
  queue: number | null;
  queueTooltip: string | undefined;
  avatarUrl: string | undefined;
}) {
  const showQueueBadge = queueTooltip !== undefined && queue !== null && queue > 0;
  const ringColor = STATUS_COLOR[status];
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 11,
      fontSize: 12,
      minWidth: 0,
    }}>
      {/* Avatar block ----------------------------------------------------- */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        {avatarUrl ? (
          <span style={{
            display: 'inline-flex',
            width: 36,
            height: 36,
            borderRadius: '50%',
            padding: 2,
            background: `linear-gradient(135deg, ${ringColor}, color-mix(in oklab, ${ringColor} 60%, transparent))`,
            boxShadow: status === 'active'
              ? `0 0 0 3px color-mix(in oklab, ${ringColor} 22%, transparent), 0 1px 4px color-mix(in oklab, var(--vscode-foreground) 22%, transparent)`
              : '0 1px 3px color-mix(in oklab, var(--vscode-foreground) 22%, transparent)',
          }}>
            <img
              src={avatarUrl}
              alt=""
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                objectFit: 'cover',
                display: 'block',
                background: 'var(--vscode-editor-background)',
              }}
            />
          </span>
        ) : (
          // No avatar: fall back to a status dot inside a 36px slot so
          // the layout doesn't shift between rendered/unrendered states.
          <span style={{
            display: 'inline-flex',
            width: 36,
            height: 36,
            borderRadius: '50%',
            background: ringColor,
            opacity: 0.85,
          }} />
        )}
        {/* Notification badge — top-right corner of the avatar, scoped
            in size so a 3-digit count still fits without ballooning the
            node. Hidden when queue is 0 so the badge is a real signal. */}
        {showQueueBadge && (
          <span
            title={queueTooltip}
            style={{
              position: 'absolute',
              top: -4,
              right: -6,
              minWidth: 18,
              height: 18,
              padding: '0 5px',
              borderRadius: 9,
              background: 'var(--vscode-charts-red, #f14c4c)',
              color: 'white',
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '18px',
              textAlign: 'center',
              boxShadow: '0 0 0 2px var(--vscode-editor-background)',
              boxSizing: 'border-box',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {queue! > 99 ? '99+' : queue}
          </span>
        )}
      </div>

      {/* Text block ------------------------------------------------------- */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--feed-fg)',
          whiteSpace: 'nowrap',
          letterSpacing: 0.1,
        }}>
          {name}
        </div>
        <div style={{
          fontSize: 10.5,
          color: 'var(--feed-muted)',
          opacity: 0.85,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          whiteSpace: 'nowrap',
        }}>
          {character && <span>{character}</span>}
          {isCodeAgent && (
            <span
              title="One code agent per branch — Architect, Developer, and Principal Engineer share this slot."
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: 0.4,
                padding: '1px 5px',
                borderRadius: 3,
                background: 'color-mix(in oklab, var(--vscode-charts-orange, #d18616) 18%, transparent)',
                color: 'var(--vscode-charts-orange, #d18616)',
                lineHeight: 1.5,
                textTransform: 'uppercase',
              }}
            >
              1/branch
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function nodeStyle(status: PersonaStatus, isCodeAgent: boolean): React.CSSProperties {
  // Inactive nodes use a `color-mix`-tinted neutral so the box outline
  // stays readable across light / dark / high-contrast themes; status
  // colors only kick in for active/stale to draw the eye to live
  // activity. Old hardcoded `rgba(127,127,127,0.45)` disappeared on
  // dark themes and clashed on light.
  const inactiveBorder = 'color-mix(in oklab, var(--vscode-foreground) 32%, transparent)';
  const color = status === 'inactive' ? inactiveBorder : STATUS_COLOR[status];
  // Soft gradient + per-status accent makes the active state pop without
  // the previous flat orange tint that washed over every code-agent
  // node regardless of activity. Code agents get a subtle warm wash on
  // the right edge so the cluster still reads as a group.
  const baseBg = 'var(--vscode-editor-background)';
  const background = isCodeAgent
    ? `linear-gradient(135deg, ${baseBg} 0%, ${baseBg} 70%, color-mix(in oklab, var(--vscode-charts-orange, #d18616) 10%, transparent) 100%)`
    : baseBg;
  // Active state stacks: an inner-edge refraction (1px inset, 6% fg)
  // + the colored halo + a tinted drop shadow. The inset gives the
  // node a sense of "raised material" without sliding into glassmorphism.
  const activeShadow =
    `inset 0 0 0 1px color-mix(in oklab, var(--vscode-foreground) 6%, transparent),`
    + ` 0 0 0 1px color-mix(in oklab, ${color} 33%, transparent),`
    + ` 0 4px 12px color-mix(in oklab, var(--vscode-foreground) 16%, transparent)`;
  const restingShadow = '0 1px 3px color-mix(in oklab, var(--vscode-foreground) 14%, transparent)';
  return {
    background,
    border: `1px solid ${color}`,
    borderRadius: 12,
    padding: '12px 14px 12px 12px',
    fontSize: 12,
    color: 'var(--feed-fg)',
    fontFamily: 'var(--vscode-font-family)',
    opacity: status === 'inactive' ? 0.92 : 1,
    minWidth: 180,
    boxShadow: status === 'active' ? activeShadow : restingShadow,
    transition: 'box-shadow 160ms ease-out, transform 160ms ease-out',
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
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--feed-fg)', letterSpacing: '-0.005em' }}>
          VibeFlow Dashboard
        </span>
        {snapshot?.projectName && (
          <span style={{ fontSize: 12, color: 'var(--feed-muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span>· {snapshot.projectName} ·</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--feed-muted)' }}>
              <GitBranchIcon size={11} />
              <span style={{ fontFamily: 'var(--vscode-editor-font-family)' }}>{snapshot.branch}</span>
            </span>
          </span>
        )}
        {generated && (
          <span style={{ fontSize: 11, color: 'var(--feed-muted)', opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>
            updated {generated}
          </span>
        )}
      </div>
      <button
        onClick={onRefresh}
        disabled={loading}
        className="transition-all duration-150 ease-out active:scale-[0.97]"
        style={{
          padding: '5px 12px',
          fontSize: 11,
          fontWeight: 500,
          background: 'var(--feed-button-bg)',
          color: 'var(--feed-button-fg)',
          border: 'none',
          borderRadius: 4,
          cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.7 : 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {loading && <SpinnerIcon size={11} />}
        {loading ? 'Loading' : 'Refresh'}
      </button>
    </div>
  );
}

function Banner({ kind, message }: { kind: 'error' | 'warning'; message: string }) {
  const fg = kind === 'error' ? 'var(--feed-error)' : 'var(--feed-warning)';
  return (
    <div style={{
      padding: '6px 16px',
      fontSize: 11,
      background: `color-mix(in oklab, ${fg} 12%, transparent)`,
      color: fg,
      borderBottom: '1px solid var(--feed-border)',
    }}>
      {message}
    </div>
  );
}

function Section({ title, subtitle, actions, children }: {
  title: string;
  subtitle?: string;
  // Right-aligned slot for section-level controls (e.g. "Reset layout"
  // for the topology). Optional so other sections render unchanged.
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ padding: '18px 18px 16px', borderBottom: '1px solid var(--feed-border)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          marginBottom: 14,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--feed-fg)',
              letterSpacing: '-0.005em',
              margin: 0,
            }}
          >
            {title}
          </h3>
          {subtitle && (
            <p
              style={{
                fontSize: 11.5,
                color: 'var(--feed-muted)',
                lineHeight: 1.5,
                margin: '4px 0 0',
                maxWidth: '70ch',
              }}
            >
              {subtitle}
            </p>
          )}
        </div>
        {actions && <div style={{ flexShrink: 0 }}>{actions}</div>}
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

  /*
   * Bento layout — replaces the generic 5-equal-cards row. Top tier
   * gives the two "live + shipped" anchors (Sessions, Work items)
   * room to breathe at half-width each; bottom tier groups the three
   * supporting numerics (Commits, Lines, Session time) in a tight
   * trio. At narrow widths the grid collapses to a single column so
   * nothing gets squeezed below readable density.
   */
  return (
    <div className="dashboard-bento">
      <div style={{ gridArea: 'sessions' }}>
        <SummaryCard
          label="Sessions"
          value={`${snapshot.sessions.active}/${snapshot.sessions.total}`}
          sub={snapshot.sessions.stale > 0 ? `${snapshot.sessions.stale} stale` : 'active'}
          tone="hero"
        />
      </div>
      {/* Combined work-item card matches the left panel's grouping
          (todos + issues collapsed by status). The user's audit
          flagged the prior split as misleading: left panel showed
          69 done while this card showed 61 done because issues were
          pulled into a separate card. Merge so the two views agree.
          Sub text breaks out the type split for users who want it. */}
      <div style={{ gridArea: 'work' }}>
        <SummaryCard
          label="Work items"
          value={`${snapshot.todos.done + snapshot.issues.done} done`}
          sub={
            `${snapshot.todos.done} todos · ${snapshot.issues.done} issues · ` +
            `${snapshot.issues.open} issues open`
          }
          tone="hero"
        />
      </div>
      <div style={{ gridArea: 'commits' }}>
        <SummaryCard
          label="Commits"
          value={`${commits}`}
          sub={commits === 0 ? 'no work logged' : 'across all sessions'}
        />
      </div>
      <div style={{ gridArea: 'lines' }}>
        <SummaryCard
          label="Lines"
          value={`+${linesAdded} −${linesDeleted}`}
          sub={'net ' + (linesAdded - linesDeleted >= 0 ? '+' : '') + (linesAdded - linesDeleted)}
          subColor={linesAdded - linesDeleted >= 0 ? 'var(--feed-success)' : 'var(--feed-error)'}
        />
      </div>
      <div style={{ gridArea: 'time' }}>
        <SummaryCard
          label="Session time"
          value={formatDuration(totalSeconds)}
          sub="capped at 15min/session"
        />
      </div>
    </div>
  );
}

function GovernanceGrid({ snapshot, loading }: { snapshot: DashboardSnapshot | undefined; loading: boolean }) {
  if (!snapshot && loading) { return <Skeleton rows={2} />; }
  if (!snapshot) { return null; }

  const f = snapshot.findings;
  const br = snapshot.branchReview;

  // The two governance cards report DIFFERENT things and the labels need
  // to make that obvious — the user audit (2026-05-08) flagged that
  // "Compliance findings: 2 open" sat next to "Branch — main: 10 open
  // findings" with no indication of why the numbers disagreed:
  //
  //   - LEFT card: PROJECT-WIDE findings, filtered by `effective_status`
  //     which honours SLA grace windows (a finding that's overdue in raw
  //     status but inside its grace period drops out). Source:
  //     `client.listComplianceFindings(projectId, {status:'open'})` →
  //     `tallyFindings` (DashboardPanel.ts).
  //   - RIGHT card: BRANCH-SCOPED metrics from
  //     `check_branch_review_status` (MCP) — security/QA pass counts and
  //     a raw `open_findings` count limited to items on this branch.
  //     Doesn't apply effective_status filtering.
  //
  // Labels now lead with scope ("Project" vs "Branch") and the
  // sub-copy spells out the filter.
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      gap: 8,
    }}>
      <Card title={`Project compliance · ${f.total_open} active`}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Pill label="critical" count={f.critical} color="var(--feed-error)" />
          <Pill label="high" count={f.high} color="var(--feed-error)" dim={f.high === 0} />
          <Pill label="medium" count={f.medium} color="var(--feed-warning)" dim={f.medium === 0} />
          <Pill label="low" count={f.low} color="var(--feed-muted)" dim={f.low === 0} />
          <Pill label="info" count={f.informational} color="var(--feed-muted)" dim={f.informational === 0} />
        </div>
        <div style={{ fontSize: 10, color: 'var(--feed-muted)', marginTop: 6, opacity: 0.85 }}>
          All projects' open findings, after SLA grace windows
        </div>
      </Card>

      <Card title={`Branch readiness · ${br?.branch ?? snapshot.branch}`}>
        {!br || br.total_items === 0 ? (
          <EmptyState
            icon={<InboxIcon size={20} />}
            headline="No tracked work"
            subtext={br?.message ?? 'No tracked work items on this branch yet.'}
            className="flex flex-col items-center justify-center text-center gap-1.5 py-3"
          />
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
                  · {br.open_findings} open finding{br.open_findings === 1 ? '' : 's'} on branch
                </span>
              )}
            </div>
            <div style={{ fontSize: 10, color: 'var(--feed-muted)', marginTop: 2, opacity: 0.85 }}>
              Items on this branch only; raw open count
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function SummaryCard({ label, value, sub, subColor, tone }: {
  label: string;
  value: string;
  sub?: string;
  subColor?: string;
  /**
   * 'hero' bumps the value type up for the top-tier bento cells AND
   * paints a heavier border so the hero status reads at a glance.
   * Default = standard chrome for the supporting numerics.
   */
  tone?: 'hero' | 'default';
}) {
  const isHero = tone === 'hero';
  return (
    <div
      style={{
        minWidth: 0,
        height: '100%',
        padding: isHero ? '14px 16px' : '12px 14px',
        borderRadius: 8,
        background: 'var(--vscode-editor-background)',
        border: isHero
          ? '1px solid color-mix(in oklab, var(--vscode-foreground) 22%, transparent)'
          : '1px solid var(--feed-border)',
        boxShadow: isHero
          ? 'inset 0 1px 0 color-mix(in oklab, var(--vscode-foreground) 6%, transparent), 0 1px 3px color-mix(in oklab, var(--vscode-foreground) 10%, transparent)'
          : '0 1px 2px color-mix(in oklab, var(--vscode-foreground) 8%, transparent)',
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--feed-muted)',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: isHero ? 26 : 18,
          fontWeight: 600,
          marginTop: isHero ? 6 : 3,
          color: 'var(--feed-fg)',
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: isHero ? '-0.018em' : '-0.01em',
          lineHeight: 1.05,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: isHero ? 11.5 : 11,
            color: subColor ?? 'var(--feed-muted)',
            marginTop: 4,
            opacity: subColor ? 0.95 : 0.85,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1.4,
          }}
        >
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
      background: dim
        ? 'transparent'
        : `color-mix(in oklab, ${color} 14%, transparent)`,
      color: dim ? 'var(--feed-muted)' : color,
      fontWeight: 600,
      fontVariantNumeric: 'tabular-nums',
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
        <div
          key={i}
          className="shimmer"
          style={{ height: 60, borderRadius: 6 }}
        />
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
