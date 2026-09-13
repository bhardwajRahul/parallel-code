import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  reasoningFeedPath,
  REASONING_MAX_BYTES,
  type ReasoningFeedRead,
} from '../shared/reasoning.js';
import { validatePath } from './validate.js';
import { appendGitInfoExcludeBlock } from './git-exclude.js';
import { parseReasoningFeed, parseReasoningUpdate } from '../shared/reasoning-feed.js';
import {
  acceptUpdate,
  emptyHistory,
  type InvestigationUpdate,
  type Snapshot,
} from '../shared/reasoning-state.js';

/** Walk every segment below the worktree so no link can redirect app-owned directories. */
function reasoningDirectory(worktreePath: string, relativeDir: string, create = false): string {
  validatePath(worktreePath, 'worktreePath');
  let directory = fs.realpathSync(worktreePath);
  for (const part of relativeDir.split('/')) {
    directory = path.join(directory, part);
    if (create) {
      try {
        fs.mkdirSync(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink()) throw new Error('Reasoning directories must not be symbolic links');
    if (!stat.isDirectory()) throw new Error('Invalid reasoning directory');
  }
  return directory;
}

function feedPath(worktreePath: string, taskId: string, agentId: string, create = false): string {
  const relative = reasoningFeedPath(taskId, agentId);
  const directory = reasoningDirectory(worktreePath, path.dirname(relative), create);
  return path.join(directory, path.basename(relative));
}

// Every append prepares the feed, and the exclude write shells out to `git rev-parse`;
// remember worktrees whose exclude file already carries the block so only the first
// append per worktree pays for the subprocess. A failure is not remembered.
const excludedWorktrees = new Set<string>();

function excludeReasoningFromGit(worktreePath: string): void {
  if (excludedWorktrees.has(worktreePath)) return;
  const result = appendGitInfoExcludeBlock(
    worktreePath,
    '/.parallel-code/reasoning/',
    '/.parallel-code/reasoning/\n',
  );
  if (result === 'failed') throw new Error('Could not exclude reasoning reports from Git');
  if (result !== 'missing') excludedWorktrees.add(worktreePath);
}

/** Prepare only app-owned directories; never truncate an existing report. */
export function prepareReasoningFeed(worktreePath: string, taskId: string, agentId: string): void {
  const file = feedPath(worktreePath, taskId, agentId, true);
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('Reasoning feed must be a regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  excludeReasoningFromGit(worktreePath);
}

export interface ReasoningFeedRef {
  worktreePath: string;
  taskId: string;
  agentId: string;
}

/** Cheap identity of the file's content: appends change size, rotation changes the inode. */
const feedStamp = (stat: fs.Stats): string => `${stat.mtimeMs}:${stat.size}:${stat.ino}`;

/** Bounded read of a regular file; no arbitrary renderer-supplied file paths.
 *  Pass the last `stamp` to skip reading a feed that has not changed. */
export async function readReasoningFeed(
  feed: ReasoningFeedRef,
  knownStamp?: string,
): Promise<ReasoningFeedRead | null> {
  try {
    const file = feedPath(feed.worktreePath, feed.taskId, feed.agentId);
    if (knownStamp) {
      const current = await fs.promises.lstat(file);
      if (current.isFile() && feedStamp(current) === knownStamp)
        return { unchanged: true, stamp: knownStamp };
    }
    return await readFeedFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readFeedFile(file: string): Promise<ReasoningFeedRead> {
  const handle = await fs.promises.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Reasoning feed must be a regular file');
    if ((await fs.promises.realpath(file)) !== file)
      throw new Error('Reasoning feed must not use symbolic links');
    const current = await fs.promises.lstat(file);
    if (current.dev !== stat.dev || current.ino !== stat.ino)
      throw new Error('Reasoning feed changed during read; retrying');
    if (stat.size > REASONING_MAX_BYTES) throw new Error('Reasoning feed too large (max 1 MB)');
    // Bound allocation and reading even if the agent appends after stat().
    const buffer = Buffer.alloc(REASONING_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > REASONING_MAX_BYTES) throw new Error('Reasoning feed too large (max 1 MB)');
    return { raw: buffer.toString('utf8', 0, size), stamp: feedStamp(stat) };
  } finally {
    await handle.close();
  }
}

/** Delete a task's report directory. Worktree removal covers worktree tasks; direct-mode
 *  tasks share the project checkout, so their reports would otherwise outlive the task. */
export function removeReasoningFeeds(worktreePath: string, taskId: string): void {
  let directory: string;
  try {
    // Every parent is checked too; rm unlinks nested links without following them.
    directory = reasoningDirectory(worktreePath, path.dirname(reasoningFeedPath(taskId, 'agent')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

const OPEN_FLAGS =
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_APPEND |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;

function readOpenFeed(fd: number, file: string): { stat: fs.Stats; raw: string; size: number } {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || fs.realpathSync(file) !== file)
    throw new Error('Reasoning feed must be a regular file without symbolic links');
  if (stat.size > REASONING_MAX_BYTES) throw new Error('Reasoning feed too large (max 1 MB)');
  const buffer = Buffer.alloc(REASONING_MAX_BYTES + 1);
  let size = 0;
  while (size < buffer.length) {
    const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
    if (!count) break;
    size += count;
  }
  if (size > REASONING_MAX_BYTES) throw new Error('Reasoning feed too large (max 1 MB)');
  return { stat, raw: buffer.toString('utf8', 0, size), size };
}

function assertUnchanged(fd: number, file: string, stat: fs.Stats, size: number): void {
  const latest = fs.lstatSync(file);
  const opened = fs.fstatSync(fd);
  if (
    latest.dev !== stat.dev ||
    latest.ino !== stat.ino ||
    opened.size !== size ||
    opened.mtimeMs !== stat.mtimeMs
  )
    throw new Error('The reasoning report changed during publication. Read again.');
}

/** Archive a stuck or superseded report beside the feed; the fresh run starts in a new file. */
function rotateFeed(file: string, line: string): void {
  // Archives are audit history; a random suffix keeps two rotations in one millisecond apart.
  fs.renameSync(file, `${file}.${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function stuckError(error: string | undefined, pending: boolean): Error {
  const cause = error ?? (pending ? 'An update is still being written.' : '');
  return new Error(
    `${cause} To start over, read the current revision and supply newRunId; the current graph is archived.`.trim(),
  );
}

/** Synchronous compare-and-append serializes MCP writers without rewriting history. */
export function appendReasoningUpdate(
  worktreePath: string,
  taskId: string,
  agentId: string,
  input: unknown,
  actor: 'user' | 'agent' = 'agent',
): Snapshot {
  const update = parseReasoningUpdate(input);
  prepareReasoningFeed(worktreePath, taskId, agentId);
  const file = feedPath(worktreePath, taskId, agentId);
  const fd = fs.openSync(file, OPEN_FLAGS, 0o600);
  try {
    const { stat, raw, size } = readOpenFeed(fd, file);
    const current = parseReasoningFeed(raw);
    const stuck = !!current.error || current.pending;
    const currentRun = current.history.updates[0]?.runId ?? null;
    const revision = current.history.snapshots[current.history.snapshots.length - 1]?.revision ?? 0;
    if (update.runId !== currentRun || update.expectedRevision !== revision)
      throw new Error(
        'The graph revision or run changed. Use reasoning_read and retry with runId and expectedRevision.',
      );
    const fresh = update.newRunId !== undefined;
    if (actor === 'user' && fresh) throw new Error('User edits cannot replace a run.');
    if (!currentRun && !fresh) throw new Error('Supply newRunId to create the graph.');
    if (stuck && !fresh) throw stuckError(current.error, current.pending);
    const event: InvestigationUpdate = {
      runId: update.newRunId ?? currentRun ?? '',
      expectedRevision: fresh ? 0 : revision,
      operations: update.operations,
      sequence: fresh ? 0 : current.history.updates.length,
      actor,
      ...(update.caption !== undefined ? { caption: update.caption } : {}),
      ...(update.activeId !== undefined ? { activeId: update.activeId } : {}),
    };
    const next = acceptUpdate(fresh ? emptyHistory() : current.history, event);
    const line = JSON.stringify(event) + '\n';
    if (
      Buffer.byteLength(line) + (fresh ? 0 : size) > REASONING_MAX_BYTES ||
      next.updates.length > 1000
    )
      throw new Error('Graph history is full; read the current revision and start a new run.');
    const snapshot = next.snapshots[next.snapshots.length - 1];
    if (!snapshot) throw new Error('Missing graph snapshot.');
    if (fresh && size) {
      assertUnchanged(fd, file, stat, size);
      rotateFeed(file, line);
      return snapshot;
    }
    assertUnchanged(fd, file, stat, size);
    fs.writeFileSync(fd, line);
    fs.fsyncSync(fd);
    return snapshot;
  } finally {
    fs.closeSync(fd);
  }
}
