import { randomUUID } from 'node:crypto';
import { protocol, type BrowserWindow } from 'electron';
import type { AgentChat } from './types.js';
import type { ChatConnection } from '../shared/chat-messages.js';

const SCHEME = 'parallel-chat';
const entries = new Map<
  string,
  {
    token: string;
    chat: AgentChat;
    handle: (request: Request) => Promise<Response>;
    dispose: () => void;
  }
>();
const connections = new WeakMap<AgentChat, Promise<ChatConnection>>();

export function registerChatScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

export function registerChatProtocol(win: BrowserWindow): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const entry = entries.get(url.hostname);
    if (
      !entry ||
      win.isDestroyed() ||
      request.headers.get('authorization') !== `Bearer ${entry.token}`
    )
      return new Response('Unauthorized', { status: 401 });
    const origin = request.headers.get('origin');
    const expectedOrigin = new URL(win.webContents.getURL()).origin;
    if (origin && origin !== expectedOrigin) return new Response('Forbidden', { status: 403 });
    if (entry.chat.state.status === 'closed')
      return new Response('Conversation closed', { status: 410 });
    try {
      if (request.method === 'GET' && url.pathname === '/runtime/info')
        return entry.handle(request);
      const threadId = entry.chat.state.threadId;
      if (
        request.method === 'POST' &&
        ['stop', 'is_running'].some(
          (action) => url.pathname === `/runtime/agent/default/${action}/${threadId}`,
        )
      )
        return entry.handle(request);
      if (
        request.method !== 'POST' ||
        !['/runtime/agent/default/run', '/runtime/agent/default/connect'].includes(url.pathname)
      )
        return new Response('Not found', { status: 404 });
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) {
            await reader.cancel();
            return new Response('Message too large', { status: 413 });
          }
          chunks.push(value);
        }
      const body = Buffer.concat(chunks).toString('utf8');
      const input: unknown = JSON.parse(body);
      if (
        !input ||
        typeof input !== 'object' ||
        !('threadId' in input) ||
        input.threadId !== threadId
      )
        return new Response('Wrong conversation', { status: 403 });
      // Electron cancels the response body when a renderer detaches, but does not
      // abort the incoming Request signal. Relay that cancellation to the runtime.
      const controller = new AbortController();
      const response = await entry.handle(
        new Request(request.url, {
          method: request.method,
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.any([request.signal, controller.signal]),
        }),
      );
      if (!response.body) return response;
      const source = response.body.getReader();
      return new Response(
        new ReadableStream({
          async pull(target) {
            try {
              const { done, value } = await source.read();
              if (done) target.close();
              else target.enqueue(value);
            } catch (error) {
              target.error(error);
            }
          },
          async cancel(reason) {
            controller.abort(reason);
            await source.cancel(reason);
          },
        }),
        { status: response.status, headers: response.headers },
      );
    } catch {
      return new Response('Invalid chat request', { status: 400 });
    }
  });
  win.on('closed', () => {
    protocol.unhandle(SCHEME);
    for (const entry of entries.values()) {
      entry.dispose();
      connections.delete(entry.chat);
    }
    entries.clear();
  });
}

export function getChatConnection(chat: AgentChat): Promise<ChatConnection> {
  const existing = connections.get(chat);
  if (existing) return existing;
  const connection = (async () => {
    process.env.COPILOTKIT_TELEMETRY_DISABLED = 'true';
    const { createChatRuntime } = await import('./runtime.js');
    if (chat.state.status === 'closed') throw new Error('Reconnect to the agent first.');
    const id = randomUUID();
    const token = randomUUID();
    const handle = createChatRuntime(chat);
    const dispose = chat.observe((state) => {
      if (state.status === 'closed') {
        entries.delete(id);
        connections.delete(chat);
        dispose();
      }
    });
    entries.set(id, { token, chat, handle, dispose });
    return { url: `${SCHEME}://${id}/runtime`, token };
  })();
  connections.set(chat, connection);
  void connection.catch(() => connections.delete(chat));
  return connection;
}
