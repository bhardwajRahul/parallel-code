import type { AgentChatState } from '../shared/agent-chat-types.js';

export interface AgentChat {
  readonly state: AgentChatState;
  subscribe(publish: (state: AgentChatState) => void): void;
  observe(listener: (state: AgentChatState) => void): () => void;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  respond(
    id: string | number,
    decision: 'accept' | 'decline',
    answers?: Record<string, string>,
  ): void;
  loadModels(): Promise<void>;
  selectModel(model: string, reasoningEffort?: string): void | Promise<void>;
  stop(): void;
}

export interface ChatStartOptions {
  provider: 'codex' | 'claude';
  agentId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  threadId?: string;
  skipPermissions?: boolean;
}
