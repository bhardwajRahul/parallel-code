import { batch, createEffect, createRoot, createSignal, untrack } from 'solid-js';
import { store, setStore } from './core';
import { getAgentHookStatus } from './agentHookStatus';
import { scrollTaskIntoView } from './focused-panel';
import { setActiveTask } from './navigation';
import { getCoordinatorChildren } from './sidebar-order';
import { getTaskOpenQuestion, isAgentIdle } from './taskStatus';

// Session-only: restarting the app ends the running agents this baseline describes.
const [backgroundTasks, setBackgroundTasks] = createSignal<ReadonlyMap<string, string>>(new Map());

export function isTaskBackgrounded(taskId: string): boolean {
  return backgroundOwner(taskId) !== undefined;
}

function backgroundOwner(taskId: string): string | undefined {
  if (backgroundTasks().has(taskId)) return taskId;
  const parentId = store.tasks[taskId]?.coordinatedBy;
  return parentId && backgroundTasks().has(parentId) ? parentId : undefined;
}

function taskBlock(taskId: string): string[] {
  return [taskId, ...getCoordinatorChildren(taskId).active];
}

/** Ignore ordinary output and working hook heartbeats, but notice individual
 * agents finishing/resuming even when another agent masks the task's status. */
function activitySnapshot(taskId: string): string {
  return JSON.stringify(
    taskBlock(taskId).map((id) => {
      const task = store.tasks[id];
      return {
        // Git-derived readiness can disappear during a refresh without any
        // agent activity. Only explicit review requests belong in this baseline.
        review: Boolean(
          task?.needsReview || task?.stepsContent?.at(-1)?.status === 'awaiting_review',
        ),
        question: getTaskOpenQuestion(id),
        done: task?.signalDoneAt,
        notification: task?.stagedNotification?.batchId,
        agents: task?.agentIds.map((agentId) => {
          const agent = store.agents[agentId];
          const hook = getAgentHookStatus(agentId);
          return [
            agentId,
            agent?.status,
            isAgentIdle(agentId),
            agent?.chatState?.error,
            hook && hook.state !== 'working' ? [hook.event, hook.updatedAt] : null,
          ];
        }),
      };
    }),
  );
}

/** Nearest foreground task, preferring the left neighbor as closing a task does. */
function foregroundNeighbor(taskId: string, block: readonly string[]): string | undefined {
  const index = store.taskOrder.indexOf(taskId);
  const candidates = [
    ...store.taskOrder.slice(0, index).reverse(),
    ...store.taskOrder.slice(index + 1),
  ];
  return candidates.find((id) => !block.includes(id) && !isTaskBackgrounded(id));
}

/** Moving a tile re-inserts its DOM nodes, which drops focus inside it, e.g. in
 * the terminal whose focus just selected this task. Restore it once the DOM settles. */
function keepFocusAcrossReorder(): void {
  if (typeof document === 'undefined') return;
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || focused === document.body) return;
  queueMicrotask(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (lost && focused.isConnected) focused.focus({ preventScroll: true });
  });
}

export function sendTaskToBack(taskId: string): void {
  const task = store.tasks[taskId];
  if (!task || task.collapsed || task.closingStatus || !store.taskOrder.includes(taskId)) return;
  const block = taskBlock(taskId);
  const remaining = store.taskOrder.filter((id) => !block.includes(id));
  const snapshot = activitySnapshot(taskId);
  const neighbor = foregroundNeighbor(taskId, block);
  batch(() => {
    setBackgroundTasks((previous) => {
      const next = new Map(previous);
      for (const id of block) next.delete(id);
      return next.set(taskId, snapshot);
    });
    setStore('taskOrder', [...remaining, ...block]);
    if (store.activeTaskId && block.includes(store.activeTaskId)) {
      if (neighbor) setActiveTask(neighbor);
      else {
        setStore('activeTaskId', null);
        setStore('activeAgentId', null);
      }
    }
  });
}

export function bringTaskToFront(taskId: string): void {
  const owner = backgroundOwner(taskId);
  if (!owner) return;
  batch(() => {
    setBackgroundTasks((previous) => {
      const next = new Map(previous);
      next.delete(owner);
      return next;
    });
    if (!store.taskOrder.includes(owner) || store.tasks[owner]?.collapsed) return;
    const block = taskBlock(owner);
    keepFocusAcrossReorder();
    setStore('taskOrder', [...block, ...store.taskOrder.filter((id) => !block.includes(id))]);
    // Reordering can push the active tile offscreen without changing selection.
    // The helper waits for the DOM update and respects draft focus and focus mode.
    if (store.activeTaskId) scrollTaskIntoView(store.activeTaskId, 'instant');
  });
}

/** Independent of OS notification preferences and window focus. Auto-return
 * changes order only; it never takes focus from the task the user is working on. */
export function startBackgroundTaskWatcher(): () => void {
  return createRoot((dispose) => {
    createEffect(() => {
      for (const [taskId, baseline] of backgroundTasks()) {
        const task = store.tasks[taskId];
        if (
          !task ||
          task.collapsed ||
          !store.taskOrder.includes(taskId) ||
          taskBlock(taskId).includes(store.activeTaskId ?? '') ||
          activitySnapshot(taskId) !== baseline
        ) {
          untrack(() => bringTaskToFront(taskId));
        }
      }
    });
    return dispose;
  });
}
