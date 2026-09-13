// The canvas channels need a window with an ipcRenderer, so this runs in the
// client (happy-dom) config over the real store; only IPC and saving are mocked.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { setStore, store } from './core';
import { startRemoteTaskHandlers } from './remoteTaskHandler';
import type { Task } from './types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('./persistence', () => ({ saveState: vi.fn(async () => undefined) }));

const listeners = new Map<string, (payload: unknown) => void>();
let stop: (() => void) | undefined;
const task: Task = {
  id: 'task',
  name: 'Task',
  projectId: 'project',
  branchName: 'task/test',
  worktreePath: '/tmp/task',
  agentIds: ['agent'],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
};

beforeEach(() => {
  Object.assign(window, {
    electron: {
      ipcRenderer: {
        on: (channel: string, cb: (payload: unknown) => void) => {
          listeners.set(channel, cb);
          return () => listeners.delete(channel);
        },
      },
    },
  });
  setStore('tasks', reconcile({ task: { ...task }, closing: { ...task, id: 'closing' } }));
  setStore('tasks', 'closing', 'closingStatus', 'closing');
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  stop = startRemoteTaskHandlers();
});
afterEach(() => {
  stop?.();
  // Stopping must unsubscribe every channel it registered.
  expect(listeners.size).toBe(0);
});

/** Sends one request and returns the reply the main process would forward. */
async function request(channel: string, payload: Record<string, unknown>) {
  vi.mocked(invoke).mockClear();
  listeners.get(channel)?.({ reqId: 'req', ...payload });
  await Promise.resolve();
  await Promise.resolve();
  const reply = vi.mocked(invoke).mock.calls.find(([c]) => c === IPC.Remote_RendererReply);
  return reply?.[1] as { ok: boolean; data?: unknown; error?: string } | undefined;
}

const canvasChannels = [
  { channel: IPC.MCP_ReadMindMapRequest, payload: {} },
  {
    channel: IPC.MCP_UpdateMindMapRequest,
    payload: { update: { expectedRevision: 0, operations: [] } },
  },
  { channel: IPC.MCP_ReadReasoningRequest, payload: {} },
  {
    channel: IPC.MCP_UpdateReasoningRequest,
    payload: { update: { runId: 'run', expectedRevision: 1, operations: [] } },
  },
  { channel: IPC.MCP_OpenCanvasRequest, payload: { view: 'mindmap' } },
];

it.each(canvasChannels)(
  'rejects unknown, inherited, and closing task IDs with a plain message: $channel',
  async ({ channel, payload }) => {
    for (const taskId of ['missing', '__proto__', 'constructor', 'closing']) {
      const reply = await request(channel, { taskId, ...payload });
      expect(reply?.ok).toBe(false);
      expect(reply?.error).toBe('Task not available.');
    }
    expect(Object.hasOwn(store.tasks, '__proto__')).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'mindMap')).toBe(false);
    expect(store.tasks.task.mindMap).toBeUndefined();
  },
);

it('reports a stale mind map revision without the Error prefix and keeps the map', async () => {
  const read = await request(IPC.MCP_ReadMindMapRequest, { taskId: 'task' });
  expect(read?.ok).toBe(true);
  const map = read?.data as { revision: number; records: Array<{ id: string }> };
  const parent = map.records[0].id;
  const insert = {
    type: 'insert',
    node: { id: 'child', parent, title: 'Child', detail: '' },
  };
  const stale = await request(IPC.MCP_UpdateMindMapRequest, {
    taskId: 'task',
    update: { expectedRevision: map.revision + 1, operations: [insert] },
  });
  expect(stale?.ok).toBe(false);
  expect(stale?.error).toMatch(/changed\. Read it again/i);
  expect(stale?.error?.startsWith('Error:')).toBe(false);
  expect(store.tasks.task.mindMap?.records.some((record) => record.id === 'child')).toBe(false);
  const fresh = await request(IPC.MCP_UpdateMindMapRequest, {
    taskId: 'task',
    update: { expectedRevision: map.revision, operations: [insert] },
  });
  expect(fresh?.ok).toBe(true);
  expect(store.tasks.task.mindMap?.records.some((record) => record.id === 'child')).toBe(true);
});

it('opens a canvas view for a known task only', async () => {
  const opened = await request(IPC.MCP_OpenCanvasRequest, { taskId: 'task', view: 'reasoning' });
  expect(opened).toEqual({ reqId: 'req', ok: true, data: { ok: true }, error: undefined });
  expect(store.tasks.task.canvasActiveTab).toBe('reasoning');
  const invalid = await request(IPC.MCP_OpenCanvasRequest, { taskId: 'task', view: 'browser' });
  expect(invalid?.ok).toBe(false);
  expect(typeof invalid?.error).toBe('string');
});
