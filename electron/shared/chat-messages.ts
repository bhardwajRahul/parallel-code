import type { Message } from '@ag-ui/core';
import type { AgentChatState } from './agent-chat-types.js';

export interface ChatConnection {
  url: string;
  token: string;
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
