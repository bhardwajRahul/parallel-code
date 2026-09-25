import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { TaskTitleBar } from '../components/TaskTitleBar';
import { store, setStore } from './core';
import { applyAgentHookEvent } from './agentHookStatus';
import { clearAgentActivity, getTaskAttentionState, markAgentBusy } from './taskStatus';
import { setActiveTask } from './navigation';
import { computeNeedsInputTasks } from './sidebar-attention';
import {
  bringTaskToFront,
  isTaskBackgrounded,
  sendTaskToBack,
  startBackgroundTaskWatcher,
} from './background-tasks';
import type { Task } from './types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));

function task(id: string): Task {
  return {
    id,
    name: id,
    projectId: 'project',
    branchName: id,
    worktreePath: `/tmp/${id}`,
    agentIds: [`${id}-agent`],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
  };
}

function hook(state: 'working' | 'waiting' | 'done', event: string, taskId = 'one') {
  applyAgentHookEvent({ agentId: `${taskId}-agent`, taskId, state, event, at: Date.now() });
}

let stop: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  setStore('tasks', reconcile({ one: task('one'), two: task('two'), three: task('three') }));
  setStore('agents', reconcile({}));
  setStore('taskGitStatus', reconcile({}));
  for (const id of ['one', 'two', 'three']) {
    setStore('agents', `${id}-agent`, {
      id: `${id}-agent`,
      taskId: id,
      def: {
        id: 'claude-code',
        name: 'Claude',
        command: 'claude',
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
    });
  }
  setStore('taskOrder', ['one', 'two', 'three']);
  setStore('collapsedTaskOrder', []);
  setActiveTask('one');
  stop = startBackgroundTaskWatcher();
});

afterEach(() => {
  stop();
  for (const id of ['one', 'two', 'three']) {
    bringTaskToFront(id);
    clearAgentActivity(`${id}-agent`);
  }
  vi.useRealTimers();
});

it('moves a running task to the back, keeps its agent, and focuses another task', () => {
  hook('working', 'UserPromptSubmit');
  sendTaskToBack('one');
  expect(store.taskOrder).toEqual(['two', 'three', 'one']);
  expect(store.activeTaskId).toBe('two');
  expect(store.activeAgentId).toBe('two-agent');
  expect(store.tasks.one.agentIds).toEqual(['one-agent']);
  expect(store.agents['one-agent'].status).toBe('running');
  expect(isTaskBackgrounded('one')).toBe(true);

  vi.advanceTimersByTime(1);
  hook('working', 'PostToolUse');
  expect(isTaskBackgrounded('one')).toBe(true);
});

it('hands selection to the neighbor, not the first task', () => {
  setActiveTask('three');
  sendTaskToBack('three');
  expect(store.activeTaskId).toBe('two');
});

it.each([
  ['waiting', 'PermissionRequest'],
  ['done', 'Stop'],
] as const)(
  'returns on %s without stealing focus or relying on OS notifications',
  (state, event) => {
    setStore('desktopNotificationsEnabled', false);
    hook('working', 'UserPromptSubmit');
    sendTaskToBack('one');
    hook(state, event);
    expect(store.taskOrder).toEqual(['one', 'two', 'three']);
    expect(isTaskBackgrounded('one')).toBe(false);
    expect(store.activeTaskId).toBe('two');
  },
);

it('returns when an idle agent becomes active again', () => {
  sendTaskToBack('one');
  markAgentBusy('one-agent');
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder[0]).toBe('one');
});

it.each([{ stale: true }, { refreshing: true }, { error: 'Git refresh failed' }])(
  'stays in the background when Git status loses validity: %j',
  (flags) => {
    setStore('taskGitStatus', 'one', {
      has_committed_changes: true,
      has_uncommitted_changes: false,
      current_branch: 'one',
      base_branch: 'main',
      refreshedAt: Date.now(),
    });
    expect(getTaskAttentionState('one')).toBe('ready');
    sendTaskToBack('one');
    setStore('taskGitStatus', 'one', flags);
    expect(getTaskAttentionState('one')).toBe('idle');
    expect(isTaskBackgrounded('one')).toBe(true);
    setStore('taskGitStatus', 'one', { stale: false, refreshing: false, error: undefined });
    expect(getTaskAttentionState('one')).toBe('ready');
    expect(isTaskBackgrounded('one')).toBe(true);
    expect(store.taskOrder).toEqual(['two', 'three', 'one']);
  },
);

