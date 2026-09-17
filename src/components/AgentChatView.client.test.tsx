import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentChatView } from './AgentChatView';
import type { ChatProps } from './chat/CopilotChat.react';
import { store, setStore } from '../store/core';
import { IPC } from '../../electron/ipc/channels';
import type { AgentChatState } from '../../electron/shared/agent-chat-types';
import type { Task } from '../store/types';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (): Promise<unknown> => undefined),
  sendPrompt: vi.fn(async () => undefined),
  saveState: vi.fn(),
  chatProps: undefined as ChatProps | undefined,
  disposeView: vi.fn(),
  channel: undefined as
    | { onmessage: ((state: AgentChatState) => void) | null; dispose: () => void }
    | undefined,
}));
vi.mock('../lib/ipc', () => ({
  invoke: mocks.invoke,
  Channel: class {
    id = 'channel-id';
    onmessage = null;
    dispose = vi.fn();
    constructor() {
      mocks.channel = this;
    }
  },
}));
vi.mock('../store/persistence', () => ({ saveState: mocks.saveState }));
vi.mock('../store/tasks', () => ({
  sendPrompt: mocks.sendPrompt,
  clearPrefillPrompt: (taskId: string) => setStore('tasks', taskId, 'prefillPrompt', undefined),
  setTaskPromptDraft: (taskId: string, value: string) =>
    setStore('tasks', taskId, 'promptDraft', value),
}));
vi.mock('../store/focus', () => ({ registerAction: vi.fn(), unregisterAction: vi.fn() }));
vi.mock('../store/focused-panel', () => ({ registerFocusFn: vi.fn(), unregisterFocusFn: vi.fn() }));
vi.mock('./chat/CopilotChat.react', () => ({
  mountChat: (shadow: ShadowRoot) => ({
    update: (snapshot: ChatProps) => {
      mocks.chatProps = snapshot;
      const element = document.createElement('div');
      element.textContent =
        snapshot.state.items.map((i) => i.text).join(' ') +
        snapshot.state.requests.map((r) => r.text).join(' ');
      const button = document.createElement('button');
      button.textContent = 'Decline';
      button.onclick = () => {
        const request = snapshot.state.requests[0];
        if (request) void snapshot.onRespond(request, 'decline', {});
      };
      element.append(button);
      shadow.replaceChildren(element);
    },
    dispose: mocks.disposeView,
  }),
}));

let dispose: (() => void) | undefined;
let container: HTMLDivElement;
const task = () => store.tasks['task-1'];
const state = (overrides: Partial<AgentChatState> = {}): AgentChatState => ({
  status: 'ready',
  threadId: 'thread-1',
  items: [],
  requests: [],
  ...overrides,
});
async function tick() {
  await vi.waitFor(() => expect(mocks.chatProps).toBeDefined());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chatProps = undefined;
  mocks.invoke.mockResolvedValue({ url: 'parallel-chat://test/runtime', token: 'token' });
  setStore('tasks', {
    'task-1': {
      id: 'task-1',
      agentIds: ['agent-1'],
      worktreePath: '/worktree',
      mainAgentView: 'chat',
      codexChatThreadId: 'saved-thread',
      promptDraft: 'Fix tests',
    } as Task,
  });
  setStore('agents', {
    'agent-1': {
      id: 'agent-1',
      taskId: 'task-1',
      def: {
        id: 'codex',
        name: 'Codex',
        command: 'codex',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
      status: 'running',
      resumed: false,
      generation: 0,
      exitCode: null,
      signal: null,
      lastOutput: [],
      chatState: state(),
    },
  });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  dispose?.();
  container.remove();
});

