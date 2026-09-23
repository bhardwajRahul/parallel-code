import { For, Show, createEffect, createSignal, on } from 'solid-js';
import { getDeepActiveElement } from '../../lib/dom-focus';
import type { ChatDecision, ChatRequest } from '../../../electron/shared/agent-chat-types';

export type RespondToRequest = (
  request: ChatRequest,
  decision: ChatDecision,
  answers: Record<string, string>,
) => Promise<void>;

/**
 * Whether the user has words in flight here. Focusing the composer is how the app
 * hands a chat panel the keyboard, so a focused *empty* composer means "waiting",
 * not "typing" — only unsent text is worth protecting the caret for.
 */
const holdsUnsentText = (node: Element | null): boolean => {
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement)
    return node.value.trim() !== '';
  return node instanceof HTMLElement && node.isContentEditable && !!node.textContent?.trim();
};

const modalOpen = () => !!document.querySelector('[aria-modal="true"]');

/**
 * One pending approval or question from the agent, answerable from the keyboard:
 * the card opens on its default choice so Enter alone resolves it.
 */
export function RequestCard(props: {
  agentName: string;
  request: ChatRequest;
  respond: RespondToRequest;
  /** The user is looking at this chat and this is the request they should answer first. */
  autoFocus: boolean;
  onResolved: () => void;
}) {
  const [answers, setAnswers] = createSignal<Record<string, string>>({});
  const [selectedOptions, setSelectedOptions] = createSignal<Record<string, string[]>>({});
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal('');
  let card: HTMLElement | undefined;
  let preselected: HTMLButtonElement | undefined;
  const allowIsDefault = () => props.request.kind === 'approval' && !props.request.defaultToNo;
  // Only an approval can be remembered; an answer to a question is not a permission.
  const canRemember = () =>
    props.request.kind === 'approval' && props.request.canAlwaysAllow === true;
  // Open the card on the choice the user most likely wants so Enter alone answers it.
  // Questions have nothing safe to preselect, so they start on their first control.
  createEffect(
    on(
      () => props.autoFocus,
      (autoFocus) => {
        if (!autoFocus || modalOpen()) return;
        const active = getDeepActiveElement();
        // Focus elsewhere in the app (a dialog, another panel) belongs to that place.
        if (active && active !== document.body && !card?.closest('.chat-ui')?.contains(active))
          return;
        // Never pull the caret out of a half-written message — Enter there means "send
        // my message" — and never re-grab focus this card already holds.
        if (card?.contains(active) || holdsUnsentText(active)) return;
        (preselected ?? card?.querySelector<HTMLElement>('button, input'))?.focus();
      },
    ),
  );
  async function submit(decision: ChatDecision) {
    if (pending()) return;
    const element = card;
    const heldFocus = !!element?.contains(getDeepActiveElement());
    setPending(true);
    setError('');
    try {
      await props.respond(props.request, decision, answers());
      // The state notification may remove the card before the IPC response arrives,
      // which leaves focus on the body rather than on anything the user chose.
      const active = getDeepActiveElement();
      if (
        heldFocus &&
        !modalOpen() &&
        (element?.contains(active) || active === document.body || active === null)
      )
        props.onResolved();
    } catch (error) {
      setError(String(error));
    } finally {
      setPending(false);
    }
  }
  const pick = (id: string, label: string, multiSelect?: boolean) => {
    if (!multiSelect) {
      setAnswers({ ...answers(), [id]: label });
      return;
    }
    const previous = selectedOptions()[id] ?? [];
    const next = previous.includes(label)
      ? previous.filter((entry) => entry !== label)
      : [...previous, label];
    setSelectedOptions({ ...selectedOptions(), [id]: next });
    setAnswers({ ...answers(), [id]: next.join(', ') });
  };
  return (
    <section
      class="chat-request"
      data-default={props.request.defaultToNo ? 'decline' : 'allow'}
      aria-label={`${props.agentName} request`}
      ref={card}
    >
      <strong>
        {props.request.kind === 'question'
          ? `${props.agentName} needs your input`
          : // Naming the action still has to read as a gate, not as a status line.
            `Approval needed${props.request.action ? `: ${props.request.action}` : ''}`}
      </strong>
      <Show when={props.request.kind === 'approval'}>
        <p class="chat-request-text">{props.request.text}</p>
        <Show when={props.request.details}>
          <details class="chat-request-details">
            <summary>Details</summary>
            <pre>{props.request.details}</pre>
          </details>
        </Show>
      </Show>
      <For each={props.request.questions}>
        {(q) => (
          <label>
            {q.question}
            <div class="chat-options">
              <For each={q.options}>
                {(option) => (
                  <button
                    title={option.description}
                    disabled={pending()}
                    aria-pressed={
                      q.multiSelect
                        ? (selectedOptions()[q.id]?.includes(option.label) ?? false)
                        : answers()[q.id] === option.label
                    }
                    onClick={() => pick(q.id, option.label, q.multiSelect)}
                  >
                    {option.label}
                  </button>
                )}
              </For>
            </div>
            <input
              aria-label={q.question}
              placeholder={q.options.length ? 'Or type your own answer' : 'Your answer'}
              type={q.isSecret ? 'password' : 'text'}
              value={answers()[q.id] ?? ''}
              onInput={(event) => {
                setAnswers({ ...answers(), [q.id]: event.currentTarget.value });
                setSelectedOptions({ ...selectedOptions(), [q.id]: [] });
              }}
            />
          </label>
        )}
      </For>
      <div class="chat-options">
        <button
          ref={(element) => {
            if (allowIsDefault()) preselected = element;
          }}
          class={allowIsDefault() ? 'chat-request-default' : undefined}
          disabled={pending() || props.request.questions?.some((q) => !answers()[q.id]?.trim())}
          onClick={() => void submit('accept')}
        >
          {props.request.kind === 'question' ? 'Submit answers' : 'Allow once'}
        </button>
        <Show when={canRemember()}>
          <button
            disabled={pending()}
            title={props.request.alwaysAllowNote}
            onClick={() => void submit('accept-always')}
          >
            Always allow
          </button>
        </Show>
        <Show when={props.request.kind === 'approval'}>
          <button
            ref={(element) => {
              if (props.request.defaultToNo) preselected = element;
            }}
            class={props.request.defaultToNo ? 'chat-request-default' : undefined}
            disabled={pending()}
            onClick={() => void submit('decline')}
          >
            Decline
          </button>
        </Show>
      </div>
      <Show when={canRemember() && props.request.alwaysAllowNote}>
        {/* Said out loud, not hidden in a tooltip: remembering can outlive the session. */}
        <p class="chat-request-note">Always allow will {props.request.alwaysAllowNote}.</p>
      </Show>
      <Show when={props.request.kind === 'approval'}>
        <p class="chat-request-hint">{allowIsDefault() ? 'Enter allows once' : 'Enter declines'}</p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </section>
  );
}
