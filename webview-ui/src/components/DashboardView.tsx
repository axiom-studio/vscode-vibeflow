import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Position,
  MarkerType,
  NodeToolbar,
  Handle,
  BaseEdge,
  getBezierPath,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getVsCodeApi } from '../vscodeApi';
import { AVATAR_BY_PERSONA } from '../personaAvatars';
import { PERSONA_COLORS } from '../types';
import { KanbanBoard, type KanbanCard } from './kanban/KanbanBoard';
import type { DashboardClientMessage, DashboardHostMessage } from '../../../src/core/webviewMessages';
import { GitBranchIcon, SpinnerIcon } from './_shared/icons';

const vscode = getVsCodeApi() as { postMessage: (msg: DashboardClientMessage) => void };

type PersonaStatus = 'active' | 'stale' | 'inactive';

/** One queued work item shown in a persona node's hover card (mirrors host). */
interface PersonaQueueItem {
  id: number;
  type: 'todo' | 'issue';
  title: string;
  status: string;
  priority?: string;
}

/** Live Agent Topology (feature 472) — mirrors host LiveAgent/LiveBranch/LiveSnapshot. */
interface LiveAgent {
  sessionId: string;
  personaKey: string;
  personaName: string;
  characterName?: string;
  avatarUrl?: string;
  branch: string;
  liveness: 'active' | 'stale' | 'dead';
  role: 'upstream' | 'code' | 'review';
  lastMessage?: string;
  lastMessageAt?: string;
  agentModel?: string;
  workDir?: string;
  lastHeartbeat?: string;
  pendingPrompts?: number;
}
interface LiveBranch { branch: string; agents: LiveAgent[]; }
interface LiveSnapshot { branches: LiveBranch[]; total: number; }

