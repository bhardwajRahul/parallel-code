import {
  createMindMap,
  applyMapOperations,
  type MindMapDocument,
  type MapNode,
} from '../graph/model';
import { parseMindMapUpdate } from '../../electron/shared/mindmap';
import { parseCanvasView } from '../../electron/shared/canvas-view';
import { branchPrompt, type BranchRequest } from '../graph/agentActions';
import { produce, unwrap } from 'solid-js/store';
import { batch } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { isAgentHookEventPayload } from '../../electron/agent-hooks/status';
import { isPlanApprovalEvent, nextCanvasOpen } from '../lib/canvas-auto-open';
import { canvasTabKey, isTaskCanvasVisible, withTab, withoutTab } from '../lib/canvas-tabs';
import {
  CANVAS_DEFAULT_WIDTH,
  TASK_TILE_DEFAULT_WIDTH,
  TASK_TILE_MIN_WIDTH,
} from '../lib/layout-sizes';
import { store, setStore } from './core';
import { setPlanContent, setPrefillPrompt, setTaskPromptDraftActive } from './tasks';
import { setActiveTask } from './navigation';
import { saveState } from './persistence';
import { getPanelUserSize, setPanelUserSize } from './ui';
import { aiTerminalPanels, setTaskFocusedPanel } from './focused-panel';
import type { CanvasTab, Task } from './types';
import type { ReasoningProfile } from '../investigation/profiles';
import type { ReasoningWorkspace } from '../investigation/editing';

type CanvasState = Pick<Task, 'canvasOpen' | 'canvasTabs' | 'canvasActiveTab'>;

export { isTaskCanvasVisible } from '../lib/canvas-tabs';

/** Stage a stable node reference alongside the user's existing draft; never send it. */
export function referenceCanvasNode(
  taskId: string,
  canvas: 'mindmap' | 'reasoning',
  node: MapNode,
  revision: number,
  runId?: string,
): void {
  const task = store.tasks[taskId];
  if (!task || task.closingStatus) return;
  const reference = [
    `Node reference (${canvas === 'mindmap' ? 'mind map' : 'reasoning'}):`,
    JSON.stringify({
      taskId,
      runId,
      revision,
      id: node.id,
      title: node.title,
      detail: node.detail,
    }),
    `Use ${canvas === 'mindmap' ? 'mindmap_read' : 'reasoning_read'} to look up this ID in the current map.`,
    // The working marker only moves when the agent writes activeId; say so where the node is named.
    ...(canvas === 'reasoning'
      ? ['Set activeId to this id while you work on it and clear it when you are done.']
      : []),
  ].join('\n');
  stageCanvasRequest(taskId, reference);
}

export function askCanvasBranch(
  taskId: string,
  canvas: 'mindmap' | 'reasoning',
  request: BranchRequest,
  runId?: string,
): void {
  const prompt = branchPrompt(taskId, canvas, request, runId);
  if (prompt) stageCanvasRequest(taskId, prompt);
}

function stageCanvasRequest(taskId: string, request: string): void {
  const task = store.tasks[taskId];
  if (!task || task.closingStatus) return;
  const text = [task.prefillPrompt ?? task.promptDraft ?? '', request].filter(Boolean).join('\n\n');
  setTaskPromptDraftActive(taskId, true);
  setStore('showPromptInput', true);
  setPrefillPrompt(taskId, text);
  queueMicrotask(() => {
    if (store.tasks[taskId]) setTaskFocusedPanel(taskId, 'prompt');
  });
}

/** The width the canvas column takes: the size the user dragged it to, else its minimum. */
function canvasWidth(taskId: string): number {
  return getPanelUserSize(`task:${taskId}:canvas-cols:canvas`) ?? CANVAS_DEFAULT_WIDTH;
}

/** The task column grows by the canvas when it opens and gives the space back
 *  when it closes, so the task body keeps its width either way. */
function resizeTaskColumnForCanvas(taskId: string, direction: 1 | -1): void {
  const key = `tiling:${taskId}`;
  const width = getPanelUserSize(key) ?? TASK_TILE_DEFAULT_WIDTH;
  const next = width + direction * canvasWidth(taskId);
  setPanelUserSize(key, Math.max(TASK_TILE_MIN_WIDTH, next));
}

/** Applies a canvas change, resizing the column when it appears or goes. */
function updateCanvas(taskId: string, next: CanvasState): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const was = isTaskCanvasVisible(task);
  const will = isTaskCanvasVisible(next);
  if (will && !was) resizeTaskColumnForCanvas(taskId, 1);
  if (was && !will) resizeTaskColumnForCanvas(taskId, -1);
  setStore('tasks', taskId, next);
}

