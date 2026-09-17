import { graphOperationsSchema } from '../shared/graph-schema.js';
import { canvasViews } from '../shared/canvas-view.js';
import { semanticNodeKinds, reasoningStatuses } from '../shared/graph.js';
import type { ReasoningUpdate } from '../shared/reasoning-state.js';
/** Pure tool-list logic — extracted so it can be unit-tested without starting the MCP server. */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    examples?: unknown[];
  };
}

const initialReasoningUpdate = {
  runId: null,
  newRunId: 'run-1',
  expectedRevision: 0,
  operations: [
    {
      type: 'insert',
      node: {
        id: 'goal',
        title: 'Actual task goal',
        detail: 'Scope and acceptance criteria.',
        kind: 'goal',
        status: 'unresolved',
      },
    },
    {
      type: 'insert',
      node: {
        id: 'cause',
        parent: 'goal',
        title: 'Candidate cause',
        detail: 'A testable claim; say what would refute it.',
        kind: 'hypothesis',
        status: 'untested',
      },
    },
    {
      type: 'insert',
      node: {
        id: 'finding',
        parent: 'cause',
        title: 'Inspected fact',
        detail: 'What was actually observed and where.',
        kind: 'observation',
        status: 'observed',
      },
    },
    {
      type: 'insert_relation',
      relation: {
        id: 'finding-supports-cause',
        source: 'finding',
        target: 'cause',
        kind: 'supports',
        rationale: 'Explain what the fact supports.',
      },
    },
  ],
} satisfies ReasoningUpdate;

export const MINDMAP_TOOLS: ToolDef[] = [
  {
    name: 'mindmap_read',
    description:
      'Read this task’s canonical mind map, including saved user edits, protected fields and revision. Creates a central topic if empty. Unsent drafts are excluded. Read before updating.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'mindmap_update',
    description:
      'Apply atomic graph operations with expectedRevision from mindmap_read. Insert or patch nodes, move or remove branches, and edit relations or explanations. Omitted fields stay unchanged; null clears optional fields. Preserve user edits; overrideUser is an explicit per-operation override. The root cannot be moved or removed. On conflict read again. Ordinary nodes may omit kind. observation displays as Evidence; work as Work item. Prefer the smallest map that answers the question: about three levels and thirty notes, then offer to expand a branch rather than pre-expanding it. Leave out redundancy, never content the user asked for. Report public summaries, not private chain-of-thought.',
    inputSchema: {
      type: 'object',
      properties: {
        expectedRevision: { type: 'integer', minimum: 0 },
        operations: graphOperationsSchema,
      },
      required: ['expectedRevision', 'operations'],
    },
  },
];
export const REASONING_TOOLS: ToolDef[] = [
  {
    name: 'reasoning_read',
    description:
      'Read this task’s single current reasoning graph with saved user edits, protected fields and deleted IDs, plus runId, revision, workflow and workflows (reporting guidance keyed by workflow name). Follow the guidance for the current workflow; if the user’s question clearly calls for another shape, such as explaining existing structure rather than investigating a cause, follow that workflow’s guidance and say which you used. Unsent drafts are excluded. Read before publishing.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'reasoning_update',
    description:
      'Apply atomic graph operations. Pass runId and expectedRevision from reasoning_read, including when creating a new run. For an empty graph also supply newRunId; on an explicit request to start over, supply newRunId to archive the old graph. Never reset to resolve an ordinary revision conflict: read again. ' +
      'Use type "insert" (not "insert_node") with node {id,title,detail,kind?,status?,parent?}; omit kind and status for a plain note, or supply both for a semantic note. Use type "update" with {id,changes} to patch a node. Keep exactly one root (omit parent); every other node needs node.parent referencing an existing node. Relations use {id,source,target,kind,rationale}, not fromId/toId. IDs are stable strings of letters, digits, underscores or hyphens; UUIDs are not required. ' +
      `Node kinds: ${semanticNodeKinds.join(', ')}. Statuses: ${reasoningStatuses.join(', ')}. Evidence uses kind "observation", not "evidence". Relations need kind supports/challenges/fits and rationale. ` +
      'Nodes may be moved or retyped. Changing kind must explicitly clear incompatible confidence/evaluations with null. Omitted fields preserve content; activeId:null clears activity. User-edited fields and deletions are protected unless the operation explicitly sets overrideUser. Attach answers with insert_explanation; explanation id, nodeId and question stay stable. Report public summaries, actual evidence and uncertainty. ' +
      `Example for an empty graph (replace sample text with actual findings; otherwise use the current runId and revision): ${JSON.stringify(initialReasoningUpdate)}`,
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: ['string', 'null'] },
        expectedRevision: { type: 'integer', minimum: 0 },
        newRunId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' },
        caption: { type: 'string', maxLength: 2000 },
        activeId: { type: ['string', 'null'] },
        operations: graphOperationsSchema,
      },
      required: ['runId', 'expectedRevision', 'operations'],
      examples: [initialReasoningUpdate],
    },
  },
];

export { CANVAS_INSTRUCTIONS } from '../shared/canvas-view.js';

export const CANVAS_VIEW_TOOLS: ToolDef[] = [
  {
    name: 'canvas_open',
    description:
      'Open or focus this task’s Mind map or Reasoning graph canvas for the user. Use it when the user asks to see, open, or create a map or graph, before or after publishing with mindmap_update or reasoning_update. Idempotent; it changes no content.',
    inputSchema: {
      type: 'object',
      required: ['view'],
      properties: { view: { enum: [...canvasViews] } },
    },
  },
];

