import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { createUnderstandingTour } from '../lib/create-understanding-tour';
import { invoke } from '../lib/ipc';
import { renderMermaidIn } from '../lib/mermaid';
import { openFileInEditor } from '../lib/shell';
import { GIST_LABEL } from '../lib/understanding-tour';
import { UnderstandingTourDialog } from './UnderstandingTourDialog';
import { UnderstandButton } from './understanding/UnderstandButton';

const channels = vi.hoisted(
  () =>
    [] as {
      onmessage: ((message: { type: string; text?: string; exitCode?: number }) => void) | null;
      dispose: () => void;
    }[],
);
vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(() => Promise.resolve()),
  Channel: class {
    onmessage = null;
    dispose = vi.fn();
    constructor() {
      channels.push(this);
    }
  },
}));
vi.mock('../store/store', async () => {
  const { createStore } = await import('solid-js/store');
  const [store] = createStore({
    askCodeProvider: 'minimax',
    agentEnvFiles: {},
    editorCommand: 'code',
  });
  return { store };
});
vi.mock('../lib/mermaid', () => ({ renderMermaidIn: vi.fn() }));
vi.mock('../lib/shell', () => ({ openFileInEditor: vi.fn(() => Promise.resolve()) }));
vi.mock('../lib/log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/log')>()),
  info: vi.fn(),
}));

function card(over: Record<string, unknown> = {}) {
  return { label: 'KEY DECISION', title: 'Title', body: 'Body text.', tone: 'neutral', ...over };
}
const TOUR_JSON = JSON.stringify({
  gist: card({ label: GIST_LABEL, title: 'Gist title', tone: 'important' }),
  cards: [
    card({ title: 'First card', refs: [{ filePath: 'electron/ipc/pty.ts', line: 189 }] }),
    card({
      title: 'Second card',
      tone: 'risk',
      diagram: { kind: 'text', source: 'PTY -> Buffer -> IPC' },
    }),
    card({
      title: 'Third card',
      diagram: { kind: 'mermaid', source: 'graph TD; A-->B' },
    }),
  ],
});
const BRANCH_JSON = JSON.stringify({
  cards: [card({ title: 'Deep one' }), card({ title: 'Deep two' })],
});

const disposers: (() => void)[] = [];
beforeEach(() => {
  vi.mocked(invoke).mockImplementation((() => Promise.resolve(undefined)) as typeof invoke);
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  channels.length = 0;
  vi.clearAllMocks();
});

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}
const panel = () => {
  const element = document.querySelector('[role="dialog"]');
  if (!element) throw new Error('Dialog is not open');
  return element;
};
const buttons = () => [...panel().querySelectorAll('button')];
function clickButton(label: string) {
  const button = buttons().find((candidate) => candidate.textContent?.includes(label));
  if (!button)
    throw new Error(`No button labelled ${label}: ${buttons().map((b) => b.textContent)}`);
  button.click();
}
/** The chrome around the card is icon-only, so it is found by its label. */
function iconButton(label: string) {
  const button = buttons().find((candidate) => candidate.getAttribute('aria-label') === label);
  if (!button)
    throw new Error(
      `No icon labelled ${label}: ${buttons().map((b) => b.getAttribute('aria-label'))}`,
    );
  return button;
}
function clickIcon(label: string) {
  iconButton(label).click();
}
const progressText = () => panel().querySelector('.understanding-progress')?.textContent ?? '';
const askInput = () => {
  const input = panel().querySelector<HTMLInputElement>('.understanding-ask-input');
  if (!input) throw new Error('Ask input is missing');
  return input;
};

const PLAN_INPUT = {
  kind: 'plan',
  taskName: 'Task',
  worktreePath: '/repo',
  planContent: '# Plan',
  subject: 'output buffering',
} as const;

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const onClose = vi.fn();
  let controller: ReturnType<typeof createUnderstandingTour> | undefined;
  disposers.push(
    render(() => {
      controller = createUnderstandingTour();
      return (
        <UnderstandingTourDialog
          tour={controller}
          open={true}
          onClose={onClose}
          worktreePath="/repo"
        />
      );
    }, host),
  );
  if (!controller) throw new Error('Controller was not created');
  return { tour: controller, onClose };
}

/** Mounts the dialog with a generated tour, on its first card: the gist. */
async function mountWithTour(response = TOUR_JSON) {
  const mounted = mount();
  void mounted.tour.generate(PLAN_INPUT);
  await flush();
  channels[0].onmessage?.({ type: 'chunk', text: response });
  channels[0].onmessage?.({ type: 'done', exitCode: 0 });
  await flush();
  return mounted;
}

