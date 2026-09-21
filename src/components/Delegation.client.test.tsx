import { createSignal, untrack } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { DelegationState } from '../../electron/shared/delegation-types';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import type { Task } from '../store/types';
import { DelegationPanel } from './DelegationPanel';
import { DelegationReviewDialog } from './DelegationReviewDialog';
import { setDelegationStates, canUsePeerComposer, usePeerComposer } from '../store/delegation';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../store/tasks', () => ({ clearStagedNotification: vi.fn() }));
const task: Task = {
  id: 'parent',
  name: 'Parent',
  projectId: 'project',
  branchName: 'task/parent',
  worktreePath: '/repo/parent',
  agentIds: ['agent'],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  promptDraft: 'Keep my draft',
  gitIsolation: 'worktree',
};
let dispose: (() => void) | undefined;
let host: HTMLDivElement;
let state: DelegationState;
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
beforeEach(() => {
  state = { attempts: [], messages: [], paused: false };
  setStore({
    projects: [{ id: 'project', name: 'Repo', path: '/repo', color: '' }],
    tasks: { parent: { ...task } },
    taskOrder: ['parent'],
    collapsedTaskOrder: [],
    mcpOrchestrationEnabled: true,
    availableAgents: [
      {
        id: 'claude',
        name: 'Claude',
        command: 'claude',
        args: [],
        resume_args: ['--continue'],
        skip_permissions_args: [],
        description: '',
      },
    ],
  });
  setStore('agents', 'agent', {
    id: 'agent',
    taskId: 'parent',
    def: store.availableAgents[0],
    resumed: false,
    status: 'running',
    capabilities: { profile: 'ordinary', canCreate: true, peers: true },
    generation: 0,
    exitCode: null,
    signal: null,
    lastOutput: [],
  });
  vi.mocked(invoke).mockImplementation(async (_channel, args) => {
    if (args?.action === 'state') return state;
    return {};
  });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
  setDelegationStates('parent', { attempts: [], messages: [], paused: false });
});

it('offers tools restart after enabling MCP for a session without tools', () => {
  setStore('tasks', 'parent', 'agentSessionIds', { agent: 'conversation' });
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  expect(host.querySelector('[aria-label="Task collaboration"]')).toBeNull();
  setStore('agents', 'agent', 'capabilities', undefined);
  expect(button('Restart and resume Claude')).toBeDefined();
  setStore('mcpOrchestrationEnabled', false);
  expect(button('Restart and resume Claude')).toBeUndefined();
  setStore('mcpOrchestrationEnabled', true);
  expect(button('Restart and resume Claude')).toBeDefined();
  setStore('agents', 'agent', 'capabilities', {
    profile: 'ordinary',
    canCreate: true,
    peers: true,
  });
  setStore('tasks', 'parent', 'delegationParent', true);
  expect(host.querySelector('[aria-label="Task collaboration"]')).toBeNull();
});

it('reviews and manually copies held messages without touching drafts or sending terminal input', async () => {
  const sender = {
    agentId: 'sender',
    sessionInstanceId: 'sender-instance',
    taskId: 'other',
    name: 'Other task',
    agentLabel: 'Claude',
    branchName: 'other',
    status: 'running',
  };
  state.messages = [
    {
      deliveryId: 'delivery',
      sender,
      recipient: {
        ...sender,
        agentId: 'agent',
        sessionInstanceId: 'exact-instance',
        taskId: 'parent',
        name: 'Parent',
      },
      prompt: 'Please inspect this patch',
      state: 'waiting',
      createdAt: new Date().toISOString(),
    },
  ];
  setStore('tasks', 'parent', 'stagedNotification', {
    batchId: 'summary',
    notificationIds: ['child-result'],
    text: 'Result ready',
    autoFireAt: 0,
    userEdited: false,
  });
  const copy = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  await vi.waitFor(() => expect(button('Copy for manual handling')).toBeDefined());
  const sections = [...host.querySelectorAll('details')];
  expect(sections).toHaveLength(2);
  expect(sections.every((section) => !section.open)).toBe(true);
  expect(sections[0].querySelector('summary')?.textContent).toContain('Child updates (1)');
  expect(sections[1].querySelector('summary')?.textContent).toContain('Incoming messages (1)');
  sections[1].open = true;
  button('Review')?.click();
  expect(vi.mocked(invoke).mock.calls.some(([, args]) => args?.action === 'handleMessage')).toBe(
    false,
  );
  button('Copy for manual handling')?.click();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
      action: 'handleMessage',
      deliveryId: 'delivery',
      agentId: 'agent',
      sessionInstanceId: 'exact-instance',
      state: 'handled',
    }),
  );
  expect(copy).toHaveBeenCalledWith('Please inspect this patch');
  expect(store.tasks.parent.promptDraft).toBe('Keep my draft');
  expect(vi.mocked(invoke).mock.calls.every(([channel]) => channel !== IPC.WriteToAgent)).toBe(
    true,
  );
});

