/** @jsxImportSource react */
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CopilotKitProvider,
  CopilotChatView,
  CopilotChatConfigurationProvider,
  CopilotChatAssistantMessage,
  useAgent,
  type CopilotChatAssistantMessageProps,
} from '@copilotkit/react-core/v2';
import type { Message } from '@ag-ui/core';
import { HttpAgent } from '@ag-ui/client';
import {
  reasoningEffortLabel,
  selectedChatModel,
  effectiveReasoningEffort,
  type ChatConnection,
} from '../../../electron/shared/chat-messages';
import type { ChatItem, AgentChatState } from '../../../electron/shared/agent-chat-types';
import libraryCss from '@copilotkit/react-core/v2/styles.css?inline';
import chatCss from './chat.css?inline';
import { useReveal } from './use-reveal.react';
import { enableCopyOnSelect } from './copy-on-select';
import { RequestCard, type RespondToRequest } from './RequestCard.react';

export interface ChatActions {
  focus: () => void;
  send: () => Promise<void>;
}
export interface ChatProps {
  agentName: string;
  connection: ChatConnection;
  state: AgentChatState;
  messages: Message[];
  draft: string;
  dark: boolean;
  disabled: boolean;
  /** This chat's panel is the one the user is working in; only it may claim focus. */
  active: boolean;
  onSelectModel: (model: string, reasoningEffort?: string) => Promise<void>;
  onReloadModels: () => Promise<void>;
  onDraft: (text: string) => void;
  onSend: (text: string, deliver: (text: string) => Promise<void>) => Promise<void>;
  onStop: () => Promise<void>;
  onRespond: RespondToRequest;
  onActions: (actions: ChatActions) => void;
}

const ActivityContext = createContext<ChatItem[]>([]);
const activityLabels = {
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  declined: 'Declined',
  interrupted: 'Stopped',
};

function ActivityRow({ id, content }: { id: string; content: string }) {
  const activity = useContext(ActivityContext).find((item) => item.id === id)?.activity;
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (activity?.status === 'failed' && details.current) details.current.open = true;
  }, [activity?.status]);
  return (
    <details className="chat-tool" ref={details} data-status={activity?.status}>
      <summary>
        <span className="chat-tool-type">
          {activity?.type === 'command'
            ? 'Command'
            : activity?.type === 'files'
              ? 'Changes'
              : 'Tool'}
        </span>
        <span className="chat-tool-label" title={activity?.label}>
          {activity?.label || content.split('\n')[0] || 'Tool activity'}
        </span>
        {/* "Done" on every finished row is noise; the rail already reads as settled. */}
        {activity && activity.status !== 'completed' && (
          <span className="chat-tool-status">
            {activityLabels[activity.status]}
            {activity.exitCode !== undefined && activity.exitCode !== 0
              ? ` · exit ${activity.exitCode}`
              : ''}
          </span>
        )}
      </summary>
      <pre>{content || 'No output.'}</pre>
    </details>
  );
}

const AssistantMessage = Object.assign(function AssistantMessage(
  props: CopilotChatAssistantMessageProps,
) {
  const text = useReveal(props.message.content ?? '', !!props.isRunning);
  if (props.message.toolCalls?.length)
    return (
      <>
        {props.message.toolCalls.map((call) => {
          const result = props.messages?.find((m) => m.role === 'tool' && m.toolCallId === call.id);
          const content = typeof result?.content === 'string' ? result.content : '';
          return <ActivityRow key={call.id} id={call.id} content={content} />;
        })}
      </>
    );
  return <CopilotChatAssistantMessage {...props} markdownRenderer={{ content: text }} />;
}, CopilotChatAssistantMessage);

