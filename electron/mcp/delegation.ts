import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Coordinator } from './coordinator.js';
import type { CoordinatedTask } from './types.js';
import { stripAnsi } from './prompt-detect.js';
import { canConfigureCanvasMcp } from './canvas-config.js';
import { validateBranchName } from './validation.js';
import { getSkipPermissionsArgs } from '../shared/skip-permissions.js';
import { getActiveAgentIds, getAgentMeta, getAgentScrollback, killAgent } from '../ipc/pty.js';
import { deleteTask } from '../ipc/tasks.js';
import type {
  DelegateAssignment,
  DelegationAttempt,
  DelegationChanged,
  DelegationRequest,
  DelegationSnapshot,
  DelegationState,
  PeerMessage,
  PeerSession,
  ProjectDelegationPolicy,
  SessionCaller,
  SessionCapabilities,
  TaskAuthorityInput,
} from '../shared/delegation-types.js';

const exec = promisify(execFile);
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_MESSAGES = 200;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;

type Authority = TaskAuthorityInput & { closing?: boolean; closed?: boolean };

export class DelegationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new DelegationError(`${name} must be nonempty and at most ${max} characters`);
  return value;
}
function id(value: unknown, name = 'ID'): string {
  const result = text(value, name, 128);
  if (!ID.test(result)) throw new DelegationError(`Invalid ${name}`);
  return result;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DelegationError('Expected an object');
  return value as Record<string, unknown>;
}
function timeout(value: unknown): number {
  if (value === undefined) return 30_000;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new DelegationError('Invalid timeout');
  return Math.min(60_000, value);
}
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}

/** Identity comes only from acknowledged desktop lifecycle operations, never display broadcasts. */
export class DelegationService {
  private readonly tasks = new Map<string, Authority>();
  private readonly policies = new Map<string, ProjectDelegationPolicy>();
  private readonly detached = new Set<string>();
  private readonly requests = new Map<
    string,
    { payload: string; promise: Promise<{ taskId: string; agentId: string }> }
  >();
  private readonly attempts = new Map<string, DelegationAttempt>();
  private readonly messages = new Map<string, PeerMessage>();
  private readonly messageRequests = new Map<string, { payload: string; deliveryId: string }>();
  private readonly messageWaiters = new Set<() => void>();
  private readonly closes = new Map<string, Promise<{ detachedChildIds: string[] }>>();

  constructor(
    private readonly options: {
      coordinator: () => Promise<Coordinator>;
      currentCoordinator: () => Coordinator | null;
      prepareParent: (task: TaskAuthorityInput, assignment?: DelegateAssignment) => Promise<void>;
      sessions: () => SessionCaller[];
      changed: (event: DelegationChanged) => void;
      persist: () => void;
      parentCreated?: (taskId: string) => void;
    },
  ) {}

  getTask(taskId: string): TaskAuthorityInput | undefined {
    return this.tasks.get(taskId);
  }

  private requireTask(taskId: string): Authority {
    const task = this.tasks.get(taskId);
    if (!task || task.closed || task.closing)
      throw new DelegationError('Task unavailable or closing', 403);
    return task;
  }