// Branch readiness card is hidden in v1.1; the host still sends this
// data so the card can return without a wire change. Kept as a partial
// model (no `items[]` until the card is back) to satisfy noUnusedLocals.
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
  // Actual items behind each persona's count (mirrors host PersonaQueueItem).
  // Keyed by persona; advisory personas (project_manager/customer) absent.
  personaQueueItems: Record<string, PersonaQueueItem[]>;
  // Cards for the optional embedded Kanban board (mirrors host KanbanCard).
  kanbanCards: KanbanCard[];
  sessions: { active: number; stale: number };
  // Per-session, per-branch live view (Live topology mode).
  live: LiveSnapshot;
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
const PERSONA_EDGES: Array<{ id: string; source: string; target: string; dashed?: boolean; type?: string }> = [
  // Planning collaboration (Customer + UX feed PM iteratively for PRDs).
  // Bezier ('default') for these two, NOT smoothstep: Customer + UX are
  // stacked at the same x and converge on PM's single left handle, so
  // smoothstep's right-angle paths stack into one overlapping vertical bar.
  // A curve from each gives two distinct smooth lines (one down, one up) into
  // PM. Safe here — no node sits between Customer/UX and PM, so the curve
  // can't arc across anything (the reason smoothstep is the default elsewhere).
  { id: 'cust-pm',  source: 'customer',           target: 'product_manager',    dashed: true, type: 'default' },
  { id: 'ux-pm',    source: 'ux_designer',        target: 'product_manager',    dashed: true, type: 'default' },
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
  qa_lead:            'Items in `done` where security_reviewed=true and qa_verified=false.',
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

  const openWorkItem = useCallback((item: PersonaQueueItem) => {
    vscode.postMessage({
      type: 'dashboardOpenWorkItem',
      payload: { workItemType: item.type, workItemId: item.id },
    });
  }, []);

  // Optional embedded Kanban board (toggled from the header). In-memory v1.
  const [kanbanEmbedded, setKanbanEmbedded] = useState(false);
  // Explain (static teaching chart) ↔ Live (per-branch running sessions). #2329
  const [topologyMode, setTopologyMode] = useState<'explain' | 'live'>('explain');
  const toggleKanban = useCallback(() => setKanbanEmbedded(v => !v), []);
  const onKanbanMove = useCallback((itemType: 'todo' | 'issue', itemId: number, newStatus: string) => {
    vscode.postMessage({ type: 'dashboardKanbanMove', payload: { itemType, itemId, newStatus } });
  }, []);
  const onKanbanOpen = useCallback((card: KanbanCard) => {
    vscode.postMessage({ type: 'dashboardOpenWorkItem', payload: { workItemType: card.type, workItemId: card.id } });
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
  const personaQueueItems = state.snapshot?.personaQueueItems ?? {};
  const serverUrl = state.snapshot?.serverUrl ?? '';
  const nodes: Node[] = useMemo(() => {
    const personaNodes: Node[] = Object.keys(PERSONA_DISPLAY).map(key => {
      const status = personaStatus[key] ?? 'inactive';
      const isCodeAgent = CODE_AGENT_KEYS.has(key);
      const queue = personaQueues[key];
      const items = personaQueueItems[key] ?? [];
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
              queue={queue === undefined ? null : queue}
              queueTooltip={QUEUE_TOOLTIPS[key]}
              avatarUrl={avatarUrl}
              personaColor={PERSONA_COLORS[key] ?? 'var(--vscode-foreground)'}
              items={items}
              isCodeAgent={isCodeAgent}
              onOpenItem={openWorkItem}
            />
          ),
        },
        style: nodeStyle(status, isCodeAgent),
      };
    });

    // Floating "1 active per branch" chip pinned above the code-agent
    // cluster. Single shared affordance replaces the old per-node
    // orange `1/branch` pill. Anchored to the architect node's CURRENT
    // position (drag-aware) rather than the static default — otherwise
    // dragging the cluster strands the chip at its original spot.
    const archPos = positions.architect ?? PERSONA_POSITIONS.architect;
    const slotNode: Node = {
      id: 'slot-code-agent',
      type: 'slotLabel',
      position: { x: archPos.x + 8, y: archPos.y - 34 },
      data: { label: '1 active per branch · code agents' },
      draggable: false,
      selectable: false,
      focusable: false,
      style: { background: 'transparent', border: 'none', padding: 0, width: 'auto' },
    };

    return [slotNode, ...personaNodes];
  }, [personaStatus, personaQueues, personaQueueItems, positions, serverUrl, openWorkItem]);

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
    // Single label on the Security → QA gate makes the final hand-off
    // legible without crowding the rest of the graph. Code-agent →
    // Security edges share a single conceptual "review" step and would
    // produce 3 redundant labels stacked vertically — left unlabeled.
    const label = e.id === 'sec-qa' ? 'verify' : undefined;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      // Smoothstep is the default — clean orthogonal corners that respect the
      // explicit handle positions, instead of bezier curves that arc across
      // other nodes. A few edges opt into bezier ('default') via
      // PERSONA_EDGES.type where converging paths (customer/ux → PM) would
      // otherwise stack into one overlapping right-angle bar.
      type: e.type ?? 'smoothstep',
      animated: isActive,
      label,
      labelStyle: label
        ? {
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            fill: 'var(--feed-muted)',
          }
        : undefined,
      labelBgStyle: label
        ? {
            fill: 'var(--vscode-editor-background)',
            stroke: 'color-mix(in oklab, var(--vscode-foreground) 14%, transparent)',
            strokeWidth: 1,
          }
        : undefined,
      labelBgPadding: label ? [6, 3] as [number, number] : undefined,
      labelBgBorderRadius: label ? 3 : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 12, height: 12 },
      style: {
        stroke,
        strokeWidth: isActive ? 2.5 : 1.25,
        ...(e.dashed ? { strokeDasharray: '4,4' } : {}),
        // Active edges get a soft glow so the live path reads at a
        // glance against the muted inactive lines. Tinted via color-mix
        // off the active color (`--feed-link`) so it stays subtle in HC.
        ...(isActive
          ? {
              filter: 'drop-shadow(0 0 4px color-mix(in oklab, var(--feed-link) 40%, transparent))',
            }
          : {}),
      },
    };
  }), [personaStatus]);

  return (
    <div style={{ width: '100%', height: '100vh', background: 'var(--feed-bg)', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      <Header
        snapshot={state.snapshot}
        loading={state.loading}
        onRefresh={refresh}
        kanbanEmbedded={kanbanEmbedded}
        onToggleKanban={toggleKanban}
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
        subtitle={topologyMode === 'explain'
          ? 'Click a persona to focus its terminal · Architect, Developer, and Principal Engineer share one code-agent slot per branch — advisory personas have no such limit.'
          : 'What’s running right now · every branch shows its own team — upstream (PM/UX) → code → review (Security/QA). Hover an agent for detail.'}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TopologyModeToggle mode={topologyMode} onChange={setTopologyMode} />
            {topologyMode === 'explain' && (
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
            )}
          </div>
        }
      >
        <div style={{ height: 500, width: '100%', borderRadius: 8, border: '1px solid var(--feed-border)', background: 'var(--vscode-editor-background)', overflow: 'hidden' }}>
          {topologyMode === 'live' ? (
            <LiveTopology live={state.snapshot?.live} />
          ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodeClick={onNodeClick}
            onNodeDragStop={onNodeDragStop}
            fitView
            fitViewOptions={{ padding: 0.2 }}
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
            {/* Lines variant gives the canvas an architectural plane
             *  vs the default-Excalidraw dot scatter. Color is heavily
             *  tinted toward `--vscode-foreground` so the grid sits
             *  behind the content without competing for attention. */}
            <Background
              variant={BackgroundVariant.Lines}
              color="color-mix(in oklab, var(--vscode-foreground) 5%, transparent)"
              gap={24}
              lineWidth={0.7}
            />
          </ReactFlow>
          )}
        </div>
      </Section>

      {/* Embedded Kanban (toggled from the header) — sits under the topology;
       *  Summary + Governance shift down. Standalone Kanban panel unchanged. */}
      {kanbanEmbedded && (
        <Section
          title="Kanban"
          subtitle="Drag a card to change its status · click to open. Same board as Work Items → Kanban."
        >
          <div style={{ height: 480, borderRadius: 8, border: '1px solid var(--feed-border)', background: 'var(--vscode-editor-background)', overflow: 'hidden' }}>
            <KanbanBoard
              cards={state.snapshot?.kanbanCards ?? []}
              loading={state.loading}
              onMove={onKanbanMove}
              onOpenCard={onKanbanOpen}
            />
          </div>
        </Section>
      )}

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
 * Persona node body — character-first reading order.
 *
 * Hierarchy: the character name (Kai / Morgan / Sophie / …) is the
 * primary identity; the role label is the supporting line. Personas
 * feel like collaborators, not org-chart slots. Active personas get
 * a soft 2s breathing ring on the avatar (gated by prefers-reduced-motion
 * via the global shield in index.css).
 *
 * Queue count stays as a corner notification badge on the avatar
 * (chat/mail-style "unread count") so it doesn't compete with the
 * primary text identity. The code-agent shared-slot constraint is now
 * conveyed by a single visual chip floating above the cluster
 * (see `SlotLabelNode`) instead of per-node "1/branch" badges.
 */
function PersonaNodeLabel({ name, character, status, queue, queueTooltip, avatarUrl, personaColor, items, isCodeAgent, onOpenItem }: {
  name: string;
  character: string | undefined;
  status: PersonaStatus;
  queue: number | null;
  queueTooltip: string | undefined;
  avatarUrl: string | undefined;
  personaColor: string;
  items: PersonaQueueItem[];
  isCodeAgent: boolean;
  onOpenItem: (item: PersonaQueueItem) => void;
}) {
  const showQueueBadge = queueTooltip !== undefined && queue !== null && queue > 0;
  // Hover card with the actual queued items. Hover-intent: a short close
  // delay lets the pointer travel from the node to the portal'd card
  // (which lives outside this node's DOM) without it snapping shut.
  const rootRef = useRef<HTMLDivElement>(null);
  const [hovering, setHovering] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = undefined; } };
  const openCard = () => { cancelClose(); setHovering(true); };
  const closeSoon = () => { cancelClose(); closeTimer.current = setTimeout(() => setHovering(false), 130); };
  useEffect(() => cancelClose, []);
  const showCard = hovering && items.length > 0 && rootRef.current !== null;
  const ringColor = STATUS_COLOR[status];
  const restingShadow = `0 1px 3px color-mix(in oklab, var(--vscode-foreground) 22%, transparent)`;
  // Active personas get the live breathing ring via the .persona-pulse
  // class (defined in index.css). The CSS custom property pipes the
  // persona's brand color into the pulse keyframe so each persona
  // pulses in its own color, not a shared blue.
  const isActive = status === 'active';
  const avatarStyle: React.CSSProperties = {
    display: 'inline-flex',
    width: 36,
    height: 36,
    borderRadius: '50%',
    padding: 2,
    background: `linear-gradient(135deg, ${ringColor}, color-mix(in oklab, ${ringColor} 60%, transparent))`,
    ...(isActive
      ? { ['--persona-pulse-color' as string]: ringColor }
      : { boxShadow: restingShadow }),
  };
  return (
    <div
      ref={rootRef}
      onMouseEnter={openCard}
      onMouseLeave={closeSoon}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        fontSize: 12,
        minWidth: 0,
        position: 'relative',
      }}
    >
      {/* Avatar block ----------------------------------------------------- */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        {avatarUrl ? (
          <span className={isActive ? 'persona-pulse' : undefined} style={avatarStyle}>
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
          <span
            className={isActive ? 'persona-pulse' : undefined}
            style={{
              display: 'inline-flex',
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: ringColor,
              opacity: 0.85,
              ...(isActive
                ? { ['--persona-pulse-color' as string]: ringColor }
                : {}),
            }}
          />
        )}
        {/* Notification badge — top-right corner of the avatar, scoped
            in size so a 3-digit count still fits without ballooning the
            node. Hidden when queue is 0 so the badge is a real signal. */}
        {showQueueBadge && (
          <span
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
        {character && (
          <div style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--feed-fg)',
            whiteSpace: 'nowrap',
            letterSpacing: '-0.005em',
          }}>
            {character}
          </div>
        )}
        <div style={{
          fontSize: 10.5,
          color: 'var(--feed-muted)',
          opacity: 0.92,
          whiteSpace: 'nowrap',
          letterSpacing: '0.005em',
        }}>
          {name}
        </div>
      </div>

      {showCard && (
        <PersonaQueuePopover
          anchor={rootRef.current!}
          personaName={name}
          personaColor={personaColor}
          subtitle={isCodeAgent ? 'Shared code-agent queue · one runs per branch.' : queueTooltip}
          items={items}
          onOpenItem={onOpenItem}
          onMouseEnter={openCard}
          onMouseLeave={closeSoon}
        />
      )}
    </div>
  );
}

