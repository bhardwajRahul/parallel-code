import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { reconcile } from 'solid-js/store';
import { Channel, invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import {
  CHAT_PERMISSION_MODES,
  isChatPermissionMode,
  type AgentChatState,
  type ChatPermissionMode,
} from '../../electron/shared/agent-chat-types';
import { chatMessages, type ChatConnection } from '../../electron/shared/chat-messages';
import { store, setStore } from '../store/core';
import { agentChatProvider } from '../store/agent-chat';
import { saveState } from '../store/persistence';
import { sendPrompt, setTaskPromptDraft, clearPrefillPrompt } from '../store/tasks';
import { registerAction, unregisterAction } from '../store/focus';
import { registerFocusFn, unregisterFocusFn } from '../store/focused-panel';
import type { Task } from '../store/types';
import { isLandedTaskState } from '../store/landing';
import { detectThemeTone } from '../lib/custom-theme';
import { LOOK_PRESETS } from '../lib/look';
import { GitBranchIcon } from './icons';
import type { ChatActions, ChatProps, mountChat } from './chat/CopilotChat.react';
import './AgentChatView.css';

const PERMISSION_MODE_LABELS: Record<ChatPermissionMode, string> = {
  default: 'Ask each time',
  acceptEdits: 'Accept edits',
  plan: 'Plan only',
};

export function AgentChatView(props: {
  task: Task;
  agentId: string;
  /** Every tiled task keeps its chat mounted, so only the focused pane may take focus. */
  active: boolean;
  onReady?: (focus: () => void) => void;
}) {
  const provider = () => agentChatProvider(props.agentId);
  const agentName = () => (provider() === 'claude' ? 'Claude' : 'Codex');
  const sessionKey = () =>
    provider() === 'claude' ? ('claudeChatSessionId' as const) : ('codexChatThreadId' as const);
  const state = () => store.agents[props.agentId]?.chatState;
  const [error, setError] = createSignal('');
  const [connection, setConnection] = createSignal<ChatConnection>();
  const [view, setView] = createSignal<ReturnType<typeof mountChat>>();
  let host: HTMLDivElement | undefined;
  let actions: ChatActions | undefined;
  let disposed = false;
  let connecting = false;
  const channel = new Channel<AgentChatState>();
  channel.onmessage = (next) => {
    if (disposed || !store.agents[props.agentId]) return;
    setStore('agents', props.agentId, 'chatState', reconcile(next));
    if (
      next.threadId &&
      next.threadId !== props.task[sessionKey()] &&
      (provider() === 'codex' || next.items.some((item) => item.kind === 'user'))
    ) {
      setStore('tasks', props.task.id, sessionKey(), next.threadId);
      void saveState();
    }
  };
  async function connect() {
    if (connecting) return;
    connecting = true;
    setError('');
    try {
      const agent = store.agents[props.agentId];
      if (!agent) return;
      await invoke(IPC.AgentChat, {
        action: 'start',
        provider: provider(),
        agentId: props.agentId,
        taskId: props.task.id,
        stepsEnabled: props.task.stepsEnabled,
        command: agent.def.command,
        cwd: props.task.worktreePath,
        envFile: store.agentEnvFiles[agent.def.id],
        threadId: props.task[sessionKey()],
        skipPermissions: props.task.skipPermissions,
        permissionMode: props.task.chatPermissionMode,
        channelId: channel.id,
      });
      const next = await invoke<ChatConnection>(IPC.AgentChat, {
        action: 'connection',
        agentId: props.agentId,
      });
      if (!disposed) setConnection(next);
    } catch (error) {
      if (!disposed) setError(String(error));
    } finally {
      connecting = false;
    }
  }
  /** Drop this conversation and open a new one; the agent keeps no thread to resume. */
  async function newChat() {
    if (
      state()?.items.length &&
      !window.confirm(`Start a new ${agentName()} chat? This conversation is cleared from here.`)
    )
      return;
    setError('');
    try {
      await invoke(IPC.AgentChat, { action: 'stop', agentId: props.agentId });
    } catch (error) {
      setError(String(error));
      return;
    }
    setStore('tasks', props.task.id, sessionKey(), undefined);
    setStore(
      'agents',
      props.agentId,
      'chatState',
      reconcile({ status: 'starting', items: [], requests: [] } satisfies AgentChatState),
    );
    void saveState();
    await connect();
  }
  async function selectPermissionMode(mode: ChatPermissionMode) {
    setError('');
    try {
      await invoke(IPC.AgentChat, {
        action: 'setPermissionMode',
        agentId: props.agentId,
        permissionMode: mode,
      });
      // Remember it for this task, so the next session starts the way it ended.
      setStore('tasks', props.task.id, 'chatPermissionMode', mode);
      void saveState();
    } catch (error) {
      setError(String(error));
    }
  }
  const callbacks: Pick<
    ChatProps,
    'onDraft' | 'onSend' | 'onStop' | 'onRespond' | 'onActions' | 'onSelectModel' | 'onReloadModels'
  > = {
    onSelectModel: (model, reasoningEffort) =>
      invoke(IPC.AgentChat, {
        action: 'selectModel',
        agentId: props.agentId,
        model,
        reasoningEffort,
      }),
    onReloadModels: () => invoke(IPC.AgentChat, { action: 'models', agentId: props.agentId }),
    onDraft: (text) => setTaskPromptDraft(props.task.id, text),
    onSend: async (text, deliver) => {
      await sendPrompt(props.task.id, props.agentId, text, { sendChat: deliver });
      if (props.task.promptDraft?.trim() === text) setTaskPromptDraft(props.task.id, '');
    },
    onStop: () => invoke(IPC.AgentChat, { action: 'interrupt', agentId: props.agentId }),
    onRespond: (request, decision, answers) =>
      invoke(IPC.AgentChat, {
        action: 'respond',
        agentId: props.agentId,
        requestId: request.id,
        decision,
        answers,
      }),
    onActions: (next) => {
      actions = next;
    },
  };
  onMount(() => {
    props.onReady?.(() => actions?.focus());
    const focusKey = `${props.task.id}:prompt`;
    const actionKey = `${props.task.id}:send-prompt`;
    registerFocusFn(focusKey, () => actions?.focus());
    registerAction(actionKey, () => actions?.send());
    onCleanup(() => {
      unregisterFocusFn(focusKey);
      unregisterAction(actionKey);
    });
    void import('./chat/CopilotChat.react')
      .then((module) => {
        if (disposed || !host) return;
        setView(module.mountChat(host.attachShadow({ mode: 'open' })));
      })
      .catch((error) => {
        if (!disposed) setError(String(error));
      });
    void connect();
  });
  onCleanup(() => {
    disposed = true;
    channel.dispose();
    view()?.dispose();
  });
  createEffect(() => {
    const prefill = props.task.prefillPrompt;
    if (prefill !== undefined) {
      setTaskPromptDraft(props.task.id, prefill);
      clearPrefillPrompt(props.task.id);
    }
  });
  createEffect(() => {
    const renderer = view();
    const connected = connection();
    const current = state();
    if (!renderer || !connected || !current) return;
    const snapshot = JSON.parse(JSON.stringify(current)) as AgentChatState;
    const custom = store.activeCustomThemeId
      ? store.customThemes[store.activeCustomThemeId]
      : undefined;
    const dark = custom
      ? detectThemeTone(custom.vars) === 'dark'
      : LOOK_PRESETS.find((p) => p.id === store.themePreset)?.tone !== 'light';
    renderer.update({
      ...callbacks,
      agentName: agentName(),
      connection: connected,
      state: snapshot,
      messages: chatMessages(snapshot),
      draft: props.task.promptDraft ?? '',
      dark,
      disabled: isLandedTaskState(props.task.landingState),
      // Read the focus state only while a request is pending. Every tiled task keeps
      // its chat mounted, so subscribing unconditionally would re-render and deep-clone
      // each one on any focus change elsewhere in the app.
      active: snapshot.requests.length > 0 && props.active,
    });
  });
  const status = () =>
    state()?.status === 'closed'
      ? 'Disconnected'
      : state()?.requests.length
        ? 'Waiting for you'
        : state()?.status === 'working'
          ? 'Working'
          : state()?.status === 'ready'
            ? 'Ready'
            : 'Connecting…';
  /** The mode this session is really in: the user's pick, else what the agent reported. */
  const permissionMode = () => props.task.chatPermissionMode ?? state()?.permissionMode ?? '';
  return (
    <div class="codex-chat" role="region" aria-label={`${agentName()} conversation`}>
      <div class="codex-chat-header">
        <strong>{agentName()}</strong>
        <span class="codex-chat-context" title={props.task.worktreePath}>
          <GitBranchIcon size={13} />
          {props.task.branchName || 'Local worktree'}
        </span>
        <span class="codex-chat-status" role="status">
          {status()}
        </span>
        <Show when={provider() === 'claude'}>
          <select
            class="codex-chat-mode"
            aria-label="Permission mode"
            title={
              props.task.skipPermissions
                ? 'This task skips permissions, so nothing is asked.'
                : 'How this chat handles permission requests'
            }
            value={permissionMode()}
            disabled={props.task.skipPermissions || state()?.status !== 'ready'}
            onChange={(event) => {
              const mode = event.currentTarget.value;
              if (isChatPermissionMode(mode)) void selectPermissionMode(mode);
            }}
          >
            {/* A mode this view cannot switch to, such as the task's own bypass,
                still has to name itself rather than show someone else's value. */}
            <Show when={!isChatPermissionMode(permissionMode())}>
              <option value={permissionMode()} disabled>
                {permissionMode() === 'bypassPermissions'
                  ? 'Skipping permissions'
                  : permissionMode() || 'Permissions'}
              </option>
            </Show>
            <For each={CHAT_PERMISSION_MODES}>
              {(mode) => <option value={mode}>{PERMISSION_MODE_LABELS[mode]}</option>}
            </For>
          </select>
        </Show>
        <button class="codex-chat-action" onClick={() => void newChat()}>
          New chat
        </button>
        <button class="codex-chat-action" onClick={() => void connect()}>
          Reconnect
        </button>
      </div>
      <Show when={state()?.permissionNote}>
        <p class="codex-chat-note">{state()?.permissionNote}</p>
      </Show>
      <div class="codex-chat-island" ref={host} />
      <Show when={error() || state()?.error}>
        <div role="alert" class="codex-chat-error">
          {error() || state()?.error}
          {/* Reconnect lives in the header now, where it is reachable before an error too. */}
          <Show when={error() || state()?.status === 'closed'}>
            <p>If sign-in is needed, use {agentName()}’s login flow in Terminal, then reconnect.</p>
          </Show>
        </div>
      </Show>
    </div>
  );
}
