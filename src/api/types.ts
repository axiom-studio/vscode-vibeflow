// Typed postMessage protocol for extension <-> webview communication.
// This abstraction allows swapping transport (postMessage -> gRPC) without touching consumers.

export type MessageType =
  | 'activityEntry'
  | 'activityEntries'
  | 'clearActivity'
  | 'respondToPrompt'
  | 'ready';

export interface Message<T extends MessageType = MessageType, P = unknown> {
  type: T;
  payload: P;
}

// --- Extension -> Webview messages ---

export interface ActivityEntry {
  id: string;
  timestamp: string;
  personaKey: string;
  personaName: string;
  messageType:
    | 'status_change'
    | 'thinking'
    | 'action'
    | 'observation'
    | 'prompt'
    | 'commit'
    | 'completion'
    | 'error'
    | 'summary';
  content: string;
  metadata?: Record<string, unknown>;
}

export type ActivityEntryMessage = Message<'activityEntry', ActivityEntry>;
export type ActivityEntriesMessage = Message<'activityEntries', ActivityEntry[]>;
export type ClearActivityMessage = Message<'clearActivity', undefined>;

// --- Webview -> Extension messages ---

export interface PromptResponsePayload {
  promptId: string;
  response: string;
}

export type RespondToPromptMessage = Message<'respondToPrompt', PromptResponsePayload>;
export type ReadyMessage = Message<'ready', undefined>;

// Union types for type-safe message handling
export type ExtensionToWebviewMessage =
  | ActivityEntryMessage
  | ActivityEntriesMessage
  | ClearActivityMessage;

export type WebviewToExtensionMessage =
  | RespondToPromptMessage
  | ReadyMessage;

// --- MCP API response types (placeholders) ---

export interface VibeFlowProject {
  id: number;
  name: string;
  status: string;
  gitRemoteUrl?: string;
}

export interface VibeFlowSession {
  id: string;
  sid: number;
  projectId: number;
  personaKey: string;
  personaName: string;
  agentType: string;
  agentModel: string;
  gitBranch: string;
  status: 'active' | 'idle' | 'error' | 'stopped';
  currentWorkItem?: {
    id: number;
    type: 'todo' | 'issue';
    title: string;
    status: string;
  };
  heartbeatAt?: string;
}

export interface VibeFlowFeature {
  id: number;
  name: string;
  status: string;
  priority: string;
  projectId: number;
}

export interface VibeFlowTodo {
  id: number;
  title: string;
  status: string;
  priority: string;
  featureId: number;
  targetBranch: string;
  claimedBy?: string;
  qaVerified?: boolean;
  securityReviewed?: boolean;
}

export interface VibeFlowIssue {
  id: number;
  title: string;
  status: string;
  priority: string;
  projectId: number;
  targetBranch: string;
  featureId?: number;
  claimedBy?: string;
  qaVerified?: boolean;
  securityReviewed?: boolean;
}

export interface VibeFlowDocument {
  id: number;
  title: string;
  type: 'prd' | 'architecture' | 'style_guide' | 'design_system' | 'general';
  projectId: number;
}

export interface VibeFlowComment {
  id: number;
  entity_type: 'document' | 'context';
  entity_id: number;
  project_id: number;
  section_heading: string;
  content: string;
  user_id: number;
  user_email?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateCommentInput {
  entityType: 'document' | 'context';
  entityId: number;
  projectId: number;
  sectionHeading: string;
  content: string;
}
