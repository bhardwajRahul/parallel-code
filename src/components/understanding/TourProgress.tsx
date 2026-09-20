import { For } from 'solid-js';

/** Which part of the spine a segment stands for; drives its fill. */
function segmentState(index: number, current: number): 'seen' | 'current' | 'rest' {
  if (index === current) return 'current';
  return index < current ? 'seen' : 'rest';
}

/**
 * The only chrome above the card: what the tour is about, a hairline bar for
 * where you are in it and "n / m".
 *
 * @param current zero-based index into the spine
 */
export function TourProgress(props: {
  /** Mono path or title the tour is about. */
  subject: string;
  total: number;
  current: number;
}) {
  return (
    <div class="understanding-progress">
      <span class="understanding-subject" title={props.subject}>
        {props.subject}
      </span>
      <span class="understanding-segments">
        <For each={Array.from({ length: props.total }, (_unused, index) => index)}>
          {(index) => (
            <span
              data-state={segmentState(index, props.current)}
              aria-current={index === props.current ? 'step' : undefined}
            />
          )}
        </For>
      </span>
      <span class="understanding-count">{`${props.current + 1} / ${props.total}`}</span>
    </div>
  );
}
