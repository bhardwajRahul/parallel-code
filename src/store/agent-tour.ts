import { parseAgentTourPayload } from '../../electron/shared/agent-tour';
import { store, setStore } from './core';

/**
 * Accepts a tour the coding agent published through the `tour_publish` MCP tool.
 * Only shape and size are checked here; the cards are validated in the panel,
 * which then opens the viewer. Runtime state only, never persisted.
 */
export function publishAgentTour(taskId: string, input: unknown): void {
  const payload = parseAgentTourPayload(input);
  if (!Object.hasOwn(store.tasks, taskId) || store.tasks[taskId].closingStatus)
    throw new Error('Task not available.');
  const revision = (store.tasks[taskId].agentTour?.revision ?? 0) + 1;
  setStore('tasks', taskId, 'agentTour', { revision, payload });
}
