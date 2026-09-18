/** @jsxImportSource react */
import { createContext, useContext, useEffect, useRef, useState, type ComponentProps } from 'react';
import {
  CopilotChatView,
  CopilotChatAssistantMessage,
  CopilotChatUserMessage,
  type CopilotChatAssistantMessageProps,
  type CopilotChatUserMessageProps,
} from '@copilotkit/react-core/v2';
import type {
  AgentChatState,
  ChatItem,
  ChatImage,
} from '../../../electron/shared/agent-chat-types';
import { useReveal } from './use-reveal.react';

export const TranscriptContext = createContext<{
  state: AgentChatState;
  onReview?: (path?: string) => void;
  onOpenFile?: (path: string) => void;
  onReuse: (text: string, images?: ChatImage[]) => void;
}>({ state: { status: 'ready', items: [], requests: [] }, onReuse: () => {} });

const activityLabels = {
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  declined: 'Declined',
  interrupted: 'Stopped',
};

function ActivityRow({ item }: { item: ChatItem }) {
  const context = useContext(TranscriptContext);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (item.activity?.status === 'failed' && details.current) details.current.open = true;
  }, [item.activity?.status]);
  return (
    <div data-chat-id={item.id}>
      <details className="chat-tool" ref={details} data-status={item.activity?.status}>
        <summary>
          <span className="chat-tool-type">
            {item.activity?.type === 'command'
              ? 'Command'
              : item.activity?.type === 'files'
                ? 'Changes'
                : 'Tool'}
          </span>
          <span className="chat-tool-label" title={item.activity?.label}>
            {item.activity?.label || 'Tool activity'}
          </span>
          <span className="chat-tool-status">
            {item.activity && activityLabels[item.activity.status]}
            {item.activity?.exitCode !== undefined ? ` · exit ${item.activity.exitCode}` : ''}
          </span>
        </summary>
        {item.activity?.files?.map((path) => (
          <div className="chat-file" key={path}>
            <button
              onClick={() => context.onOpenFile?.(path)}
              disabled={!context.onOpenFile}
              title={path}
            >
              {path}
            </button>
            {item.activity?.type === 'files' && context.onReview && (
              <button onClick={() => context.onReview?.(path)}>Review diff</button>
            )}
          </div>
        ))}
        <pre>{item.text || 'No output yet.'}</pre>
      </details>
    </div>
  );
}

function ActivityGroup({ ids }: { ids: string[] }) {
  const { state, onReview } = useContext(TranscriptContext);
  const idSet = new Set(ids);
  const items = state.items.filter((item) => idSet.has(item.id));
  const details = useRef<HTMLDetailsElement>(null);
  const failures = items.filter((item) => item.activity?.status === 'failed').length;
  const running = items.findLast((item) => item.activity?.status === 'running');
  const readFiles = new Set(
    items.flatMap((item) => (item.activity?.type !== 'files' ? (item.activity?.files ?? []) : [])),
  );
  const commands = items.filter((item) => item.activity?.type === 'command').length;
  const files = new Set(
    items.flatMap((item) =>
      item.activity?.type === 'files' && item.activity.status === 'completed'
        ? (item.activity.files ?? [])
        : [],
    ),
  );
  useEffect(() => {
    if (failures && details.current) details.current.open = true;
  }, [failures]);
  return (
    <div className="chat-activity-group">
      <details ref={details}>
        <summary
          className="chat-activity-summary"
          data-status={failures ? 'failed' : running ? 'running' : 'completed'}
        >
          <span>
            {items.length} {items.length === 1 ? 'operation' : 'operations'}
            {readFiles.size > 0 ? ` · ${readFiles.size} files read` : ''}
            {commands > 0 ? ` · ${commands} ${commands === 1 ? 'command' : 'commands'}` : ''}
            {files.size > 0
              ? ` · ${files.size} changed ${files.size === 1 ? 'file' : 'files'}`
              : ''}
          </span>
          {failures > 0 && <strong>{failures} failed</strong>}
          {running && <span className="chat-current-operation">{running.activity?.label}</span>}
        </summary>
        {items.map((item) => (
          <ActivityRow key={item.id} item={item} />
        ))}
      </details>
      {files.size > 0 && onReview && (
        <button className="chat-review" onClick={() => onReview()}>
          Review changes ↗
        </button>
      )}
    </div>
  );
}

const fileLinkOptions: ComponentProps<
  typeof CopilotChatAssistantMessage.MarkdownRenderer
>['remarkRehypeOptions'] = {
  handlers: {
    link(state, node) {
      // Preserve local paths through URL sanitization, which otherwise treats
      // README.md:12 as a scheme and rewrites relative paths as absolute URLs.
      const local =
        node.url &&
        !node.url.startsWith('#') &&
        !node.url.startsWith('//') &&
        (!/^[a-z][a-z0-9+.-]*:/i.test(node.url) || /^[^/:]+\.[^/:]+:\d+(?::\d+)?$/.test(node.url));
      const href = local ? `#parallel-code-file=${encodeURIComponent(node.url)}` : node.url;
      const result = {
        type: 'element' as const,
        tagName: 'a',
        properties: { href, ...(node.title ? { title: node.title } : {}) },
        children: state.all(node),
      };
      state.patch(node, result);
      return state.applyData(node, result);
    },
  },
};

