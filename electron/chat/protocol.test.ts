import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { CodexChat } from '../ipc/codex-chat.js';
import type { AgentChatState } from '../shared/agent-chat-types.js';
import { getChatConnection, registerChatProtocol, registerChatScheme } from './protocol.js';

const mocks = vi.hoisted(() => ({
  handler: undefined as ((request: Request) => Promise<Response>) | undefined,
  handle: vi.fn(async () => Response.json({ ok: true })),
  register: vi.fn(),
  unhandle: vi.fn(),
}));
vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: mocks.register,
    handle: (_scheme: string, handler: typeof mocks.handler) => {
      mocks.handler = handler;
    },
    unhandle: mocks.unhandle,
  },
}));
vi.mock('./runtime.js', () => ({ createChatRuntime: () => mocks.handle }));
let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  vi.clearAllMocks();
});
async function harness() {
  const observers = new Set<(state: AgentChatState) => void>();
  const state: AgentChatState = { status: 'ready', threadId: 'thread-1', items: [], requests: [] };
  const chat = {
    state,
    observe: (observer: (state: AgentChatState) => void) => {
      observers.add(observer);
      return () => observers.delete(observer);
    },
  } as unknown as CodexChat;
  registerChatProtocol({
    isDestroyed: () => false,
    webContents: { getURL: () => 'file:///app/index.html' },
    on: (_event: string, callback: () => void) => {
      close = callback;
    },
  } as unknown as BrowserWindow);
  const connection = await getChatConnection(chat);
  const request = (path: string, body?: unknown, token = connection.token, origin = 'null') => {
    if (!mocks.handler) throw new Error('Protocol not registered');
    return mocks.handler(
      new Request(connection.url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, Origin: origin },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  };
  return { request, observers, state, chat, connection };
}
describe('private chat protocol', () => {
  it('supports streaming without bypassing CSP', () => {
    registerChatScheme();
    expect(mocks.register).toHaveBeenCalledWith([
      {
        scheme: 'parallel-chat',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          stream: true,
        },
      },
    ]);
  });
  it('authenticates and scopes the runtime to one conversation', async () => {
    const h = await harness();
    expect((await h.request('/info', undefined, 'wrong')).status).toBe(401);
    expect(
      (await h.request('/info', undefined, h.connection.token, 'https://untrusted.example')).status,
    ).toBe(403);
    expect((await h.request('/agent/default/run', { threadId: 'another' })).status).toBe(403);
    expect((await h.request('/agent/default/stop/another', {})).status).toBe(404);
    expect(mocks.handle).not.toHaveBeenCalled();
    expect((await h.request('/info')).status).toBe(200);
    expect((await h.request('/agent/default/run', { threadId: 'thread-1' })).status).toBe(200);
    expect((await h.request('/agent/default/stop/thread-1', {})).status).toBe(200);
  });
  it('limits request size before forwarding and revokes closed sessions', async () => {
    const h = await harness();
    expect(
      (
        await h.request('/agent/default/run', {
          threadId: 'thread-1',
          text: 'x'.repeat(10 * 1024 * 1024),
        })
      ).status,
    ).toBe(413);
    expect(mocks.handle).not.toHaveBeenCalled();
    h.state.status = 'closed';
    for (const observer of h.observers) observer(h.state);
    expect((await h.request('/info')).status).toBe(401);
    expect(h.observers.size).toBe(0);
    await expect(getChatConnection(h.chat)).rejects.toThrow('Reconnect');
  });
  it('aborts the runtime when Electron cancels a detached renderer response', async () => {
    const h = await harness();
    let runtimeSignal: AbortSignal | undefined;
    mocks.handle.mockImplementationOnce(async (request?: Request) => {
      runtimeSignal = request?.signal;
      return new Response(new ReadableStream());
    });
    const response = await h.request('/agent/default/run', { threadId: 'thread-1' });
    expect(runtimeSignal?.aborted).toBe(false);
    await response.body?.cancel();
    expect(runtimeSignal?.aborted).toBe(true);
  });

  it('reuses a connection and releases observers when its window closes', async () => {
    const h = await harness();
    expect(await getChatConnection(h.chat)).toBe(h.connection);
    expect(h.observers.size).toBe(1);
    close?.();
    expect(h.observers.size).toBe(0);
    expect(mocks.unhandle).toHaveBeenCalledWith('parallel-chat');
  });
});