/** Status pill metadata for grouping items in the hover card. */
const QUEUE_STATUS_META: Record<string, { label: string; color: string; order: number }> = {
  in_review:                    { label: 'In Review',        color: 'var(--vscode-charts-purple, #c586c0)', order: 0 },
  needs_pm_input:               { label: 'Needs PM',         color: 'var(--vscode-charts-purple, #c586c0)', order: 1 },
  needs_ux_input:               { label: 'Needs UX',         color: 'var(--vscode-charts-orange, #d18616)', order: 2 },
  planning:                     { label: 'Planning',         color: 'var(--vscode-charts-blue, #4e94ce)',   order: 3 },
  ready_to_implement:           { label: 'Ready',            color: 'var(--vscode-charts-blue, #4e94ce)',   order: 4 },
  architecture_review_complete: { label: 'Arch Review Done', color: 'var(--vscode-charts-blue, #4e94ce)',   order: 5 },
  implementing:                 { label: 'Implementing',     color: 'var(--vscode-charts-yellow, #cca700)', order: 6 },
  done:                         { label: 'Done',             color: 'var(--vscode-charts-green, #89d185)',  order: 7 },
};

function groupQueueItemsByStatus(items: PersonaQueueItem[]) {
  const buckets = new Map<string, PersonaQueueItem[]>();
  for (const it of items) {
    const arr = buckets.get(it.status) ?? [];
    arr.push(it);
    buckets.set(it.status, arr);
  }
  return [...buckets.entries()]
    .map(([status, groupItems]) => ({
      key: status,
      label: QUEUE_STATUS_META[status]?.label ?? status,
      color: QUEUE_STATUS_META[status]?.color ?? 'var(--vscode-descriptionForeground)',
      order: QUEUE_STATUS_META[status]?.order ?? 99,
      items: groupItems,
    }))
    .sort((a, b) => a.order - b.order);
}

