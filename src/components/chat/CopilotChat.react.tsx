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
import type { ChatConnection } from '../../../electron/shared/chat-messages';
import type {
  ChatItem,
  ChatRequest,
  AgentChatState,
} from '../../../electron/shared/agent-chat-types';
import libraryCss from '@copilotkit/react-core/v2/styles.css?inline';
import chatCss from './chat.css?inline';
import { useReveal } from './use-reveal.react';

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
  onSelectModel: (model: string, reasoningEffort?: string) => Promise<void>;
  onReloadModels: () => Promise<void>;
  onDraft: (text: string) => void;
  onSend: (text: string, deliver: (text: string) => Promise<void>) => Promise<void>;
  onStop: () => Promise<void>;
  onRespond: (
    request: ChatRequest,
    decision: 'accept' | 'decline',
    answers: Record<string, string>,
  ) => Promise<void>;
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
        {activity && (
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

function RequestCard({
  request,
  respond,
  agentName,
}: {
  agentName: string;
  request: ChatRequest;
  respond: ChatProps['onRespond'];
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(decision: 'accept' | 'decline') {
    setPending(true);
    setError('');
    try {
      await respond(request, decision, answers);
    } catch (error) {
      setError(String(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="chat-request" aria-label={`${agentName} request`}>
      <strong>
        {request.kind === 'question' ? `${agentName} needs your input` : 'Approval needed'}
      </strong>
      {request.kind === 'approval' && <pre>{request.text}</pre>}
      {request.questions?.map((q) => (
        <label key={q.id}>
          {q.question}
          <div className="chat-options">
            {q.options.map((option) => (
              <button
                key={option.label}
                title={option.description}
                disabled={pending}
                aria-pressed={
                  q.multiSelect
                    ? (selectedOptions[q.id]?.includes(option.label) ?? false)
                    : answers[q.id] === option.label
                }
                onClick={() => {
                  if (q.multiSelect) {
                    const previous = selectedOptions[q.id] ?? [];
                    const next = previous.includes(option.label)
                      ? previous.filter((label) => label !== option.label)
                      : [...previous, option.label];
                    setSelectedOptions({ ...selectedOptions, [q.id]: next });
                    setAnswers({ ...answers, [q.id]: next.join(', ') });
                  } else setAnswers({ ...answers, [q.id]: option.label });
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <input
            aria-label={q.question}
            type={q.isSecret ? 'password' : 'text'}
            value={answers[q.id] ?? ''}
            onChange={(e) => {
              setAnswers({ ...answers, [q.id]: e.target.value });
              setSelectedOptions({ ...selectedOptions, [q.id]: [] });
            }}
          />
        </label>
      ))}
      <div className="chat-options">
        <button
          disabled={pending || request.questions?.some((q) => !answers[q.id]?.trim())}
          onClick={() => void submit('accept')}
        >
          {request.kind === 'question' ? 'Submit answers' : 'Allow once'}
        </button>
        {request.kind === 'approval' && (
          <button disabled={pending} onClick={() => void submit('decline')}>
            Decline
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function ModelPicker({
  state,
  disabled,
  onSelectModel,
  onReloadModels,
}: Pick<ChatProps, 'state' | 'disabled' | 'onSelectModel' | 'onReloadModels'>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const models = state.models ?? [];
  const selected = models.find((model) => model.model === state.model);
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
      <div className="chat-model-selectors">
        <label>
          <span>Model</span>
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
        </label>
        <label>
          <span>Reasoning</span>
          <select
            aria-label="Reasoning effort"
            title={
              !selected
                ? 'Select a model to see its reasoning levels'
                : !efforts.length
                  ? 'This model does not offer adjustable reasoning'
                  : 'Reasoning level for the next message'
            }
            value={state.reasoningEffort ?? selected?.defaultReasoningEffort ?? ''}
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
                    {option.reasoningEffort.charAt(0).toUpperCase() +
                      option.reasoningEffort.slice(1)}
                  </option>
                ))}
              </>
            )}
          </select>
        </label>
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
  const active = useRef(true);
  const request = useRef<AbortController | undefined>(undefined);
  const cleanupSubmit = useRef(false);
  const current = useRef(props);
  current.current = props;
  const working = props.state.status === 'working';
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
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
      if (active.current) setError(String(error));
    } finally {
      if (active.current) setSending(false);
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
                      {props.state.requests.map((request) => (
                        <RequestCard
                          key={`${typeof request.id}:${request.id}`}
                          request={request}
                          agentName={props.agentName}
                          respond={props.onRespond}
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
                    {textArea}
                    {sendButton}
                  </div>
                  <ModelPicker
                    state={props.state}
                    disabled={props.disabled || sending}
                    onSelectModel={props.onSelectModel}
                    onReloadModels={props.onReloadModels}
                  />
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
      root.unmount();
      styles.remove();
      target.remove();
    },
  };
}
