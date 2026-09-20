import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { theme } from '../../lib/theme';
import { sf } from '../../lib/fontScale';
import { createAnchorEffect, placeBelow, type BelowAnchor } from '../../lib/floating';
import { CheckIcon, ChevronDownIcon } from '../icons';
import {
  ASK_CODE_CLAUDE_MODELS,
  ASK_CODE_MODELS,
  type AskCodeProvider,
} from '../../../electron/shared/ask-code-models';
import { codexModels, loadCodexModels } from '../../lib/codex-models';
import { store } from '../../store/core';
import { setAskCodeModel, setAskCodeProvider } from '../../store/store';
import { askCodeModelLabel } from './ask-code-label';

const MENU_WIDTH = 190;
/** Room the menu needs; placeBelow flips it above the trigger when the foot is close. */
const MENU_HEIGHT = 230;

interface ModelChoice {
  provider: AskCodeProvider;
  /** Undefined for MiniMax, which offers a single model. */
  model?: string;
  label: string;
  /** Shown on hover where the label is a display name, not the slug sent to the CLI. */
  title?: string;
}

interface ModelGroup {
  heading: string;
  choices: ModelChoice[];
  /** Shown in place of the rows when a provider offers nothing. */
  empty?: string;
}

/**
 * The providers in one flat list, so arrow keys walk them in the order shown.
 * Codex models come from its CLI cache, so that group can be empty.
 */
function groups(): ModelGroup[] {
  return [
    {
      heading: 'Claude Code',
      choices: ASK_CODE_CLAUDE_MODELS.map((model) => ({
        provider: 'claude' as const,
        model,
        label: model,
      })),
    },
    {
      heading: 'Codex',
      choices: codexModels().map((model) => ({
        provider: 'codex' as const,
        model: model.slug,
        label: model.displayName,
        title: model.slug,
      })),
      empty: 'No Codex models found',
    },
    {
      heading: 'MiniMax',
      choices: [{ provider: 'minimax', label: ASK_CODE_MODELS.minimax }],
    },
  ];
}

function isChosen(choice: ModelChoice): boolean {
  if (choice.provider === 'minimax') return store.askCodeProvider === 'minimax';
  return store.askCodeProvider === choice.provider && store.askCodeModel === choice.model;
}

function pick(choice: ModelChoice): void {
  setAskCodeProvider(choice.provider);
  if (choice.model) setAskCodeModel(choice.model);
}

/**
 * The provider and model every tour and code question is sent to. One setting,
 * so the menu shows the Claude aliases and MiniMax's single model side by side
 * rather than asking for a provider first.
 */
function ModelList(props: { position: BelowAnchor; onClose: () => void }) {
  let menu: HTMLDivElement | undefined;
  const items = () =>
    Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);

  onMount(() => {
    // The chevron that opened the menu gets the focus back when it goes.
    const opener = document.activeElement;
    const list = items();
    const checked = list.find((item) => item.getAttribute('aria-checked') === 'true');
    requestAnimationFrame(() => (checked ?? list[0])?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const current = items();
      const at = current.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      current[(at + step + current.length) % current.length]?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => {
      window.removeEventListener('keydown', onKey, true);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    });
  });

  return (
    <Portal>
      <div
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
        onContextMenu={() => props.onClose()}
        style={{ position: 'fixed', inset: '0', 'z-index': '2000' }}
      >
        <div
          ref={menu}
          role="menu"
          aria-label="Tour model"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: `${props.position.top}px`,
            right: `${props.position.right}px`,
            width: `${MENU_WIDTH}px`,
            background: theme.bgElevated,
            border: `1px solid ${theme.border}`,
            'border-radius': 'var(--radius-md)',
            'box-shadow': '0 6px 20px rgba(0, 0, 0, 0.35)',
            padding: '4px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '1px',
          }}
        >
          <For each={groups()}>
            {(group) => (
              <>
                <div
                  role="presentation"
                  style={{
                    padding: '6px 8px 2px',
                    'font-size': sf(10),
                    'text-transform': 'uppercase',
                    'letter-spacing': '0.06em',
                    color: theme.fgMuted,
                  }}
                >
                  {group.heading}
                </div>
                <Show when={group.empty && group.choices.length === 0}>
                  <div
                    role="presentation"
                    style={{
                      padding: '5px 8px 5px 26px',
                      'font-size': sf(12),
                      color: theme.fgSubtle,
                    }}
                  >
                    {group.empty}
                  </div>
                </Show>
                <For each={group.choices}>
                  {(choice) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={isChosen(choice)}
                      title={choice.title}
                      onClick={(e) => {
                        e.stopPropagation();
                        pick(choice);
                        props.onClose();
                      }}
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        gap: '6px',
                        padding: '5px 8px',
                        background: 'transparent',
                        border: 'none',
                        'border-radius': 'var(--radius-sm)',
                        color: theme.fg,
                        cursor: 'pointer',
                        'text-align': 'left',
                        font: 'inherit',
                        'font-size': sf(12),
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = theme.bgHover)}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      {/* The space is reserved on every row, so the labels line up. */}
                      <span
                        aria-hidden="true"
                        style={{
                          width: '12px',
                          'flex-shrink': '0',
                          color: theme.success,
                          display: 'inline-flex',
                        }}
                      >
                        <Show when={isChosen(choice)}>
                          <CheckIcon size={12} />
                        </Show>
                      </span>
                      <span>{choice.label}</span>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
      </div>
    </Portal>
  );
}

/**
 * The chevron half of the Take Tour split button: picks the provider and model
 * used for tours and every other code question, which share one setting.
 */
export function TourModelMenu(props: { style?: JSX.CSSProperties; class?: string }) {
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<BelowAnchor>({ top: 0, right: 0, maxHeight: 0 });
  let trigger: HTMLButtonElement | undefined;

  createAnchorEffect(open, () => {
    if (!trigger) return;
    setPosition(
      placeBelow(
        trigger.getBoundingClientRect(),
        MENU_WIDTH,
        { width: window.innerWidth, height: window.innerHeight },
        12,
        MENU_HEIGHT,
      ),
    );
  });

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="Tour model"
        aria-haspopup="menu"
        aria-expanded={open()}
        title={`Model: ${askCodeModelLabel()}`}
        class={props.class}
        style={props.style}
        onClick={(event) => {
          // The notes overlay behind the button reacts to clicks of its own.
          event.stopPropagation();
          // Read the Codex cache on first open, not on every render of a tour button.
          if (!open()) loadCodexModels();
          setOpen(!open());
        }}
      >
        <ChevronDownIcon size={12} />
      </button>
      <Show when={open()}>
        <ModelList position={position()} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}
