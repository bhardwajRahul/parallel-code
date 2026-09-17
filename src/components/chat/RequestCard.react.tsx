/** @jsxImportSource react */
import { useEffect, useRef, useState } from 'react';
import type { ChatRequest } from '../../../electron/shared/agent-chat-types';

export type RespondToRequest = (
  request: ChatRequest,
  decision: 'accept' | 'decline',
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

/**
 * One pending approval or question from the agent, answerable from the keyboard:
 * the card opens on its default choice so Enter alone resolves it.
 */
export function RequestCard({
  request,
  respond,
  agentName,
  autoFocus,
  onResolved,
}: {
  agentName: string;
  request: ChatRequest;
  respond: RespondToRequest;
  /** The user is looking at this chat and this is the request they should answer first. */
  autoFocus: boolean;
  onResolved: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const card = useRef<HTMLElement>(null);
  const preselected = useRef<HTMLButtonElement>(null);
  const allowIsDefault = request.kind === 'approval' && !request.defaultToNo;
  // Open the card on the choice the user most likely wants so Enter alone answers it.
  // Questions have nothing safe to preselect, so they start on their first control.
  useEffect(() => {
    if (!autoFocus) return;
    const active = focusedElement();
    // Never pull the caret out of a half-written message — Enter there means "send
    // my message" — and never re-grab focus this card already holds.
    if (card.current?.contains(active) || holdsUnsentText(active)) return;
    (preselected.current ?? card.current?.querySelector<HTMLElement>('button, input'))?.focus();
  }, [autoFocus]);
  function focusedElement(): Element | null {
    return (card.current?.getRootNode() as DocumentOrShadowRoot | undefined)?.activeElement ?? null;
  }
  async function submit(decision: 'accept' | 'decline') {
    setPending(true);
    setError('');
    try {
      await respond(request, decision, answers);
      // Hand the keyboard back before this card unmounts and drops focus on the body
      // — but the response is an IPC round-trip, so only if the card still holds it.
      if (card.current?.contains(focusedElement())) onResolved();
    } catch (error) {
      setError(String(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      className="chat-request"
      data-default={request.defaultToNo ? 'decline' : 'allow'}
      aria-label={`${agentName} request`}
      ref={card}
    >
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
            placeholder={q.options.length ? 'Or type your own answer' : 'Your answer'}
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
          ref={allowIsDefault ? preselected : undefined}
          className={allowIsDefault ? 'chat-request-default' : undefined}
          disabled={pending || request.questions?.some((q) => !answers[q.id]?.trim())}
          onClick={() => void submit('accept')}
        >
          {request.kind === 'question' ? 'Submit answers' : 'Allow once'}
        </button>
        {request.kind === 'approval' && (
          <button
            ref={request.defaultToNo ? preselected : undefined}
            className={request.defaultToNo ? 'chat-request-default' : undefined}
            disabled={pending}
            onClick={() => void submit('decline')}
          >
            Decline
          </button>
        )}
      </div>
      {request.kind === 'approval' && (
        <p className="chat-request-hint">
          {allowIsDefault ? 'Enter allows once' : 'Enter declines'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