  async register(input: TaskAuthorityInput): Promise<void> {
    id(input.taskId, 'taskId');
    id(input.projectId, 'projectId');
    if (!['worktree', 'direct', 'none'].includes(input.gitIsolation))
      throw new DelegationError('Invalid task isolation');
    text(input.projectRoot, 'projectRoot', 16_384);
    text(input.worktreePath, 'worktreePath', 16_384);
    if (!Array.isArray(input.agentArgs) || input.agentArgs.some((arg) => typeof arg !== 'string'))
      throw new DelegationError('Invalid agent arguments');
    if (typeof input.agentCommand !== 'string') throw new DelegationError('Invalid agent command');
    const [projectRoot, worktreePath] = await Promise.all([
      realpath(input.projectRoot),
      realpath(input.worktreePath),
    ]);
    if (input.gitIsolation === 'worktree') {
      const [projectCommon, taskCommon, worktrees] = await Promise.all([
        git(projectRoot, 'rev-parse', '--git-common-dir'),
        git(worktreePath, 'rev-parse', '--git-common-dir'),
        git(projectRoot, 'worktree', 'list', '--porcelain', '-z'),
      ]);
      const [a, b] = await Promise.all([
        realpath(resolve(projectRoot, projectCommon)),
        realpath(resolve(worktreePath, taskCommon)),
      ]);
      if (a !== b || !worktrees.split('\0').includes(`worktree ${worktreePath}`))
        throw new DelegationError('Task is not a worktree of this project');
      validateBranchName(input.branchName, 'branchName');
    }
    const previous = this.tasks.get(input.taskId);
    if (
      previous &&
      (previous.projectId !== input.projectId ||
        previous.projectRoot !== projectRoot ||
        previous.worktreePath !== worktreePath)
    )
      throw new DelegationError('Conflicting task authority');
    if (previous?.closing || previous?.closed) throw new DelegationError('Task is closing');
    const parentTaskId = this.detached.has(input.taskId) ? undefined : input.parentTaskId;
    if (parentTaskId) {
      id(parentTaskId, 'parentTaskId');
      const parent = this.requireTask(parentTaskId);
      if (parent.projectId !== input.projectId || parent.projectRoot !== projectRoot)
        throw new DelegationError('Parent belongs to another project');
    }
    const task: Authority = {
      ...input,
      projectRoot,
      worktreePath,
      parentTaskId,
      delegationPaused: previous?.delegationPaused ?? input.delegationPaused,
      delegationParent: previous?.delegationParent ?? input.delegationParent,
    };
    this.tasks.set(input.taskId, task);
    if (task.delegationParent && !task.coordinatorMode) await this.options.prepareParent(task);
  }

  registerChild(child: CoordinatedTask): void {
    const parent = this.requireTask(child.coordinatorTaskId);
    this.tasks.set(child.id, {
      ...parent,
      taskId: child.id,
      name: child.name,
      branchName: child.branchName,
      worktreePath: child.worktreePath,
      parentTaskId: child.coordinatorTaskId,
      delegationParent: false,
      coordinatorMode: false,
      externalWorktree: false,
      delegationPaused: false,
      integrationPolicy: child.integrationPolicy,
    });
  }

