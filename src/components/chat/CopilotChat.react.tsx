/** @jsxImportSource react */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CopilotKitProvider,
  CopilotChatView,
  CopilotChatConfigurationProvider,
  useAgent,
} from '@copilotkit/react-core/v2';
import type { Message } from '@ag-ui/core';
import { HttpAgent } from '@ag-ui/client';
import {
  reasoningEffortLabel,
  selectedChatModel,
  effectiveReasoningEffort,
  type ChatConnection,
} from '../../../electron/shared/chat-messages';
import {
  validateChatImages,
  type ChatImage,
  type AgentChatState,
  type ChatPermissionMode,
  CHAT_PERMISSION_MODES,
  isChatPermissionMode,
} from '../../../electron/shared/agent-chat-types';
import libraryCss from '@copilotkit/react-core/v2/styles.css?inline';
import chatCss from './chat.css?inline';
import {
  ChatScrollView,
  AssistantMessage,
  UserMessage,
  TranscriptContext,
  TranscriptSearch,
  Progress,
} from './Transcript.react';
import { ChatContext, readChatImages } from './ChatContext.react';
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
  onReview?: (path?: string) => void;
  onOpenFile?: (path: string) => void;
  onListFiles?: () => Promise<string[]>;
  /** Path to reference for a dropped file — worktree-relative when inside it — or
   *  undefined when it has no path on disk, such as an image dragged from a browser. */
  dropPathFor?: (file: File) => string | undefined;
  permissionMode?: string;
  permissionsDisabled?: boolean;
  onPermissionMode?: (mode: ChatPermissionMode) => Promise<void>;
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

interface ComposerMemory {
  images: ChatImage[];
  files: string[];
  queue: { id: string; text: string; images: ChatImage[] }[];
}