/** Opens or activates a canvas tab without replacing its neighbours. */
function openCanvasTab(taskId: string, tab: CanvasTab, activate = true): void {
  const task = store.tasks[taskId];
  if (!task) return;
  updateCanvas(taskId, {
    canvasTabs: withTab(task.canvasTabs ?? [], tab),
    canvasActiveTab: activate ? canvasTabKey(tab) : task.canvasActiveTab,
    canvasOpen: activate ? true : task.canvasOpen,
  });
  void saveState();
}

export function activateCanvasTab(taskId: string, key: string): void {
  const task = store.tasks[taskId];
  if (!task?.canvasTabs?.some((t) => canvasTabKey(t) === key)) return;
  setStore('tasks', taskId, 'canvasActiveTab', key);
  void saveState();
}

export function openCanvasDocument(taskId: string, path: string): void {
  openCanvasTab(taskId, { kind: 'markdown', path });
}

export function openCanvasMindMap(taskId: string): void {
  openCanvasTab(taskId, { kind: 'mindmap' });
}

/** Reading initializes one persistent root shared by every pane and agent. */
export function getTaskMindMap(taskId: string): MindMapDocument {
  if (!Object.hasOwn(store.tasks, taskId) || store.tasks[taskId].closingStatus)
    throw new Error('Task not available.');
  const task = store.tasks[taskId];
  if (!task.mindMap && task.mindMapUnreadable !== undefined)
    throw new Error(
      'The saved mind map could not be read. Ask the user to replace it from the Mind map tab.',
    );
  const document = task.mindMap ?? createMindMap();
  if (!task.mindMap) setTaskMindMap(taskId, document);
  return structuredClone(unwrap(document));
}

/** The user chose to give up a saved map that failed validation; start an empty one instead. */
export function replaceUnreadableMindMap(taskId: string): void {
  if (!Object.hasOwn(store.tasks, taskId)) return;
  setStore('tasks', taskId, 'mindMapUnreadable', undefined);
  setTaskMindMap(taskId, createMindMap());
  void saveState();
}

export async function updateTaskMindMapFromAgent(
  taskId: string,
  input: unknown,
): Promise<MindMapDocument> {
  const { expectedRevision, operations } = parseMindMapUpdate(input);
  const current = getTaskMindMap(taskId);
  const next = applyMapOperations(current, operations, expectedRevision, 'agent');
  // Commit synchronously before awaiting persistence: competing writers must see the new revision.
  setStore('tasks', taskId, 'mindMap', next);
  // Opening the tab saves the task, map included.
  if (store.tasks[taskId].canvasTabs?.some((tab) => tab.kind === 'mindmap')) await saveState();
  else openCanvasMindMap(taskId);
  return next;
}

/** Agents open a view on request ("show me the reasoning graph"); content stays untouched. */
export function openCanvasViewFromAgent(taskId: string, input: unknown): void {
  const view = parseCanvasView(input);
  if (!Object.hasOwn(store.tasks, taskId) || store.tasks[taskId].closingStatus)
    throw new Error('Task not available.');
  if (view === 'mindmap') openCanvasMindMap(taskId);
  else {
    const agentId = store.tasks[taskId].agentIds[0];
    const agent = store.agents[agentId];
    if (agent)
      setStore('tasks', taskId, 'reasoningCanvasRequest', {
        agentId,
        generation: agent.generation,
      });
    openCanvasReasoning(taskId);
  }
}

/** Autosave persists the document; saving here again would write on every keystroke. */
export function setTaskMindMap(taskId: string, document: MindMapDocument): void {
  if (!store.tasks[taskId]) return;
  setStore('tasks', taskId, 'mindMap', document);
}

export function openCanvasReasoning(taskId: string): void {
  openCanvasTab(taskId, { kind: 'reasoning' });
}

export function setTaskReasoningProfile(taskId: string, profile: ReasoningProfile): void {
  if (!store.tasks[taskId]) return;
  setStore('tasks', taskId, 'reasoningProfile', profile);
  void saveState();
}

/** Draft edits use the shared debounced autosave. */
/** Only the current run's workspace is kept; archived runs would otherwise accumulate forever. */
export function setTaskReasoningWorkspace(
  taskId: string,
  key: string,
  workspace: ReasoningWorkspace,
): void {
  if (!store.tasks[taskId]) return;
  // Assigning replaces the record; a plain setStore would merge the old keys back in.
  setStore(
    'tasks',
    taskId,
    produce((task) => {
      task.reasoningWorkspaces = { [key]: workspace };
    }),
  );
}

/** Closes one tab; closing the last one closes the column. */
export function closeCanvasTab(taskId: string, key: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const next = withoutTab(task.canvasTabs ?? [], task.canvasActiveTab, key);
  if (next.tabs.length === 0) {
    closeTaskCanvas(taskId);
    return;
  }
  updateCanvas(taskId, { canvasTabs: next.tabs, canvasActiveTab: next.active });
  void saveState();
}

/** Shows the column; with nothing open it offers the picker. Not persisted. */
export function openTaskCanvas(taskId: string): void {
  updateCanvas(taskId, { canvasOpen: true });
}

