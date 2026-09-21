import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeTask } from './git.js';

const directories: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-merge-'));
  directories.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  appendFileSync(join(root, '.git/info/exclude'), '/.worktrees/\n');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const expectedTargetCommit = git(root, 'rev-parse', 'HEAD');
  const child = join(root, '.worktrees/child');
  git(root, 'worktree', 'add', '-b', 'child', child);
  writeFileSync(join(child, 'result.txt'), 'reviewed result\n');
  git(child, 'add', '.');
  git(child, 'commit', '-m', 'result');
  const approval = {
    expectedCommit: git(child, 'rev-parse', 'HEAD'),
    expectedTargetBranch: 'main',
    expectedTargetCommit,
  };
  return {
    root,
    child,
    approval,
    merge: () => mergeTask(root, 'child', false, null, false, 'main', child, root, approval),
  };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('exact user approval under the Git repository lock', () => {
  it('merges precisely the approved result without committing child changes', async () => {
    const { root, child, approval, merge } = fixture();
    await merge();
    expect(git(root, 'rev-parse', 'HEAD')).toBe(approval.expectedCommit);
    expect(git(child, 'rev-parse', 'HEAD')).toBe(approval.expectedCommit);
  });

  it.each(['child', 'target', 'dirty', 'branch'] as const)(
    'rejects a changed %s after review',
    async (change) => {
      const { root, child, approval, merge } = fixture();
      if (change === 'branch') git(root, 'checkout', '-b', 'different-target');
      else {
        const cwd = change === 'target' ? root : child;
        writeFileSync(join(cwd, 'later.txt'), 'changed after approval\n');
        if (change !== 'dirty') {
          git(cwd, 'add', '.');
          git(cwd, 'commit', '-m', 'later');
        }
      }
      const beforeChild = git(child, 'rev-parse', 'HEAD');
      const beforeTarget = git(root, 'rev-parse', 'HEAD');
      await expect(merge()).rejects.toThrow('Review again');
      expect(git(child, 'rev-parse', 'HEAD')).toBe(beforeChild);
      expect(git(root, 'rev-parse', 'HEAD')).toBe(beforeTarget);
      if (change === 'dirty') expect(beforeChild).toBe(approval.expectedCommit);
    },
  );

  it('invalidates a second queued approval after the first moves the destination', async () => {
    const { merge } = fixture();
    const outcomes = await Promise.allSettled([merge(), merge()]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
  });
});
