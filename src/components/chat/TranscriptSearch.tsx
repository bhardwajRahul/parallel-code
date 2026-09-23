import { For, Show, createMemo, createSignal } from 'solid-js';
import type { ChatItem } from '../../../electron/shared/agent-chat-types';

const speakers = { user: 'You', tool: 'Activity', assistant: 'Assistant' };

/** Everything an entry shows, including what a collapsed row hides: a command
 *  and its output, the files it touched and the lines an edit changed. */
function searchable(item: ChatItem): string {
  const activity = item.activity;
  return [
    activity?.command ?? activity?.label,
    item.text,
    ...(activity?.files ?? []),
    ...(activity?.diffs ?? []).flatMap((diff) => [diff.path, diff.diff]),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Finds text in messages and tool output, including what collapsed activity hides. */
export function TranscriptSearch(props: { items: ChatItem[]; onJump: (id: string) => void }) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const needle = () => query().trim().toLocaleLowerCase();
  const matches = createMemo(() => {
    const wanted = needle();
    if (!wanted) return [];
    return props.items.flatMap((item) => {
      const text = searchable(item);
      return text.toLocaleLowerCase().includes(wanted) ? [{ item, text }] : [];
    });
  });
  const excerpt = (text: string) => {
    const start = Math.max(0, text.toLocaleLowerCase().indexOf(needle()) - 40);
    return text.slice(start, start + 180);
  };
  return (
    <div class="chat-search">
      <button aria-expanded={open()} onClick={() => setOpen(!open())}>
        Search conversation
      </button>
      <Show when={open()}>
        <div class="chat-search-panel">
          <input
            ref={(element) => queueMicrotask(() => element.focus())}
            aria-label="Search conversation"
            placeholder="Find in messages and output…"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
            }}
          />
          <Show when={needle()}>
            <span role="status">{matches().length} matching messages</span>
          </Show>
          <div class="chat-search-results">
            <For each={matches()}>
              {(match) => (
                <button onClick={() => props.onJump(match.item.id)}>
                  <strong>{speakers[match.item.kind]}</strong> {excerpt(match.text)}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