/** Hides the column and forgets every tab. */
export function closeTaskCanvas(taskId: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const restoreAgentFocus =
    store.activeTaskId === taskId &&
    store.focusedPanel[taskId] === 'canvas' &&
    !store.sidebarFocused &&
    !store.placeholderFocused;
  updateCanvas(taskId, {
    canvasTabs: undefined,
    canvasActiveTab: undefined,
    canvasOpen: undefined,
  });
  if (restoreAgentFocus) setTaskFocusedPanel(taskId, aiTerminalPanels(task)[0]);
  void saveState();
}

/** A plan publish from the backend watcher. */
export interface PlanContentMessage {
  taskId: string;
  content: string | null;
  fileName: string | null;
  relativePath?: string | null;
  /** The plan was found already on disk rather than seen being written. */
  recovered?: boolean;
}

/**
 * Applies a plan publish. The plan tab always follows the file on disk, but a
 * plan only opens the canvas when this session was seen writing it, and then
 * once per file so repeated edits leave the user's choice of tab alone.
 *
 * A recovered publish deliberately leaves `livePlanPath` untouched rather than
 * clearing it: the watcher restarts on every agent spawn and republishes what
 * it finds, which would otherwise demote the plan the agent just wrote.
 */
export function applyPlanContent(msg: PlanContentMessage): void {
  const task = store.tasks[msg.taskId];
  if (!task) return;
  const path = msg.relativePath ?? null;
  const opens = !msg.recovered && path !== null && path !== task.livePlanPath;
  batch(() => {
    setPlanContent(msg.taskId, msg.content, msg.fileName, path);
    if (!msg.recovered) setStore('tasks', msg.taskId, 'livePlanPath', path ?? undefined);
  });
  if (opens && path) {
    // Reporting a Markdown plan must not hide the live graph and stop its reader.
    // An explicit plan-approval request can still activate the plan below.
    const keepReasoning = isTaskCanvasVisible(task) && task.canvasActiveTab === 'reasoning';
    openCanvasTab(msg.taskId, { kind: 'markdown', path }, !keepReasoning);
  }
}

/** Brings this session's plan back to the front when approval is asked for. A
 *  plan merely found on disk is left alone: it is not what is being approved,
 *  and opening it is the wrong-file bug this guard exists to stop. */
function openLivePlan(taskId: string): void {
  const path = store.tasks[taskId]?.livePlanPath;
  if (path) openCanvasDocument(taskId, path);
}

/**
 * Puts the Markdown file an agent just wrote on its task's canvas, when
 * nothing is open there. Tabs the user has stay; they can switch by hand.
 * A plan waiting for approval comes back to the front, provided this run is
 * what produced it. Returns the unsubscribe.
 */
export function startCanvasAutoOpen(): () => void {
  const pending = new Map<string, string>();
  return window.electron.ipcRenderer.on(IPC.AgentHookEvent, (data: unknown) => {
    if (!isAgentHookEventPayload(data)) return;
    const task = store.tasks[data.taskId];
    if (!task?.worktreePath) return;
    if (isPlanApprovalEvent(data)) {
      openLivePlan(data.taskId);
      return;
    }
    const opened = nextCanvasOpen(pending, data, task.worktreePath);
    if (opened && !task.canvasTabs?.length) openCanvasDocument(task.id, opened);
  });
}

/** One browser per task; its last URL survives closing the tab. */
export function openCanvasBrowser(taskId: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const tab: CanvasTab = { kind: 'browser', path: 'preview' };
  updateCanvas(taskId, {
    canvasTabs: withTab(task.canvasTabs ?? [], tab),
    canvasActiveTab: canvasTabKey(tab),
    canvasOpen: true,
  });
  void saveState();
}

export function setTaskBrowserUrl(taskId: string, url: string): void {
  if (!store.tasks[taskId] || store.tasks[taskId].browserUrl === url) return;
  setStore('tasks', taskId, 'browserUrl', url);
  // History updates can be frequent; the existing autosave debounce persists them.
}

/** Native guest clicks do not bubble through the task DOM. Record focus without
 * invoking a renderer focus callback that would steal it back from the page. */
export function markBrowserFocused(taskId: string): void {
  if (!store.tasks[taskId]) return;
  batch(() => {
    setActiveTask(taskId);
    setStore('focusedPanel', taskId, 'canvas');
    setStore('sidebarFocused', false);
    setStore('placeholderFocused', false);
  });
}

export function appendBrowserReference(taskId: string, reference: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const draft = task.prefillPrompt ?? task.promptDraft ?? '';
  const text = draft ? `${draft}\n\n${reference}` : reference;
  batch(() => {
    setStore('tasks', taskId, { promptDraft: text, prefillPrompt: text, promptDraftActive: true });
    setStore('showPromptInput', true);
  });
}
