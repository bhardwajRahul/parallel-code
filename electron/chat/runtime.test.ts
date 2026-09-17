import { describe, expect, it, vi } from 'vitest';
import type { CodexChat } from '../ipc/codex-chat.js';
import type { AgentChatState } from '../shared/agent-chat-types.js';
import { createChatRuntime } from './runtime.js';

function harness() {
  const state: AgentChatState = { threadId: 'thread-1', status: 'ready', items: [], requests: [] };
  const observers = new Set<(state: AgentChatState) => void>();
  let sends = 0;
  const publish = () => {
    for (const observer of observers) observer(state);
  };
  const chat = {
    state,
    observe: (observer: (state: AgentChatState) => void) => {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    send: async () => {
      sends++;
      state.status = 'working';
      publish();
    },
    interrupt: async () => {
      state.status = 'ready';
      publish();
    },
  } as unknown as CodexChat;
  const handle = createChatRuntime(chat);
  const request = (path: string, body: unknown, signal?: AbortSignal) =>
    handle(
      new Request(`http://local/runtime/agent/default/${path}`, {
        signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const input = {
    threadId: 'thread-1',
    runId: 'run-1',
    state: {},
    messages: [{ id: 'u', role: 'user', content: 'Hello' }],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  return { state, observers, publish, request, input, handle, sends: () => sends };
}

describe('app-owned CopilotKit runtime', () => {
  it('disables inspector telemetry and sends no analytics even when sampling selects events', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected network request'));
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const h = harness();
      const info = await h.handle(new Request('http://local/runtime/info'));
      expect(await info.json()).toMatchObject({ telemetryDisabled: true });
      const response = await h.request('run', h.input);
      const events = response.text();
      h.state.status = 'ready';
      h.publish();
      expect(await events).toContain('RUN_FINISHED');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      random.mockRestore();
    }
  });
  it('sends once, emits text deltas and confirmation, and releases the stream', async () => {
    const h = harness();
    const response = await h.request('run', h.input);
    const text = response.text();
    await Promise.resolve();
    expect(h.sends()).toBe(1);
    h.state.items.push({ id: 'a', kind: 'assistant', text: 'Hello' });
    h.publish();
    h.state.items[0].text += ' world';
    h.publish();
    h.state.status = 'ready';
    h.publish();
    const events = await text;
    expect(events).toContain('parallel-code/accepted');
    expect(events).toContain('TEXT_MESSAGE_CONTENT');
    expect(events).toContain(' world');
    expect(events).toContain('RUN_FINISHED');
    expect(h.observers.size).toBe(0);
  });
  it('reconnects to the authoritative snapshot without replaying old errors or sending', async () => {
    const h = harness();
    h.state.items.push({ id: 'old', kind: 'user', text: 'Previous prompt' });
    const response = await h.request('connect', h.input);
    const events = await response.text();
    expect(events).toContain('Previous prompt');
    expect(events).toContain('RUN_FINISHED');
    expect(events).not.toContain('RUN_ERROR');
    expect(h.sends()).toBe(0);
    expect(h.observers.size).toBe(0);
  });
  it('does not replay a previous turn as a fresh failure on every reconnect', async () => {
    const h = harness();
    // A failed turn leaves the error on the chat until the next successful send.
    h.state.error = 'Usage limit reached';
    for (let attach = 0; attach < 2; attach++) {
      const response = await h.request('connect', h.input);
      const events = await response.text();
      expect(events).not.toContain('RUN_ERROR');
      expect(events).toContain('RUN_FINISHED');
    }
  });

  it('detaching a view leaves work running and reconnecting observes completion', async () => {
    const h = harness();
    const controller = new AbortController();
    const response = await h.request('run', h.input, controller.signal);
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    expect(h.observers.size).toBe(0);
    void reader?.cancel();
    expect(h.state.status).toBe('working');
    const reconnected = await h.request('connect', h.input);
    const text = reconnected.text();
    await h.request('stop/thread-1', {});
    expect(await text).toContain('RUN_FINISHED');
    expect(h.observers.size).toBe(0);
  });
  it('reports disconnect and rejects the wrong conversation without sending', async () => {
    const h = harness();
    const wrong = await h.request('run', { ...h.input, threadId: 'other' });
    expect(await wrong.text()).toContain('Conversation does not belong');
    expect(h.sends()).toBe(0);
    const response = await h.request('run', h.input);
    const text = response.text();
    h.state.status = 'closed';
    h.state.error = 'Disconnected';
    h.publish();
    expect(await text).toContain('Disconnected');
    expect(h.observers.size).toBe(0);
  });
});
