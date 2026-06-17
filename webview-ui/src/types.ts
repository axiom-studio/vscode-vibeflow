// Mirrors src/api/types.ts — shared protocol between extension host and webview.
// Kept as a separate copy to avoid cross-project imports.

export type ActivityMessageType =
  | 'status_change'
  | 'thinking'
  | 'action'
  | 'observation'
  | 'prompt'
  | 'commit'
  | 'completion'
  | 'error'
  | 'summary';

export interface ActivityEntry {
  id: string;
  timestamp: string;
  personaKey: string;
  personaName: string;
  messageType: ActivityMessageType;
  content: string;
  metadata?: Record<string, unknown>;
}

// Mirror of FeedState in src/core/webviewMessages.ts. Kept duplicated to
// avoid cross-project imports; the host is the source of truth and the
// webview combines this with `entries.length` to render one of the four
// presentations from Design Spec Doc #224 §"Activity Feed States".
export type FeedState =
  | { kind: 'unauthenticated' }
  | { kind: 'noSessions' }
  | { kind: 'sessionsActive' }
  | { kind: 'disconnected' };

// Extension -> Webview
export type ExtensionMessage =
  | { type: 'activityEntry'; payload: ActivityEntry }
  | { type: 'activityEntries'; payload: ActivityEntry[] }
  | { type: 'clearActivity'; payload: undefined }
  | { type: 'feedState'; payload: FeedState };

// Webview -> Extension
export type WebviewMessage =
  | { type: 'respondToPrompt'; payload: { promptId: string; response: string } }
  | { type: 'ready'; payload: undefined }
  // Empty-state CTA dispatches.
  | { type: 'runSetup'; payload: undefined }
  | { type: 'launchSession'; payload: undefined };

// Persona color mapping.
//
// Vibrant, identity-first palette (replaces the old VS Code *syntax-token*
// colors, which are deliberately low-chroma for fatigue-free code reading and
// read washed-out as UI accents). Tuned for high chroma at ~even perceptual
// lightness (so none washes out on a dark editor bg) with hues spread evenly
// around the wheel for 9-way distinguishability. Semantic anchors kept:
// security = red, qa = green, developer = blue. Used for the chat author name,
// the agent-bubble tint/border, the avatar fallback, and the activity-feed
// persona dots. NOTE: the brightest hues (amber/lime/cyan) have weaker text
// contrast on *light* themes — a theme-aware palette is a tracked follow-up.
export const PERSONA_COLORS: Record<string, string> = {
  developer: '#4d9fff',          // blue
  architect: '#b483ff',          // violet
  principal_engineer: '#ffcf4a', // amber  (was khaki #dcdcaa)
  security_lead: '#ff5d5d',      // red
  qa_lead: '#43d782',            // emerald
  product_manager: '#ff9a3d',    // orange (was tan #ce9178)
  project_manager: '#34d6e0',    // cyan   (was pale-blue #9cdcfe)
  ux_designer: '#ff70c4',        // pink   (was gold #d7ba7d)
  customer: '#b6e84a',           // lime   (was sage #b5cea8)
};

// Message type icons
export const MESSAGE_ICONS: Record<ActivityMessageType, string> = {
  status_change: '🔄',
  thinking: '🤔',
  action: '⚡',
  observation: '👁',
  prompt: '❓',
  commit: '📝',
  completion: '✅',
  error: '❌',
  summary: '📋',
};

// ===========================================================================
// Compliance — mirror of src/api/types.ts. Wire shape per
// axiomcloud/database/vibeflow_models.go.
// ===========================================================================
export interface VibeFlowComplianceTag {
  id: number;
  finding_id: number;
  framework: string;
  section_reference?: string;
  notes?: string;
}

export interface VibeFlowComplianceFinding {
  id: number;
  created_at: string;
  updated_at: string;
  project_id: number;
  feature_id?: number;
  work_item_type: string;
  work_item_id: number;
  source_item_type?: string;
  source_item_id?: number;
  finding_type: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'informational';
  status: 'open' | 'in_progress' | 'resolved' | 'accepted_risk';
  effective_status?: string;
  description?: string;
  resolved_at?: string;
  resolved_by?: string;
  resolution_commit?: string;
  remediation_notes?: string;
  backward_compatible?: boolean;
  compliance_tags?: VibeFlowComplianceTag[];
}