/**
 * Hover card listing a persona's actual queued work items, grouped by status.
 * Rendered via a portal to `document.body` so it escapes React Flow's node
 * clipping / z-index stacking / drag capture entirely. Anchored to the node's
 * on-screen rect and viewport-clamped. Clicking a row opens that work item.
 */
function PersonaQueuePopover({ anchor, personaName, personaColor, subtitle, items, onOpenItem, onMouseEnter, onMouseLeave }: {
  anchor: HTMLElement;
  personaName: string;
  personaColor: string;
  subtitle: string | undefined;
  items: PersonaQueueItem[];
  onOpenItem: (item: PersonaQueueItem) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const WIDTH = 320;
  const [pos, setPos] = useState<{ left: number; top: number } | undefined>(undefined);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const margin = 8;
    let left = r.left;
    if (left + WIDTH > window.innerWidth - margin) { left = window.innerWidth - WIDTH - margin; }
    if (left < margin) { left = margin; }
    const estHeight = Math.min(360, 96 + items.length * 28);
    const roomBelow = window.innerHeight - r.bottom;
    const top = (roomBelow < estHeight + margin && r.top > estHeight + margin)
      ? r.top - estHeight - 6
      : r.bottom + 6;
    setPos({ left, top });
  }, [anchor, items.length]);

  const groups = useMemo(() => groupQueueItemsByStatus(items), [items]);
  // Until measured, render off-screen to avoid a flash at (0,0).
  const left = pos?.left ?? -9999;
  const top = pos?.top ?? -9999;

  return createPortal(
    <div
      className="nodrag nopan"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'fixed',
        left,
        top,
        width: WIDTH,
        zIndex: 10000,
        background: 'var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)))',
        color: 'var(--vscode-menu-foreground, var(--vscode-foreground))',
        border: '1px solid var(--vscode-menu-border, color-mix(in oklab, var(--vscode-foreground) 18%, transparent))',
        borderRadius: 10,
        boxShadow: '0 10px 30px color-mix(in oklab, black 48%, transparent)',
        overflow: 'hidden',
        fontSize: 12,
        animation: 'vf-pop-in 120ms ease-out',
      }}
    >
      {/* Header: persona-colored accent + name + count */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '9px 12px',
        borderTop: `2px solid ${personaColor}`,
        background: `color-mix(in oklab, ${personaColor} 12%, transparent)`,
        borderBottom: '1px solid color-mix(in oklab, var(--vscode-foreground) 12%, transparent)',
      }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: personaColor, flexShrink: 0 }} />
        <span style={{ fontWeight: 600, color: 'var(--vscode-foreground)' }}>{personaName}</span>
        <span style={{ marginLeft: 'auto', fontWeight: 700, color: personaColor, fontVariantNumeric: 'tabular-nums' }}>
          {items.length}
        </span>
      </div>

      {subtitle && (
        <div style={{
          padding: '6px 12px',
          fontSize: 10.5,
          lineHeight: 1.4,
          color: 'var(--vscode-descriptionForeground)',
          borderBottom: '1px solid color-mix(in oklab, var(--vscode-foreground) 8%, transparent)',
        }}>
          {subtitle}
        </div>
      )}

      {/* Body: items grouped by status, scrollable */}
      <div style={{ maxHeight: 300, overflowY: 'auto', padding: '4px 6px 8px' }}>
        {groups.map(g => (
          <div key={g.key} style={{ marginTop: 4 }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 6px 3px',
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: 'var(--vscode-descriptionForeground)',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: 2, background: g.color, flexShrink: 0 }} />
              {g.label}
              <span style={{ marginLeft: 'auto', opacity: 0.7 }}>{g.items.length}</span>
            </div>
            {g.items.map(it => (
              <button
                key={`${it.type}-${it.id}`}
                type="button"
                onClick={() => onOpenItem(it)}
                title={it.title}
                className="hover:bg-[var(--vscode-list-hoverBackground)]"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  padding: '5px 6px',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--vscode-foreground)',
                  cursor: 'pointer',
                  borderRadius: 6,
                  font: 'inherit',
                }}
              >
                <span style={{
                  fontFamily: 'var(--vscode-editor-font-family, monospace)',
                  fontSize: 10.5,
                  color: 'var(--vscode-descriptionForeground)',
                  flexShrink: 0,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {it.type === 'issue' ? '◆' : '○'} #{it.id}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.title}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Floating chip rendered as a React Flow node above the code-agent
 * cluster. Conveys the "one active code agent per branch" constraint
 * once for the whole cluster instead of duplicating an orange `1/branch`
 * pill on each of the three agent nodes. Non-draggable, non-clickable.
 */
function SlotLabelNode({ data }: { data: { label: string } }) {
  return (
    <div
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        padding: '3px 9px',
        borderRadius: 999,
        background: 'color-mix(in oklab, var(--vscode-charts-orange, #d18616) 14%, transparent)',
        color: 'var(--vscode-charts-orange, #d18616)',
        border: '1px solid color-mix(in oklab, var(--vscode-charts-orange, #d18616) 32%, transparent)',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      {data.label}
    </div>
  );
}

const NODE_TYPES = {
  slotLabel: SlotLabelNode,
} as const;

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

/**
 * Explain ↔ Live segmented toggle for the topology section (#2329). Explain is
 * the static teaching chart; Live shows running sessions grouped by branch.
 */
function TopologyModeToggle({ mode, onChange }: { mode: 'explain' | 'live'; onChange: (m: 'explain' | 'live') => void }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--feed-border)', borderRadius: 6, overflow: 'hidden' }}>
      {(['explain', 'live'] as const).map(m => (
        <button
          key={m}
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          title={m === 'explain'
            ? 'How the personas and pipeline work (teaching view)'
            : 'What’s running right now — sessions grouped by branch'}
          style={{
            fontSize: 11, fontWeight: 600, padding: '5px 11px', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 5,
            background: mode === m ? 'color-mix(in oklab, var(--feed-link) 18%, transparent)' : 'transparent',
            color: mode === m ? 'var(--feed-link)' : 'var(--feed-muted)',
          }}
        >
          {m === 'live' && (
            <span
              className={mode === 'live' ? 'persona-pulse' : undefined}
              style={{ width: 6, height: 6, borderRadius: '50%', background: mode === 'live' ? 'var(--feed-success)' : 'var(--feed-muted)' }}
            />
          )}
          {m === 'explain' ? 'Explain' : 'Live'}
        </button>
      ))}
    </div>
  );
}

/**
 * Live Agent Topology (feature 472). One team-per-branch band per active branch
 * — its whole crew laid out as an upstream→code→review mini-pipeline, with
 * flowing-token edges + breathing liveness rings. Mirrors the host LiveSnapshot.
 */
const LIVE_FIT = { padding: 0.18 };

function LiveTopology({ live }: { live: LiveSnapshot | undefined }) {
  const graph = useMemo(() => buildLiveGraph(live), [live]);
  if (!live || live.total === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--feed-muted)' }}>
        <div style={{ fontSize: 26, opacity: 0.45 }}>◍</div>
        <div style={{ fontSize: 13 }}>No agents are running right now.</div>
        <div style={{ fontSize: 11, opacity: 0.7 }}>Launch a session and it’ll appear here live.</div>
      </div>
    );
  }
  return (
    <ReactFlow
      nodes={graph.nodes}
      edges={graph.edges}
      nodeTypes={LIVE_NODE_TYPES}
      edgeTypes={LIVE_EDGE_TYPES}
      fitView
      fitViewOptions={LIVE_FIT}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnScroll={false}
      panOnDrag={true}
      minZoom={0.4}
    >
      <Background
        variant={BackgroundVariant.Lines}
        color="color-mix(in oklab, var(--vscode-foreground) 5%, transparent)"
        gap={24}
        lineWidth={0.7}
      />
      {/* Out-of-the-box controls: zoom +/- · fit · and an overview minimap. */}
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeStrokeWidth={2}
        maskColor="color-mix(in oklab, var(--vscode-foreground) 10%, transparent)"
        style={{ background: 'var(--vscode-editor-background)', border: '1px solid var(--feed-border)' }}
      />
    </ReactFlow>
  );
}

