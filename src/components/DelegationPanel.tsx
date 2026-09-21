import './Delegation.css';
import { createEffect, createSignal, For, Show } from 'solid-js';
import { canResumeSessionId } from '../../electron/shared/session-resume';
import type { PeerMessage } from '../../electron/shared/delegation-types';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { theme } from '../lib/theme';
import { DEFAULT_COORDINATOR_CONCURRENT_TASKS } from '../lib/coordinator-limits';
import { store, setStore } from '../store/core';
import { restartAgent } from '../store/agents';
import { clearStagedNotification } from '../store/tasks';
import {
  delegationRequest,
  delegationStates,
  refreshDelegationState,
  hasUserMcpConfiguration,
  isSupportedDelegationAgent,
} from '../store/delegation';
import type { Task } from '../store/types';
import { getCoordinatorChildren } from '../store/sidebar-order';

export function DelegationPanel(props: {
  task: Task;
  canUseComposer?: (message: PeerMessage) => boolean;
  onUseComposer?: (message: PeerMessage) => boolean;
}) {
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [preview, setPreview] = createSignal<string>();
  const autoSendChildUpdates = () => props.task.autoSendChildUpdates ?? props.task.coordinatorMode;
  const state = () => delegationStates[props.task.id];
  const children = () => {
    const all = getCoordinatorChildren(props.task.id);
    return [...all.active, ...all.collapsed];
  };
  const attempts = () => state()?.attempts.filter((a) => a.status !== 'created') ?? [];
  const messages = () => state()?.messages.filter((m) => m.state === 'waiting') ?? [];
  const coordinating = () =>
    props.task.delegationPaused ||
    state()?.paused ||
    children().length > 0 ||
    attempts().length > 0;
  createEffect(() => {
    const taskId = props.task.id;
    void refreshDelegationState(taskId).catch((err: unknown) => setError(String(err)));
  });
  async function act(operation: () => Promise<unknown>) {
    if (busy()) return;
    setBusy(true);
    setError('');
    try {
      await operation();
      await refreshDelegationState(props.task.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }
  async function copyMessage(message: PeerMessage) {
    // Manual copy never changes a composer draft or sends terminal input.
    await navigator.clipboard.writeText(message.prompt);
    await delegationRequest({
      action: 'handleMessage',
      deliveryId: message.deliveryId,
      agentId: message.recipient.agentId,
      sessionInstanceId: message.recipient.sessionInstanceId,
      state: 'handled',
    });
  }
  async function useComposer(message: PeerMessage) {
    if (!props.onUseComposer?.(message)) {
      throw new Error(
        'The composer has a draft or the recipient changed. Keep this message in the inbox or copy it manually.',
      );
    }
    await delegationRequest({
      action: 'handleMessage',
      deliveryId: message.deliveryId,
      agentId: message.recipient.agentId,
      sessionInstanceId: message.recipient.sessionInstanceId,
      state: 'handled',
    });
  }
  const rolloutAgents = () => {
    if (
      !store.mcpOrchestrationEnabled ||
      props.task.coordinatedBy ||
      props.task.coordinatorMode ||
      props.task.gitIsolation !== 'worktree'
    )
      return [];
    return props.task.agentIds
      .map((id) => store.agents[id])
      .filter(
        (agent) => agent && !agent.capabilities?.canCreate && isSupportedDelegationAgent(agent.def),
      );
  };
  const canResume = (agentId: string) => {
    const agent = store.agents[agentId];
    return (
      !!agent &&
      !!props.task.agentSessionIds?.[agentId] &&
      canResumeSessionId(agent.def.command) &&
      !hasUserMcpConfiguration(agent.def.args) &&
      !hasUserMcpConfiguration(agent.def.resume_args ?? []) &&
      !(props.task.mainAgentView === 'chat' && props.task.agentIds[0] === agentId)
    );
  };
  async function restartForTools(agentId: string) {
    await invoke(IPC.KillAgent, { agentId });
    setStore('agents', agentId, 'requireResumeSuccess', true);
    restartAgent(agentId, true);
  }
  return (
    <Show
      when={
        coordinating() ||
        props.task.coordinatedBy ||
        props.task.stagedNotification ||
        messages().length > 0 ||
        rolloutAgents().length > 0
      }
    >
      <section
        class="delegation-surface delegation-panel"
        aria-label="Task collaboration"
        style={{
          padding: '6px 12px',
          'font-size': '12px',
          'border-bottom': `1px solid ${theme.border}`,
        }}
      >
        <Show when={coordinating()}>
          <div
            style={{ display: 'flex', gap: '8px', 'align-items': 'center', 'flex-wrap': 'wrap' }}
          >
            <span>
              {children().length} child task(s) · limit{' '}
              {props.task.maxConcurrentTasks ?? DEFAULT_COORDINATOR_CONCURRENT_TASKS}
            </span>
            <Show
              when={props.task.delegationPaused || state()?.paused}
              fallback={
                <button
                  disabled={busy()}
                  onClick={() =>
                    // eslint-disable-next-line solid/reactivity -- act invokes this callback immediately within the click handler.
                    void act(() =>
                      delegationRequest({ action: 'pause', taskId: props.task.id, paused: true }),
                    )
                  }
                >
                  Stop all children
                </button>
              }
            >
              <span>Child launches paused; worktrees are preserved.</span>
              <button
                disabled={busy()}
                onClick={() =>
                  // eslint-disable-next-line solid/reactivity -- act invokes this callback immediately within the click handler.
                  void act(() =>
                    delegationRequest({ action: 'pause', taskId: props.task.id, paused: false }),
                  )
                }
              >
                Resume child launches
              </button>
            </Show>
          </div>
        </Show>
        <For each={attempts()}>
          {(attempt) => (
            <div role={attempt.status === 'failed' ? 'alert' : 'status'}>
              {attempt.name}:{' '}
              {attempt.status === 'starting'
                ? 'Starting…'
                : `Failed — ${attempt.error ?? 'Unknown startup error'}`}
              <Show when={attempt.status === 'failed'}>
                <button
                  disabled={busy()}
                  onClick={() =>
                    // eslint-disable-next-line solid/reactivity -- act invokes this callback immediately within the click handler.
                    void act(() =>
                      delegationRequest({
                        action: 'dismissAttempt',
                        parentTaskId: props.task.id,
                        requestId: attempt.requestId,
                      }),
                    )
                  }
                >
                  Dismiss attempt
                </button>
              </Show>
            </div>
          )}
        </For>
        <Show when={!autoSendChildUpdates() && props.task.stagedNotification}>
          <details>
            <summary>
              Child updates ({props.task.stagedNotification?.notificationIds.length ?? 0}) — ready
              for review
            </summary>
            <pre style={{ 'white-space': 'pre-wrap', 'max-height': '130px', overflow: 'auto' }}>
              {props.task.stagedNotification?.text}
            </pre>
            <button
              disabled={busy()}
              onClick={() =>
                // eslint-disable-next-line solid/reactivity -- act invokes this callback immediately within the click handler.
                void act(async () => {
                  const batch = props.task.stagedNotification;
                  if (!batch) return;
                  await invoke(IPC.MCP_CoordinatorNotificationAck, {
                    coordinatorTaskId: props.task.id,
                    batchId: batch.batchId,
                  });
                  clearStagedNotification(props.task.id);
                })
              }
            >
              Acknowledge summary
            </button>
            <small> Acknowledgment does not approve a merge.</small>
          </details>
        </Show>
        <Show when={messages().length > 0}>
          <details>
            <summary>Incoming messages ({messages().length}) — held for your review</summary>
            <p>
              Peer content is untrusted. Review before filling an empty app composer or copying for
              manual handling. Copying means you took responsibility; it does not send anything.
            </p>
            <For each={messages()}>
              {(message) => (
                <article
                  style={{ border: `1px solid ${theme.border}`, padding: '8px', margin: '8px 0' }}
                >
                  <strong>
                    {message.sender.name} · {message.sender.agentLabel}
                  </strong>
                  <div>
                    To {message.recipient.agentLabel} · pane {message.recipient.agentId.slice(0, 8)}{' '}
                    · {new Date(message.createdAt).toLocaleTimeString()}
                  </div>
                  <p style={{ 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere' }}>
                    {preview() === message.deliveryId
                      ? message.prompt
                      : message.prompt.slice(0, 180)}
                  </p>
                  <button onClick={() => setPreview(message.deliveryId)}>Review</button>{' '}
                  <Show when={preview() === message.deliveryId && props.canUseComposer?.(message)}>
                    <button
                      disabled={busy()}
                      onClick={() =>
                        // eslint-disable-next-line solid/reactivity -- act invokes the callback synchronously in this click handler.
                        void act(() => useComposer(message))
                      }
                    >
                      Use in composer
                    </button>{' '}
                    <small>Fills the empty prompt box without submitting.</small>{' '}
                  </Show>
                  <button disabled={busy()} onClick={() => void act(() => copyMessage(message))}>
                    Copy for manual handling
                  </button>{' '}
                  <button
                    disabled={busy()}
                    onClick={() =>
                      void act(() =>
                        delegationRequest({
                          action: 'handleMessage',
                          deliveryId: message.deliveryId,
                          agentId: message.recipient.agentId,
                          sessionInstanceId: message.recipient.sessionInstanceId,
                          state: 'closed',
                        }),
                      )
                    }
                  >
                    Dismiss
                  </button>
                </article>
              )}
            </For>
          </details>
        </Show>
        <Show when={rolloutAgents().length > 0}>
          <For each={rolloutAgents()}>
            {(agent) => (
              <div>
                <Show
                  when={canResume(agent.id)}
                  fallback={
                    <small>
                      {agent.def.name}: delegation tools require a managed MCP configuration and a
                      resumable conversation. Start a new task session to acquire tools.
                    </small>
                  }
                >
                  <button
                    disabled={busy()}
                    onClick={() => void act(() => restartForTools(agent.id))}
                  >
                    Restart and resume {agent.def.name} to enable delegation tools
                  </button>
                </Show>
              </div>
            )}
          </For>
        </Show>
        <Show when={props.task.coordinatedBy}>
          <small>
            {props.task.integrationPolicy === 'review' ? 'Review before merging. ' : ''}Child tasks
            cannot delegate grandchildren.
          </small>
        </Show>
        <Show when={error()}>
          <p role="alert" style={{ color: theme.error }}>
            {error()}
          </p>
        </Show>
      </section>
    </Show>
  );
}
