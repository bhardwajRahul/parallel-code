import type {
  AgentChatState,
  ChatDecision,
  ChatImage,
  ChatPermissionMode,
} from '../shared/agent-chat-types.js';

export interface AgentChat {
  readonly state: AgentChatState;
  subscribe(publish: (state: AgentChatState) => void): void;
  observe(listener: (state: AgentChatState) => void): () => void;
  send(text: string, images?: ChatImage[]): Promise<void>;
  interrupt(): Promise<void>;
  respond(id: string | number, decision: ChatDecision, answers?: Record<string, string>): void;
  loadModels(): Promise<void>;
  selectModel(model: string, reasoningEffort?: string): void | Promise<void>;
  /** Only agents whose CLI can change mode mid-session offer this. */
  setPermissionMode?(mode: ChatPermissionMode): Promise<void>;
  /** `immediate` is for app shutdown: no process may outlive Electron waiting on a timer. */
  stop(immediate?: boolean): void;
}

export interface ChatStartOptions {
  provider: 'codex' | 'claude';
  agentId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  threadId?: string;
  skipPermissions?: boolean;
  /** The mode the user picked for this task, overriding their settings' defaultMode. */
  permissionMode?: ChatPermissionMode;
  /** App-owned, task-scoped MCP configuration generated at session startup. */
  mcpArgs?: string[];
}