function ModelPicker({
  state,
  disabled,
  onSelectModel,
  onReloadModels,
}: Pick<ChatProps, 'state' | 'disabled' | 'onSelectModel' | 'onReloadModels'>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const models = state.models ?? [];
  const selected = selectedChatModel(state);
  const efforts = selected?.supportedReasoningEfforts ?? [];
  const unavailable = disabled || pending || state.status !== 'ready';
  async function change(action: () => Promise<void>) {
    setPending(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(String(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="chat-model-settings">
      {/* No visible captions: the selects sit on the composer and name themselves
          through their own values, so `aria-label` carries the accessible name. */}
      <div className="chat-model-selectors">
        <select
          aria-label="Model"
          title="Model for the next message"
          value={state.model ?? ''}
          disabled={unavailable || !models.length}
          onChange={(event) => void change(() => onSelectModel(event.target.value))}
        >
          {!selected && (
            <option value={state.model ?? ''} disabled>
              {state.model || 'Default model'}
            </option>
          )}
          {models.map((model) => (
            <option key={model.model} value={model.model}>
              {model.displayName}
            </option>
          ))}
        </select>
        <select
          aria-label="Reasoning effort"
          title={
            !selected
              ? 'Select a model to see its reasoning levels'
              : !efforts.length
                ? 'This model does not offer adjustable reasoning'
                : 'Reasoning level for the next message'
          }
          value={effectiveReasoningEffort(state) ?? ''}
          disabled={unavailable || !efforts.length}
          onChange={(event) =>
            void change(() => onSelectModel(selected?.model ?? '', event.target.value))
          }
        >
          {!efforts.length ? (
            <option value={state.reasoningEffort ?? ''}>
              {selected ? 'Not supported' : 'Select a model'}
            </option>
          ) : (
            <>
              {!selected?.defaultReasoningEffort && <option value="">Default</option>}
              {state.reasoningEffort &&
                !efforts.some((option) => option.reasoningEffort === state.reasoningEffort) && (
                  <option value={state.reasoningEffort} disabled>
                    {state.reasoningEffort}
                  </option>
                )}
              {efforts.map((option) => (
                <option
                  key={option.reasoningEffort}
                  value={option.reasoningEffort}
                  title={option.description}
                >
                  {reasoningEffortLabel(option.reasoningEffort)}
                </option>
              ))}
            </>
          )}
        </select>
      </div>
      {(error || state.modelsError) && (
        <div className="chat-model-error" role="alert">
          {error || `Models unavailable: ${state.modelsError}`}
          {state.modelsError && (
            <button disabled={pending} onClick={() => void change(onReloadModels)}>
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Conversation(props: ChatProps) {
  const { agent, isReady } = useAgent({
    agentId: 'conversation',
    runtimeAgentId: 'default',
    threadId: props.state.threadId ?? '',
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const request = useRef<AbortController | undefined>(undefined);
  const cleanupSubmit = useRef(false);
  const current = useRef(props);
  current.current = props;
  const working = props.state.status === 'working';
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      void agent.detachActiveRun();
    };
  }, [agent]);

  function deliver(text: string): Promise<void> {
    if (!(agent instanceof HttpAgent))
      return Promise.reject(new Error('Chat transport is not ready.'));
    return new Promise((resolve, reject) => {
      let accepted = false;
      const controller = new AbortController();
      request.current = controller;
      const sub = agent.subscribe({
        onCustomEvent: ({ event }) => {
          if (event.name === 'parallel-code/accepted') {
            accepted = true;
            resolve();
          }
        },
        onRunFinishedEvent: () => {
          accepted = true;
          resolve();
        },
        onRunErrorEvent: ({ event }) => reject(new Error(event.message)),
      });
      agent.setMessages([{ id: crypto.randomUUID(), role: 'user', content: text }]);
      // Own the HTTP lifetime: detaching AG-UI alone does not abort its fetch.
      void agent
        .runAgent({ abortController: controller })
        .catch(reject)
        .finally(() => {
          sub.unsubscribe();
          if (request.current === controller) request.current = undefined;
          if (!accepted)
            reject(new Error('The message could not be confirmed. Reconnect before retrying.'));
        });
    });
  }
  async function send(text = current.current.draft) {
    if (
      !isReady ||
      sending ||
      current.current.disabled ||
      current.current.state.status !== 'ready' ||
      !text.trim()
    )
      return;
    setSending(true);
    setError('');
    try {
      await current.current.onSend(text.trim(), deliver);
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      if (mounted.current) setSending(false);
    }
  }
  useEffect(() => {
    props.onActions({
      focus: () => container.current?.querySelector('textarea')?.focus(),
      send: () => send(),
    });
  });
  return (
    <div ref={container} className={`chat-ui${props.dark ? ' dark' : ''}`}>
      <CopilotChatConfigurationProvider
        agentId="conversation"
        threadId={props.state.threadId}
        // The composer dock replaces the library's input layout, so its built-in
        // disclaimer slot never renders; .chat-composer-hint carries that line.
        labels={{ welcomeMessageText: 'What would you like to work on?' }}
      >
        <ActivityContext.Provider value={props.state.items}>
          <CopilotChatView
            hasExplicitThreadId={working || props.state.requests.length > 0}
            messages={props.messages}
            isRunning={working}
            inputValue={props.draft}
            onInputChange={(text) => {
              if (!(cleanupSubmit.current && text === '')) props.onDraft(text);
            }}
            onSubmitMessage={(text) => {
              cleanupSubmit.current = true;
              queueMicrotask(() => {
                cleanupSubmit.current = false;
              });
              void send(text);
            }}
            onStop={() => {
              void props.onStop().catch((error) => setError(String(error)));
            }}
            messageView={{ assistantMessage: AssistantMessage }}
            input={{
              children: ({ textArea, sendButton }) => (
                <div className="chat-composer-dock">
                  {props.state.requests.length > 0 && (
                    <div className="chat-requests" aria-label="Pending requests">
                      {props.state.requests.map((request, index) => (
                        <RequestCard
                          key={`${typeof request.id}:${request.id}`}
                          request={request}
                          agentName={props.agentName}
                          respond={props.onRespond}
                          autoFocus={props.active && index === 0}
                          onResolved={() => container.current?.querySelector('textarea')?.focus()}
                        />
                      ))}
                    </div>
                  )}
                  {error && (
                    <div role="alert" className="chat-error">
                      {error}
                    </div>
                  )}
                  <div className="chat-composer">
                    <div className="chat-composer-row">
                      {textArea}
                      {sendButton}
                    </div>
                    <ModelPicker
                      state={props.state}
                      disabled={props.disabled || sending}
                      onSelectModel={props.onSelectModel}
                      onReloadModels={props.onReloadModels}
                    />
                  </div>
                  <div className="chat-composer-hint">
                    Enter to send · Shift+Enter for a new line
                  </div>
                </div>
              ),
              textArea: {
                'aria-label': `Message ${props.agentName}`,
                placeholder: working ? 'Draft next message…' : `Message ${props.agentName}…`,
              },
              sendButton: {
                'aria-label': working ? 'Stop response' : 'Send message',
                disabled:
                  !working &&
                  (!isReady ||
                    sending ||
                    props.disabled ||
                    props.state.status !== 'ready' ||
                    !props.draft.trim()),
              },
            }}
            className="chat-view"
          />
        </ActivityContext.Provider>
      </CopilotChatConfigurationProvider>
    </div>
  );
}

export function mountChat(shadow: ShadowRoot) {
  const styles = document.createElement('style');
  styles.textContent = libraryCss + '\n' + chatCss;
  const target = document.createElement('div');
  target.className = 'chat-root';
  shadow.append(styles, target);
  const stopCopyOnSelect = enableCopyOnSelect(shadow);
  const root = createRoot(target);
  return {
    update: (props: ChatProps) =>
      root.render(
        <CopilotKitProvider
          key={props.connection.url}
          runtimeUrl={props.connection.url}
          headers={{ Authorization: `Bearer ${props.connection.token}` }}
          useSingleEndpoint={false}
          showDevConsole={false}
        >
          <Conversation {...props} />
        </CopilotKitProvider>,
      ),
    dispose: () => {
      stopCopyOnSelect();
      root.unmount();
      styles.remove();
      target.remove();
    },
  };
}
