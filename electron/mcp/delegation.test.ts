import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
import type { Coordinator } from './coordinator.js';
import type { CoordinatedTask } from './types.js';
import type {
  DelegateAssignment,
  SessionCaller,
  TaskAuthorityInput,
} from '../shared/delegation-types.js';

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  realpath: vi.fn(),
  meta: vi.fn(),
  scrollback: vi.fn(),
  kill: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.git }),
}));
vi.mock('node:fs/promises', () => ({ realpath: mocks.realpath }));
vi.mock('../ipc/pty.js', () => ({
  getActiveAgentIds: () => [],
  getAgentMeta: mocks.meta,
  getAgentScrollback: mocks.scrollback,
  killAgent: mocks.kill,
}));
vi.mock('../ipc/tasks.js', () => ({ deleteTask: mocks.remove }));
vi.mock('./canvas-config.js', () => ({
  canConfigureCanvasMcp: (command: string, args: string[]) =>
    command === 'codex' && !args.includes('--mcp-config'),
}));
const { DelegationService } = await import('./delegation.js');
const head = 'a'.repeat(40);
const worktrees = new Map<string, string>();
let dirty = '';
let sessions: SessionCaller[];
let service: InstanceType<typeof DelegationService>;
let core: {
  createTask: ReturnType<typeof vi.fn>;
  listTasks: ReturnType<typeof vi.fn>;
  getTaskStatus: ReturnType<typeof vi.fn>;
  getTaskDiff: ReturnType<typeof vi.fn>;
  getTaskOutput: ReturnType<typeof vi.fn>;
  isRegisteredCoordinator: ReturnType<typeof vi.fn>;
  waitForSignalDone: ReturnType<typeof vi.fn>;
  detachChildren: ReturnType<typeof vi.fn>;
  deregisterCoordinator: ReturnType<typeof vi.fn>;
  stopChildren: ReturnType<typeof vi.fn>;
  resumeChildren: ReturnType<typeof vi.fn>;
};
let persist: () => void;