function Conversation(props: ChatProps & { drafts: Map<string, ComposerMemory> }) {
  const draftKey = `${props.agentName}:${props.state.threadId ?? ''}`;
  const saved = props.drafts.get(draftKey);
  const { agent, isReady } = useAgent({
    agentId: 'conversation',
    runtimeAgentId: 'default',
    threadId: props.state.threadId ?? '',
  });
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [images, setImages] = useState<ChatImage[]>(saved?.images ?? []);
  const [files, setFiles] = useState<string[]>(saved?.files ?? []);
  // Where the `@` that opened the file search sits in the draft, and the files before it.
  const [picker, setPicker] = useState<{ at: number; files: string[] } | null>(null);
  const caretAfterPick = useRef<number | null>(null);
  const [readingImages, setReadingImages] = useState(false);
  const [queue, setQueue] = useState<{ id: string; text: string; images: ChatImage[] }[]>(
    saved?.queue ?? [],
  );
  const [queuePaused, setQueuePaused] = useState(!!saved?.queue.length);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [permissionPending, setPermissionPending] = useState(false);
  const transportDone = useRef<Promise<void>>(Promise.resolve());
  const [error, setError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const request = useRef<AbortController | undefined>(undefined);
  const cleanupSubmit = useRef(false);
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    props.drafts.set(draftKey, { images, files, queue });
  }, [props.drafts, draftKey, images, files, queue]);
  useLayoutEffect(() => {
    const caret = caretAfterPick.current;
    if (caret === null) return;
    caretAfterPick.current = null;
    container.current?.querySelector('textarea')?.setSelectionRange(caret, caret);
  }, [props.draft]);
  const working = props.state.status === 'working';
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      void agent.detachActiveRun();
    };
  }, [agent]);

  async function deliver(text: string, attached: ChatImage[] = []): Promise<void> {
    await transportDone.current;
    if (!mounted.current) throw new Error('Conversation closed.');
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
      transportDone.current = agent
        .runAgent({ abortController: controller, forwardedProps: { images: attached } })
        .then(() => {}, reject)
        .finally(() => {
          sub.unsubscribe();
          if (request.current === controller) request.current = undefined;
          if (!accepted)
            reject(new Error('The message could not be confirmed. Reconnect before retrying.'));
        });
    });
  }
  async function transmit(text: string, attached: ChatImage[]): Promise<boolean> {
    if (
      !isReady ||
      sendingRef.current ||
      stoppingRef.current ||
      current.current.disabled ||
      current.current.state.status !== 'ready'
    )
      return false;
    sendingRef.current = true;
    setSending(true);
    setError('');
    try {
      await current.current.onSend(text, (value) => deliver(value, attached));
      return true;
    } catch (error) {
      if (mounted.current) {
        setError(String(error));
        setQueuePaused(true);
      }
      return false;
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  }
  function composedText(text: string) {
    return (
      [
        text.trim(),
        files.length
          ? `Referenced files:\n${files.map((file) => JSON.stringify(file)).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n') || 'Please examine the attached images.'
    );
  }
  function clearDraft(draft: string) {
    if (current.current.draft === draft) current.current.onDraft('');
    setImages((current) => (current === images ? [] : current));
    setFiles((current) => (current === files ? [] : current));
  }
  async function send(text = current.current.draft) {
    if (
      readingImages ||
      sendingRef.current ||
      stoppingRef.current ||
      current.current.disabled ||
      (!text.trim() && !images.length && !files.length)
    )
      return;
    const message = composedText(text);
    if (message.length > 100_000) {
      setError('Enter a message of at most 100,000 characters.');
      return;
    }
    if (current.current.state.status === 'working') {
      setQueue((entries) => [...entries, { id: crypto.randomUUID(), text: message, images }]);
      clearDraft(text);
      return;
    }
    if (await transmit(message, images)) clearDraft(text);
  }
  useEffect(() => {
    if (
      props.state.status !== 'ready' ||
      props.state.requests.length ||
      props.state.error ||
      props.disabled ||
      queuePaused ||
      stopping ||
      sending ||
      !queue.length
    )
      return;
    const next = queue[0];
    void transmit(next.text, next.images).then((accepted) => {
      if (accepted && mounted.current)
        setQueue((entries) => entries.filter((entry) => entry.id !== next.id));
    });
  }, [
    props.state.status,
    props.state.requests.length,
    props.state.error,
    props.disabled,
    queue,
    queuePaused,
    stopping,
    sending,
    isReady,
  ]);
  async function stop(interruptAndSend = false) {
    if (stoppingRef.current) return;
    const draft = current.current.draft;
    const message = composedText(draft);
    if (interruptAndSend && message.length > 100_000) {
      setError('Enter a message of at most 100,000 characters.');
      return;
    }
    stoppingRef.current = true;
    setStopping(true);
    setQueuePaused(true);
    setError('');
    try {
      await current.current.onStop();
      if (!mounted.current) return;
      if (interruptAndSend) {
        setQueue((entries) => [{ id: crypto.randomUUID(), text: message, images }, ...entries]);
        clearDraft(draft);
        setQueuePaused(false);
      }
    } catch (error) {
      setError(String(error));
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  }
  async function addImages(selected: File[]) {
    if (readingImages || sendingRef.current || stoppingRef.current || props.disabled) return;
    setReadingImages(true);
    setError('');
    try {
      const added = await readChatImages(selected);
      setImages(validateChatImages([...images, ...added]));
    } catch (error) {
      setError(String(error));
    } finally {
      setReadingImages(false);
    }
  }
  // Images attach inline; other files are referenced by path, so they need one on disk.
  function addDropped(dropped: File[]) {
    if (sendingRef.current || stoppingRef.current || props.disabled) return;
    const others = dropped
      .filter((file) => !file.type.startsWith('image/'))
      .map((file) => ({ name: file.name, path: props.dropPathFor?.(file) }));
    const paths = others.flatMap((file) => file.path ?? []);
    const rejected = others.filter((file) => !file.path);
    if (paths.length) setFiles((current) => [...new Set([...current, ...paths])]);
    const pictures = dropped.filter((file) => file.type.startsWith('image/'));
    if (pictures.length) void addImages(pictures);
    if (rejected.length)
      setError(
        `No file on disk for: ${rejected.map((file) => file.name).join(', ')}. Save it first, then drop the saved file.`,
      );
  }
  // `@` at a word start opens the file search. The `@` stays typed until a file is
  // chosen, so a literal mention such as `@Component` costs only an Escape.
  function openFilePicker(event: FormEvent<HTMLTextAreaElement>) {
    const input = event.currentTarget;
    const at = input.selectionStart - 1;
    if (
      !props.onListFiles ||
      !(event.nativeEvent instanceof InputEvent) ||
      event.nativeEvent.data !== '@' ||
      /\S/.test(input.value[at - 1] ?? '')
    )
      return;
    setPicker({ at, files });
  }
  function closeFilePicker() {
    if (!picker) return;
    const draft = current.current.draft;
    const chosen = files.some((file) => !picker.files.includes(file));
    const removed = chosen && draft[picker.at] === '@';
    if (removed) current.current.onDraft(draft.slice(0, picker.at) + draft.slice(picker.at + 1));
    setPicker(null);
    const textarea = container.current?.querySelector('textarea');
    textarea?.focus();
    // A new draft value moves the caret to the end, so wait for it to commit.
    if (removed) caretAfterPick.current = picker.at;
    else textarea?.setSelectionRange(picker.at + 1, picker.at + 1);
  }
  function reuse(text: string, attached: ChatImage[] = []) {
    if (
      current.current.draft.trim() &&
      !window.confirm('Replace the unsent draft with this prompt?')
    )
      return false;
    current.current.onDraft(text);
    setImages(attached);
    setFiles([]);
    container.current?.querySelector('textarea')?.focus();
    return true;
  }
  function jump(id: string) {
    const element = Array.from(
      container.current?.querySelectorAll<HTMLElement>('[data-chat-id]') ?? [],
    ).find((element) => element.dataset.chatId === id);
    if (!element) return;
    let ancestor: HTMLElement | null = element;
    while (ancestor) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    element.querySelectorAll('details').forEach((details) => {
      details.open = true;
    });
    element.scrollIntoView({ block: 'center' });
    element.tabIndex = -1;
    element.focus({ preventScroll: true });
  }
  useEffect(() => {
    props.onActions({
      focus: () => container.current?.querySelector('textarea')?.focus(),
      send: () => send(),
    });
  });
  return (
    <div
      ref={container}
      className={`chat-ui${props.dark ? ' dark' : ''}`}
      onClick={(event) => {
        const link = event.target instanceof Element ? event.target.closest('a') : null;
        const href = link?.getAttribute('href');
        const fileLink = href?.startsWith('#parallel-code-file=');
        if (
          !props.onOpenFile ||
          !href ||
          (!fileLink &&
            (href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')))
        )
          return;
        event.preventDefault();
        try {
          const target = fileLink
            ? decodeURIComponent(href.slice('#parallel-code-file='.length))
            : href;
          props.onOpenFile(decodeURIComponent(target.split('#')[0]));
        } catch (error) {
          setError(String(error));
        }
      }}
    >
      <div className="chat-toolbar">
        <TranscriptSearch items={props.state.items} onJump={jump} />
        {props.onReview && <button onClick={() => props.onReview?.()}>Review changes ↗</button>}
      </div>
      <CopilotChatConfigurationProvider
        agentId="conversation"
        threadId={props.state.threadId}
        // The composer dock replaces the library's input layout, so its built-in
        // disclaimer slot never renders; .chat-composer-hint carries that line.
        labels={{ welcomeMessageText: 'What would you like to work on?' }}
      >
        <TranscriptContext.Provider
          value={{
            state: props.state,
            onReview: props.onReview,
            onOpenFile: props.onOpenFile,
            onReuse: reuse,
          }}
        >
          <CopilotChatView
            hasExplicitThreadId
            autoScroll="pin-to-bottom"
            scrollView={ChatScrollView}
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
            onStop={() => void stop()}
            messageView={{
              assistantMessage: AssistantMessage,
              userMessage: UserMessage,
              children: ({ messageElements }) => (
                <div className="chat-transcript">
                  {messageElements.length ? (
                    messageElements
                  ) : (
                    <div className="chat-empty">
                      <strong>What would you like to work on?</strong>
                      <p>
                        Describe a change or ask about the code. Type @ or drop files to reference
                        them; paste or drop images.
                      </p>
                    </div>
                  )}
                </div>
              ),
            }}
            input={{
              children: ({ textArea }) => (
                <div className="chat-composer-dock">
                  <Progress state={props.state} />
                  {queue.length > 0 && (
                    <div className="chat-queue" aria-label="Queued messages">
                      <div>
                        {queuePaused || props.state.error
                          ? 'Queue paused'
                          : 'Sends when the agent finishes'}{' '}
                        · {queue.length}
                      </div>
                      {queue.map((entry) => (
                        <div key={entry.id}>
                          <span>{entry.text}</span>
                          <button
                            disabled={sending}
                            onClick={() => {
                              if (!reuse(entry.text)) return;
                              setFiles([]);
                              setImages(entry.images);
                              setQueue((entries) => entries.filter((item) => item.id !== entry.id));
                            }}
                          >
                            Edit
                          </button>
                          <button
                            disabled={sending}
                            aria-label="Remove queued message"
                            onClick={() =>
                              setQueue((entries) => entries.filter((item) => item.id !== entry.id))
                            }
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      {(queuePaused || props.state.error) && (
                        <button
                          disabled={sending || props.disabled || props.state.status !== 'ready'}
                          onClick={() => {
                            setQueuePaused(false);
                            const next = queue[0];
                            void transmit(next.text, next.images).then((accepted) => {
                              if (accepted)
                                setQueue((entries) =>
                                  entries.filter((item) => item.id !== next.id),
                                );
                            });
                          }}
                        >
                          Retry queued message
                        </button>
                      )}
                    </div>
                  )}
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
                      <button
                        data-testid="copilot-send-button"
                        className="chat-send"
                        disabled={
                          !isReady ||
                          sending ||
                          readingImages ||
                          stopping ||
                          props.disabled ||
                          !['ready', 'working'].includes(props.state.status) ||
                          (!props.draft.trim() && !images.length && !files.length)
                        }
                        aria-label={working ? 'Queue message' : 'Send message'}
                        title={working ? 'Queue message' : 'Send message'}
                        onClick={() => void send()}
                      >
                        {working ? 'Queue' : '↑'}
                      </button>
                      {working && (
                        <button
                          className="chat-stop"
                          disabled={stopping}
                          aria-label="Stop response"
                          onClick={() => void stop()}
                        >
                          ■ Stop
                        </button>
                      )}
                    </div>
                    <ChatContext
                      files={files}
                      images={images}
                      disabled={props.disabled || sending || readingImages || stopping}
                      open={!!picker}
                      onFiles={setFiles}
                      onRemoveImage={(index) => setImages(images.filter((_, i) => i !== index))}
                      onClose={closeFilePicker}
                      onListFiles={props.onListFiles}
                    />
                    {readingImages && <div role="status">Reading images…</div>}
                    <div className="chat-composer-settings">
                      <ModelPicker
                        state={props.state}
                        disabled={props.disabled || sending}
                        onSelectModel={props.onSelectModel}
                        onReloadModels={props.onReloadModels}
                      />
                      {props.onPermissionMode && (
                        <select
                          aria-label="Permission mode"
                          value={props.permissionMode ?? ''}
                          disabled={
                            props.permissionsDisabled ||
                            props.disabled ||
                            permissionPending ||
                            props.state.status !== 'ready'
                          }
                          onChange={(event) => {
                            const mode = event.target.value;
                            if (isChatPermissionMode(mode)) {
                              setPermissionPending(true);
                              void props
                                .onPermissionMode?.(mode)
                                .catch((error) => setError(String(error)))
                                .finally(() => setPermissionPending(false));
                            }
                          }}
                        >
                          {!isChatPermissionMode(props.permissionMode) && (
                            <option value={props.permissionMode ?? ''}>
                              {props.permissionMode === 'bypassPermissions'
                                ? 'Skipping permissions'
                                : props.permissionMode || 'Permissions'}
                            </option>
                          )}
                          {CHAT_PERMISSION_MODES.map((mode) => (
                            <option key={mode} value={mode}>
                              {
                                {
                                  default: 'Ask each time',
                                  auto: 'Auto (ask if risky)',
                                  acceptEdits: 'Accept edits',
                                  plan: 'Plan only',
                                }[mode]
                              }
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    {working && (props.draft.trim() || images.length > 0 || files.length > 0) && (
                      <button
                        className="chat-interrupt"
                        disabled={stopping || sending || readingImages || props.disabled}
                        onClick={() => void stop(true)}
                      >
                        Interrupt and send now
                      </button>
                    )}
                  </div>
                  <div className="chat-composer-hint">
                    {working ? 'Enter to queue' : 'Enter to send'} · Shift+Enter for a new line · @
                    for files
                  </div>
                </div>
              ),
              textArea: {
                'aria-label': `Message ${props.agentName}`,
                placeholder: working ? 'Add a follow-up…' : `Message ${props.agentName}…`,
                disabled: props.disabled,
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.stopPropagation();
                    void send();
                  }
                },
                onPaste: (event) => {
                  const pasted = Array.from(event.clipboardData.files);
                  if (pasted.length) {
                    event.preventDefault();
                    void addImages(pasted);
                  }
                },
                onInput: openFilePicker,
                onDragOver: (event) => {
                  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
                },
                onDrop: (event) => {
                  if (event.dataTransfer.files.length) {
                    event.preventDefault();
                    addDropped(Array.from(event.dataTransfer.files));
                  }
                },
              },
            }}
            className="chat-view"
          />
        </TranscriptContext.Provider>
      </CopilotChatConfigurationProvider>
    </div>
  );
}

// Task objects are weak keys, so closing a task also releases its unsent image data.
const composerMemories = new WeakMap<object, Map<string, ComposerMemory>>();

export function mountChat(shadow: ShadowRoot, sessionScope: object = shadow) {
  const drafts = composerMemories.get(sessionScope) ?? new Map<string, ComposerMemory>();
  composerMemories.set(sessionScope, drafts);
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
          enableInspector={false}
        >
          <Conversation key={props.state.threadId} {...props} drafts={drafts} />
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