/**
 * Lay out the live snapshot as team-per-branch bands (#2333): one group node
 * per branch, and inside it a 3-column mini-pipeline of THAT branch's team —
 * upstream (PM/UX/PMgr/Customer) → code (the lock holder) → review (Security,
 * QA). Flow edges are INTRA-lane (agent→agent), so two PMs on different
 * branches never connect. Manual coords; P4 adds elk auto-layout.
 */
// Sort order within each role column (pipeline order — Security before QA).
const PERSONA_ORDER: Record<string, number> = {
  product_manager: 0, ux_designer: 1, project_manager: 2, customer: 3,
  architect: 0, developer: 1, principal_engineer: 2,
  security_lead: 0, qa_lead: 1,
};
const byPersonaOrder = (a: LiveAgent, b: LiveAgent): number =>
  (PERSONA_ORDER[a.personaKey] ?? 99) - (PERSONA_ORDER[b.personaKey] ?? 99);
const eid = (a: LiveAgent): string => `ag-${a.sessionId}`;

function buildLiveGraph(live: LiveSnapshot | undefined): { nodes: Node[]; edges: Edge[] } {
  if (!live) { return { nodes: [], edges: [] }; }
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const edgeType = prefersReducedMotion() ? 'default' : 'flow';

  const HEADER = 40, TOP_PAD = 16, BOT_PAD = 16, AGENT_H = 74;
  const COL_X = [16, 300, 584]; // upstream · code · review — generous gaps
  const BAND_W = 786, BAND_VGAP = 30;
  let y = 0;

  live.branches.forEach(b => {
    const groupId = `br-${b.branch}`;
    const up = b.agents.filter(a => a.role === 'upstream').sort(byPersonaOrder);
    const code = b.agents.filter(a => a.role === 'code').sort(byPersonaOrder);
    const rev = b.agents.filter(a => a.role === 'review').sort(byPersonaOrder);
    const rows = Math.max(up.length, code.length, rev.length, 1);
    const height = HEADER + TOP_PAD + rows * AGENT_H + BOT_PAD;

    nodes.push({ id: groupId, type: 'liveBranch', position: { x: 0, y }, data: { branch: b.branch, count: b.agents.length }, style: { width: BAND_W, height }, draggable: false, selectable: false });

    const place = (list: LiveAgent[], colX: number) => list.forEach((a, i) => {
      nodes.push({ id: `ag-${a.sessionId}`, type: 'liveAgent', position: { x: colX, y: HEADER + TOP_PAD + i * AGENT_H }, data: { agent: a }, parentId: groupId, extent: 'parent', draggable: false, selectable: false });
    });
    place(up, COL_X[0]);
    place(code, COL_X[1]);
    place(rev, COL_X[2]);

    // Sequential pipeline edges: upstream → code → Security → QA. When a stage
    // is absent, bridge to the next present one so the flow still reads.
    const sec = rev.filter(a => a.personaKey === 'security_lead');
    const qa = rev.filter(a => a.personaKey !== 'security_lead');
    const builders = code.length ? code : up;
    if (code.length) {
      for (const u of up) { for (const c of code) { edges.push(liveEdge(eid(u), eid(c), edgeType)); } }
    }
    if (sec.length) {
      for (const s of builders) { for (const t of sec) { edges.push(liveEdge(eid(s), eid(t), edgeType)); } }
      for (const s of sec) { for (const q of qa) { edges.push(liveEdge(eid(s), eid(q), edgeType)); } }
    } else {
      for (const s of builders) { for (const q of qa) { edges.push(liveEdge(eid(s), eid(q), edgeType)); } }
    }

    y += height + BAND_VGAP;
  });

  return { nodes, edges };
}

