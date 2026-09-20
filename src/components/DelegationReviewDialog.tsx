import './Delegation.css';
import { createResource, createSignal, Show } from 'solid-js';
import type { DelegationReview } from '../../electron/shared/delegation-types';
import { delegationRequest } from '../store/delegation';
import type { Task } from '../store/types';
import { Dialog } from './Dialog';
import { theme } from '../lib/theme';

/** The reviewed commits are sent back to main, where approval and merge are one operation. */
export function DelegationReviewDialog(props: { task: Task; open: boolean; onClose: () => void }) {
  const [error, setError] = createSignal('');
  const [merging, setMerging] = createSignal(false);
  const [review, { refetch }] = createResource(
    () => (props.open ? props.task.id : undefined),
    (taskId) => delegationRequest<DelegationReview>({ action: 'review', taskId }),
  );
  async function merge() {
    const snapshot = review();
    if (!snapshot || merging()) return;
    setMerging(true);
    setError('');
    try {
      const { expectedCommit, expectedTargetBranch, expectedTargetCommit } = snapshot;
      await delegationRequest({
        action: 'merge',
        taskId: props.task.id,
        review: { expectedCommit, expectedTargetBranch, expectedTargetCommit },
      });
      props.onClose();
    } catch (err) {
      setError(String(err));
      void refetch();
    } finally {
      setMerging(false);
    }
  }
  return (
    <Dialog
      open={props.open}
      onClose={() => {
        if (!merging()) props.onClose();
      }}
      width="850px"
    >
      <div class="delegation-surface">
        <h2>Review child result: {props.task.name}</h2>
        <p>Merging approves this child commit and integration target. The worktree is kept.</p>
        <Show when={review.loading}>
          <p>Loading result…</p>
        </Show>
        <Show when={review.error}>
          <p role="alert">{String(review.error)}</p>
          <button onClick={() => void refetch()}>Retry</button>
        </Show>
        <Show when={review()}>
          {(value) => (
            <>
              <p>
                <code>{value().expectedCommit.slice(0, 10)}</code> →{' '}
                <code>{value().expectedTargetBranch}</code> at{' '}
                <code>{value().expectedTargetCommit.slice(0, 10)}</code>
              </p>
              <pre
                tabIndex={0}
                aria-label="Child result diff"
                style={{
                  'white-space': 'pre-wrap',
                  'overflow-wrap': 'anywhere',
                  'max-height': '55vh',
                  overflow: 'auto',
                  background: theme.bgInput,
                  padding: '12px',
                }}
              >
                {value().diff || 'No changes to merge.'}
              </pre>
            </>
          )}
        </Show>
        <Show when={error()}>
          <p role="alert" style={{ color: theme.error }}>
            {error()}
          </p>
        </Show>
        <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
          <button disabled={merging()} onClick={() => props.onClose()}>
            Cancel
          </button>
          <button
            class="btn-primary"
            disabled={merging() || review.loading || !!review.error || !review()}
            onClick={() => void merge()}
          >
            {merging() ? 'Merging…' : 'Approve and merge this result'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
