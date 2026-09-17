import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskAITerminal } from './TaskAITerminal';
import { store, setStore } from '../store/core';
import { clearAgentActivity, markAgentSpawned, markAgentOutput } from '../store/taskStatus';
import { nextTerminalInputPending } from '../lib/terminalInputPending';
import { IPC } from '../../electron/ipc/channels';
import { closeAgentInTask } from '../store/agents';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(channel: unknown, args?: unknown) => Promise<unknown>>(async () => undefined),
  terminalMounts: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: mocks.invoke,
  fireAndForget: vi.fn(),
  Channel: class {
    id = 'chat-channel';
    onmessage = null;
    dispose() {}
  },
}));
vi.mock('../store/persistence', async (original) => ({
  ...(await original<typeof import('../store/persistence')>()),
  saveState: vi.fn(async () => undefined),
}));
vi.mock('./TerminalView', () => ({
  TerminalView: (props: unknown) => {
    mocks.terminalMounts(props);
    return <div data-testid="terminal">Terminal conversation</div>;
  },
}));

let host: HTMLDivElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (_channel?: unknown, _args?: unknown) => ({
    threadId: 'exact-thread',
  }));
  setStore('tasks', {
    task: {
      id: 'task',
      name: 'Task',
      projectId: 'project',
      branchName: 'task/chat',
      worktreePath: '/worktree',
      agentIds: ['agent'],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
    },
  });
  setStore('agents', {
    agent: {
      id: 'agent',
      taskId: 'task',
      def: {
        id: 'codex',
        name: 'Codex',
        command: 'codex',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
      resumed: false,
      status: 'running',
      exitCode: null,
      signal: null,
      lastOutput: [],
      generation: 0,
    },
  });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  dispose?.();
  host.remove();
  clearAgentActivity('agent');
});

function mount() {
  dispose = render(
    () => (
      <TaskAITerminal
        task={store.tasks.task}
        selectedAgentId="agent"
        isActive
        promptHandle={undefined}
      />
    ),
    host,
  );
}

function clickChat() {
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]');
  expect(button).not.toBeNull();
  button?.click();
}

it('keeps the remaining agent in its own terminal when the main chat agent is closed', async () => {
  setStore('agents', 'second', { ...store.agents.agent, id: 'second' });
  setStore('tasks', 'task', 'agentIds', ['agent', 'second']);
  setStore('tasks', 'task', 'mainAgentView', 'chat');
  setStore('tasks', 'task', 'codexChatThreadId', 'old-thread');
  setStore('tasks', 'task', 'claudeChatSessionId', 'old-claude');
  setStore('tasks', 'task', 'chatPermissionMode', 'plan');
  mount();
  mocks.invoke.mockClear();
  await closeAgentInTask('task', 'agent');
  expect(store.tasks.task.agentIds).toEqual(['second']);
  expect(store.tasks.task.mainAgentView).toBeUndefined();
  expect(store.tasks.task.codexChatThreadId).toBeUndefined();
  expect(store.tasks.task.claudeChatSessionId).toBeUndefined();
  expect(store.tasks.task.chatPermissionMode).toBeUndefined();
  expect(mocks.invoke).not.toHaveBeenCalledWith(
    IPC.AgentChat,
    expect.objectContaining({ action: 'start', agentId: 'second' }),
  );
});

it('shows both modes and hands off the exact terminal conversation before mounting Chat', async () => {
  mount();
  const chatButton = host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]');
  const terminalButton = host.querySelector<HTMLButtonElement>(
    '[aria-label="Show main agent terminal"]',
  );
  expect(chatButton?.getAttribute('aria-pressed')).toBe('false');
  expect(terminalButton?.getAttribute('aria-pressed')).toBe('true');
  clickChat();
  expect(store.tasks.task.mainAgentView).not.toBe('chat');
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
  expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
    action: 'handoffToChat',
    agentId: 'agent',
  });
  expect(mocks.invoke).toHaveBeenCalledWith(
    IPC.AgentChat,
    expect.objectContaining({ action: 'start', threadId: 'exact-thread' }),
  );
  expect(chatButton?.getAttribute('aria-pressed')).toBe('true');
  expect(terminalButton?.getAttribute('aria-pressed')).toBe('false');
});

