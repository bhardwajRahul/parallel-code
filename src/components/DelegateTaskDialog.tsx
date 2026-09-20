import './Delegation.css';
import { createEffect, createResource, createSignal, For, Show } from 'solid-js';
import type { DelegationSnapshot } from '../../electron/shared/delegation-types';
import { Dialog } from './Dialog';
import { theme } from '../lib/theme';
import { store, setStore } from '../store/core';
import type { Task } from '../store/types';
import {
  delegationRequest,
  isSupportedDelegationAgent,
  refreshDelegationState,
} from '../store/delegation';
import { setTaskFocusedPanel } from '../store/focused-panel';

export function DelegateTaskDialog(props: { task: Task; open: boolean; onClose: () => void }) {
  const [name, setName] = createSignal('');
  const [prompt, setPrompt] = createSignal('');
  const [agentId, setAgentId] = createSignal('');
  const [useLastCommit, setUseLastCommit] = createSignal(false);
  const [propagate, setPropagate] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal('');
  const agents = () => store.availableAgents.filter(isSupportedDelegationAgent);
  const selectedAgent = () => agents().find((a) => a.id === agentId());
  const [snapshot, { refetch }] = createResource(
    () => (props.open ? props.task.id : undefined),
    (taskId) => delegationRequest<DelegationSnapshot>({ action: 'snapshot', taskId }),
  );
  createEffect(() => {
    if (!props.open) return;
    setUseLastCommit(false);
    setError('');
    if (!agentId()) {
      const own = store.agents[props.task.agentIds[0]]?.def;
      if (own && isSupportedDelegationAgent(own)) setAgentId(own.id);
    }
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const current = snapshot();
    const agent = selectedAgent();
    if (!current || !agent || !name().trim() || !prompt().trim() || submitting()) return;
    if (current.changedFileCount > 0 && !useLastCommit()) return;
    setSubmitting(true);
    setError('');
    try {
      await delegationRequest({
        action: 'create',
        assignment: {
          parentTaskId: props.task.id,
          requestId: crypto.randomUUID(),
          name: name().trim(),
          prompt: prompt().trim(),
          expectedBranch: current.branchName,
          expectedHeadSha: current.headSha,
          useLastCommit: useLastCommit(),
          agentCommand: agent.command,
          agentArgs: agent.args,
          agentEnvFile: store.agentEnvFiles[agent.id],
          propagateSkipPermissions: propagate(),
        },
      });
      setStore('tasks', props.task.id, 'delegationParent', true);
      setName('');
      setPrompt('');
      props.onClose();
      await refreshDelegationState(props.task.id);
    } catch (err) {
      setError(String(err));
      setUseLastCommit(false);
      void refetch();
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Dialog
      open={props.open}
      onClose={() => {
        if (!submitting()) props.onClose();
      }}
      width="600px"
    >
      <form class="delegation-surface" onSubmit={submit} style={{ display: 'grid', gap: '12px' }}>
        <h2>Delegate task</h2>
        <p>
          Create a child in {store.projects.find((p) => p.id === props.task.projectId)?.name}. The
          child receives a committed snapshot, not your conversation or uncommitted edits.
        </p>
        <label>
          Name
          <input
            required
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            style={{ width: '100%' }}
          />
        </label>
        <label>
          Assignment
          <textarea
            required
            rows={6}
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            style={{ width: '100%' }}
            placeholder="Describe the assignment and include the context the child needs."
          />
        </label>
        <label>
          Child agent
          <select
            required
            value={agentId()}
            onChange={(e) => setAgentId(e.currentTarget.value)}
            style={{ width: '100%' }}
          >
            <option value="">Choose a supported agent…</option>
            <For each={agents()}>{(agent) => <option value={agent.id}>{agent.name}</option>}</For>
          </select>
        </label>
        <Show when={agents().length === 0}>
          <p role="alert">
            Configure a supported Claude, Codex, or Copilot child agent in Settings before
            delegating.
          </p>
        </Show>
        <p>
          Review before merging — the child commits and verifies its work, then waits for your
          review.
        </p>
        <label>
          <input
            type="checkbox"
            checked={propagate()}
            onChange={(e) => setPropagate(e.currentTarget.checked)}
          />{' '}
          Allow permission bypass for this child
        </label>
        <Show when={snapshot.loading}>
          <p>Checking parent branch and commit…</p>
        </Show>
        <Show when={snapshot.error}>
          <p role="alert">Could not inspect the parent: {String(snapshot.error)}</p>
          <button type="button" onClick={() => void refetch()}>
            Retry
          </button>
        </Show>
        <Show when={snapshot()}>
          {(base) => (
            <div>
              <p>
                Branch: <code>{base().branchName}</code> · snapshot{' '}
                <code>{base().headSha.slice(0, 10)}</code>
              </p>
              <Show when={base().changedFileCount > 0}>
                <p>{base().changedFileCount} changed file(s) will be absent from the child.</p>
                <button
                  type="button"
                  onClick={() => {
                    props.onClose();
                    setTaskFocusedPanel(props.task.id, 'ai-terminal');
                  }}
                >
                  Review and commit first
                </button>
                <label style={{ display: 'block', margin: '8px 0' }}>
                  <input
                    type="checkbox"
                    checked={useLastCommit()}
                    onChange={(e) => setUseLastCommit(e.currentTarget.checked)}
                  />{' '}
                  Use the last commit ({base().headSha.slice(0, 10)})
                </label>
                <small>
                  Your assignment draft is kept when you cancel or review first. Reopen to refresh
                  the snapshot.
                </small>
              </Show>
            </div>
          )}
        </Show>
        <Show when={error()}>
          <p role="alert" style={{ color: theme.error }}>
            {error()}
          </p>
        </Show>
        <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
          <button type="button" disabled={submitting()} onClick={() => props.onClose()}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              submitting() ||
              !snapshot() ||
              snapshot.loading ||
              !!snapshot.error ||
              !selectedAgent() ||
              !name().trim() ||
              !prompt().trim() ||
              ((snapshot()?.changedFileCount ?? 0) > 0 && !useLastCommit())
            }
          >
            {submitting() ? 'Starting child…' : 'Delegate task'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
