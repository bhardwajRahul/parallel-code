import { Show, type JSX } from 'solid-js';
import type { UnderstandingTourState } from '../../lib/create-understanding-tour';
import type { UnderstandingTourKind } from '../../lib/understanding-tour';
import { HoverHint } from './HoverHint';
import { askCodeModelLabel } from './ask-code-label';

const HEADINGS: Record<UnderstandingTourKind, string> = {
  plan: 'Guided tour of this document',
  file: 'Guided tour of this file',
  agent: 'Tour from the agent',
};

export interface TourHintText {
  heading: string;
  body: string;
  action: string;
}

/** What pressing the button does right now, for a reader who has never taken a tour. */
export function tourHintText(input: {
  kind: UnderstandingTourKind;
  subject: string;
  loading: boolean;
  ready: boolean;
  error: string;
  receiving: boolean;
  elapsedSeconds: number;
}): TourHintText {
  const heading = HEADINGS[input.kind];
  if (input.loading)
    return {
      heading,
      body: `Generating… ${input.receiving ? 'Receiving response' : 'Waiting for provider'} · ${input.elapsedSeconds}s`,
      action: 'Click to cancel.',
    };
  if (input.ready) return { heading, body: 'The tour is ready.', action: 'Click to open it.' };
  if (input.error) return { heading, body: input.error, action: 'Click to retry.' };
  if (input.kind === 'agent')
    return {
      heading,
      body: `Cards the agent wrote to explain ${input.subject}.`,
      action: 'Click to open it.',
    };
  return {
    heading,
    body:
      input.kind === 'plan'
        ? 'A handful of cards on what this document proposes: the gist, the key decisions, trade-offs and risks. About a minute of reading.'
        : 'A handful of cards on what this file is, how it works and what to watch out for. It reads the file and its direct imports.',
    action: 'Generates in the background; a notification tells you when it is ready.',
  };
}

/**
 * Hover and focus popover for a tour button: names the file the tour is about
 * and what the button does in its current state. Wraps the control; the child
 * renders the button and gives it `aria-describedby={describedBy()}`.
 */
export function TourHint(props: {
  kind: UnderstandingTourKind;
  subject: string;
  tour?: UnderstandingTourState;
  /** Extra class on the wrapper, for callers that position the control through it. */
  class?: string;
  children: (describedBy: () => string | undefined) => JSX.Element;
}) {
  const text = () =>
    tourHintText({
      kind: props.kind,
      subject: props.subject,
      loading: props.tour?.isLoading(props.kind, props.subject) ?? false,
      ready: props.tour?.isReady(props.kind, props.subject) ?? false,
      error: props.tour?.errorFor?.(props.kind, props.subject) ?? '',
      receiving: props.tour?.receiving?.() ?? false,
      elapsedSeconds: props.tour?.elapsedSeconds?.() ?? 0,
    });
  const idle = () => text().action.startsWith('Generates');

  return (
    <HoverHint
      class={props.class}
      hint={() => (
        <>
          <strong class="tour-hint-heading">{text().heading}</strong>
          <code class="tour-hint-subject" title={props.subject}>
            {props.subject}
          </code>
          <p class="tour-hint-body">{text().body}</p>
          <p class="tour-hint-action">{text().action}</p>
          <Show when={idle()}>
            <p class="tour-hint-action">Uses: {askCodeModelLabel()}</p>
          </Show>
        </>
      )}
    >
      {props.children}
    </HoverHint>
  );
}
