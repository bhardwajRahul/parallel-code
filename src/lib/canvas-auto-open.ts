/**
 * Decides when a Markdown file the agent just wrote should open on the task
 * canvas. Claude's PreToolUse hook carries the file path; PostToolUse only the
 * tool-use id, so the path is remembered until the write completes. A write
 * that never completes (denied permission) is dropped when the map fills.
 */
import { isPlanApprovalTool } from '../../electron/agent-hooks/status';
import { isMarkdownPath } from './canvas-tabs';

interface HookEventLike {
  event: string;
  toolName?: string;
  toolUseId?: string;
  detail?: string;
}

/** Claude asking to have a plan approved: the moment to put the plan on the canvas. */
export function isPlanApprovalEvent(event: HookEventLike): boolean {
  return event.event === 'PreToolUse' && isPlanApprovalTool(event.toolName);
}

// Only whole-file writes: Claude writes new docs (plans, notes, reports) with
// Write and touches up existing ones with Edit, which is not worth a canvas.
const WRITE_TOOLS = new Set(['write']);
const PENDING_CAP = 50;

/** Worktree-relative form of a path the hook reported, or null when it is not
 *  a Markdown file inside the worktree (or was clipped by the hook summary). */
export function worktreeMarkdownPath(reported: string, worktreePath: string): string | null {
  if (!reported || reported.endsWith('…')) return null;
  const root = worktreePath.replace(/\/+$/, '');
  let rel = reported;
  if (reported.startsWith('/')) {
    if (!reported.startsWith(`${root}/`)) return null;
    rel = reported.slice(root.length + 1);
  }
  rel = rel.replace(/^\.\//, '');
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '..')) return null;
  if (/^\.(parallel|worktrees|git|claude)(\/|$)/.test(rel)) return null;
  return isMarkdownPath(rel) ? rel : null;
}

// Repo boilerplate agents routinely rewrite while doing other work.
const BOILERPLATE_NAME =
  /^(readme|changelog|changes|history|agents|claude|gemini|contributing|code_of_conduct|license|security|support)\.(md|markdown)$/i;
const NOISE_DIR = /(^|\/)(\.github|tests?|__tests__|fixtures|__fixtures__|__snapshots__)\//i;

function isBoilerplateDoc(rel: string): boolean {
  return NOISE_DIR.test(rel) || BOILERPLATE_NAME.test(rel.slice(rel.lastIndexOf('/') + 1));
}

/**
 * Feeds one hook event through; returns the worktree-relative Markdown path to
 * open when this event completes a write, else null. `pending` is the caller's
 * map of tool-use ids to paths.
 */
export function nextCanvasOpen(
  pending: Map<string, string>,
  event: HookEventLike,
  worktreePath: string,
): string | null {
  const id = event.toolUseId;
  if (!id) return null;
  if (event.event === 'PreToolUse') {
    if (!WRITE_TOOLS.has((event.toolName ?? '').toLowerCase()) || !event.detail) return null;
    const rel = worktreeMarkdownPath(event.detail, worktreePath);
    if (!rel || isBoilerplateDoc(rel)) return null;
    if (pending.size >= PENDING_CAP) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) pending.delete(oldest);
    }
    pending.set(id, rel);
    return null;
  }
  if (event.event === 'PostToolUse') {
    const rel = pending.get(id) ?? null;
    pending.delete(id);
    return rel;
  }
  if (event.event === 'PostToolUseFailure') pending.delete(id);
  return null;
}