export const AssistantMessage = Object.assign(function AssistantMessage(
  props: CopilotChatAssistantMessageProps,
) {
  const context = useContext(TranscriptContext);
  const last = context.state.items.at(-1);
  const streaming = !!props.isRunning && last?.id === props.message.id;
  const text = useReveal(props.message.content ?? '', streaming);
  if (props.message.toolCalls?.length)
    return <ActivityGroup ids={props.message.toolCalls.map((call) => call.id)} />;
  return (
    <div data-chat-id={props.message.id} className="chat-answer">
      <CopilotChatAssistantMessage
        {...props}
        isRunning={streaming}
        markdownRenderer={{ content: text, remarkRehypeOptions: fileLinkOptions }}
      />
    </div>
  );
}, CopilotChatAssistantMessage);

export const UserMessage = Object.assign(function UserMessage(props: CopilotChatUserMessageProps) {
  const context = useContext(TranscriptContext);
  const item = context.state.items.find((item) => item.id === props.message.id);
  return (
    <div data-chat-id={props.message.id} className="chat-user-turn">
      <span className="chat-speaker">You</span>
      <CopilotChatUserMessage
        {...props}
        additionalToolbarItems={
          <button
            title="Edit this text and send it as a new message; earlier messages stay unchanged"
            onClick={() =>
              context.onReuse(
                typeof props.message.content === 'string' ? props.message.content : '',
                item?.images,
              )
            }
          >
            Use as new prompt
          </button>
        }
      />
      {item?.images?.map((image, index) => (
        <img
          className="chat-image"
          key={index}
          src={`data:${image.mediaType};base64,${image.data}`}
          alt={image.name}
        />
      ))}
    </div>
  );
}, CopilotChatUserMessage);

export function Progress({ state }: { state: AgentChatState }) {
  const [now, setNow] = useState(Date.now());
  const working = state.status === 'working';
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working]);
  const running = state.items.findLast((item) => item.activity?.status === 'running');
  const elapsed = state.startedAt
    ? Math.max(0, Math.floor((now - state.startedAt) / 1000))
    : undefined;
  return (
    <>
      {state.plan?.length ? (
        <details className="chat-plan">
          <summary>
            Plan · {state.plan.filter((step) => step.status === 'completed').length}/
            {state.plan.length} complete
          </summary>
          <ol>
            {state.plan.map((step, index) => (
              <li key={index} data-status={step.status}>
                <span>
                  {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '→' : '○'}
                </span>{' '}
                {step.step}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {(working || state.interrupted) && (
        <div className="chat-progress" role="status">
          <span>
            {state.requests.length
              ? 'Waiting for your input'
              : working
                ? running?.activity?.label || 'Working…'
                : 'Response stopped'}
          </span>
          {working && elapsed !== undefined && (
            <time>
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
            </time>
          )}
        </div>
      )}
    </>
  );
}

export function TranscriptSearch({
  items,
  onJump,
}: {
  items: ChatItem[];
  onJump: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const matches = query.trim()
    ? items.filter((item) =>
        `${item.text} ${item.activity?.label ?? ''}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase().trim()),
      )
    : [];
  return (
    <div className="chat-search">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        Search conversation
      </button>
      {open && (
        <div className="chat-search-panel">
          <input
            autoFocus
            aria-label="Search conversation"
            placeholder="Find in messages and output…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
            }}
          />
          {query.trim() && <span role="status">{matches.length} matching messages</span>}
          <div className="chat-search-results">
            {matches.map((item) => (
              <button key={item.id} onClick={() => onJump(item.id)}>
                <strong>
                  {item.kind === 'user' ? 'You' : item.kind === 'tool' ? 'Activity' : 'Assistant'}
                </strong>{' '}
                {item.text.slice(
                  Math.max(
                    0,
                    item.text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase()) - 40,
                  ),
                  Math.max(
                    0,
                    item.text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase()) - 40,
                  ) + 180,
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Native scrolling keeps the reader in charge while streaming and disclosures resize. */
export function ChatScrollView({
  children,
  inputContainerHeight = 0,
}: ComponentProps<typeof CopilotChatView.ScrollView>) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [latest, setLatest] = useState(true);
  function bottom() {
    if (!scroll.current) return;
    following.current = true;
    scroll.current.scrollTop = scroll.current.scrollHeight;
    setLatest(true);
  }
  useEffect(() => {
    if (!scroll.current || !content.current) return;
    const observer = new ResizeObserver(() => {
      if (following.current) bottom();
      else if (scroll.current)
        setLatest(
          scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 24,
        );
    });
    observer.observe(scroll.current);
    observer.observe(content.current);
    bottom();
    return () => observer.disconnect();
  }, []);
  return (
    <div className="chat-scroll-container">
      <div
        ref={scroll}
        className="chat-scroll"
        onScroll={() => {
          const element = scroll.current;
          if (!element) return;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          following.current = atBottom;
          setLatest(atBottom);
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) following.current = false;
        }}
        onPointerDown={() => {
          following.current = false;
        }}
      >
        <div ref={content}>{children}</div>
      </div>
      {!latest && (
        <button
          className="chat-jump"
          style={{ bottom: inputContainerHeight + 8 }}
          aria-label="Jump to latest message"
          onClick={bottom}
        >
          ↓ Latest
        </button>
      )}
    </div>
  );
}