  capabilities(taskId: string): SessionCapabilities | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.closed || task.closing || task.gitIsolation !== 'worktree') return undefined;
    return {
      profile: task.parentTaskId
        ? task.integrationPolicy === 'review'
          ? 'child-review'
          : 'child-automatic'
        : 'ordinary',
      canCreate:
        !task.parentTaskId && this.policies.get(task.projectId)?.allowAgentTaskCreation === true,
      peers: true,
    };
  }

  updatePolicy(policy: ProjectDelegationPolicy): void {
    id(policy.projectId, 'projectId');
    if (
      typeof policy.allowAgentTaskCreation !== 'boolean' ||
      typeof policy.allowPeerAccess !== 'boolean'
    )
      throw new DelegationError('Invalid project policy');
    this.policies.set(policy.projectId, { ...policy });
    for (const message of this.messages.values()) {
      if (
        message.state === 'waiting' &&
        !this.canContact(message.sender.taskId, message.recipient.taskId)
      ) {
        message.state = 'closed';
        message.reason = 'Peer access disabled';
        this.messageChanged(message);
      }
    }
    this.options.persist();
  }

  async snapshot(taskId: string): Promise<DelegationSnapshot> {
    const task = this.requireTask(taskId);
    if (task.gitIsolation !== 'worktree')
      throw new DelegationError('Delegation requires a Git worktree task');
    const [branchName, headSha, status] = await Promise.all([
      git(task.worktreePath, 'symbolic-ref', '--short', 'HEAD'),
      git(task.worktreePath, 'rev-parse', 'HEAD'),
      git(task.worktreePath, 'status', '--porcelain'),
    ]);
    this.requireTask(taskId);
    return { branchName, headSha, changedFileCount: status ? status.split('\n').length : 0 };
  }

  private creationGuard(taskId: string, caller?: SessionCaller): void {
    const task = this.requireTask(taskId);
    if (task.parentTaskId || task.gitIsolation !== 'worktree')
      throw new DelegationError('Only top-level worktree tasks may delegate', 403);
    if (task.delegationPaused)
      throw new DelegationError('Child creation is paused. Resume it in Parallel Code.', 403);
    if (caller) {
      this.requireCaller(caller);
      if (
        caller.taskId !== taskId ||
        !caller.capabilities.canCreate ||
        !this.policies.get(task.projectId)?.allowAgentTaskCreation
      )
        throw new DelegationError(
          'Enable agent-created tasks for this project and restart/resume the session.',
          403,
        );
    }
  }

  create(
    assignment: DelegateAssignment,
    caller?: SessionCaller,
  ): Promise<{ taskId: string; agentId: string }> {
    this.creationGuard(assignment.parentTaskId, caller);
    id(assignment.requestId, 'requestId');
    text(assignment.name, 'name');
    text(assignment.prompt, 'prompt', MAX_PROMPT_BYTES);
    if (Buffer.byteLength(assignment.prompt) > MAX_PROMPT_BYTES)
      throw new DelegationError('Prompt too large');
    const key = `${assignment.parentTaskId}:${assignment.requestId}`;
    const payload = JSON.stringify(assignment);
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.payload !== payload)
        throw new DelegationError('Request ID reused with a different assignment');
      return previous.promise;
    }
    const promise = this.createOnce(assignment, caller, key);
    this.requests.set(key, { payload, promise });
    return promise;
  }

  private async createOnce(
    assignment: DelegateAssignment,
    caller: SessionCaller | undefined,
    key: string,
  ): Promise<{ taskId: string; agentId: string }> {
    const attempt: DelegationAttempt = {
      requestId: assignment.requestId,
      parentTaskId: assignment.parentTaskId,
      name: assignment.name,
      status: 'starting',
    };
    this.attempts.set(key, attempt);
    this.emit(assignment.parentTaskId);
    try {
      const task = this.requireTask(assignment.parentTaskId);
      const snapshot = await this.snapshot(task.taskId);
      if (
        snapshot.branchName !== assignment.expectedBranch ||
        snapshot.headSha !== assignment.expectedHeadSha
      )
        throw new DelegationError(
          'Parent branch or commit changed. Refresh the assignment snapshot.',
        );
      if (snapshot.changedFileCount && assignment.useLastCommit !== true)
        throw new DelegationError(
          `Parent has ${snapshot.changedFileCount} changed files. Review/commit first or explicitly use the last commit (${snapshot.headSha}).`,
        );
      const command = assignment.agentCommand ?? task.agentCommand;
      const bypassFlags = new Set([...getSkipPermissionsArgs(command), '--yolo']);
      const args = (assignment.agentArgs ?? task.agentArgs).filter(
        (arg) => !bypassFlags.has(arg.split('=')[0]),
      );
      if (!canConfigureCanvasMcp(command, args))
        throw new DelegationError('Select a supported agent without custom MCP configuration');
      task.branchName = snapshot.branchName;
      await this.options.prepareParent(task, assignment);
      this.creationGuard(task.taskId, caller);
      const coordinator = await this.options.coordinator();
      const child = await coordinator.createTask({
        name: assignment.name,
        prompt: assignment.prompt,
        coordinatorTaskId: task.taskId,
        baseBranch: snapshot.branchName,
        snapshotCommit: snapshot.headSha,
        agentCommand: command,
        agentArgs: args,
        integrationPolicy: 'review',
        agentEnvFile: assignment.agentEnvFile ?? task.agentEnvFile,
        skipPermissions:
          assignment.propagateSkipPermissions ?? task.propagateSkipPermissions ?? false,
        launchGuard: () => this.creationGuard(task.taskId, caller),
        nativeLaunchGuard: () => this.creationGuard(task.taskId, caller),
      });
      this.registerChild(child);
      const childAuthority = this.tasks.get(child.id);
      if (childAuthority) {
        childAuthority.agentCommand = command;
        childAuthority.agentArgs = args;
      }
      task.delegationParent = true;
      this.options.parentCreated?.(task.taskId);
      this.options.persist();
      attempt.status = 'created';
      attempt.taskId = child.id;
      return { taskId: child.id, agentId: child.agentId };
    } catch (error) {
      attempt.status = 'failed';
      attempt.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.emit(assignment.parentTaskId);
    }
  }

  private requireCaller(caller: SessionCaller): Authority {
    if (
      !this.options
        .sessions()
        .some(
          (session) =>
            session.agentId === caller.agentId &&
            session.sessionInstanceId === caller.sessionInstanceId &&
            session.taskId === caller.taskId,
        )
    )
      throw new DelegationError('Session expired', 403);
    return this.requireTask(caller.taskId);
  }

  async callTool(
    caller: SessionCaller,
    name: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const task = this.requireCaller(caller);
    if (
      [
        'list_agent_sessions',
        'get_agent_output',
        'send_agent_prompt',
        'wait_for_agent_prompt',
      ].includes(name)
    ) {
      if (!caller.capabilities.peers) throw new DelegationError('Peer tools unavailable', 403);
      return this.peerTool(caller, name, params);
    }
    if (task.parentTaskId) {
      const coordinator = await this.options.coordinator();
      this.requireCaller(caller);
      if (name === 'signal_done') return { ok: coordinator.signalDone(task.taskId) };
      if (
        name === 'land_self' &&
        task.integrationPolicy !== 'review' &&
        caller.capabilities.profile === 'child-automatic'
      ) {
        return coordinator.landSelf(
          task.taskId,
          params as unknown as Parameters<Coordinator['landSelf']>[1],
        );
      }
      throw new DelegationError('Tool unavailable to this child session', 403);
    }
    if (caller.capabilities.profile !== 'ordinary')
      throw new DelegationError('Invalid session profile', 403);
    if (name === 'create_task') {
      this.creationGuard(task.taskId, caller);
      const requestId = id(params.requestId, 'requestId');
      const previous = this.requests.get(`${task.taskId}:${requestId}`);
      const original = previous ? (JSON.parse(previous.payload) as DelegateAssignment) : undefined;
      const snap = original
        ? { branchName: original.expectedBranch, headSha: original.expectedHeadSha }
        : await this.snapshot(task.taskId);
      this.requireCaller(caller);
      return this.create(
        {
          parentTaskId: task.taskId,
          requestId,
          name: text(params.name, 'name'),
          prompt: text(params.prompt, 'prompt', MAX_PROMPT_BYTES),
          expectedBranch:
            typeof params.expectedBranch === 'string' ? params.expectedBranch : snap.branchName,
          expectedHeadSha:
            typeof params.expectedHeadSha === 'string' ? params.expectedHeadSha : snap.headSha,
          useLastCommit: params.useLastCommit === true,
        },
        caller,
      );
    }
    const allowed = [
      'list_tasks',
      'get_task_status',
      'get_task_diff',
      'get_task_output',
      'send_prompt',
      'wait_for_idle',
      'wait_for_signal_done',
    ];
    if (!allowed.includes(name))
      throw new DelegationError('Tool unavailable to ordinary sessions', 403);
    const coordinator = this.options.currentCoordinator();
    if (name === 'list_tasks')
      return (
        coordinator?.listTasks().filter((child) => child.coordinatorTaskId === task.taskId) ?? []
      );
    if (name === 'wait_for_signal_done') {
      if (!coordinator?.isRegisteredCoordinator(task.taskId)) return { remaining: 0 };
      return coordinator.waitForSignalDone(task.taskId, timeout(params.timeoutMs));
    }
    const childId = id(params.taskId, 'taskId');
    const child = coordinator?.getTaskStatus(childId);
    if (!coordinator || !child || child.coordinatorTaskId !== task.taskId)
      throw new DelegationError('This is not your child task', 403);
    switch (name) {
      case 'get_task_status':
        return child;
      case 'get_task_diff':
        return coordinator.getTaskDiff(childId);
      case 'get_task_output':
        return { output: coordinator.getTaskOutput(childId) };
      case 'send_prompt':
        return coordinator.sendPrompt(childId, text(params.prompt, 'prompt', MAX_PROMPT_BYTES));
      case 'wait_for_idle':
        return coordinator.waitForIdle(childId, timeout(params.timeoutMs));
    }
  }

  private canContact(senderId: string, targetId: string): boolean {
    const sender = this.tasks.get(senderId),
      target = this.tasks.get(targetId);
    if (
      !sender ||
      !target ||
      sender.closed ||
      target.closed ||
      sender.closing ||
      target.closing ||
      sender.projectId !== target.projectId
    )
      return false;
    if (sender.parentTaskId) return sender.parentTaskId === targetId;
    if (target.parentTaskId === senderId) return true;
    return !target.parentTaskId && this.policies.get(sender.projectId)?.allowPeerAccess === true;
  }

  private peer(session: SessionCaller): PeerSession {
    const task = this.requireTask(session.taskId);
    return {
      agentId: session.agentId,
      sessionInstanceId: session.sessionInstanceId,
      taskId: session.taskId,
      name: task.name,
      agentLabel: task.agentCommand,
      branchName: task.branchName,
      status: this.options.currentCoordinator()?.getTaskStatus(task.taskId)?.status ?? 'unknown',
    };
  }

  private target(caller: SessionCaller, params: Record<string, unknown>): SessionCaller {
    const agentId = id(params.agentId, 'agentId'),
      instance = id(params.sessionInstanceId, 'sessionInstanceId');
    const target = this.options
      .sessions()
      .find((s) => s.agentId === agentId && s.sessionInstanceId === instance);
    if (!target || !this.canContact(caller.taskId, target.taskId) || getAgentMeta(agentId)?.isShell)
      throw new DelegationError('Recipient unavailable or outside your scope', 403);
    return target;
  }

  private async peerTool(
    caller: SessionCaller,
    name: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.expireMessages();
    if (name === 'list_agent_sessions')
      return this.options
        .sessions()
        .filter(
          (s) =>
            s.agentId !== caller.agentId &&
            !getAgentMeta(s.agentId)?.isShell &&
            this.canContact(caller.taskId, s.taskId),
        )
        .map((s) => this.peer(s));
    if (name === 'wait_for_agent_prompt') {
      const deliveryId = id(params.deliveryId, 'deliveryId');
      const message = this.messages.get(deliveryId);
      if (
        !message ||
        message.sender.sessionInstanceId !== caller.sessionInstanceId ||
        message.sender.agentId !== caller.agentId
      )
        throw new DelegationError('Receipt unavailable', 404);
      const last = params.lastObservedState;
      if (last !== undefined && !['waiting', 'handled', 'closed'].includes(String(last)))
        throw new DelegationError('Invalid receipt state');
      if (message.state !== 'waiting' || last !== message.state) return this.receipt(message);
      await new Promise<void>((resolveWait) => {
        const done = () => {
          clearTimeout(timer);
          this.messageWaiters.delete(check);
          resolveWait();
        };
        const check = () => {
          if (message.state !== 'waiting') done();
        };
        const timer = setTimeout(done, timeout(params.timeoutMs));
        this.messageWaiters.add(check);
      });
      this.requireCaller(caller);
      return this.receipt(message);
    }
    const target = this.target(caller, params);
    if (name === 'get_agent_output') {
      const maxBytes = params.maxBytes ?? 16_384;
      if (
        typeof maxBytes !== 'number' ||
        !Number.isInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 65_536
      )
        throw new DelegationError('maxBytes must be between 1 and 65536');
      const raw = getAgentScrollback(target.agentId);
      if (raw === null) throw new DelegationError('Recipient exited', 404);
      const decoded = Buffer.from(stripAnsi(Buffer.from(raw, 'base64').toString('utf8')));
      return {
        output: decoded.subarray(Math.max(0, decoded.length - maxBytes)).toString('utf8'),
        truncated: decoded.length > maxBytes,
        observedAt: new Date().toISOString(),
      };
    }
    const prompt = text(params.prompt, 'prompt', MAX_PROMPT_BYTES);
    if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new DelegationError('Prompt too large');
    const requestId = id(params.requestId, 'requestId');
    const key = `${caller.sessionInstanceId}:${requestId}`;
    const payload = JSON.stringify([target.agentId, target.sessionInstanceId, prompt]);
    const old = this.messageRequests.get(key);
    if (old) {
      if (old.payload !== payload)
        throw new DelegationError('Request ID reused with different content');
      const message = this.messages.get(old.deliveryId);
      if (!message) throw new DelegationError('Receipt expired; do not automatically resend', 410);
      return this.receipt(message);
    }
    if (this.messageRequests.size >= 2000)
      throw new DelegationError('Session message limit reached', 429);
    if (this.messages.size >= MAX_MESSAGES) {
      for (const [key, message] of this.messages) {
        if (message.state !== 'waiting') {
          this.messages.delete(key);
          break;
        }
      }
      if (this.messages.size >= MAX_MESSAGES)
        throw new DelegationError('Incoming message queue is full', 429);
    }
    const message: PeerMessage = {
      deliveryId: randomUUID(),
      sender: this.peer(caller),
      recipient: this.peer(target),
      prompt,
      createdAt: new Date().toISOString(),
      state: 'waiting',
    };
    this.messages.set(message.deliveryId, message);
    this.messageRequests.set(key, { payload, deliveryId: message.deliveryId });
    this.messageChanged(message);
    return this.receipt(message);
  }

  private receipt(message: PeerMessage): {
    deliveryId: string;
    state: PeerMessage['state'];
    reason?: string;
  } {
    return { deliveryId: message.deliveryId, state: message.state, reason: message.reason };
  }
  private messageChanged(message: PeerMessage): void {
    this.emit(message.recipient.taskId);
    for (const check of this.messageWaiters) check();
  }
  expireMessages(): void {
    const sessions = this.options.sessions();
    const liveInstances = new Set(sessions.map((session) => session.sessionInstanceId));
    for (const key of this.messageRequests.keys()) {
      if (!liveInstances.has(key.split(':')[0])) this.messageRequests.delete(key);
    }
    for (const message of this.messages.values()) {
      if (
        message.state === 'waiting' &&
        (!this.canContact(message.sender.taskId, message.recipient.taskId) ||
          !sessions.some(
            (s) =>
              s.agentId === message.recipient.agentId &&
              s.sessionInstanceId === message.recipient.sessionInstanceId,
          ))
      ) {
        message.state = 'closed';
        message.reason = 'Recipient session ended or access revoked';
        this.messageChanged(message);
      }
    }
  }
  private emit(taskId: string): void {
    this.options.changed({ taskId, state: this.state(taskId) });
  }
  state(taskId: string): DelegationState {
    return {
      attempts: [...this.attempts.values()].filter((a) => a.parentTaskId === taskId),
      messages: [...this.messages.values()].filter(
        (m) => m.recipient.taskId === taskId && m.state === 'waiting',
      ),
      paused: this.tasks.get(taskId)?.delegationPaused === true,
    };
  }

  async request(raw: unknown): Promise<unknown> {
    const request = record(raw) as unknown as DelegationRequest;
    switch (request.action) {
      case 'unregister': {
        const taskId = id(request.taskId);
        if (this.tasks.get(taskId)?.delegationParent || this.tasks.get(taskId)?.coordinatorMode)
          throw new DelegationError('Close parent through the detach operation');
        this.unregister(taskId);
        this.options.persist();
        return { ok: true };
      }
      case 'register':
        await this.register(request.task);
        return { ready: true };
      case 'projectPolicy':
        this.updatePolicy(request.policy);
        return request.policy;
      case 'snapshot':
        return this.snapshot(id(request.taskId));
      case 'create':
        return this.create(request.assignment);
      case 'state':
        this.expireMessages();
        return this.state(id(request.taskId));
      case 'inbox':
        this.expireMessages();
        return this.state(id(request.taskId)).messages;
      case 'pause': {
        const task = this.requireTask(id(request.taskId));
        if (typeof request.paused !== 'boolean') throw new DelegationError('Invalid pause state');
        task.delegationPaused = request.paused;
        this.options.persist();
        const coordinator = this.options.currentCoordinator();
        if (coordinator?.isRegisteredCoordinator(task.taskId)) {
          if (request.paused) coordinator.stopChildren(task.taskId);
          else coordinator.resumeChildren(task.taskId);
        }
        this.emit(task.taskId);
        return { paused: request.paused };
      }
      case 'review':
        return (await this.options.coordinator()).getReviewSnapshot(id(request.taskId));
      case 'merge':
        return (await this.options.coordinator()).approveAndMergeTask(
          id(request.taskId),
          request.review,
        );
      case 'dismissAttempt':
        this.attempts.delete(`${id(request.parentTaskId)}:${id(request.requestId)}`);
        this.emit(request.parentTaskId);
        return { ok: true };
      case 'handleMessage': {
        const message = this.messages.get(id(request.deliveryId));
        this.expireMessages();
        if (!message || message.state !== 'waiting')
          throw new DelegationError('Message unavailable');
        if (
          request.agentId !== message.recipient.agentId ||
          request.sessionInstanceId !== message.recipient.sessionInstanceId ||
          !this.options
            .sessions()
            .some(
              (s) =>
                s.agentId === request.agentId && s.sessionInstanceId === request.sessionInstanceId,
            )
        )
          throw new DelegationError('Recipient session changed');
        if (request.state !== 'handled' && request.state !== 'closed')
          throw new DelegationError('Invalid receipt action');
        message.state = request.state;
        if (request.state === 'closed') message.reason = 'Dismissed by user';
        this.messageChanged(message);
        return this.receipt(message);
      }
      case 'closeParent':
        return this.closeParent(id(request.taskId), request.deleteBranch ?? true);
      default:
        throw new DelegationError('Unknown delegation action');
    }
  }

  closeParent(taskId: string, deleteBranch: boolean): Promise<{ detachedChildIds: string[] }> {
    const existing = this.closes.get(taskId);
    if (existing) return existing;
    const promise = this.closeParentOnce(taskId, deleteBranch).finally(() =>
      this.closes.delete(taskId),
    );
    this.closes.set(taskId, promise);
    return promise;
  }
  private async closeParentOnce(
    taskId: string,
    deleteBranch: boolean,
  ): Promise<{ detachedChildIds: string[] }> {
    const task = this.requireTask(taskId);
    task.closing = true;
    task.delegationPaused = true;
    try {
      const coordinator = await this.options.coordinator();
      const detachedChildIds = coordinator.detachChildren(taskId);
      for (const childId of detachedChildIds) {
        this.detached.add(childId);
        const child = this.tasks.get(childId);
        if (child) {
          child.parentTaskId = undefined;
          child.delegationPaused = true;
          child.integrationPolicy = undefined;
        }
      }
      this.options.persist();
      this.expireMessages();
      this.options.changed({ taskId, detachedChildIds });
      const agentIds = getActiveAgentIds().filter(
        (agentId) => getAgentMeta(agentId)?.taskId === taskId,
      );
      for (const agentId of agentIds) killAgent(agentId);
      if (!task.externalWorktree && task.gitIsolation === 'worktree')
        await deleteTask({
          taskId,
          agentIds: [],
          branchName: task.branchName,
          deleteBranch,
          projectRoot: task.projectRoot,
          worktreePath: task.worktreePath,
        });
      coordinator.deregisterCoordinator(taskId);
      task.closed = true;
      this.options.persist();
      return { detachedChildIds };
    } finally {
      task.closing = false;
    }
  }

  requiresWideTransport(): boolean {
    const coordinator = this.options.currentCoordinator();
    return [...this.tasks.values()].some(
      (task) =>
        !task.closed && task.dockerMode && coordinator?.isRegisteredCoordinator(task.taskId),
    );
  }

  async assertDirectMergeAllowed(projectRoot: string, branchName: string): Promise<void> {
    const canonicalRoot = await realpath(projectRoot);
    for (const task of this.tasks.values()) {
      if (
        !task.closed &&
        task.projectRoot === canonicalRoot &&
        task.branchName === branchName &&
        task.integrationPolicy === 'review'
      )
        throw new DelegationError('Review this delegated result before merging it.');
    }
  }

  unregister(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) task.closed = true;
    this.expireMessages();
  }

  /** Backend lifecycle fields override stale renderer snapshots after detach/stop/close. */
  normalizeState(json: string): string {
    const state = record(JSON.parse(json));
    const tasks =
      state.tasks && typeof state.tasks === 'object' && !Array.isArray(state.tasks)
        ? (state.tasks as Record<string, unknown>)
        : {};
    for (const [taskId, authority] of this.tasks) {
      const raw = tasks[taskId];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const task = raw as Record<string, unknown>;
      if (authority.closed) {
        Reflect.deleteProperty(tasks, taskId);
        continue;
      }
      if (authority.delegationParent) task.delegationParent = true;
      task.delegationPaused = authority.delegationPaused;
      if (this.detached.has(taskId)) {
        for (const key of [
          'coordinatedBy',
          'controlledBy',
          'integrationPolicy',
          'mcpConfigPath',
          'mcpLaunchArgs',
          'mcpStartupStatus',
        ])
          Reflect.deleteProperty(task, key);
      } else if (authority.parentTaskId) {
        task.coordinatedBy = authority.parentTaskId;
        task.integrationPolicy = authority.integrationPolicy;
      }
    }
    for (const key of ['taskOrder', 'collapsedTaskOrder']) {
      if (Array.isArray(state[key]))
        state[key] = (state[key] as unknown[]).filter(
          (taskId) => typeof taskId !== 'string' || !this.tasks.get(taskId)?.closed,
        );
    }
    if (Array.isArray(state.projects)) {
      for (const raw of state.projects) {
        if (!raw || typeof raw !== 'object') continue;
        const project = raw as Record<string, unknown>;
        const policy = typeof project.id === 'string' ? this.policies.get(project.id) : undefined;
        if (policy) {
          project.allowAgentTaskCreation = policy.allowAgentTaskCreation;
          project.allowPeerAccess = policy.allowPeerAccess;
        }
      }
    }
    return JSON.stringify(state);
  }
}
