import { Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';

/** Native scrolling keeps the reader in charge while streaming and disclosures resize.
 *  The log follows new output only while the reader is at the bottom. */
export function ChatScroll(props: {
  children: JSX.Element;
  /** Receives a way to bring the newest message into view, e.g. after sending. */
  onControls?: (controls: { toLatest: () => void }) => void;
}) {
  let scroll: HTMLDivElement | undefined;
  let content: HTMLDivElement | undefined;
  let following = true;
  const [latest, setLatest] = createSignal(true);
  const atBottom = (element: HTMLElement) =>
    element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  function bottom() {
    if (!scroll) return;
    following = true;
    scroll.scrollTop = scroll.scrollHeight;
    setLatest(true);
  }
  onMount(() => {
    props.onControls?.({ toLatest: bottom });
    if (!scroll || !content) return;
    const observer = new ResizeObserver(() => {
      if (following) bottom();
      else if (scroll) setLatest(atBottom(scroll));
    });
    observer.observe(scroll);
    observer.observe(content);
    bottom();
    onCleanup(() => observer.disconnect());
  });
  return (
    <div class="chat-scroll-container">
      <div
        ref={scroll}
        class="chat-scroll"
        onScroll={(event) => {
          following = atBottom(event.currentTarget);
          setLatest(following);
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) following = false;
        }}
        onPointerDown={() => {
          following = false;
        }}
      >
        <div ref={content}>{props.children}</div>
      </div>
      <Show when={!latest()}>
        <button class="chat-jump" aria-label="Jump to latest message" onClick={bottom}>
          ↓ Latest
        </button>
      </Show>
    </div>
  );
}