function task(taskId: string, extra: Partial<TaskAuthorityInput> = {}): TaskAuthorityInput {
  return {
    taskId,
    name: taskId,
    projectId: 'project',
    projectRoot: '/repo',
    worktreePath: `/external/${taskId}`,
    branchName: 'feature',
    gitIsolation: 'worktree',
    agentCommand: 'codex',
    agentArgs: [],
    ...extra,
  };
}
async function register(taskId: string, extra: Partial<TaskAuthorityInput> = {}) {
  const record = task(taskId, extra);
  worktrees.set(record.worktreePath, record.projectRoot);
  await service.register(record);
  return record;
}
function session(taskId: string, instance = `instance-${taskId}`, child = false): SessionCaller {
  const caller: SessionCaller = {
    taskId,
    agentId: `agent-${taskId}`,
    sessionInstanceId: instance,
    capabilities: { profile: child ? 'child-review' : 'ordinary', canCreate: !child, peers: true },
  };
  sessions.push(caller);
  return caller;
}
function assignment(extra: Partial<DelegateAssignment> = {}): DelegateAssignment {
  return {
    parentTaskId: 'parent',
    requestId: 'request-1',
    name: 'Child',
    prompt: 'Implement assignment',
    expectedBranch: 'feature',
    expectedHeadSha: head,
    useLastCommit: false,
    ...extra,
  };
}
function childRecord(): CoordinatedTask {
  return {
    id: 'child',
    name: 'Child',
    projectId: 'project',
    projectRoot: '/repo',
    worktreePath: '/external/child',
    branchName: 'child',
    baseBranch: 'feature',
    agentId: 'agent-child',
    coordinatorTaskId: 'parent',
    status: 'running',
    exitCode: null,
    integrationPolicy: 'review',
  };
}
function policy(allowAgentTaskCreation = false, allowPeerAccess = false) {
  service.updatePolicy({ projectId: 'project', allowAgentTaskCreation, allowPeerAccess });
}
async function send(sender: SessionCaller, target: SessionCaller, requestId = 'message-1') {
  return (await service.callTool(sender, 'send_agent_prompt', {
    agentId: target.agentId,
    sessionInstanceId: target.sessionInstanceId,
    prompt: 'Please inspect this',
    requestId,
  })) as { deliveryId: string; state: string; reason?: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  worktrees.clear();
  dirty = '';
  sessions = [];
  mocks.realpath.mockImplementation(async (path: string) => path);
  mocks.git.mockImplementation(
    async (_command: string, args: string[], options: { cwd: string }) => {
      let stdout = '';
      if (args.includes('--git-common-dir'))
        stdout = `${worktrees.get(options.cwd) ?? options.cwd}/.git`;
      else if (args[0] === 'worktree')
        stdout = [...worktrees]
          .filter(([, project]) => project === options.cwd)
          .map(([path]) => `worktree ${path}\0HEAD ${head}\0`)
          .join('');
      else if (args[0] === 'symbolic-ref') stdout = 'feature';
      else if (args[0] === 'rev-parse') stdout = head;
      else if (args[0] === 'status') stdout = dirty;
      return { stdout, stderr: '' };
    },
  );
  mocks.meta.mockImplementation((agentId: string) => ({ agentId, isShell: false }));
  mocks.scrollback.mockReturnValue(Buffer.from('\u001b[31mHello peer\u001b[0m').toString('base64'));
  core = {
    createTask: vi.fn().mockResolvedValue(childRecord()),
    listTasks: vi.fn().mockReturnValue([]),
    getTaskStatus: vi.fn(),
    getTaskDiff: vi.fn(),
    getTaskOutput: vi.fn(),
    isRegisteredCoordinator: vi.fn().mockReturnValue(true),
    waitForSignalDone: vi.fn().mockResolvedValue({ remaining: 0 }),
    detachChildren: vi.fn().mockReturnValue(['child']),
    deregisterCoordinator: vi.fn(),
    stopChildren: vi.fn(),
    resumeChildren: vi.fn(),
  };
  persist = vi.fn();
  service = new DelegationService({
    coordinator: async () => core as unknown as Coordinator,
    currentCoordinator: () => core as unknown as Coordinator,
    prepareParent: async () => {},
    sessions: () => sessions,
    changed: vi.fn(),
    persist,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('delegation authority and creation', () => {
  it('accepts validated external worktrees and rejects conflicting lifecycle identity', async () => {
    await register('parent');
    expect(service.getTask('parent')?.projectRoot).toBe('/repo');
    await expect(service.register(task('parent', { projectId: 'other' }))).rejects.toThrow(
      'Conflicting',
    );
    await expect(service.register(task('missing'))).rejects.toThrow('not a worktree');
    expect(service.getTask('parent')?.projectRoot).toBe('/repo');
  });

  it('never creates authority from a live session alone', async () => {
    const caller = session('unregistered');
    await expect(service.callTool(caller, 'list_tasks', {})).rejects.toThrow('unavailable');
    expect(service.capabilities('unregistered')).toBeUndefined();
  });

  it('requires project consent for agent creation while allowing one explicit desktop creation', async () => {
    await register('parent');
    const caller = session('parent');
    expect(() => service.create(assignment(), caller)).toThrow('Enable');
    await service.create(assignment());
    expect(core.createTask).toHaveBeenCalledOnce();
    expect(service.capabilities('parent')?.canCreate).toBe(false);
  });

  it('deduplicates a pending request and rejects changed content with the same ID', async () => {
    await register('parent');
    policy(true);
    const caller = session('parent');
    const first = service.create(assignment(), caller);
    expect(service.create(assignment(), caller)).toBe(first);
    expect(() => service.create(assignment({ prompt: 'Different instruction' }), caller)).toThrow(
      'reused',
    );
    await first;
    expect(core.createTask).toHaveBeenCalledOnce();
  });

  it('replays an agent request without deriving a new snapshot after the parent advances', async () => {
    await register('parent');
    policy(true);
    const caller = session('parent');
    const params = { requestId: 'stable-request', name: 'Child', prompt: 'Implement assignment' };
    const first = await service.callTool(caller, 'create_task', params);
    const snapshot = vi.spyOn(service, 'snapshot').mockRejectedValue(new Error('Parent changed'));
    await expect(service.callTool(caller, 'create_task', params)).resolves.toEqual(first);
    expect(snapshot).not.toHaveBeenCalled();
    expect(core.createTask).toHaveBeenCalledOnce();
  });

  it('prevents generic merge bypass through a symlinked project path', async () => {
    await register('parent');
    await register('child', {
      parentTaskId: 'parent',
      integrationPolicy: 'review',
      branchName: 'child',
    });
    mocks.realpath.mockImplementation(async (value: string) =>
      value === '/project-link' ? '/repo' : value,
    );
    await expect(service.assertDirectMergeAllowed('/project-link', 'child')).rejects.toThrow(
      'Review',
    );
  });

  it('can resume a detached task without creating a parent coordinator', async () => {
    await register('detached', { delegationPaused: true });
    core.isRegisteredCoordinator.mockReturnValue(false);
    await expect(
      service.request({ action: 'pause', taskId: 'detached', paused: false }),
    ).resolves.toEqual({ paused: false });
    expect(core.resumeChildren).not.toHaveBeenCalled();
    expect(service.state('detached').paused).toBe(false);
  });

  it('requires an explicit committed-state choice when the parent is dirty', async () => {
    await register('parent');
    dirty = ' M changed.ts';
    await expect(service.create(assignment())).rejects.toThrow('changed files');
    expect(core.createTask).not.toHaveBeenCalled();
    await service.create(assignment({ requestId: 'confirmed', useLastCommit: true }));
    expect(core.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotCommit: head,
        baseBranch: 'feature',
        integrationPolicy: 'review',
      }),
    );
  });

  it('retains failed attempts and rejects a changed snapshot', async () => {
    await register('parent');
    await expect(service.create(assignment({ expectedHeadSha: 'b'.repeat(40) }))).rejects.toThrow(
      'changed',
    );
    expect(service.state('parent').attempts).toEqual([
      expect.objectContaining({ status: 'failed', error: expect.stringContaining('changed') }),
    ]);
    expect(core.createTask).not.toHaveBeenCalled();
  });

  it('rechecks revoked consent through the reserved launch guard', async () => {
    await register('parent');
    policy(true);
    const caller = session('parent');
    core.createTask.mockImplementationOnce(async (options: { launchGuard: () => void }) => {
      policy(false);
      options.launchGuard();
      return childRecord();
    });
    await expect(service.create(assignment(), caller)).rejects.toThrow('Enable');
  });

  it('denies grandchildren and keeps ordinary supervision scoped', async () => {
    await register('parent');
    await register('child', { parentTaskId: 'parent', integrationPolicy: 'review' });
    const child = session('child', 'child-instance', true);
    await expect(service.callTool(child, 'create_task', {})).rejects.toThrow('unavailable');
    const parent = session('parent');
    core.getTaskStatus.mockReturnValue({ coordinatorTaskId: 'someone-else' });
    await expect(
      service.callTool(parent, 'get_task_output', { taskId: 'foreign-child' }),
    ).rejects.toThrow('not your child');
    await expect(service.callTool(parent, 'merge_task', { taskId: 'child' })).rejects.toThrow(
      'unavailable',
    );
  });
});

describe('held peer messages and access', () => {
  it('requires peer opt-in across top-level tasks and denies cross-project access', async () => {
    await register('parent');
    await register('peer');
    await register('other', { projectRoot: '/other', projectId: 'other' });
    const parent = session('parent'),
      peer = session('peer');
    session('other');
    await expect(service.callTool(parent, 'list_agent_sessions', {})).resolves.toEqual([]);
    await expect(send(parent, peer)).rejects.toThrow('scope');
    policy(false, true);
    await expect(service.callTool(parent, 'list_agent_sessions', {})).resolves.toEqual([
      expect.objectContaining({ taskId: 'peer' }),
    ]);
    await expect(
      service.callTool(parent, 'get_agent_output', {
        agentId: peer.agentId,
        sessionInstanceId: peer.sessionInstanceId,
      }),
    ).resolves.toMatchObject({ output: 'Hello peer', truncated: false });
  });

  it('limits a child to its own parent even when peer access is enabled', async () => {
    await register('parent');
    await register('peer');
    await register('child', { parentTaskId: 'parent' });
    session('parent');
    session('peer');
    const child = session('child', 'child-instance', true);
    policy(false, true);
    await expect(service.callTool(child, 'list_agent_sessions', {})).resolves.toEqual([
      expect.objectContaining({ taskId: 'parent' }),
    ]);
  });

  it('holds messages, deduplicates sends and resolves receipt waits only on explicit handling', async () => {
    await register('parent');
    await register('peer');
    const parent = session('parent'),
      peer = session('peer');
    policy(false, true);
    const receipt = await send(parent, peer);
    expect(receipt.state).toBe('waiting');
    expect(await send(parent, peer)).toEqual(receipt);
    expect(service.state('peer').messages).toHaveLength(1);
    const waiting = service.callTool(parent, 'wait_for_agent_prompt', {
      deliveryId: receipt.deliveryId,
      lastObservedState: 'waiting',
    });
    await service.request({
      action: 'handleMessage',
      deliveryId: receipt.deliveryId,
      agentId: peer.agentId,
      sessionInstanceId: peer.sessionInstanceId,
      state: 'handled',
    });
    await expect(waiting).resolves.toMatchObject({ state: 'handled' });
    expect(service.state('peer').messages).toEqual([]);
  });

  it('expires the old recipient on same-pane restart and cannot redirect messages', async () => {
    await register('parent');
    await register('peer');
    const parent = session('parent'),
      peer = session('peer');
    policy(false, true);
    const receipt = await send(parent, peer);
    sessions = sessions.filter((entry) => entry !== peer);
    session('peer', 'replacement');
    service.expireMessages();
    await expect(
      service.callTool(parent, 'wait_for_agent_prompt', { deliveryId: receipt.deliveryId }),
    ).resolves.toMatchObject({ state: 'closed', reason: expect.stringContaining('ended') });
    await expect(send(parent, peer, 'new-request')).rejects.toThrow('unavailable');
    await expect(
      service.request({
        action: 'handleMessage',
        deliveryId: receipt.deliveryId,
        agentId: peer.agentId,
        sessionInstanceId: 'replacement',
        state: 'handled',
      }),
    ).rejects.toThrow('unavailable');
  });

  it('revocation closes unaccepted peer entries and removes discovery/output access', async () => {
    await register('parent');
    await register('peer');
    const parent = session('parent'),
      peer = session('peer');
    policy(false, true);
    const receipt = await send(parent, peer);
    policy(false, false);
    await expect(
      service.callTool(parent, 'wait_for_agent_prompt', { deliveryId: receipt.deliveryId }),
    ).resolves.toMatchObject({ state: 'closed', reason: expect.stringContaining('disabled') });
    await expect(service.callTool(parent, 'list_agent_sessions', {})).resolves.toEqual([]);
    await expect(
      service.callTool(parent, 'get_agent_output', {
        agentId: peer.agentId,
        sessionInstanceId: peer.sessionInstanceId,
      }),
    ).rejects.toThrow('scope');
  });
});

describe('backend detach normalization', () => {
  it('overrides stale renderer relationships before deleting the parent', async () => {
    await register('parent');
    await register('child', { parentTaskId: 'parent', integrationPolicy: 'review' });
    await service.closeParent('parent', true);
    expect(persist).toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
    const saved = JSON.parse(
      service.normalizeState(
        JSON.stringify({
          tasks: {
            parent: { id: 'parent' },
            child: {
              id: 'child',
              coordinatedBy: 'parent',
              controlledBy: 'coordinator',
              integrationPolicy: 'review',
              mcpLaunchArgs: ['old-token'],
            },
          },
          taskOrder: ['parent', 'child'],
        }),
      ),
    );
    expect(saved.tasks.parent).toBeUndefined();
    expect(saved.tasks.child).not.toHaveProperty('coordinatedBy');
    expect(saved.tasks.child).not.toHaveProperty('mcpLaunchArgs');
    expect(saved.tasks.child.delegationPaused).toBe(true);
    expect(saved.taskOrder).toEqual(['child']);
  });
});