it('still returns when the task requests review', () => {
  sendTaskToBack('one');
  setStore('tasks', 'one', 'needsReview', true);
  expect(isTaskBackgrounded('one')).toBe(false);
});

it('hides a deferred question from the input tray until a new notification arrives', () => {
  hook('waiting', 'PermissionRequest');
  expect(computeNeedsInputTasks().map((entry) => entry.taskId)).toContain('one');
  sendTaskToBack('one');
  expect(computeNeedsInputTasks()).toEqual([]);
  vi.advanceTimersByTime(1);
  hook('waiting', 'Notification');
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(computeNeedsInputTasks().map((entry) => entry.taskId)).toContain('one');
});

it('notices completion even when the task attention state stays at review', () => {
  setStore('tasks', 'one', 'needsReview', true);
  hook('working', 'UserPromptSubmit');
  sendTaskToBack('one');
  hook('done', 'Stop');
  expect(isTaskBackgrounded('one')).toBe(false);
});

it('brings a task forward when selected manually', () => {
  sendTaskToBack('one');
  setActiveTask('one');
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder[0]).toBe('one');
  expect(store.activeTaskId).toBe('one');
});

it('keeps a coordinator and its children together and returns on child activity', () => {
  setStore('tasks', 'two', 'coordinatedBy', 'one');
  sendTaskToBack('one');
  expect(store.taskOrder).toEqual(['three', 'one', 'two']);
  hook('waiting', 'PermissionRequest', 'two');
  expect(store.taskOrder).toEqual(['one', 'two', 'three']);
  expect(store.activeTaskId).toBe('three');
});

it('defers existing child questions with their coordinator and restores them manually', () => {
  setStore('tasks', 'two', 'coordinatedBy', 'one');
  hook('waiting', 'PermissionRequest', 'two');
  sendTaskToBack('one');
  expect(isTaskBackgrounded('two')).toBe(true);
  expect(computeNeedsInputTasks()).toEqual([]);
  bringTaskToFront('two');
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder).toEqual(['one', 'two', 'three']);
  expect(computeNeedsInputTasks().map((entry) => entry.taskId)).toEqual(['two']);
});

it('returns a chat task when its turn finishes', () => {
  setStore('tasks', 'one', 'mainAgentView', 'chat');
  setStore('agents', 'one-agent', 'chatState', {
    status: 'working',
    items: [],
    requests: [],
  });
  sendTaskToBack('one');
  setStore('agents', 'one-agent', 'chatState', 'status', 'ready');
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder[0]).toBe('one');
});

it('offers the action and a manual return in the task header', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const dispose = render(
    () => (
      <TaskTitleBar
        task={store.tasks.one}
        isActive={store.activeTaskId === 'one'}
        onClose={() => undefined}
        onMerge={() => undefined}
        onPush={() => undefined}
        pushing={false}
        pushSuccess={false}
        onTitleEditRef={() => undefined}
      />
    ),
    container,
  );
  try {
    const send = container.querySelector<HTMLButtonElement>(
      'button[title="Send task to back until new activity"]',
    );
    expect(send).not.toBeNull();
    send?.click();
    expect(isTaskBackgrounded('one')).toBe(true);
    expect(container.textContent).toContain('Background');
    const restore = container.querySelector<HTMLButtonElement>(
      'button[title="Bring task to front"]',
    );
    expect(restore).not.toBeNull();
    restore?.click();
    expect(isTaskBackgrounded('one')).toBe(false);
    expect(container.textContent).not.toContain('Background');
  } finally {
    dispose();
    container.remove();
  }
});

it('can background the only task without immediately waking it', () => {
  setStore('taskOrder', ['one']);
  sendTaskToBack('one');
  expect(store.activeTaskId).toBeNull();
  expect(isTaskBackgrounded('one')).toBe(true);
  setActiveTask('one');
  expect(isTaskBackgrounded('one')).toBe(false);
});

it('forgets removed tasks without inserting them into the order', () => {
  sendTaskToBack('one');
  setStore('taskOrder', ['two', 'three']);
  expect(isTaskBackgrounded('one')).toBe(false);
  expect(store.taskOrder).toEqual(['two', 'three']);
});
