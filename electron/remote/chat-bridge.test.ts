import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentChat } from '../chat/types.js';
import type { AgentChatState } from '../shared/agent-chat-types.js';
import {
  CHAT_FRAME_INTERVAL_MS,
  createChatSubscriptions,
  runRemoteChatAction,
  type RemoteChatSource,
} from './chat-bridge.js';
import type { ServerMessage } from './protocol.js';

function fakeChat() {
  const listeners = new Set<(state: AgentChatState) => void>();
  const state: AgentChatState = { status: 'ready', items: [], requests: [] };
  const chat = {
    state,
    observe: vi.fn((listener: (state: AgentChatState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    send: vi.fn(async () => {}),
    respond: vi.fn(),
    publish: () => listeners.forEach((listener) => listener(state)),
    listeners,
  };
  return chat;
}

let chat: ReturnType<typeof fakeChat>;
let source: RemoteChatSource;
let sent: ServerMessage[];

beforeEach(() => {
  vi.useFakeTimers();
  chat = fakeChat();
  source = {
    list: () => [{ agentId: 'a1', taskId: 't1', status: 'running' }],
    find: (agentId) => (agentId === 'a1' ? (chat as unknown as AgentChat) : undefined),
    onChange: () => () => {},
  };
  sent = [];
});
afterEach(() => vi.useRealTimers());

it('sends the conversation at once, then at most one frame per interval', () => {
  const subscriptions = createChatSubscriptions(source, (message) => sent.push(message));
  subscriptions.subscribe('a1');
  expect(sent).toHaveLength(1);
  chat.state.items.push({ id: '1', kind: 'assistant', text: 'Hel' });
  chat.publish();
  chat.state.items[0].text = 'Hello';
  chat.publish();
  expect(sent).toHaveLength(1);
  vi.advanceTimersByTime(CHAT_FRAME_INTERVAL_MS);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({
    type: 'chat-state',
    agentId: 'a1',
    state: { items: [{ text: 'Hello' }] },
  });
});

it('leaves image data out of phone frames without touching the desktop state', () => {
  const image = { name: 'shot.png', mediaType: 'image/png' as const, data: 'AAAA' };
  chat.state.items.push({ id: '1', kind: 'user', text: 'Look', images: [image] });
  createChatSubscriptions(source, (message) => sent.push(message)).subscribe('a1');
  expect(sent[0]).toMatchObject({ state: { items: [{ id: '1', text: 'Look' }] } });
  expect(JSON.stringify(sent[0])).not.toContain('AAAA');
  expect(chat.state.items[0].images).toEqual([image]);
});

it('stops observing and drops a pending frame on unsubscribe and dispose', () => {
  const subscriptions = createChatSubscriptions(source, (message) => sent.push(message));
  subscriptions.subscribe('a1');
  subscriptions.subscribe('a1');
  expect(chat.observe).toHaveBeenCalledOnce();
  chat.publish();
  subscriptions.unsubscribe('a1');
  vi.advanceTimersByTime(CHAT_FRAME_INTERVAL_MS);
  expect(sent).toHaveLength(1);
  expect(chat.listeners.size).toBe(0);

  subscriptions.subscribe('a1');
  subscriptions.dispose();
  expect(chat.listeners.size).toBe(0);
});

it('ignores subscriptions to chats that are not running', () => {
  createChatSubscriptions(source, (message) => sent.push(message)).subscribe('gone');
  expect(sent).toEqual([]);
});

it('runs actions through the desktop validation', async () => {
  await runRemoteChatAction(source, {
    type: 'chat-action',
    agentId: 'a1',
    requestId: 'r',
    action: 'send',
    params: { text: 'hi', action: 'stop' },
  });
  expect(chat.send).toHaveBeenCalledWith('hi', []);
  await expect(
    runRemoteChatAction(source, {
      type: 'chat-action',
      agentId: 'a1',
      requestId: 'r',
      action: 'respond',
      params: { requestId: 1, decision: 'maybe' },
    }),
  ).rejects.toThrow('Invalid approval decision.');
  expect(chat.respond).not.toHaveBeenCalled();
  await expect(
    runRemoteChatAction(source, {
      type: 'chat-action',
      agentId: 'gone',
      requestId: 'r',
      action: 'interrupt',
      params: {},
    }),
  ).rejects.toThrow('has closed');
});
