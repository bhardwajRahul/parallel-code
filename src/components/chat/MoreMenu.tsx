import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { KebabIcon } from '../icons';
import { createAnchorEffect, placeBelow, type BelowAnchor } from '../../lib/floating';

export interface MoreMenuItem {
  label: string;
  /** A keyboard shortcut shown beside the label. */
  hint?: string;
  disabled?: boolean;
  /** Items sharing a group are listed under it as a heading. */
  group?: string;
  run: () => void;
}

const MENU_WIDTH = 220;
/** Roughly the height of one entry and of the menu's padding, from chat.css. */
const ITEM_HEIGHT = 27;
const MENU_PADDING = 10;

function MenuList(props: { items: MoreMenuItem[]; position: BelowAnchor; onClose: () => void }) {
  let menu: HTMLDivElement | undefined;
  const entries = () =>
    Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
  onMount(() => {
    // The button that opened the menu gets the focus back when it goes.
    const opener = document.activeElement;
    requestAnimationFrame(() => entries()[0]?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        props.onClose();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const list = entries();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => {
      window.removeEventListener('keydown', onKey, true);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    });
  });
  return (
    <Portal>
      <div class="chat-menu-backdrop" onClick={() => props.onClose()}>
        <div
          ref={menu}
          class="chat-menu"
          role="menu"
          aria-label="More actions"
          onClick={(event) => event.stopPropagation()}
          style={{
            top: `${props.position.top}px`,
            right: `${props.position.right}px`,
            width: `${MENU_WIDTH}px`,
            'max-height': `${props.position.maxHeight}px`,
          }}
        >
          <For each={props.items}>
            {(item, index) => (
              <>
                <Show when={item.group && item.group !== props.items[index() - 1]?.group}>
                  <div class="chat-menu-group" role="presentation">
                    {item.group}
                  </div>
                </Show>
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    // Close first: the opener takes focus back, and an action such as
                    // search must be free to move it again.
                    props.onClose();
                    item.run();
                  }}
                >
                  <span class="chat-menu-label">{item.label}</span>
                  <Show when={item.hint}>
                    <kbd>{item.hint}</kbd>
                  </Show>
                </button>
              </>
            )}
          </For>
        </div>
      </div>
    </Portal>
  );
}

/** A "⋯" button holding the conversation actions that are needed only now and then. */
export function MoreMenu(props: { items: MoreMenuItem[] }) {
  let button: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<BelowAnchor>({ top: 0, right: 0, maxHeight: 0 });
  createAnchorEffect(open, () => {
    if (!button) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    // Room the menu needs; placeBelow flips it above the button near the window's foot.
    const height = props.items.length * ITEM_HEIGHT + MENU_PADDING;
    setPosition(placeBelow(button.getBoundingClientRect(), MENU_WIDTH, viewport, 12, height));
  });
  return (
    <>
      <button
        ref={button}
        class="chat-more"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <KebabIcon size={14} />
      </button>
      <Show when={open()}>
        <MenuList items={props.items} position={position()} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}
