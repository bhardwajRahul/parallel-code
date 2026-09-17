import type { Message } from '@ag-ui/core';
import type { AgentChatState, ChatModel } from './agent-chat-types.js';

export interface ChatConnection {
  url: string;
  token: string;
}

/** The catalog entry for the model the next message would use, if it is known. */
export function selectedChatModel(state: AgentChatState): ChatModel | undefined {
  return state.models?.find((model) => model.model === state.model);
}

/** Effort the next message would use: the explicit choice, else the model's own
 *  default. The chat header and the picker must agree on this. */
export function effectiveReasoningEffort(state: AgentChatState): string | undefined {
  return state.reasoningEffort ?? selectedChatModel(state)?.defaultReasoningEffort;
}

/** Display form of a reasoning effort, which the agents report lowercase. */
export function reasoningEffortLabel(effort: string): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** Keep backend IDs stable across streaming updates and reconnects. */
export function chatMessages(state: AgentChatState): Message[] {
  return state.items.flatMap<Message>((item) =>
    item.kind === 'tool'
      ? [
          {
            id: item.id,
            role: 'assistant',
            toolCalls: [
              { id: item.id, type: 'function', function: { name: 'activity', arguments: '{}' } },
            ],
          },
          { id: `${item.id}:result`, role: 'tool', toolCallId: item.id, content: item.text },
        ]
      : [{ id: item.id, role: item.kind, content: item.text }],
  );
}
