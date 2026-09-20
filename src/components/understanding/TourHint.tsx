import { Show, createSignal, createUniqueId, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  createAnchorEffect,
  createHeldSignal,
  placeBelow,
  type BelowAnchor,
} from '../../lib/floating';
import type { UnderstandingTourState } from '../../lib/create-understanding-tour';
import type { UnderstandingTourKind } from '../../lib/understanding-tour';
import { askCodeModelLabel } from './ask-code-label';

const HINT_WIDTH = 300;
/** Room the hint needs; placeBelow flips it above the control when the foot is close. */
const HINT_HEIGHT = 200;

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
  const id = createUniqueId();
  const held = createHeldSignal<boolean>(150);
  const open = () => !!held.value();
  const [position, setPosition] = createSignal<BelowAnchor>({ top: 0, right: 0, maxHeight: 0 });
  let anchor: HTMLDivElement | undefined;

  createAnchorEffect(open, () => {
    if (!anchor) return;
    setPosition(
      placeBelow(
        anchor.getBoundingClientRect(),
        Math.min(HINT_WIDTH, window.innerWidth - 24),
        { width: window.innerWidth, height: window.innerHeight },
        12,
        HINT_HEIGHT,
      ),
    );
  });

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
    <>
      <div
        ref={anchor}
        class={props.class ? `tour-hint-anchor ${props.class}` : 'tour-hint-anchor'}
        onMouseEnter={() => held.set(true)}
        onMouseLeave={() => {
          if (!anchor?.contains(document.activeElement)) held.clear();
        }}
        onFocusIn={() => held.set(true)}
        onFocusOut={(event) => {
          if (!(event.relatedTarget instanceof Node) || !anchor?.contains(event.relatedTarget))
            held.set(false);
        }}
      >
        {props.children(() => (open() ? id : undefined))}
      </div>
      <Show when={open()}>
        <Portal>
          <div
            id={id}
            role="tooltip"
            class="tour-hint"
            style={{
              top: `${position().top}px`,
              right: `${position().right}px`,
              width: `${HINT_WIDTH}px`,
            }}
          >
            <strong class="tour-hint-heading">{text().heading}</strong>
            <code class="tour-hint-subject" title={props.subject}>
              {props.subject}
            </code>
            <p class="tour-hint-body">{text().body}</p>
            <p class="tour-hint-action">{text().action}</p>
            <Show when={idle()}>
              <p class="tour-hint-action">Uses: {askCodeModelLabel()}</p>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
}
