import { afterEach, expect, it, vi } from 'vitest';
import type { AgentChatState } from '../shared/agent-chat-types.js';
import {
  getAgentChat,
  releaseCodexChat,
  startAgentChat,
  stopAgentChat,
  stopAllAgentChats,
} from './sessions.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), start: vi.fn(async () => {}) }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
vi.mock('../ipc/codex-chat.js', () => ({
  CodexChat: class {
    state: AgentChatState = { status: 'starting', items: [], requests: [] };
    observers = new Set<(state: AgentChatState) => void>();
    async start() {
      await mocks.start();
      this.state.status = 'ready';
    }
    subscribe() {}
    observe(listener: (state: AgentChatState) => void) {
      this.observers.add(listener);
      return () => this.observers.delete(listener);
    }
    stop() {
      this.state.status = 'closed';
      for (const listener of this.observers) listener(this.state);
    }
    async release() {
      this.stop();
      return {};
    }
  },
}));

const opts = {
  provider: 'codex' as const,
  agentId: 'agent',
  command: 'codex',
  cwd: '/worktree',
  env: {},
};
afterEach(() => {
  stopAllAgentChats();
  vi.clearAllMocks();
});

it('shares startup, passes canvas configuration, and releases it on handoff', async () => {
  const dispose = vi.fn();
  const prepare = vi.fn(async () => ({
    args: ['--config', 'mcp_servers.parallel-code={}'],
    dispose,
  }));
  const results = await Promise.all([
    startAgentChat(opts, () => {}, prepare),
    startAgentChat(opts, () => {}, prepare),
  ]);
  expect(results).toEqual([{ canvasTools: true }, { canvasTools: true }]);
  expect(prepare).toHaveBeenCalledOnce();
  expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
    'codex',
    ['app-server', '--config', 'mcp_servers.parallel-code={}'],
    expect.objectContaining({ cwd: '/worktree' }),
  );
  await startAgentChat(opts, () => {}, prepare);
  expect(prepare).toHaveBeenCalledOnce();
  await releaseCodexChat('agent');
  expect(dispose).toHaveBeenCalledOnce();
  stopAgentChat('agent');
  expect(dispose).toHaveBeenCalledOnce();
});

it('cancels startup and revokes resources if the task closes during canvas setup', async () => {
  const dispose = vi.fn();
  let release = () => {};
  const prepare = () =>
    new Promise<{ args: string[]; dispose: () => void }>((resolve) => {
      release = () => resolve({ args: ['--config', 'canvas'], dispose });
    });
  const starting = startAgentChat(opts, () => {}, prepare);
  const reattaching = startAgentChat(opts, () => {}, prepare);
  const rejected = expect(starting).rejects.toThrow('cancelled');
  const reattachRejected = expect(reattaching).rejects.toThrow('cancelled');
  stopAgentChat('agent');
  release();
  await rejected;
  await reattachRejected;
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
  expect(() => getAgentChat('agent')).toThrow('Open Chat');
});

it.each([false, true])(
  'rejects handoff during canvas setup, then permits it when ready (reconnect: %s)',
  async (reconnect) => {
    if (reconnect) {
      await startAgentChat(opts, () => {});
      getAgentChat('agent').stop();
      mocks.spawn.mockClear();
    }
    const dispose = vi.fn();
    let finishSetup = () => {};
    const starting = startAgentChat(
      opts,
      () => {},
      () =>
        new Promise((resolve) => {
          finishSetup = () => resolve({ args: [], dispose });
        }),
    );
    try {
      await expect(releaseCodexChat('agent')).rejects.toThrow(
        'Wait for chat startup to finish before switching views.',
      );
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      finishSetup();
      await starting;
    }
    expect(mocks.spawn).toHaveBeenCalledOnce();
    await expect(releaseCodexChat('agent')).resolves.toEqual({});
    expect(dispose).toHaveBeenCalledOnce();
  },
);

it('releases credentials when startup fails and allows a clean retry', async () => {
  const dispose = vi.fn();
  mocks.start.mockRejectedValueOnce(new Error('Startup failed'));
  await expect(
    startAgentChat(
      opts,
      () => {},
      async () => ({ args: [], dispose }),
    ),
  ).rejects.toThrow('Startup failed');
  expect(dispose).toHaveBeenCalledOnce();
  expect(() => getAgentChat('agent')).toThrow('Open Chat');
  await expect(startAgentChat(opts, () => {})).resolves.toEqual({ canvasTools: false });
});

it('releases credentials on an unexpected process exit', async () => {
  const dispose = vi.fn();
  await startAgentChat(
    opts,
    () => {},
    async () => ({ args: [], dispose }),
  );
  getAgentChat('agent').stop();
  expect(dispose).toHaveBeenCalledOnce();
});