it.each(['working', 'draft', 'queued prompt'] as const)(
  'blocks terminal handoff with %s pending',
  (reason) => {
    if (reason === 'working') markAgentSpawned('agent');
    else if (reason === 'draft') setStore('tasks', 'task', 'terminalInputPending', true);
    else setStore('tasks', 'task', 'initialPrompt', 'Queued instruction');
    mount();
    clickChat();
    // The reason must be announced, not only offered as a tooltip on a button
    // that cannot be reached by keyboard or screen reader.
    const chat = host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]');
    expect(chat?.getAttribute('aria-disabled')).toBe('true');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(chat?.title);
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/before switching views/);
    expect(
      host
        .querySelector<HTMLButtonElement>('[aria-label="Show main agent terminal"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('false');
    expect(store.tasks.task.mainAgentView).not.toBe('chat');
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      IPC.AgentChat,
      expect.objectContaining({ action: 'handoffToChat' }),
    );
  },
);

it('reports the reason that holds now, not the one that was clicked on', () => {
  setStore('tasks', 'task', 'initialPrompt', 'Queued instruction');
  mount();
  clickChat();
  const alert = () => host.querySelector('[role="alert"]')?.textContent;
  expect(alert()).toMatch(/queued prompt/);
  // The queued prompt goes out, but the user starts typing in the terminal
  // before retrying. The alert must not still be citing the prompt.
  setStore('tasks', 'task', 'initialPrompt', undefined);
  setStore('tasks', 'task', 'terminalInputPending', true);
  expect(alert()).toMatch(/terminal draft/);
  setStore('tasks', 'task', 'terminalInputPending', false);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('explains itself while a handoff is in flight', async () => {
  let release: ((value: unknown) => void) | undefined;
  mocks.invoke.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  mount();
  clickChat();
  const chat = host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]');
  // Marked unavailable, so it owes the user a reason — and must keep focus.
  expect(chat?.getAttribute('aria-disabled')).toBe('true');
  expect(chat?.title).toBe('Switching conversation…');
  expect(chat?.disabled).toBe(false);
  release?.({ threadId: 'exact-thread' });
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
});

it('stops Chat before restarting Terminal with the same session and settings', async () => {
  mount();
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
  mocks.invoke.mockResolvedValue({
    threadId: 'exact-thread',
    model: 'model-a',
    reasoningEffort: 'high',
  });
  host.querySelector<HTMLButtonElement>('[aria-label="Show main agent terminal"]')?.click();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('terminal'));
  expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
    action: 'handoffToTerminal',
    agentId: 'agent',
  });
  expect(store.tasks.task.codexChatHandoff).toEqual({
    threadId: 'exact-thread',
    model: 'model-a',
    reasoningEffort: 'high',
  });
  expect(store.agents.agent.resumed).toBe(true);
  expect(mocks.terminalMounts).toHaveBeenCalledTimes(2);
});

it('keeps the terminal visible when handoff fails and allows retry', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('Codex has not exited'));
  mount();
  clickChat();
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('has not exited'),
  );
  expect(store.tasks.task.mainAgentView).not.toBe('chat');
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
});

it('does not start a second handoff after rapid clicks', async () => {
  let release: ((value: unknown) => void) | undefined;
  mocks.invoke.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  mount();
  clickChat();
  clickChat();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  release?.({ threadId: 'exact-thread' });
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
});

it('opens the Claude chat from a Claude Code terminal', () => {
  setStore('agents', 'agent', 'def', {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
  });
  mount();
  clickChat();
  expect(store.tasks.task.mainAgentView).toBe('chat');
  expect(host.querySelector('[aria-label="Claude conversation"]')).not.toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith(
    IPC.AgentChat,
    expect.objectContaining({ action: 'start', provider: 'claude', command: 'claude' }),
  );
  host.querySelector<HTMLButtonElement>('[aria-label="Show main agent terminal"]')?.click();
  expect(store.tasks.task.mainAgentView).toBe('terminal');
  clickChat();
  expect(store.tasks.task.mainAgentView).toBe('chat');
});

