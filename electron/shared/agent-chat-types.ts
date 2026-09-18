export interface ChatItem {
  id: string;
  kind: 'user' | 'assistant' | 'tool';
  text: string;
  activity?: {
    type: 'command' | 'files' | 'tool';
    label: string;
    status: 'running' | 'completed' | 'failed' | 'declined' | 'interrupted';
    exitCode?: number;
  };
}

export interface ChatQuestion {
  id: string;
  question: string;
  isSecret: boolean;
  multiSelect?: boolean;
  options: { label: string; description: string }[];
}

/** How the user answered a request. 'accept-always' also stops the agent asking again. */
export type ChatDecision = 'accept' | 'accept-always' | 'decline';

export function isChatDecision(value: unknown): value is ChatDecision {
  return value === 'accept' || value === 'accept-always' || value === 'decline';
}

export interface ChatRequest {
  id: string | number;
  since: number;
  kind: 'approval' | 'question';
  /** What the agent wants to do, in the agent's own words. */
  text: string;
  /** Short noun phrase for the action, e.g. "Read file". Heads the card when present. */
  action?: string;
  /** The raw tool name and arguments, shown only when the user opens the details. */
  details?: string;
  questions?: ChatQuestion[];
  /** The agent asked that approval not be one keystroke away; open the card on Decline. */
  defaultToNo?: boolean;
  /** Approving can be remembered, so this ask does not come back. */
  canAlwaysAllow?: boolean;
  /** What remembering would change, including any settings file it would write. */
  alwaysAllowNote?: string;
}

/**
 * Permission modes a chat session can run in. 'bypassPermissions' is missing on
 * purpose: it cannot be switched on mid-session, so it stays the task's own
 * "skip permissions" setting, applied when the session launches.
 */
export const CHAT_PERMISSION_MODES = ['default', 'auto', 'acceptEdits', 'plan'] as const;
export type ChatPermissionMode = (typeof CHAT_PERMISSION_MODES)[number];

export function isChatPermissionMode(value: unknown): value is ChatPermissionMode {
  return CHAT_PERMISSION_MODES.includes(value as ChatPermissionMode);
}

export interface ChatModel {
  model: string;
  displayName: string;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
}

export interface AgentChatState {
  model?: string;
  reasoningEffort?: string;
  models?: ChatModel[];
  modelsError?: string;
  threadId?: string;
  status: 'starting' | 'ready' | 'working' | 'closed';
  items: ChatItem[];
  requests: ChatRequest[];
  error?: string;
  /** The mode the agent reports it is actually running in, once it says so. */
  permissionMode?: string;
  /** Why the running mode differs from the one the user configured, if it does. */
  permissionNote?: string;
}
