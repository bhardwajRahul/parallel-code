import { For, Match, Show, Switch, createEffect, createMemo, on } from 'solid-js';
import type { ChatItem } from '../../../electron/shared/agent-chat-types';
import { DiffStat, DiffView } from './DiffView';

const activityLabels = {
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  declined: 'Declined',
  interrupted: 'Stopped',
};

const typeLabels = { command: 'Command', files: 'Changes', tool: 'Tool' };

export interface ActivityActions {
  onReview?: (path?: string) => void;
  onOpenFile?: (path: string) => void;
}

/** A command line above its output, as a terminal shows it. */
function CommandOutput(props: { command: string; output: string; running: boolean }) {
  return (
    <pre class="chat-command">
      <span class="chat-command-line">$ {props.command}</span>
      {'\n'}
      {props.output || (props.running ? 'No output yet.' : 'No output.')}
    </pre>
  );
}

function ActivityRow(props: ActivityActions & { item: ChatItem }) {
  let details: HTMLDetailsElement | undefined;
  const activity = () => props.item.activity;
  const stats = createMemo(() => totalStats([props.item]));
  createEffect(() => {
    if (activity()?.status === 'failed' && details) details.open = true;
  });
  return (
    <div data-chat-id={props.item.id}>
      <details
        class="chat-tool"
        // Edits are what the reader came for; reads and commands stay one line.
        ref={(element) => {
          details = element;
          element.open = !!activity()?.diffs?.length;
        }}
        data-status={activity()?.status}
      >
        <summary>
          <span class="chat-tool-type">{typeLabels[activity()?.type ?? 'tool']}</span>
          <span class="chat-tool-label" title={activity()?.label}>
            {activity()?.label || 'Tool activity'}
          </span>
          <Show when={stats()}>{(total) => <DiffStat {...total()} />}</Show>
          <span class="chat-tool-status">
            {activity() && activityLabels[activity()?.status ?? 'running']}
            {activity()?.exitCode !== undefined ? ` · exit ${activity()?.exitCode}` : ''}
          </span>
        </summary>
        <Switch
          fallback={
            <>
              <For each={activity()?.files}>
                {(path) => (
                  <div class="chat-file">
                    <button
                      onClick={() => props.onOpenFile?.(path)}
                      disabled={!props.onOpenFile}
                      title={path}
                    >
                      {path}
                    </button>
                    <Show when={activity()?.type === 'files' && props.onReview}>
                      <button onClick={() => props.onReview?.(path)}>Review diff</button>
                    </Show>
                  </div>
                )}
              </For>
              <pre>{props.item.text || 'No output yet.'}</pre>
            </>
          }
        >
          <Match when={activity()?.command}>
            {(command) => (
              <CommandOutput
                command={command()}
                output={props.item.text}
                running={activity()?.status === 'running'}
              />
            )}
          </Match>
          <Match when={activity()?.diffs?.length}>
            <For each={activity()?.diffs}>
              {(diff) => (
                <DiffView
                  diff={diff}
                  applied={activity()?.status === 'completed'}
                  onReview={props.onReview}
                  onOpenFile={props.onOpenFile}
                />
              )}
            </For>
            <Show when={props.item.text}>
              <pre>{props.item.text}</pre>
            </Show>
          </Match>
        </Switch>
      </details>
    </div>
  );
}

/** Lines added and removed across the applied and running edits in `items`, if any. */
function totalStats(items: ChatItem[]) {
  const diffs = items.flatMap((item) =>
    item.activity?.status === 'completed' || item.activity?.status === 'running'
      ? (item.activity.diffs ?? [])
      : [],
  );
  if (!diffs.length) return undefined;
  return diffs.reduce(
    (total, diff) => ({ added: total.added + diff.added, removed: total.removed + diff.removed }),
    { added: 0, removed: 0 },
  );
}

/** One run of consecutive tool calls, folded into a summary line. */
export function ActivityGroup(props: ActivityActions & { items: ChatItem[] }) {
  let details: HTMLDetailsElement | undefined;
  const failures = () => props.items.filter((item) => item.activity?.status === 'failed').length;
  const running = () => props.items.findLast((item) => item.activity?.status === 'running');
  const summary = createMemo(() => {
    const readFiles = new Set(
      props.items.flatMap((item) =>
        item.activity?.type !== 'files' ? (item.activity?.files ?? []) : [],
      ),
    );
    const commands = props.items.filter((item) => item.activity?.type === 'command').length;
    const changed = new Set(
      props.items.flatMap((item) =>
        item.activity?.type === 'files' && item.activity.status === 'completed'
          ? (item.activity.files ?? [])
          : [],
      ),
    );
    const count = props.items.length;
    return {
      changed: changed.size,
      text:
        `${count} ${count === 1 ? 'operation' : 'operations'}` +
        (readFiles.size ? ` · ${readFiles.size} files read` : '') +
        (commands ? ` · ${commands} ${commands === 1 ? 'command' : 'commands'}` : '') +
        (changed.size ? ` · ${changed.size} changed ${changed.size === 1 ? 'file' : 'files'}` : ''),
    };
  });
  const stats = createMemo(() => totalStats(props.items));
  createEffect(() => {
    if (failures() && details) details.open = true;
  });
  // Opens once, when the first edit arrives, so the change shows without a click;
  // closing it afterwards is the reader's choice and sticks. Any edit counts, so a
  // declined one does not re-arm the opening for the next.
  // A memo, because `on` re-runs whenever the items change, not when the answer does.
  const edited = createMemo(() => props.items.some((item) => item.activity?.diffs?.length));
  createEffect(
    on(edited, (hasEdits) => {
      if (hasEdits && details) details.open = true;
    }),
  );
  return (
    <div class="chat-activity-group">
      <details ref={details}>
        <summary
          class="chat-activity-summary"
          data-status={failures() ? 'failed' : running() ? 'running' : 'completed'}
        >
          <span>{summary().text}</span>
          <Show when={stats()}>{(total) => <DiffStat {...total()} />}</Show>
          <Show when={failures()}>
            <strong>{failures()} failed</strong>
          </Show>
          <Show when={running()}>
            {(item) => <span class="chat-current-operation">{item().activity?.label}</span>}
          </Show>
        </summary>
        <For each={props.items}>
          {(item) => (
            <ActivityRow item={item} onReview={props.onReview} onOpenFile={props.onOpenFile} />
          )}
        </For>
      </details>
      <Show when={summary().changed > 0 && props.onReview}>
        <button class="chat-review" onClick={() => props.onReview?.()}>
          Review changes ↗
        </button>
      </Show>
    </div>
  );
}