it('approves only the child commit and target shown in the review', async () => {
  const review = {
    expectedCommit: 'child-sha',
    expectedTargetBranch: 'task/parent',
    expectedTargetCommit: 'target-sha',
    diff: '+ reviewed line',
  };
  vi.mocked(invoke).mockImplementation(async (_channel, args) =>
    args?.action === 'review' ? review : {},
  );
  dispose = render(
    () => <DelegationReviewDialog task={store.tasks.parent} open={true} onClose={vi.fn()} />,
    host,
  );
  await vi.waitFor(() => expect(document.body.textContent).toContain('+ reviewed line'));
  button('Approve and merge')?.click();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
      action: 'merge',
      taskId: 'parent',
      review: {
        expectedCommit: 'child-sha',
        expectedTargetBranch: 'task/parent',
        expectedTargetCommit: 'target-sha',
      },
    }),
  );
});

it('uses only the exact recipient empty composer and marks handling without sending', async () => {
  const session = {
    agentId: 'agent',
    sessionInstanceId: 'exact-instance',
    taskId: 'parent',
    name: 'Parent',
    agentLabel: 'Claude',
    branchName: 'task/parent',
    status: 'running',
  };
  const message = {
    deliveryId: 'composer-delivery',
    sender: { ...session, taskId: 'sender' },
    recipient: session,
    prompt: 'Review this child',
    state: 'waiting' as const,
    createdAt: new Date().toISOString(),
  };
  state.messages = [message];
  setStore('agents', 'agent', 'sessionInstanceId', 'exact-instance');
  const [text, setText] = createSignal('');
  const composer = { getText: text, setText };
  dispose = render(
    () => (
      <DelegationPanel
        task={store.tasks.parent}
        canUseComposer={(incoming) =>
          canUsePeerComposer(store.tasks.parent, incoming, composer, true)
        }
        onUseComposer={(incoming) => usePeerComposer(store.tasks.parent, incoming, composer, true)}
      />
    ),
    host,
  );
  await vi.waitFor(() => expect(button('Review')).toBeDefined());
  expect(button('Use in composer')).toBeUndefined();
  button('Review')?.click();
  button('Use in composer')?.click();
  await vi.waitFor(() => expect(untrack(text)).toBe(message.prompt));
  expect(invoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
    action: 'handleMessage',
    deliveryId: message.deliveryId,
    agentId: 'agent',
    sessionInstanceId: 'exact-instance',
    state: 'handled',
  });
  expect(vi.mocked(invoke).mock.calls.every(([channel]) => channel !== IPC.WriteToAgent)).toBe(
    true,
  );
  // An existing draft, restarted recipient, secondary pane, and hidden composer all fail closed.
  setText('my draft');
  expect(usePeerComposer(store.tasks.parent, message, composer, true)).toBe(false);
  expect(untrack(text)).toBe('my draft');
  setText('');
  setStore('agents', 'agent', 'sessionInstanceId', 'replacement-instance');
  expect(usePeerComposer(store.tasks.parent, message, composer, true)).toBe(false);
  setStore('agents', 'agent', 'sessionInstanceId', 'exact-instance');
  expect(
    usePeerComposer(
      store.tasks.parent,
      { ...message, recipient: { ...session, agentId: 'secondary' } },
      composer,
      true,
    ),
  ).toBe(false);
  expect(usePeerComposer(store.tasks.parent, message, composer, false)).toBe(false);
  expect(untrack(text)).toBe('');
});

it('does not show an empty collaboration section merely for automatic updates', () => {
  setStore('tasks', 'parent', 'autoSendChildUpdates', true);
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  expect(host.querySelector('[aria-label="Task collaboration"]')).toBeNull();
});

it('respects explicit automatic update policy over the legacy mode marker', () => {
  setStore('tasks', 'parent', {
    coordinatorMode: true,
    autoSendChildUpdates: false,
    stagedNotification: {
      batchId: 'batch',
      notificationIds: ['child'],
      text: 'Child complete',
      autoFireAt: 0,
      userEdited: false,
    },
  });
  dispose = render(() => <DelegationPanel task={store.tasks.parent} />, host);
  expect(host.textContent).toContain('ready for review');
  setStore('tasks', 'parent', 'autoSendChildUpdates', true);
  expect(host.textContent).not.toContain('ready for review');
});
