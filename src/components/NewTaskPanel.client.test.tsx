import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import { NewTaskPanel } from './NewTaskPanel';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));

let host: HTMLDivElement;
let dispose: () => void;

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (channel) => {
    if (channel === IPC.GetBranches) return ['main'];
    if (channel === IPC.GetMainBranch) return 'main';
    if (channel === IPC.GetGitignoredDirs) return [];
    if (channel === IPC.CheckDockerAvailable) return false;
    return undefined;
  });
  setStore({
    projects: [{ id: 'project', name: 'Project', path: '/project', color: '#abc' }],
    availableAgents: [
      {
        id: 'agent',
        name: 'Agent',
        command: 'agent',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
    ],
    showNewTaskPanel: true,
  });
  host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
});

afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it('dims only the form, keeps status clear, and restores editing after creation fails', async () => {
  const form = host.querySelector('form');
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));

  let rejectCreation!: (error: Error) => void;
  const pending = new Promise((_, reject) => (rejectCreation = reject));
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) =>
    channel === IPC.CreateTask ? pending : Promise.resolve(originalInvoke?.(channel, args)),
  );
  const outside = document.createElement('button');
  const outsideClick = vi.fn();
  outside.onclick = outsideClick;
  document.body.append(outside);

  form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(form?.inert).toBe(true);
  expect(form?.style.opacity).toBe('0.4');
  expect(form?.getAttribute('aria-busy')).toBe('true');
  const status = host.querySelector('[role="status"]');
  expect(status?.textContent).toContain('Creating task...');
  expect(status?.querySelector('.inline-spinner')).not.toBeNull();
  expect(form?.contains(status)).toBe(false);
  expect(document.body.inert).toBe(false);
  outside.click();
  expect(outsideClick).toHaveBeenCalledOnce();

  form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(
    vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.CreateTask),
  ).toHaveLength(1);
  rejectCreation(new Error('Worktree creation failed'));
  await vi.waitFor(() => expect(form?.inert).toBe(false));
  expect(form?.style.opacity).toBe('1');
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.textContent).toContain('Worktree creation failed');
  expect(submit?.disabled).toBe(false);
  expect(store.showNewTaskPanel).toBe(true);
});

it('creates a linked task from the editable canvas assignment with the source branch and selected agent', async () => {
  dispose();
  host.replaceChildren();
  setStore('tasks', 'parent', {
    id: 'parent',
    name: 'Parent',
    projectId: 'project',
    branchName: 'task/parent',
    worktreePath: '/project/parent',
    gitIsolation: 'worktree',
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
  });
  setStore('newTaskPrefillPrompt', {
    name: 'Canvas assignment',
    prompt: 'Saved branch requirements',
    projectId: 'project',
    baseBranch: 'task/parent',
    canvasSource: {
      taskId: 'parent',
      canvas: 'reasoning',
      agentId: 'owner-agent',
      runId: 'run-1',
      nodeId: 'work',
    },
  });
  const originalInvoke = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((channel, args) => {
    if (channel === IPC.GetBranches) return Promise.resolve(['main', 'task/parent']);
    if (channel === IPC.CreateTask)
      return Promise.resolve({
        id: 'child',
        branch_name: 'task/child',
        worktree_path: '/project/child',
      });
    return Promise.resolve(originalInvoke?.(channel, args));
  });
  dispose = render(() => <NewTaskPanel open={true} onClose={vi.fn()} />, host);
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  await vi.waitFor(() => expect(submit?.disabled).toBe(false));
  const prompt = host.querySelector('textarea');
  expect(prompt?.value).toBe('Saved branch requirements');
  if (!prompt) throw new Error('Missing prompt editor');
  prompt.value = 'User revised assignment';
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  host
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(store.tasks.child).toBeDefined());
  expect(invoke).toHaveBeenCalledWith(
    IPC.CreateTask,
    expect.objectContaining({ name: 'Canvas assignment', baseBranch: 'task/parent' }),
  );
  expect(store.tasks.child.savedInitialPrompt).toBe('User revised assignment');
  expect(store.agents[store.tasks.child.agentIds[0]].def.id).toBe('agent');
  expect(store.tasks.parent.canvasTaskLinks).toEqual([
    expect.objectContaining({
      canvas: 'reasoning',
      agentId: 'owner-agent',
      runId: 'run-1',
      nodeId: 'work',
      taskId: 'child',
    }),
  ]);
  expect(store.showNewTaskPanel).toBe(false);
  expect(store.newTaskPrefillPrompt).toBeNull();
});