function liveEdge(source: string, target: string, type: string): Edge {
  return {
    id: `e-${source}-${target}`, source, target, type,
    style: { stroke: 'color-mix(in oklab, var(--feed-link) 45%, transparent)', strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--feed-link)', width: 14, height: 14 },
  };
}

function livenessRing(liveness: LiveAgent['liveness'], personaColor: string): string {
  return liveness === 'active' ? personaColor : liveness === 'stale' ? 'var(--feed-warning)' : 'var(--feed-muted)';
}

function LivenessAvatar({ agent, color, size }: { agent: LiveAgent; color: string; size: number }) {
  const ring = livenessRing(agent.liveness, color);
  const isActive = agent.liveness === 'active';
  return (
    <div
      // Active agents BREATHE — reuse the existing persona-pulse halo keyframe
      // (already prefers-reduced-motion shielded). Stale/idle stay static.
      className={isActive ? 'persona-pulse' : undefined}
      style={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0, padding: 2,
        border: `2px solid ${ring}`,
        opacity: agent.liveness === 'dead' ? 0.5 : 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
        ...(isActive ? { ['--persona-pulse-color' as string]: color } : {}),
      }}
    >
      {agent.avatarUrl
        ? <img src={agent.avatarUrl} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
        : <span style={{ fontSize: size * 0.4, fontWeight: 700, color }}>{(agent.characterName ?? agent.personaName).charAt(0).toUpperCase()}</span>}
    </div>
  );
}

