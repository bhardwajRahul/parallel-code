import { createSignal, createEffect, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { parseUnifiedDiff } from '../lib/unified-diff-parser';
import { ChangeTour } from './ChangeTour';
import { ChangeTourButton } from './ChangeTourButton';
import { createChangeTour } from '../lib/create-change-tour';
import { info as logInfo } from '../lib/log';
import { setAskCodeModel, setAskCodeProvider, store } from '../store/store';
import {
  CHANGE_TOUR_TIMEOUT_MS,
  CHANGE_TOUR_PROMPT_LIMIT,
} from '../../electron/shared/change-tour-limits';

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
  const [store, setStore] = createStore({
    askCodeProvider: 'minimax',
    askCodeModel: 'sonnet',
    agentEnvFiles: {},
  });
  return {
    store,
    setAskCodeProvider: (provider: string) => setStore('askCodeProvider', provider),
    setAskCodeModel: (model: string) => setStore('askCodeModel', model),
  };
});
vi.mock('../lib/log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/log')>()),
  info: vi.fn(),
}));
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  channels.length = 0;
  vi.clearAllMocks();
  vi.useRealTimers();
  setAskCodeProvider('minimax');
  setAskCodeModel('sonnet');
});
const diff = 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n';

function mount(initialDiff = diff, initiallyDisabled = false) {
  const [raw, setRaw] = createSignal(initialDiff);
  const [disabled, setDisabled] = createSignal(initiallyDisabled);
  const [readerOpen, setReaderOpen] = createSignal(false);
  const navigate = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(
    render(() => {
      const tour = createChangeTour();
      createEffect(() => tour.reconcile(raw()));
      return (
        <>
          <ChangeTourButton
            tour={tour}
            disabled={disabled()}
            onClick={() => {
              if (tour.stops().length) setReaderOpen(true);
              else
                tour.generate({
                  rawDiff: raw(),
                  files: parseUnifiedDiff(raw()),
                  taskName: 'Task',
                  worktreePath: '/repo',
                });
            }}
          />
          <Show when={readerOpen()}>
            <ChangeTour tour={tour} onNavigate={navigate} onFinish={() => setReaderOpen(false)} />
          </Show>
        </>
      );
    }, host),
  );
  return { host, setRaw, navigate, setReaderOpen, setDisabled };
}
function complete(index = 0, filePath = 'file.ts') {
  const stop = {
    title: 'Changed behavior',
    explanation: 'The returned value changes.',
    locations: [{ filePath, line: 1 }],
  };
  channels[index].onmessage?.({
    type: 'chunk',
    text: JSON.stringify({ stops: [stop, { ...stop, title: 'Tests' }] }),
  });
  channels[index].onmessage?.({ type: 'done', exitCode: 0 });
}

const largeDiff = ['file.ts', 'second.ts', 'third.ts']
  .map(
    (filePath) =>
      `diff --git a/${filePath} b/${filePath}\n@@ -1 +1 @@\n-${'a'.repeat(CHANGE_TOUR_PROMPT_LIMIT / 3)}\n+${'b'.repeat(CHANGE_TOUR_PROMPT_LIMIT / 3)}\n`,
  )
  .join('');

