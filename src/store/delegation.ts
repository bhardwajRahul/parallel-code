import { createStore } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import type {
  DelegationChanged,
  DelegationRequest,
  DelegationState,
  PeerMessage,
  TaskAuthorityInput,
} from '../../electron/shared/delegation-types';
import { invoke } from '../lib/ipc';
import { store, setStore } from './core';
import type { AgentDef } from '../ipc/types';
import type { PersistedTask, Project, Task } from './types';

export const [delegationStates, setDelegationStates] = createStore<Record<string, DelegationState>>(
  {},
);

export function delegationRequest<T>(request: DelegationRequest): Promise<T> {
  return invoke<T>(IPC.DelegationRequest, request);
}

export function taskAuthorityInput(
  task: Task | PersistedTask,
  project: Project,
  agent: AgentDef | undefined,
  agentEnvFile?: string,
): TaskAuthorityInput {
  return {
    taskId: task.id,
    name: task.name,
    projectId: project.id,
    projectRoot: project.path,
    worktreePath: task.worktreePath,
    branchName: task.branchName,
    gitIsolation: task.gitIsolation,
    parentTaskId: task.coordinatedBy,
    coordinatorMode: task.coordinatorMode,
    externalWorktree: task.externalWorktree,
    integrationPolicy: task.integrationPolicy,
    delegationPaused: task.delegationPaused,
    delegationParent: task.delegationParent,
    agentCommand: agent?.command ?? '',
    agentArgs: agent?.args ?? [],
    agentEnvFile,
    dockerMode: task.dockerMode,
    dockerImage: task.dockerImage,
    verifyCommand: project.verifyCommand,
    maxConcurrentTasks: task.maxConcurrentTasks,
    propagateSkipPermissions: task.propagateSkipPermissions,
  };
}

export async function registerTaskAuthority(task: Task, agent?: AgentDef): Promise<void> {
  const project = store.projects.find((p) => p.id === task.projectId);
  if (!project) throw new Error('Project not found');
  await delegationRequest({
    action: 'register',
    task: taskAuthorityInput(
      task,
      project,
      agent,
      agent ? store.agentEnvFiles[agent.id] : undefined,
    ),
  });
}

export function applyDelegationChange(change: DelegationChanged): void {
  if ('state' in change) {
    setDelegationStates(change.taskId, change.state);
    if (store.tasks[change.taskId]) {
      setStore('tasks', change.taskId, 'delegationPaused', change.state.paused);
      if (change.state.attempts.length > 0)
        setStore('tasks', change.taskId, 'delegationParent', true);
    }
  } else {
    for (const id of change.detachedChildIds) {
      if (!store.tasks[id]) continue;
      setStore('tasks', id, {
        coordinatedBy: undefined,
        controlledBy: undefined,
        mcpConfigPath: undefined,
        mcpLaunchArgs: undefined,
        integrationPolicy: undefined,
        delegationPaused: true,
        mcpStartupStatus: undefined,
        mcpStartupError: undefined,
      });
    }
  }
}

export async function refreshDelegationState(taskId: string): Promise<void> {
  const state = await delegationRequest<DelegationState>({ action: 'state', taskId });
  if (state) applyDelegationChange({ taskId, state });
}

/** UI creation remains available independently of the agent's tool integration. */
export function canDelegate(task: Task): boolean {
  return task.gitIsolation === 'worktree' && !task.coordinatedBy && !task.closingStatus;
}

export function isSupportedDelegationAgent(agent: AgentDef): boolean {
  return ['claude', 'codex', 'copilot'].includes(agent.command.split('/').pop() ?? '');
}

export function hasUserMcpConfiguration(args: string[]): boolean {
  return args.some(
    (arg) =>
      /^(--mcp-config|--additional-mcp-config|--strict-mcp-config)(=|$)/.test(arg) ||
      /^(?:(?:--config|-c)=)?mcp_servers(?:\.|\[|=)/.test(arg),
  );
}

interface PeerComposer {
  getText(): string;
  setText(value: string): void;
}

/** A composer belongs to the first pane; peer messages never select a different pane. */
export function canUsePeerComposer(
  task: Task,
  message: PeerMessage,
  composer: PeerComposer | undefined,
  enabled: boolean,
): boolean {
  const agentId = task.agentIds[0];
  return (
    enabled &&
    !!composer &&
    message.recipient.taskId === task.id &&
    message.recipient.agentId === agentId &&
    !!store.agents[agentId]?.sessionInstanceId &&
    store.agents[agentId].sessionInstanceId === message.recipient.sessionInstanceId &&
    composer.getText() === ''
  );
}

/** Called synchronously by the explicit Review action; never submits terminal input. */
export function usePeerComposer(
  task: Task,
  message: PeerMessage,
  composer: PeerComposer | undefined,
  enabled: boolean,
): boolean {
  if (!composer || !canUsePeerComposer(task, message, composer, enabled)) return false;
  composer.setText(message.prompt);
  setStore('tasks', task.id, 'promptDraftActive', true);
  return true;
}