function LivenessLabel({ liveness }: { liveness: LiveAgent['liveness'] }) {
  const [label, c] = liveness === 'active'
    ? ['Active', 'var(--feed-success, #3fb950)']
    : liveness === 'stale'
      ? ['Stale', 'var(--feed-warning)']
      : ['Idle', 'var(--feed-muted)'];
  return <span style={{ color: c, fontWeight: 600 }}>{label}</span>;
}

/** Invisible handles — Live edges connect nodes programmatically (#2331). */
const HIDDEN_HANDLE = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 'none', background: 'transparent', pointerEvents: 'none' as const };

/**
 * Floating live-detail card for an agent node (#2330). Uses React Flow's
 * NodeToolbar so it renders OUTSIDE the canvas viewport — never clipped or
 * zoom-scaled. Driven by the node's own hover state.
 */
function AgentDetailToolbar({ agent, visible }: { agent: LiveAgent; visible: boolean }) {
  return (
    <NodeToolbar isVisible={visible} position={Position.Top} offset={8}>
      <div style={{ width: 244, textAlign: 'left', background: 'var(--vscode-editorHoverWidget-background, var(--feed-bg))', border: '1px solid var(--vscode-editorHoverWidget-border, var(--feed-border))', borderRadius: 6, padding: '9px 11px', fontSize: 11, lineHeight: 1.5, color: 'var(--feed-fg)', boxShadow: '0 6px 24px rgba(0,0,0,0.35)' }}>
        <div style={{ fontWeight: 700, marginBottom: 5 }}>
          {agent.characterName ?? agent.personaName}
          <span style={{ color: 'var(--feed-muted)', fontWeight: 400 }}> · {agent.personaName}</span>
        </div>
        <DetailRow label="Branch" value={agent.branch} mono />
        {agent.agentModel && <DetailRow label="Model" value={agent.agentModel} />}
        {agent.workDir && <DetailRow label="Dir" value={agent.workDir} mono truncate />}
        <DetailRow label="State" value={agent.liveness === 'active' ? 'Active' : agent.liveness === 'stale' ? `Stale · last seen ${formatAge(agent.lastHeartbeat) ?? 'a while ago'}` : 'Idle'} />
        {!!agent.pendingPrompts && agent.pendingPrompts > 0 && (
          <div style={{ marginTop: 6, color: 'var(--feed-warning)', fontWeight: 600 }}>⚠ Waiting for your input ({agent.pendingPrompts})</div>
        )}
        {agent.lastMessage && (
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--feed-border)', color: 'var(--feed-muted)' }}>{agent.lastMessage}</div>
        )}
      </div>
    </NodeToolbar>
  );
}

function DetailRow({ label, value, mono, truncate }: { label: string; value: string; mono?: boolean; truncate?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <span style={{ color: 'var(--feed-muted)', minWidth: 44, flexShrink: 0 }}>{label}</span>
      <span style={{ minWidth: 0, fontFamily: mono ? 'var(--vscode-editor-font-family)' : undefined, overflow: truncate ? 'hidden' : undefined, textOverflow: truncate ? 'ellipsis' : undefined, whiteSpace: truncate ? 'nowrap' : 'normal' }}>{value}</span>
    </div>
  );
}