describe('guided tour', () => {
  it('picks the tour model from the chevron beside Generate tour', () => {
    const { host } = mount();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Tour model"]');
    const controls = host.querySelector('.change-tour-hover');
    if (!trigger || !controls) throw new Error('Missing model chevron');
    // The chevron is outside the hover anchor, so the help popover gives way to
    // the menu instead of standing over it.
    controls.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    trigger.click();
    // No backend answers the Codex model list here, so that group stays empty.
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('No Codex models found');
    const opus = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.trim() === 'opus',
    );
    opus?.click();
    expect(store.askCodeProvider).toBe('claude');
    expect(store.askCodeModel).toBe('opus');
  });

  it('explains generation and the configured model on hover/focus without generating', () => {
    const { host } = mount();
    const button = host.querySelector('button');
    const controls = button?.closest('.change-tour-hover');
    if (!button || !controls) throw new Error('Missing generate control');
    expect(button.textContent).toBe('Generate tour');
    // The action and the model chevron beside it, and nothing else.
    expect(host.querySelectorAll('button')).toHaveLength(2);
    controls.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('MiniMax-M2.7');
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Sends the selected tour diff',
    );
    expect(invoke).not.toHaveBeenCalled();
    setAskCodeProvider('claude');
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'sonnet (CLI model alias)',
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    button.focus();
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    button.click();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(channels).toHaveLength(1);
  });

  it('dismisses focused button help on outside click without generating', () => {
    const { host } = mount();
    host.querySelector('button')?.focus();
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
  it('accepts commentary after streamed tour JSON without starting another request', () => {
    const { host } = mount();
    host.querySelector('button')?.click();
    const response = JSON.stringify({
      stops: [
        {
          title: 'Behavior',
          explanation: 'Changes the value.',
          locations: [{ filePath: 'file.ts', line: 1 }],
        },
      ],
    });
    channels[0].onmessage?.({ type: 'chunk', text: response });
    channels[0].onmessage?.({ type: 'chunk', text: '\nNote: tests were not executed.' });
    channels[0].onmessage?.({ type: 'done', exitCode: 0 });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('button')?.textContent).toContain('Start tour');
    expect(channels).toHaveLength(1);
  });
  it('logs request timing once without logging code or response content', () => {
    vi.useFakeTimers();
    const { host, setRaw } = mount();
    host.querySelector('button')?.click();
    vi.advanceTimersByTime(1200);
    channels[0].onmessage?.({ type: 'chunk', text: ' ' });
    vi.advanceTimersByTime(800);
    complete();
    setRaw(diff.replace('+new', '+newer'));
    expect(logInfo).toHaveBeenCalledExactlyOnceWith('changeTour', 'Tour request finished', {
      requestId: expect.any(String),
      provider: 'minimax',
      part: 1,
      parts: 1,
      promptChars: expect.any(Number),
      responseChars: expect.any(Number),
      firstOutputMs: 1200,
      durationMs: 2000,
      outcome: 'completed',
    });
  });
  it('hides the entire footer until changed files are available', () => {
    const { host, setDisabled } = mount(diff, true);
    expect(host.textContent).toBe('');
    expect(host.querySelector('button')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    setDisabled(false);
    expect(host.querySelector('button')?.textContent).toBe('Generate tour');
    setDisabled(true);
    expect(host.querySelector('button')).toBeNull();
  });

  it('keeps active and ready tours accessible if the live file list becomes empty', () => {
    const { host, setDisabled } = mount();
    host.querySelector('button')?.click();
    setDisabled(true);
    expect(host.querySelector('button[aria-busy="true"] .inline-spinner')).not.toBeNull();
    complete();
    expect(host.querySelector('button')?.textContent).toContain('Start tour');
    expect(host.querySelector('button')?.disabled).toBe(false);
  });

  it('shows a ready checkmark and opens the completed tour without regenerating it', () => {
    const { host, navigate } = mount();
    host.querySelector('button')?.click();
    expect(host.querySelector('[aria-label="Guided change tour"]')).toBeNull();
    complete();
    expect(host.querySelector('[aria-label="Tour ready"]')).not.toBeNull();
    expect(host.querySelector('button')?.textContent).toContain('Start tour');
    expect(navigate).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Guided change tour"]')).toBeNull();
    host.querySelector('button')?.click();
    expect(host.querySelector('[aria-label="Guided change tour"]')).not.toBeNull();
    expect(
      vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AskAboutCode),
    ).toHaveLength(1);
  });
  it('shows a spinner, elapsed time and incoming response activity while generating', () => {
    vi.useFakeTimers();
    const { host } = mount();
    host.querySelector('button')?.click();
    expect(host.querySelector('.inline-spinner')).not.toBeNull();
    expect(host.querySelector('button')?.getAttribute('aria-busy')).toBe('true');
    vi.advanceTimersByTime(5000);
    expect(host.textContent).toContain('Waiting for provider · 5s');
    channels[0].onmessage?.({ type: 'chunk', text: '{' });
    expect(host.textContent).toContain('Receiving response · 5s');
    channels[0].onmessage?.({ type: 'error', text: 'Provider disconnected' });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Provider disconnected');
  });

  it('times out when IPC never completes and ignores late results', () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(() => {}));
    const { host, navigate } = mount(largeDiff);
    host.querySelector('button')?.click();
    vi.advanceTimersByTime(CHANGE_TOUR_TIMEOUT_MS + 5000);
    expect(logInfo).toHaveBeenCalledWith(
      'changeTour',
      'Tour request finished',
      expect.objectContaining({
        outcome: 'timeout',
        firstOutputMs: null,
        durationMs: CHANGE_TOUR_TIMEOUT_MS + 5000,
      }),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'did not finish within five minutes',
    );
    expect(host.querySelector('.inline-spinner')).toBeNull();
    expect(host.querySelector('button')?.getAttribute('aria-busy')).toBe('false');
    expect(invoke).toHaveBeenCalledWith(
      IPC.CancelAskAboutCode,
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    complete();
    expect(navigate).not.toHaveBeenCalled();
    expect(channels).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up each part’s timers and cancels them when the diff changes', () => {
    vi.useFakeTimers();
    const { host, setRaw } = mount(largeDiff);
    host.querySelector('button')?.click();
    expect(vi.getTimerCount()).toBe(2);
    complete();
    expect(channels).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(2);
    setRaw(diff);
    expect(vi.getTimerCount()).toBe(0);
    expect(host.querySelector('.inline-spinner')).toBeNull();
  });

  it('generates on request and navigates stops', () => {
    const { host, navigate } = mount();
    expect(invoke).not.toHaveBeenCalled();
    host.querySelector('button')?.click();
    expect(invoke).toHaveBeenCalledWith(
      IPC.AskAboutCode,
      expect.objectContaining({ provider: 'minimax', purpose: 'tour' }),
    );
    complete();
    host.querySelector('button')?.click();
    expect(host.textContent).toContain('Stop 1 of 2');
    expect(navigate).toHaveBeenCalledWith('file.ts', 1);
    const content = host.querySelector('h2')?.parentElement;
    if (!content) throw new Error('Tour content is missing');
    content.scrollTop = 120;
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Next')?.click();
    expect(host.textContent).toContain('Stop 2 of 2');
    expect(host.querySelector('h2')?.textContent).toBe('Tests');
    expect(content.scrollTop).toBe(0);
  });

  it('cancels and ignores a stale response when the diff changes', () => {
    const { host, setRaw, navigate } = mount();
    host.querySelector('button')?.click();
    setRaw(diff.replace('+new', '+newer'));
    expect(invoke).toHaveBeenCalledWith(
      IPC.CancelAskAboutCode,
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    complete();
    expect(navigate).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Changed behavior');
  });

  it('shows provider failures without treating a partial explanation as a tour', () => {
    const { host } = mount();
    host.querySelector('button')?.click();
    channels[0].onmessage?.({ type: 'error', text: 'Provider unavailable' });
    channels[0].onmessage?.({ type: 'done', exitCode: 1 });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Provider unavailable');
  });

  it('processes a large diff sequentially and combines all parts into one tour', () => {
    const { host, navigate } = mount(largeDiff);
    host.querySelector('button')?.click();
    expect(host.querySelector('button')?.textContent).toContain('part 1 of 3');
    expect(channels).toHaveLength(1);
    complete();
    expect(channels).toHaveLength(2);
    expect(host.querySelector('button')?.textContent).toContain('part 2 of 3');
    expect(navigate).not.toHaveBeenCalled();
    complete(1, 'second.ts');
    complete(2, 'third.ts');
    expect(navigate).not.toHaveBeenCalled();
    host.querySelector('button')?.click();
    expect(host.textContent).toContain('Stop 1 of 6');
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(navigate).toHaveBeenCalledWith('file.ts', 1);
    for (const [channel, args] of vi.mocked(invoke).mock.calls) {
      if (channel === IPC.AskAboutCode)
        expect((args?.prompt as string).length).toBeLessThanOrEqual(CHANGE_TOUR_PROMPT_LIMIT);
    }
  });

  it('cancels the active part and never starts remaining parts', () => {
    const { host, navigate } = mount(largeDiff);
    host.querySelector('button')?.click();
    complete();
    [...host.querySelectorAll('button')]
      .find((button) => button.title === 'Cancel tour generation')
      ?.click();
    complete(1, 'second.ts');
    expect(channels).toHaveLength(2);
    expect(navigate).not.toHaveBeenCalled();
    const calls = vi.mocked(invoke).mock.calls;
    const activeRequest = calls.filter(([channel]) => channel === IPC.AskAboutCode)[1][1];
    expect(invoke).toHaveBeenCalledWith(IPC.CancelAskAboutCode, {
      requestId: activeRequest?.requestId,
    });
  });

  it('does not present a partial tour as complete if a later part fails', () => {
    const { host, navigate } = mount(largeDiff);
    host.querySelector('button')?.click();
    complete();
    channels[1].onmessage?.({ type: 'error', text: 'Provider unavailable' });
    channels[1].onmessage?.({ type: 'done', exitCode: 1 });
    expect(channels).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Provider unavailable');
    expect(host.textContent).not.toContain('Stop 1');
    expect(navigate).not.toHaveBeenCalled();
  });
});
