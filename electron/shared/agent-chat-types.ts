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

export interface ChatRequest {
  id: string | number;
  since: number;
  kind: 'approval' | 'question';
  text: string;
  questions?: ChatQuestion[];
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
}
