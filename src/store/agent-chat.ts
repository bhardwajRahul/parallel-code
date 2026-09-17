import { store } from './core';
import type { Task } from './types';

export function agentChatProvider(agentId: string): 'codex' | 'claude' | undefined {
  const id = store.agents[agentId]?.def.id;
  return id === 'codex' ? 'codex' : id === 'claude-code' ? 'claude' : undefined;
}

export function agentChatUnavailableReason(task: Task): string {
  if (task.dockerMode) return 'Chat is not available for Docker tasks yet';
  if (task.coordinatorMode || task.coordinatedBy)
    return 'Chat is not available for coordinator tasks or subtasks yet';
  return '';
}

export function supportsAgentChat(task: Task): boolean {
  return !!agentChatProvider(task.agentIds[0]) && !agentChatUnavailableReason(task);
}

export function isAgentChat(task: Task | undefined, agentId: string): boolean {
  return (
    !!task &&
    task.mainAgentView === 'chat' &&
    task.agentIds[0] === agentId &&
    supportsAgentChat(task)
  );
}

/** The task's composer is the chat view, so the terminal prompt is not the one on screen. */
export function taskUsesAgentChat(task: Task | undefined): boolean {
  return !!task && isAgentChat(task, task.agentIds[0]);
}