export const SUBTASK_TOOLS: ToolDef[] = [
  {
    name: 'land_self',
    description:
      'Land your own completed sub-task through the Parallel Code backend. Call this only after committing your work and running verification successfully. A successful call is terminal; do not call signal_done afterward.',
    inputSchema: {
      type: 'object',
      properties: {
        verification: {
          type: 'object',
          description: 'Structured verification showing the checks you ran and their results.',
          properties: {
            checks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  command: { type: 'string' },
                  result: { type: 'string', enum: ['passed', 'blocked', 'failed'] },
                  reason: { type: 'string' },
                },
                required: ['name', 'command', 'result'],
              },
            },
          },
          required: ['checks'],
        },
        summary: {
          type: 'string',
          description: 'Optional concise summary of what landed.',
        },
      },
      required: ['verification'],
    },
  },
  {
    name: 'signal_done',
    description:
      'Legacy/manual-review completion signal. Use land_self for normal self-landing; call signal_done only when the coordinator asked to review and land manually.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

export const COORDINATOR_TOOLS: ToolDef[] = [
  {
    name: 'create_task',
    description:
      'Create a new task with its own git worktree and AI agent. The agent starts automatically and the prompt is delivered once the agent is ready. A startup/default placeholder prompt in get_task_output is not evidence that delivery failed; wait and re-check before sending follow-up instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Task name (used for branch name)' },
        prompt: {
          type: 'string',
          description: 'Initial prompt to send to the agent once it finishes starting up.',
        },
        baseBranch: {
          type: 'string',
          description:
            'Git branch to base the worktree on. Defaults to the coordinator task branch. Only set this when deliberately overriding that default.',
        },
      },
      required: ['name', 'prompt'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all coordinated tasks with their current status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_task_status',
    description: 'Get detailed status of a specific task including git info and agent state.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID' } },
      required: ['taskId'],
    },
  },
  {
    name: 'send_prompt',
    description:
      "Send a follow-up instruction to a task's AI agent. The tool may report that the prompt was queued rather than sent when the initial assignment or user activity is still blocking delivery; don't call wait_for_idle until a prompt was actually sent. Do not resend the full original assignment merely because a newly created task is idle or get_task_output shows a startup/default placeholder prompt; wait briefly and re-check unless the agent clearly asks for input, starts unrelated work, or prompt delivery clearly failed.",
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        prompt: { type: 'string', description: 'Prompt text to send' },
      },
      required: ['taskId', 'prompt'],
    },
  },
  {
    name: 'wait_for_idle',
    description:
      "Wait until a task's agent becomes idle (sitting at its prompt). Returns when the agent is ready for the next instruction.",
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 300000 = 5 min)',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'get_task_diff',
    description: "Get the changed files and unified diff for a task's work.",
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID' } },
      required: ['taskId'],
    },
  },
  {
    name: 'get_task_output',
    description:
      "Get recent terminal output from a task's agent (stripped of ANSI codes). A startup/default placeholder prompt, such as 'Improve documentation in @filename', can be stale while the dispatched create_task prompt is queued or being processed; do not treat it alone as a reason to resend the task.",
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID' } },
      required: ['taskId'],
    },
  },
  {
    name: 'merge_task',
    description: "Merge a task's branch into the base branch.",
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        squash: { type: 'boolean', description: 'Squash merge (default: false)' },
        message: { type: 'string', description: 'Custom merge commit message' },
        cleanup: {
          type: 'boolean',
          description: 'Clean up worktree and branch after merge (default: false)',
        },
        skipVerification: {
          type: 'boolean',
          description:
            "Merge without running the project's verify command. Only for a failure the task cannot fix, e.g. a suite already red on the base branch (default: false)",
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'close_task',
    description: 'Close and clean up a task — kills the agent, removes worktree and branch.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID' } },
      required: ['taskId'],
    },
  },
  {
    name: 'wait_for_signal_done',
    description:
      'Wait for ANY sub-task to call signal_done. Returns { taskId, name, status, signalDoneAt, remaining } where remaining is the count of tasks still running or signaled-but-not-yet-reviewed. Call this in a loop until remaining === 0 to process all completed sub-tasks before spawning more. IMPORTANT: you MUST review the returned task before calling wait_for_signal_done again.',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 300000 = 5 min)',
        },
      },
      required: [],
    },
  },
];

/**
 * Returns the tool list for a given role.
 * Sub-tasks (taskId set, no coordinatorId) get only sub-task scoped tools.
 * Coordinators (and plain agents) get the full coordinator set — which does NOT include signal_done.
 */
/** Every session that advertises canvas tools also gets the instructions that explain them. */
export function hasCanvasTools(taskId: string, coordinatorId: string, canvasOnly = false): boolean {
  return canvasOnly || !!taskId || !!coordinatorId;
}

export function selectTools(taskId: string, coordinatorId: string, canvasOnly = false): ToolDef[] {
  const canvasTools = [...MINDMAP_TOOLS, ...REASONING_TOOLS, ...CANVAS_VIEW_TOOLS];
  if (canvasOnly) return canvasTools;
  if (taskId && !coordinatorId) return [...SUBTASK_TOOLS, ...canvasTools];
  return coordinatorId ? [...COORDINATOR_TOOLS, ...canvasTools] : COORDINATOR_TOOLS;
}