/** Branch team band — a group/sub-flow container; its team renders inside. */
function LiveBranchNode({ data }: NodeProps) {
  const { branch, count } = data as { branch: string; count: number };
  return (
    <div style={{ width: '100%', height: '100%', borderRadius: 10, border: '1px solid var(--feed-border)', background: 'color-mix(in oklab, var(--vscode-editor-background) 92%, transparent)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderBottom: '1px solid var(--feed-border)', fontSize: 11, fontWeight: 600, color: 'var(--feed-fg)' }}>
        <GitBranchIcon size={12} />
        <span style={{ fontFamily: 'var(--vscode-editor-font-family)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{branch}</span>
        <span style={{ marginLeft: 'auto', fontWeight: 400, color: 'var(--feed-muted)' }}>{count} agent{count === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}

/** A team member card (child of a branch band). One node type for every role;
 *  hidden handles carry the intra-lane upstream→code→review flow edges. */
function LiveAgentNode({ data }: NodeProps) {
  const agent = (data as { agent: LiveAgent }).agent;
  const [hov, setHov] = useState(false);
  const color = PERSONA_COLORS[agent.personaKey] ?? 'var(--vscode-foreground)';
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: 186, padding: '4px 8px 4px 4px', borderRadius: 8, border: '1px solid var(--feed-border)', background: 'var(--vscode-editor-background)' }}
    >
      <Handle type="target" position={Position.Left} style={HIDDEN_HANDLE} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={HIDDEN_HANDLE} isConnectable={false} />
      <AgentDetailToolbar agent={agent} visible={hov} />
      <LivenessAvatar agent={agent} color={color} size={30} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--feed-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.characterName ?? agent.personaName}</div>
        <div style={{ fontSize: 9.5, color: 'var(--feed-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {agent.personaName} · <LivenessLabel liveness={agent.liveness} />
          {agent.liveness === 'stale' && agent.lastHeartbeat ? ` · ${formatAge(agent.lastHeartbeat)}` : ''}
        </div>
      </div>
      {!!agent.pendingPrompts && agent.pendingPrompts > 0 && (
        <span title="Waiting for your input" style={{ color: 'var(--feed-warning)', fontWeight: 800, flexShrink: 0 }}>!</span>
      )}
    </div>
  );
}

const LIVE_NODE_TYPES = {
  liveBranch: LiveBranchNode,
  liveAgent: LiveAgentNode,
};

/** True when the user opted out of decorative motion. SMIL <animateMotion> is
 *  NOT covered by the CSS reduced-motion shield, so the token is gated here. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A pipeline edge with a work-item TOKEN flowing along it (#2331) — the
 * signature "alive pipeline" effect. The dot rides the bezier path via SVG
 * <animateMotion>. Under prefers-reduced-motion we use a plain edge instead.
 */
function FlowEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style }: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      <circle r={3.2} fill="var(--feed-link)" style={{ filter: 'drop-shadow(0 0 3px var(--feed-link))' }}>
        <animateMotion dur="2.6s" repeatCount="indefinite" path={path} />
      </circle>
    </>
  );
}

const LIVE_EDGE_TYPES = { flow: FlowEdge };

/** Relative age of a timestamp, for stale "last seen" hints. */
function formatAge(iso: string | undefined): string | null {
  if (!iso) { return null; }
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) { return null; }
  const m = Math.floor(ms / 60000);
  if (m < 1) { return 'just now'; }
  if (m < 60) { return `${m}m ago`; }
  return `${Math.floor(m / 60)}h ago`;
}

function Header({ snapshot, loading, onRefresh, kanbanEmbedded, onToggleKanban }: {
  snapshot: DashboardSnapshot | undefined;
  loading: boolean;
  onRefresh: () => void;
  kanbanEmbedded: boolean;
  onToggleKanban: () => void;
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        {/* Embedded-Kanban toggle — left of Refresh. */}
        <button
          onClick={onToggleKanban}
          aria-pressed={kanbanEmbedded}
          title="Show the Kanban board inside the dashboard, under the topology"
          className="transition-all duration-150 ease-out active:scale-[0.97] hover:bg-[var(--vscode-list-hoverBackground)]"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 10px',
            fontSize: 11,
            fontWeight: 500,
            borderRadius: 4,
            border: '1px solid var(--feed-border)',
            background: kanbanEmbedded ? 'color-mix(in oklab, var(--feed-link) 18%, transparent)' : 'transparent',
            color: kanbanEmbedded ? 'var(--feed-link)' : 'var(--feed-muted)',
            cursor: 'pointer',
          }}
        >
          <span style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: kanbanEmbedded ? 'var(--feed-link)' : 'var(--feed-muted)',
            flexShrink: 0,
          }} />
          Kanban
        </button>
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
          value={`${snapshot.sessions.active}`}
          sub={
            snapshot.sessions.stale > 0
              ? `${snapshot.sessions.stale} stale`
              : snapshot.sessions.active > 0
                ? `${snapshot.sessions.active === 1 ? 'session' : 'sessions'} active`
                : 'no sessions running'
          }
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
  if (!snapshot && loading) { return <Skeleton rows={1} />; }
  if (!snapshot) { return null; }

  const f = snapshot.findings;

  // Branch readiness card is hidden for v1.1 — the
  // `check_branch_review_status` data source needs a second pass before
  // its semantics fully agree with the rest of the dashboard. The host
  // still fetches `branchReview` so we have ready data when the card
  // returns; see GovernanceGrid history for the full render code.
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
          This project's open findings, after SLA grace windows
        </div>
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