it.each(['dockerMode', 'coordinatorMode', 'coordinatedBy'] as const)(
  'keeps the Claude switcher visible and explains the %s restriction',
  (mode) => {
    setStore('agents', 'agent', 'def', { id: 'claude-code', command: 'claude' });
    if (mode === 'coordinatedBy') setStore('tasks', 'task', mode, 'coordinator');
    else setStore('tasks', 'task', mode, true);
    mount();
    const chat = host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]');
    expect(chat).not.toBeNull();
    expect(chat?.getAttribute('aria-disabled')).toBe('true');
    expect(chat?.title).toContain(mode === 'dockerMode' ? 'Docker' : 'coordinator');
    clickChat();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(chat?.title);
    expect(store.tasks.task.mainAgentView).not.toBe('chat');
    expect(mocks.invoke).not.toHaveBeenCalled();
  },
);

it('can return to Chat after the resumed terminal sends automatic replies and becomes idle', async () => {
  mount();
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
  host.querySelector<HTMLButtonElement>('[aria-label="Show main agent terminal"]')?.click();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('terminal'));
  markAgentSpawned('agent');
  setStore(
    'tasks',
    'task',
    'terminalInputPending',
    nextTerminalInputPending(false, '\x1b]11;rgb:0000/0000/0000\x1b\\'),
  );
  markAgentOutput('agent', new TextEncoder().encode('\r\n› '));
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
  expect(
    mocks.invoke.mock.calls.filter(
      (call) => (call[1] as { action?: string })?.action === 'handoffToChat',
    ),
  ).toHaveLength(2);
});

it('shows a startup failure after clicking Chat', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('No handler registered for codex_chat'));
  mount();
  clickChat();
  await Promise.resolve();
  await Promise.resolve();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('No handler registered');
});

it.each(['working', 'starting', 'approval'] as const)(
  'keeps Chat selected while %s blocks handoff',
  (reason) => {
    setStore('tasks', 'task', 'mainAgentView', 'chat');
    setStore('agents', 'agent', 'chatState', {
      status: reason === 'approval' ? 'ready' : reason,
      items: [],
      requests:
        reason === 'approval' ? [{ id: 1, kind: 'approval', text: 'Run command?', since: 1 }] : [],
    });
    mount();
    const terminal = host.querySelector<HTMLButtonElement>(
      '[aria-label="Show main agent terminal"]',
    );
    const chat = host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]');
    expect(terminal?.getAttribute('aria-disabled')).toBe('true');
    expect(chat?.getAttribute('aria-disabled')).toBe('false');
    expect(chat?.getAttribute('aria-pressed')).toBe('true');
    terminal?.click();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(terminal?.title);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      IPC.AgentChat,
      expect.objectContaining({ action: 'handoffToTerminal' }),
    );
    // Once the agent is done, the alert must stop demanding that it be stopped.
    setStore('agents', 'agent', 'chatState', { status: 'ready', items: [], requests: [] });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(terminal?.getAttribute('aria-disabled')).toBe('false');
  },
);

it('refreshes the linked session after the user changes conversations in Terminal', () => {
  const id = '01999999-1234-4321-9876-0123456789ab';
  setStore('tasks', 'task', 'codexChatHandoff', {
    threadId: 'previous',
    model: 'old-model',
    reasoningEffort: 'low',
  });
  mount();
  const props = mocks.terminalMounts.mock.calls[0][0] as {
    onExit: (info: { exit_code: number; signal: null; last_output: string[] }) => void;
  };
  props.onExit({
    exit_code: 0,
    signal: null,
    last_output: ['To continue this session, run:', `  codex resume ${id}`],
  });
  expect(store.tasks.task.codexChatHandoff).toEqual({ threadId: id });
});
