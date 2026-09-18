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

/** A tool run keeps its first ID as it grows, so open details survive streaming. */
export function chatMessages(state: AgentChatState): Message[] {
  const messages: Message[] = [];
  let group: Extract<Message, { role: 'assistant' }> | undefined;
  for (const item of state.items) {
    if (item.kind !== 'tool') {
      group = undefined;
      messages.push({ id: item.id, role: item.kind, content: item.text });
      continue;
    }
    if (!group) {
      group = { id: item.id, role: 'assistant', toolCalls: [] };
      messages.push(group);
    }
    group.toolCalls?.push({
      id: item.id,
      type: 'function',
      function: { name: 'activity', arguments: '{}' },
    });
    messages.push({
      id: `${item.id}:result`,
      role: 'tool',
      toolCallId: item.id,
      content: item.text,
    });
  }
  return messages;
}
