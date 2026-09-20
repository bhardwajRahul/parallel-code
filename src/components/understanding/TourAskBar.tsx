import { Show, createSignal } from 'solid-js';
import { CloseIcon, LayersIcon } from '../icons';
import { TourIconButton } from './TourIconButton';

/** Ask input and Go deeper action; the result replaces the current branch. */
export function TourAskBar(props: {
  disabled: boolean;
  asking: boolean;
  onAsk: (question: string) => void;
  onGoDeeper: () => void;
  /** Aborts the follow-up request in flight. */
  onCancel: () => void;
}) {
  const [question, setQuestion] = createSignal('');

  function submit(): void {
    const text = question().trim();
    if (!text) return;
    setQuestion('');
    props.onAsk(text);
  }

  return (
    <div class="understanding-ask">
      <input
        type="text"
        class="understanding-ask-input"
        placeholder="Ask about this card…"
        aria-label="Ask about this card"
        value={question()}
        disabled={props.disabled}
        onInput={(event) => setQuestion(event.currentTarget.value)}
        // Arrow keys move the caret here; the dialog must not navigate cards, and
        // Escape only lets go of the field. Native, not delegated: a delegated
        // handler runs on document, too late to stop the dialog's Escape listener.
        on:keydown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') event.currentTarget.blur();
          if (event.key !== 'Enter') return;
          event.preventDefault();
          submit();
        }}
        on:keyup={(event) => event.stopPropagation()}
      />
      <Show
        when={props.asking}
        fallback={
          <TourIconButton
            label="Go deeper"
            tooltip="Go deeper"
            disabled={props.disabled}
            onClick={() => props.onGoDeeper()}
          >
            <LayersIcon size={15} />
          </TourIconButton>
        }
      >
        {/* The spinner carries the wait; the wording is for screen readers only. */}
        <span role="status" class="understanding-asking">
          <span class="inline-spinner" aria-hidden="true" />
          <span class="dialog-sr-only">Thinking…</span>
        </span>
        <TourIconButton label="Cancel question" tooltip="Cancel" onClick={() => props.onCancel()}>
          <CloseIcon size={14} />
        </TourIconButton>
      </Show>
    </div>
  );
}