describe('UnderstandingTourDialog', () => {
  it('shows progress, elapsed time and a cancel action while generating', async () => {
    const { tour } = mount();
    void tour.generate(PLAN_INPUT);
    await flush();
    // Nothing is on screen but the card, so the only heading is the hidden one
    // that gives the dialog its accessible name.
    expect(panel().querySelector('h1')?.className).toBe('dialog-sr-only');
    expect(panel().querySelector('h1')?.textContent).toBe('Understanding tour of output buffering');
    expect(panel().textContent).toContain('Generating tour…');
    expect(panel().querySelector('[role="status"]')?.textContent).toContain(
      'Waiting for provider · 0s',
    );
    channels[0].onmessage?.({ type: 'chunk', text: '{' });
    expect(panel().querySelector('[role="status"]')?.textContent).toContain('Receiving response');
    clickIcon('Cancel generation');
    expect(invoke).toHaveBeenCalledWith(IPC.CancelAskAboutCode, {
      requestId: expect.any(String),
    });
    expect(tour.loading()).toBe(false);
  });

  it('leaves only the close icon after a cancelled generation', async () => {
    const { tour, onClose } = mount();
    void tour.generate(PLAN_INPUT);
    await flush();
    clickIcon('Cancel generation');
    expect(tour.loading()).toBe(false);
    expect(panel().textContent).toContain('Generation cancelled.');
    // Cancelling was deliberate, so nothing offers another attempt here.
    expect(buttons().map((button) => button.getAttribute('aria-label'))).toEqual(['Close tour']);
    clickIcon('Close tour');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens on the gist as the first card of the spine', async () => {
    await mountWithTour();
    expect(panel().textContent).toContain('Gist title');
    expect(panel().textContent).toContain(GIST_LABEL);
    // The subject appears once, in the strip above the card, and never again.
    expect(progressText()).toContain('output buffering');
    // The gist is counted and navigable like every other card.
    expect(progressText()).toContain('1 / 4');
    const segments = panel().querySelectorAll('.understanding-segments > button');
    expect(segments).toHaveLength(4);
    expect(segments[0].getAttribute('aria-current')).toBe('step');
    expect(panel().querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(iconButton('Previous card').disabled).toBe(true);
    clickIcon('Next card');
    expect(panel().textContent).toContain('First card');
    expect(progressText()).toContain('2 / 4');
    // The gist stays one arrow key away instead of being left behind.
    clickIcon('Previous card');
    expect(panel().textContent).toContain('Gist title');
  });

  it('disables Previous on the first card and finishes on the last', async () => {
    const { onClose } = await mountWithTour();
    expect(iconButton('Previous card').disabled).toBe(true);
    clickIcon('Next card');
    clickIcon('Next card');
    expect(panel().textContent).toContain('Second card');
    expect(iconButton('Previous card').disabled).toBe(false);
    clickIcon('Next card');
    expect(panel().textContent).toContain('Third card');
    expect(progressText()).toContain('4 / 4');
    // The last card turns the way forward into the way out.
    expect(buttons().some((button) => button.getAttribute('aria-label') === 'Next card')).toBe(
      false,
    );
    expect(iconButton('Finish tour').title).toBe('Finish');
    clickIcon('Finish tour');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('marks the card tone and renders both diagram kinds', async () => {
    await mountWithTour();
    expect(panel().querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('important');
    clickIcon('Next card');
    clickIcon('Next card');
    const article = panel().querySelector('[data-tone]');
    expect(article?.getAttribute('data-tone')).toBe('risk');
    expect(panel().querySelector('.understanding-card-label')?.textContent).toContain('⚠');
    expect(panel().querySelector('pre.understanding-diagram')?.textContent).toBe(
      'PTY -> Buffer -> IPC',
    );
    expect(renderMermaidIn).not.toHaveBeenCalled();
    clickIcon('Next card');
    const block = panel().querySelector('.mermaid-block');
    expect(block?.getAttribute('data-mermaid')).toBe('graph TD; A-->B');
    // The source stays as text so a Mermaid failure leaves readable content.
    expect(block?.textContent).toBe('graph TD; A-->B');
    expect(renderMermaidIn).toHaveBeenCalledWith(block?.parentElement, 'understanding');
  });

  it('opens a code reference in the editor at its line', async () => {
    await mountWithTour();
    clickIcon('Next card');
    clickButton('electron/ipc/pty.ts:189');
    expect(openFileInEditor).toHaveBeenCalledWith('/repo', 'electron/ipc/pty.ts', {
      line: 189,
      editorCommand: 'code',
    });
  });

  it('asks a question from the ask bar and keeps the answer under the card', async () => {
    await mountWithTour();
    clickIcon('Next card');
    clickIcon('Next card');
    const input = askInput();
    input.value = 'Why buffer first?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(input.value).toBe('');
    expect(panel().querySelector('[role="status"]')?.textContent).toContain('Thinking…');
    const pending = panel().querySelector('.understanding-thread[aria-busy="true"]');
    expect(pending?.textContent).toContain('↳ Why buffer first?');
    const asks = vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode);
    expect(asks).toHaveLength(2);
    expect(asks[1][1]?.purpose).toBe('understand');
    expect(String(asks[1][1]?.prompt)).toContain('Why buffer first?');
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    // The spine stays put: same card, same counter, answer cards below it.
    expect(progressText()).toContain('3 / 4');
    expect(panel().textContent).toContain('Second card');
    const threads = panel().querySelectorAll('.understanding-thread');
    expect(threads).toHaveLength(1);
    expect(threads[0].getAttribute('aria-busy')).toBeNull();
    expect(threads[0].textContent).toContain('↳ Why buffer first?');
    expect(threads[0].querySelectorAll('.understanding-card')).toHaveLength(2);
    expect(threads[0].textContent).toContain('Deep one');
    // The thread belongs to its card: gone on the next card, back on return.
    clickIcon('Next card');
    expect(panel().querySelector('.understanding-thread')).toBeNull();
    clickIcon('Previous card');
    expect(panel().querySelectorAll('.understanding-thread')).toHaveLength(1);
  });

  it('explores a suggested question once and keeps its answer on the source card', async () => {
    const question = 'What happens if the buffer fills before the timer fires?';
    await mountWithTour(
      JSON.stringify({
        gist: card({ questions: [question, 'Why flush on a timer?'] }),
        cards: [card({ title: 'Next step', questions: [question] })],
      }),
    );
    const suggestions = () => [...panel().querySelectorAll<HTMLButtonElement>('.tour-question')];
    expect(suggestions()).toHaveLength(2);
    suggestions()[0].click();
    suggestions()[1].click();
    await flush();
    const asks = vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode);
    expect(asks).toHaveLength(2); // Tour generation plus one follow-up.
    expect(String(asks[1][1]?.prompt)).toContain(JSON.stringify(question));
    expect(suggestions().every((button) => button.disabled)).toBe(true);
    clickIcon('Next card');
    expect(suggestions()[0].disabled).toBe(true);
    expect(panel().querySelector('.understanding-thread')).toBeNull();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(suggestions()[0].disabled).toBe(false);
    clickIcon('Previous card');
    expect(suggestions().map((button) => button.textContent)).toEqual(['↳Why flush on a timer?']);
    expect(panel().querySelector('.understanding-thread')?.getAttribute('aria-label')).toBe(
      question,
    );
    expect(panel().querySelector('.understanding-thread')?.textContent).toContain('Deep one');
  });

  it('keeps the waiting question under its own card while the reader moves on', async () => {
    await mountWithTour();
    clickIcon('Next card');
    const input = askInput();
    input.value = 'Why buffer first?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(panel().querySelector('.understanding-thread[aria-busy="true"]')).not.toBeNull();
    clickIcon('Next card');
    expect(panel().querySelector('.understanding-thread')).toBeNull();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    // The answer belongs to the card it was asked from, so this card stays bare.
    expect(panel().querySelector('.understanding-thread')).toBeNull();
    clickIcon('Previous card');
    const threads = panel().querySelectorAll('.understanding-thread');
    expect(threads).toHaveLength(1);
    expect(threads[0].textContent).toContain('↳ Why buffer first?');
    expect(threads[0].textContent).toContain('Deep one');
  });

  it('offers Cancel only on the card whose question is in flight', async () => {
    const { tour } = await mountWithTour();
    clickIcon('Next card');
    clickIcon('Go deeper');
    await flush();
    expect(iconButton('Cancel question')).toBeDefined();
    clickIcon('Next card');
    // A Cancel here would abort the previous card's request, so there is none.
    expect(
      buttons().some((button) => button.getAttribute('aria-label') === 'Cancel question'),
    ).toBe(false);
    expect(panel().querySelector('.understanding-asking')).toBeNull();
    expect(askInput().disabled).toBe(true);
    expect(tour.asking()).toBe(true);
    clickIcon('Previous card');
    iconButton('Cancel question').click();
    expect(tour.asking()).toBe(false);
  });

  it('focuses the primary action so arrow keys navigate from the start', async () => {
    await mountWithTour();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Next card');
    const focused = document.activeElement;
    expect(focused && panel().contains(focused)).toBe(true);
    focused?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(panel().textContent).toContain('First card');
    askInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(panel().textContent).toContain('First card');
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    expect(panel().textContent).toContain('Gist title');
  });

  it('navigates with arrow keys after a click on the card moved focus to the panel', async () => {
    await mountWithTour();
    const dialog = panel();
    if (!(dialog instanceof HTMLElement)) throw new Error('Dialog panel is not an element');
    dialog.focus();
    expect(document.activeElement).toBe(dialog);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(panel().textContent).toContain('First card');
  });

  it('jumps to a card from its progress segment and with Home and End', async () => {
    await mountWithTour();
    clickIcon('Card 4 of 4: Third card');
    expect(progressText()).toContain('4 / 4');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(panel().textContent).toContain('Gist title');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(panel().textContent).toContain('Third card');
  });

  it('shows every card title in the overview and opens the one picked', async () => {
    await mountWithTour();
    clickIcon('Show overview');
    const items = [...panel().querySelectorAll('.understanding-overview li')];
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toContain('Gist title');
    items[3].querySelector('button')?.click();
    expect(panel().querySelector('.understanding-overview')).toBeNull();
    expect(progressText()).toContain('4 / 4');
  });

  it('marks the progress segment of a card that has answers', async () => {
    await mountWithTour();
    clickIcon('Next card');
    const input = askInput();
    input.value = 'Why?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    const segments = panel().querySelectorAll('.understanding-segments > button');
    expect(segments[1].hasAttribute('data-answered')).toBe(true);
    expect(segments[1].getAttribute('aria-label')).toContain('(has answers)');
    expect(segments[0].hasAttribute('data-answered')).toBe(false);
  });

  it('keeps the dialog open when Escape is pressed while typing a question', async () => {
    const { onClose } = await mountWithTour();
    const input = askInput();
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    // The field lets go of focus, so a second Escape closes the tour as usual.
    expect(document.activeElement).not.toBe(input);
  });

  it('copies the tour as Markdown', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mountWithTour();
    clickIcon('Copy tour as Markdown');
    await flush();
    const markdown = String(writeText.mock.calls[0]?.[0 as never]);
    expect(markdown).toContain('# Tour: output buffering');
    expect(markdown).toContain('## 4. Third card');
    expect(iconButton('Tour copied')).toBeDefined();
  });

  it('reworks the tour from the rework bar; Escape closes only the bar', async () => {
    const { onClose } = await mountWithTour();
    clickIcon('Rework tour');
    const input = panel().querySelector<HTMLInputElement>('.tour-rework input');
    if (!input) throw new Error('Rework input is missing');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel().querySelector('.tour-rework')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    clickIcon('Rework tour');
    const again = panel().querySelector<HTMLInputElement>('.tour-rework input');
    if (!again) throw new Error('Rework input is missing');
    again.value = 'Only the risks';
    again.dispatchEvent(new Event('input', { bubbles: true }));
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(panel().textContent).toContain('Reworking tour…');
    const asks = vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode);
    expect(String(asks[1][1]?.prompt)).toContain('"Only the risks"');
  });

  it('offers Regenerate when a reopened file tour is out of date', async () => {
    let content = 'export const a = 1;';
    vi.mocked(invoke).mockImplementation(((channel: IPC) =>
      channel === IPC.ReadFileTourContext
        ? Promise.resolve({
            filePath: 'src/a.ts',
            files: [{ path: 'src/a.ts', content, truncated: false }],
            omitted: [],
          })
        : Promise.resolve(undefined)) as typeof invoke);
    const input = {
      kind: 'file',
      taskName: 'Task',
      worktreePath: '/repo',
      filePath: 'src/a.ts',
    } as const;
    const { tour } = mount();
    void tour.generate(input);
    await flush();
    channels[0].onmessage?.({ type: 'chunk', text: TOUR_JSON });
    channels[0].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(panel().querySelector('.understanding-notice')).toBeNull();
    content = 'export const a = 2;';
    tour.open(input);
    await flush();
    expect(panel().querySelector('.understanding-notice')?.textContent).toContain('changed');
    clickButton('Regenerate');
    await flush();
    expect(tour.loading()).toBe(true);
  });

  it('cancels a follow-up from the ask bar and ignores its late chunks', async () => {
    const { tour } = await mountWithTour();
    clickIcon('Next card');
    clickIcon('Go deeper');
    await flush();
    expect(tour.asking()).toBe(true);
    clickIcon('Cancel question');
    expect(tour.asking()).toBe(false);
    channels[1].onmessage?.({ type: 'chunk', text: BRANCH_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(tour.threads()).toHaveLength(0);
    expect(panel().textContent).toContain('First card');
  });

  it('closes from the icon above the card on any state', async () => {
    const { onClose } = await mountWithTour();
    const close = panel().querySelector<HTMLButtonElement>('[aria-label="Close tour"]');
    expect(close).not.toBeNull();
    close?.click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows an alert and retries after a failed generation', async () => {
    const { tour } = mount();
    void tour.generate(PLAN_INPUT);
    await flush();
    channels[0].onmessage?.({ type: 'chunk', text: 'not json' });
    channels[0].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(panel().querySelector('[role="alert"]')).not.toBeNull();
    clickIcon('Retry');
    await flush();
    expect(channels).toHaveLength(2);
    channels[1].onmessage?.({ type: 'chunk', text: TOUR_JSON });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(panel().querySelector('[role="alert"]')).toBeNull();
    expect(panel().textContent).toContain('Gist title');
  });
});

describe('UnderstandButton', () => {
  function mountButton() {
    const host = document.createElement('div');
    document.body.append(host);
    const onClick = vi.fn();
    let controller: ReturnType<typeof createUnderstandingTour> | undefined;
    disposers.push(
      render(() => {
        controller = createUnderstandingTour();
        return (
          <UnderstandButton
            label="Understand"
            tour={controller}
            kind="plan"
            subject={PLAN_INPUT.subject}
            onClick={onClick}
          />
        );
      }, host),
    );
    if (!controller) throw new Error('Controller was not created');
    const button = host.querySelector('button');
    if (!button) throw new Error('Button is missing');
    return { tour: controller, onClick, button };
  }

  it('stays idle while the shared controller runs a different tour', async () => {
    vi.mocked(invoke).mockImplementation(((channel: IPC) =>
      channel === IPC.ReadFileTourContext
        ? Promise.resolve({
            filePath: 'src/pty.ts',
            files: [{ path: 'src/pty.ts', content: 'export const x = 1;', truncated: false }],
            omitted: [],
          })
        : Promise.resolve(undefined)) as typeof invoke);
    const { tour, onClick, button } = mountButton();
    void tour.generate({
      kind: 'file',
      taskName: 'Task',
      worktreePath: '/repo',
      filePath: 'src/pty.ts',
    });
    await flush();
    expect(tour.loading()).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.textContent).toBe('Understand');
    button.click();
    expect(onClick).toHaveBeenCalledOnce();
    // The file tour belongs to another button, so this click must not cancel it.
    expect(tour.loading()).toBe(true);
  });

  it('moves through idle, generating, ready and error states', async () => {
    const { tour, onClick, button } = mountButton();
    expect(button.textContent).toBe('Understand');
    expect(button.getAttribute('aria-busy')).toBe('false');
    button.click();
    expect(onClick).toHaveBeenCalledOnce();

    void tour.generate(PLAN_INPUT);
    await flush();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.inline-spinner')).not.toBeNull();
    // One line only: the phase and elapsed time live in the hint.
    expect(button.textContent).toContain('Understand');
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const hint = () => document.querySelector('[role="tooltip"]')?.textContent ?? '';
    expect(hint()).toContain('Waiting for provider');
    expect(hint()).toContain('Click to cancel.');
    button.click();
    expect(tour.loading()).toBe(false);
    expect(onClick).toHaveBeenCalledOnce();

    void tour.generate(PLAN_INPUT);
    await flush();
    channels[1].onmessage?.({ type: 'chunk', text: 'not json' });
    channels[1].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(button.textContent).toBe('Retry');

    void tour.generate(PLAN_INPUT);
    await flush();
    channels[2].onmessage?.({ type: 'chunk', text: TOUR_JSON });
    channels[2].onmessage?.({ type: 'done', exitCode: 0 });
    await flush();
    expect(button.querySelector('[aria-label="Tour ready"]')).not.toBeNull();
    expect(button.textContent).toContain('Understand');
    expect(hint()).toContain('Click to open it.');
  });
});
