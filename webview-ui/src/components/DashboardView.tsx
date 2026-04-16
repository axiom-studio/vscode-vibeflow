import { useCallback } from 'react';
import {
  ReactFlow,
  Background,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const PERSONA_COLORS: Record<string, string> = {
  developer: '#4fc1ff',
  architect: '#c586c0',
  principal_engineer: '#dcdcaa',
  security_lead: '#f44747',
  qa_lead: '#4ec86e',
  product_manager: '#ce9178',
  project_manager: '#9cdcfe',
  ux_designer: '#d7ba7d',
  customer: '#b5cea8',
};

/**
 * Dashboard / Mission Control.
 * Shows agent topology graph with persona nodes and workflow edges.
 * MVP: static layout with hardcoded node positions. V2 will auto-layout.
 */
export function DashboardView() {
  // Static persona nodes in a workflow layout
  const nodes: Node[] = [
    { id: 'pm', position: { x: 50, y: 50 }, data: { label: 'Product Manager' }, style: nodeStyle('product_manager') },
    { id: 'arch', position: { x: 250, y: 50 }, data: { label: 'Architect' }, style: nodeStyle('architect') },
    { id: 'dev', position: { x: 250, y: 200 }, data: { label: 'Developer' }, style: nodeStyle('developer') },
    { id: 'pe', position: { x: 450, y: 200 }, data: { label: 'Principal Eng' }, style: nodeStyle('principal_engineer') },
    { id: 'qa', position: { x: 450, y: 50 }, data: { label: 'QA Lead' }, style: nodeStyle('qa_lead') },
    { id: 'sec', position: { x: 650, y: 50 }, data: { label: 'Security Lead' }, style: nodeStyle('security_lead') },
    { id: 'ux', position: { x: 50, y: 200 }, data: { label: 'UX Designer' }, style: nodeStyle('ux_designer') },
    { id: 'projm', position: { x: 650, y: 200 }, data: { label: 'Project Mgr' }, style: nodeStyle('project_manager') },
    { id: 'cust', position: { x: 350, y: 350 }, data: { label: 'Customer' }, style: nodeStyle('customer') },
  ];

  // Workflow edges showing typical task flow
  const edges: Edge[] = [
    { id: 'e-pm-arch', source: 'pm', target: 'arch', animated: true, style: { stroke: '#555' } },
    { id: 'e-arch-dev', source: 'arch', target: 'dev', animated: true, style: { stroke: '#555' } },
    { id: 'e-dev-qa', source: 'dev', target: 'qa', animated: true, style: { stroke: '#555' } },
    { id: 'e-qa-sec', source: 'qa', target: 'sec', style: { stroke: '#555' } },
    { id: 'e-dev-pe', source: 'dev', target: 'pe', style: { stroke: '#555', strokeDasharray: '5,5' } },
    { id: 'e-ux-pm', source: 'ux', target: 'pm', style: { stroke: '#555', strokeDasharray: '5,5' } },
    { id: 'e-cust-pm', source: 'cust', target: 'pm', style: { stroke: '#555', strokeDasharray: '5,5' } },
    { id: 'e-sec-projm', source: 'sec', target: 'projm', style: { stroke: '#555' } },
  ];

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    // In production, this would focus the terminal for this persona
    console.log('[Dashboard] Clicked:', node.id);
  }, []);

  return (
    <div style={{ width: '100%', height: '100vh', background: 'var(--feed-bg)' }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--feed-border)',
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--feed-fg)',
      }}>
        VibeFlow Dashboard
      </div>
      <div style={{ width: '100%', height: 'calc(100vh - 44px)' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={onNodeClick}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--feed-border)" gap={20} />
        </ReactFlow>
      </div>
    </div>
  );
}

function nodeStyle(persona: string): React.CSSProperties {
  return {
    background: 'var(--vscode-editor-background)',
    border: `2px solid ${PERSONA_COLORS[persona] ?? '#555'}`,
    borderRadius: 8,
    padding: '8px 16px',
    fontSize: 12,
    color: 'var(--feed-fg)',
    fontFamily: 'var(--vscode-font-family)',
  };
}