describe('Codex chat view', () => {
  it('reattaches to the saved thread and preserves streamed state and new conversation ids', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    expect(mocks.invoke).toHaveBeenCalledWith(
      IPC.AgentChat,
      expect.objectContaining({
        action: 'start',
        threadId: 'saved-thread',
        cwd: '/worktree',
        channelId: 'channel-id',
      }),
    );
    mocks.channel?.onmessage?.(state({ items: [{ id: 'a', kind: 'assistant', text: 'Done' }] }));
    await tick();
    expect(container.querySelector('.codex-chat-island')?.shadowRoot?.textContent).toContain(
      'Done',
    );
    expect(task().codexChatThreadId).toBe('thread-1');
    expect(mocks.saveState).toHaveBeenCalled();
    dispose();
    dispose = undefined;
    expect(mocks.channel?.dispose).toHaveBeenCalled();
    // Hiding the view must not kill a live conversation.
    expect(mocks.invoke).not.toHaveBeenCalledWith(IPC.KillAgent, expect.anything());
  });

  it('uses Claude labels and its own session id without replacing the Codex conversation', async () => {
    setStore('agents', 'agent-1', 'def', 'id', 'claude-code');
    setStore('agents', 'agent-1', 'def', 'command', 'claude');
    setStore('tasks', 'task-1', 'claudeChatSessionId', 'claude-saved');
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    expect(mocks.invoke).toHaveBeenCalledWith(
      IPC.AgentChat,
      expect.objectContaining({ provider: 'claude', threadId: 'claude-saved' }),
    );
    expect(mocks.chatProps?.agentName).toBe('Claude');
    expect(container.querySelector('[aria-label="Claude conversation"]')).not.toBeNull();
    mocks.channel?.onmessage?.(state({ threadId: 'claude-new', items: [] }));
    expect(task().claudeChatSessionId).toBe('claude-saved');
    mocks.channel?.onmessage?.(
      state({ threadId: 'claude-new', items: [{ id: 'u', kind: 'user', text: 'Accepted' }] }),
    );
    expect(task().claudeChatSessionId).toBe('claude-new');
    expect(task().codexChatThreadId).toBe('saved-thread');
  });

  it('shows approvals without granting them and sends only the clicked decision', async () => {
    setStore(
      'agents',
      'agent-1',
      'chatState',
      state({ requests: [{ id: 4, since: 1, kind: 'approval', text: 'Run npm test?' }] }),
    );
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    expect(mocks.chatProps?.state.requests[0].text).toBe('Run npm test?');
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      IPC.AgentChat,
      expect.objectContaining({ action: 'respond' }),
    );
    const decline = container
      .querySelector('.codex-chat-island')
      ?.shadowRoot?.querySelector('button');
    decline?.click();
    await tick();
    expect(mocks.invoke).toHaveBeenCalledWith(
      IPC.AgentChat,
      expect.objectContaining({ action: 'respond', requestId: 4, decision: 'decline' }),
    );
  });

  it('lets only a focused panel with a pending request claim the keyboard', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    // Nothing to answer: stay out of the focus business entirely.
    expect(mocks.chatProps?.active).toBe(false);
    const request = { id: 4, since: 1, kind: 'approval' as const, text: 'Run npm test?' };
    mocks.channel?.onmessage?.(state({ requests: [request] }));
    expect(mocks.chatProps?.active).toBe(true);
  });

  it('never lets a background task’s request pull focus out of the active one', async () => {
    const request = { id: 4, since: 1, kind: 'approval' as const, text: 'Run npm test?' };
    setStore('agents', 'agent-1', 'chatState', state({ requests: [request] }));
    dispose = render(
      () => <AgentChatView task={task()} agentId="agent-1" active={false} />,
      container,
    );
    await tick();
    expect(mocks.chatProps?.state.requests).toHaveLength(1);
    expect(mocks.chatProps?.active).toBe(false);
  });

  it('keeps drafts on failure and clears only the accepted unchanged draft', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    const deliver = vi.fn(async () => undefined);
    mocks.sendPrompt.mockRejectedValueOnce(new Error('Disconnected'));
    await expect(mocks.chatProps?.onSend('Fix tests', deliver)).rejects.toThrow('Disconnected');
    expect(task().promptDraft).toBe('Fix tests');
    await mocks.chatProps?.onSend('Fix tests', deliver);
    expect(mocks.sendPrompt).toHaveBeenCalledWith('task-1', 'agent-1', 'Fix tests', {
      sendChat: deliver,
    });
    expect(task().promptDraft).toBe('');
    setStore('tasks', 'task-1', 'promptDraft', 'Newer typing');
    await mocks.chatProps?.onSend('Older message', deliver);
    expect(task().promptDraft).toBe('Newer typing');
  });

  it('routes model choices and catalog refreshes to the same conversation', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    await mocks.chatProps?.onSelectModel('model-b', 'high');
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
      action: 'selectModel',
      agentId: 'agent-1',
      model: 'model-b',
      reasoningEffort: 'high',
    });
    await mocks.chatProps?.onReloadModels();
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
      action: 'models',
      agentId: 'agent-1',
    });
    mocks.channel?.onmessage?.(state({ model: 'model-b', reasoningEffort: 'high' }));
    expect(mocks.chatProps?.state.model).toBe('model-b');
    expect(mocks.chatProps?.state.reasoningEffort).toBe('high');
  });

  it('updates the isolated view with theme changes and interruption', async () => {
    setStore('agents', 'agent-1', 'chatState', state({ status: 'working' }));
    setStore('themePreset', 'obsidian');
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    expect(mocks.chatProps?.dark).toBe(true);
    setStore('themePreset', 'islands-light');
    expect(mocks.chatProps?.dark).toBe(false);
    await mocks.chatProps?.onStop();
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
      action: 'interrupt',
      agentId: 'agent-1',
    });
  });
});
