import { type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { MergeDialog } from './MergeDialog';
import { mergeTask } from '../store/store';
import { IPC } from '../../electron/ipc/channels';
import type { Task } from '../store/types';

vi.mock('../store/store', () => ({
  store: { agents: {} },
  getProject: () => undefined,
  getPrChecks: () => undefined,
  getVerifyCommand: () => undefined,
  mergeTask: vi.fn(async () => {}),
  sendPrompt: vi.fn(),
  updateTaskBranch: vi.fn(),
}));
vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(async (channel: string) => {
    if (channel === IPC.GetBranchLog) return '';
    if (channel === IPC.CheckMergeStatus) return { conflicting_files: [], main_ahead_count: 0 };
    return { current_branch: 'task/parent', has_committed_changes: true };
  }),
}));
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: (props: { message: JSX.Element; onConfirm: () => void }) => (
    <div>
      {props.message}
      <button onClick={() => props.onConfirm()}>Merge task</button>
    </div>
  ),
}));
vi.mock('./ChangedFilesList', () => ({ ChangedFilesList: () => null }));
vi.mock('./MergeReadinessPanel', () => ({ MergeReadinessPanel: () => null }));
vi.mock('./VerificationPanel', () => ({ VerificationPanel: () => null }));
vi.mock('./merge-readiness', () => ({ buildMergeReadiness: () => ({}) }));
vi.mock('../lib/theme', () => ({ theme: {}, bannerStyle: () => ({}) }));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it.each([{ delegationParent: true }, { coordinatorMode: true }, {}])(
  'only allows merge cleanup without a parent relationship: %j',
  async (policy) => {
    const task: Task = {
      id: 'parent',
      name: 'Parent',
      projectId: 'project',
      branchName: 'task/parent',
      worktreePath: '/repo/.worktrees/parent',
      gitIsolation: 'worktree',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      ...policy,
    };
    dispose = render(
      () => (
        <MergeDialog open task={task} initialCleanup onDone={() => {}} onDiffFileClick={() => {}} />
      ),
      document.body,
    );
    await Promise.resolve();
    const cleanup = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const parent = Boolean(task.delegationParent || task.coordinatorMode);
    expect(cleanup?.disabled).toBe(parent);
    expect(cleanup?.checked).toBe(!parent);
    if (parent) expect(document.body.textContent).toContain('Merge first, then close this task');
    document.querySelector<HTMLButtonElement>('button')?.click();
    expect(mergeTask).toHaveBeenCalledWith('parent', expect.objectContaining({ cleanup: !parent }));
  },
);
