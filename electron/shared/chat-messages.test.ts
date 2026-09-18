import { describe, expect, it } from 'vitest';
import { chatMessages } from './chat-messages.js';
import {
  restoreChatSessions,
  validateChatImages,
  type AgentChatState,
} from './agent-chat-types.js';

describe('chat presentation data', () => {
  it('groups only consecutive operations and keeps stable IDs and tool results', () => {
    const state: AgentChatState = {
      status: 'working',
      requests: [],
      items: [
        { id: 'u', kind: 'user', text: 'Fix it' },
        { id: 't1', kind: 'tool', text: 'Read a' },
        { id: 't2', kind: 'tool', text: 'Read b' },
        { id: 'a', kind: 'assistant', text: 'Found it' },
        { id: 't3', kind: 'tool', text: 'Run tests' },
      ],
    };
    const messages = chatMessages(state);
    expect(messages.map((message) => message.id)).toEqual([
      'u',
      't1',
      't1:result',
      't2:result',
      'a',
      't3',
      't3:result',
    ]);
    expect(messages[1]).toMatchObject({ toolCalls: [{ id: 't1' }, { id: 't2' }] });
    expect(messages[3]).toMatchObject({ toolCallId: 't2', content: 'Read b' });
    state.items.push({ id: 't4', kind: 'tool', text: 'More tests' });
    expect(chatMessages(state)[5]).toMatchObject({
      id: 't3',
      toolCalls: [{ id: 't3' }, { id: 't4' }],
    });
  });
  it('rejects malformed or oversized images before they reach a provider', () => {
    const image = { name: 'screen.png', mediaType: 'image/png', data: 'aGVsbG8=' };
    expect(validateChatImages([image])).toEqual([image]);
    expect(() => validateChatImages([{ ...image, mediaType: 'image/svg+xml' }])).toThrow();
    expect(() =>
      validateChatImages([{ ...image, data: 'https://example.com/image.png' }]),
    ).toThrow();
    expect(() => validateChatImages(Array(5).fill(image))).toThrow();
    expect(() =>
      validateChatImages([{ ...image, data: 'a'.repeat(8 * 1024 * 1024 + 4) }]),
    ).toThrow();
  });
  it('restores only valid session index entries', () => {
    const session = { threadId: 'one', provider: 'claude', title: 'First chat', updatedAt: 1 };
    expect(
      restoreChatSessions([
        null,
        session,
        { ...session, provider: 'unknown' },
        { ...session, updatedAt: NaN },
      ]),
    ).toEqual([session]);
  });
});
