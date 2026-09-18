import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { AgentDetail } from './AgentDetail';
import { sendInput } from './ws';

const terminalMocks = vi.hoisted(() => ({
  scrollLines: vi.fn(),
  refresh: vi.fn(),
  options: { fontSize: 14 },
  scrollback: undefined as ((data: string, cols: number, rows: number) => void) | undefined,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: true };
    options = terminalMocks.options;
    buffer = { active: { length: 0, viewportY: 0, baseY: 0, getLine: () => undefined } };
    open() {}
    refresh(start: number, end: number) {
      terminalMocks.refresh(start, end);
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    onScroll() {
      return { dispose() {} };
    }
    onWriteParsed() {
      return { dispose() {} };
    }
    dispose() {}
    reset() {}
    write(_data: Uint8Array, callback?: () => void) {
      callback?.();
    }
    scrollLines(lines: number) {
      terminalMocks.scrollLines(lines);
    }
    scrollToBottom() {}
  },
}));
vi.mock('./ws', () => ({
  agents: () => [
    {
      agentId: 'a1',
      taskId: 't1',
      taskName: 'First task',
      status: 'running',
      attention: 'needs_input',
    },
  ],
  status: () => 'connected',
  canControl: () => true,
  reconnect: vi.fn(),
  subscribeAgent: vi.fn(),
  unsubscribeAgent: vi.fn(),
  sendInput: vi.fn(),
  onOutput: () => () => {},
  onScrollback: (_id: string, callback: (data: string, cols: number, rows: number) => void) => {
    terminalMocks.scrollback = callback;
    return () => {};
  },
}));
vi.mock('./api', () => ({
  fetchNotes: vi.fn().mockResolvedValue('Notes from desktop'),
  saveNotes: vi.fn(),
  ApiError: class extends Error {},
}));

let host: HTMLDivElement;
let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  terminalMocks.options.fontSize = 14;
  localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  dispose?.();
  host.remove();
  vi.restoreAllMocks();
});
function mount() {
  dispose = render(
    () => (
      <AgentDetail
        agentId="a1"
        taskName="First task"
        onBack={() => {}}
        onNeedsPairing={() => {}}
        onNextTask={() => {}}
      />
    ),
    host,
  );
}
function composer() {
  const field = host.querySelector<HTMLTextAreaElement>('[aria-label="Message agent"]');
  if (!field) throw new Error('Missing composer');
  return field;
}
function type(text: string) {
  composer().value = text;
  composer().dispatchEvent(new Event('input', { bubbles: true }));
}
function bashButton() {
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Shell command mode"]');
  if (!button) throw new Error('Missing shell command button');
  return button;
}
function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  button.click();
}

describe('phone reply composer', () => {
  it('resizes a restored multiline reply after returning from Notes', async () => {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
    localStorage.setItem('parallel-mobile:reply:a1', 'First line\nSecond line\nThird line');
    mount();
    await vi.waitFor(() => expect(composer().style.height).toBe('120px'));
    click('Notes');
    click('Terminal');
    await vi.waitFor(() => expect(composer().style.height).toBe('120px'));
    expect(composer().value).toBe('First line\nSecond line\nThird line');
  });
  it('preserves the draft until accepted and does not submit on plain Enter', async () => {
    let accept!: () => void;
    vi.mocked(sendInput).mockReturnValue(
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    mount();
    type('First line\nSecond line');
    composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(sendInput).not.toHaveBeenCalled();
    click('Send');
    expect(composer().value).toBe('First line\nSecond line');
    expect(composer().disabled).toBe(true);
    expect(sendInput).toHaveBeenCalledWith('a1', '\x1b[200~First line\nSecond line\x1b[201~', {
      submit: true,
    });
    accept();
    await vi.waitFor(() => expect(composer().value).toBe(''));
    expect(localStorage.getItem('parallel-mobile:reply:a1')).toBeNull();
    expect(host.textContent).toContain('Accepted by terminal');
  });
  it('sends a shell command as one request the server can keep ordered', async () => {
    vi.mocked(sendInput).mockResolvedValue(undefined);
    mount();
    bashButton().click();
    type('ls -la');
    click('Send');
    await vi.waitFor(() => expect(composer().value).toBe(''));
    expect(vi.mocked(sendInput).mock.calls).toEqual([
      ['a1', '\x1b[200~ls -la\x1b[201~', { submit: true, prefixKey: '!' }],
    ]);
    // The agent's shell prompt closes after the command, so the next reply is text.
    expect(bashButton().getAttribute('aria-pressed')).toBe('false');
  });
  it('switches to the shell when "!" opens an empty prompt, as the desktop TUI does', () => {
    mount();
    type('!');
    expect(bashButton().getAttribute('aria-pressed')).toBe('true');
    expect(composer().value).toBe('');
    expect(composer().placeholder).toBe('Shell command…');
  });
  it('still sends a message that merely begins with "!" as text', async () => {
    vi.mocked(sendInput).mockResolvedValue(undefined);
    localStorage.setItem('parallel-mobile:reply:a1', '!important: do not deploy');
    mount();
    expect(bashButton().getAttribute('aria-pressed')).toBe('false');
    click('Send');
    await vi.waitFor(() => expect(composer().value).toBe(''));
    expect(vi.mocked(sendInput).mock.calls).toEqual([
      ['a1', '\x1b[200~!important: do not deploy\x1b[201~', { submit: true }],
    ]);
  });
  it('keeps shell mode with the draft when a send fails or the task is reopened', async () => {
    vi.mocked(sendInput).mockRejectedValue(new Error('Delivery could not be confirmed'));
    mount();
    bashButton().click();
    type('npm test');
    click('Send');
    await vi.waitFor(() => expect(host.textContent).toContain('Delivery could not be confirmed'));
    expect(bashButton().getAttribute('aria-pressed')).toBe('true');
    dispose();
    mount();
    expect(composer().value).toBe('npm test');
    expect(bashButton().getAttribute('aria-pressed')).toBe('true');
  });
  it('keeps a failed draft and restores it when reopening the task', async () => {
    vi.mocked(sendInput).mockRejectedValue(new Error('Delivery could not be confirmed'));
    mount();
    type('Do not lose this');
    click('Send');
    await vi.waitFor(() => expect(host.textContent).toContain('Delivery could not be confirmed'));
    expect(composer().value).toBe('Do not lose this');
    dispose();
    mount();
    expect(composer().value).toBe('Do not lose this');
  });
  it('retains an empty notes draft instead of reloading the deleted text', async () => {
    mount();
    click('Notes');
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLTextAreaElement>('#task-notes')?.value).toBe(
        'Notes from desktop',
      ),
    );
    const notes = host.querySelector<HTMLTextAreaElement>('#task-notes');
    if (!notes) throw new Error('Missing notes');
    notes.value = '';
    notes.dispatchEvent(new Event('input', { bubbles: true }));
    dispose();
    mount();
    click('Notes');
    expect(host.querySelector<HTMLTextAreaElement>('#task-notes')?.value).toBe('');
    expect(host.textContent).toContain('Draft saved on this phone');
  });
});

describe('phone terminal viewport', () => {
  function viewport(height = 1200) {
    const scroller = host.querySelector<HTMLDivElement>('.mobile-terminal-scroll');
    const content = host.querySelector<HTMLDivElement>('.mobile-terminal');
    if (!scroller || !content) throw new Error('Missing terminal viewport');
    let top = 0;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: height },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(height - 300, value));
        },
      },
    });
    return { scroller, content };
  }
  function touch(target: HTMLElement, type: string, x: number, y: number, count = 1) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', {
      value: Array.from({ length: count }, (_, identifier) => ({
        clientX: x,
        clientY: y,
        identifier,
      })),
    });
    target.dispatchEvent(event);
    return event;
  }

  it('fits the desktop columns to the phone and repaints on open and return from Notes', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
    mount();
    const { content } = viewport();
    terminalMocks.scrollback?.('', 120, 40);
    await vi.waitFor(() => expect(terminalMocks.refresh).toHaveBeenCalledWith(0, 39));
    const fittedFontSize = terminalMocks.options.fontSize;
    expect(fittedFontSize).toBeGreaterThan(0);
    expect(fittedFontSize).toBeLessThan(14);
    expect(content.style.zoom).toBe('');
    expect(parseFloat(content.style.width)).toBeLessThanOrEqual(360);
    click('A+');
    await vi.waitFor(() =>
      expect(terminalMocks.options.fontSize).toBeCloseTo(fittedFontSize * 1.25),
    );
    click('Notes');
    terminalMocks.refresh.mockClear();
    click('Terminal');
    await vi.waitFor(() => expect(terminalMocks.refresh).toHaveBeenCalledWith(0, 39));
  });

  it('keeps a wide grid readable and overflowing so a full-screen agent UI can be panned', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    mount();
    const { content } = viewport();
    terminalMocks.scrollback?.('', 120, 40);
    await vi.waitFor(() => expect(terminalMocks.refresh).toHaveBeenCalledWith(0, 39));
    // Fitting to the width alone would land near 4px per row and fit the pane exactly.
    expect(terminalMocks.options.fontSize).toBeGreaterThan(10);
    expect(parseFloat(content.style.width)).toBeGreaterThan(360);
  });

  it('opens Terminal with immediately usable keys even with the old Read preference', async () => {
    localStorage.setItem('parallel-mobile:output-view', 'output');
    vi.mocked(sendInput).mockResolvedValue(undefined);
    mount();
    expect(host.querySelector('.mobile-terminal-hidden')).toBeNull();
    expect(host.querySelector('[aria-expanded]')).toBeNull();
    expect([...host.querySelectorAll('nav button')].map((button) => button.textContent)).toEqual([
      'Terminal',
      'Notes',
    ]);
    click('Enter');
    expect(sendInput).toHaveBeenCalledWith('a1', '\r');
    await vi.waitFor(() => expect(composer().disabled).toBe(false));
  });

  it('pans the desktop grid before scrolling history and shields gestures from xterm', () => {
    localStorage.setItem('parallel-mobile:output-view', 'terminal');
    mount();
    const { scroller, content } = viewport();
    const xtermGesture = vi.fn();
    document.addEventListener('touchmove', xtermGesture);
    try {
      touch(content, 'touchstart', 100, 100);
      const move = touch(content, 'touchmove', 50, 50);
      expect(scroller.scrollLeft).toBe(50);
      expect(scroller.scrollTop).toBe(50);
      expect(terminalMocks.scrollLines).not.toHaveBeenCalled();
      expect(move.defaultPrevented).toBe(true);
      expect(xtermGesture).not.toHaveBeenCalled();
      scroller.scrollTop = 900;
      touch(content, 'touchmove', 50, 0);
      expect(terminalMocks.scrollLines).toHaveBeenCalledWith(2);
      expect(touch(content, 'touchmove', 50, 0, 2).defaultPrevented).toBe(false);
    } finally {
      document.removeEventListener('touchmove', xtermGesture);
    }
  });

  it('scrolls history from the empty pane below a fitted terminal without typing into the agent', () => {
    mount();
    const { scroller } = viewport(300);
    touch(scroller, 'touchstart', 100, 200);
    const move = touch(scroller, 'touchmove', 100, 260);
    expect(terminalMocks.scrollLines).toHaveBeenCalledWith(-3);
    expect(move.defaultPrevented).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('handles wheel scrolling before xterm consumes it, while preserving browser zoom', () => {
    mount();
    const { content } = viewport(300);
    const xtermWheel = vi.fn();
    content.addEventListener('wheel', xtermWheel);
    const wheel = new WheelEvent('wheel', {
      deltaY: -3,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      bubbles: true,
      cancelable: true,
    });
    content.dispatchEvent(wheel);
    expect(terminalMocks.scrollLines).toHaveBeenCalledWith(-3);
    expect(xtermWheel).not.toHaveBeenCalled();
    expect(wheel.defaultPrevented).toBe(true);
    terminalMocks.scrollLines.mockClear();
    const zoom = new WheelEvent('wheel', {
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    // happy-dom's WheelEvent omits MouseEvent modifier keys.
    Object.defineProperty(zoom, 'ctrlKey', { value: true });
    content.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(false);
    expect(terminalMocks.scrollLines).not.toHaveBeenCalled();
    expect(xtermWheel).not.toHaveBeenCalled();
  });

  it('does not jump when a pinch returns to one finger', () => {
    mount();
    const { scroller } = viewport(300);
    touch(scroller, 'touchstart', 100, 100);
    touch(scroller, 'touchmove', 100, 300, 2);
    touch(scroller, 'touchmove', 100, 500);
    expect(terminalMocks.scrollLines).not.toHaveBeenCalled();
    touch(scroller, 'touchmove', 100, 560);
    expect(terminalMocks.scrollLines).toHaveBeenCalledWith(-3);
  });

  it('opens a task at the latest rows without yanking a scrolled reader on reconnect', async () => {
    localStorage.setItem('parallel-mobile:output-view', 'terminal');
    mount();
    const { scroller } = viewport();
    terminalMocks.scrollback?.('', 100, 60);
    await vi.waitFor(() => expect(scroller.scrollTop).toBe(900));
    scroller.scrollTop = 120;
    scroller.dispatchEvent(new Event('scroll'));
    terminalMocks.scrollback?.('', 100, 60);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(scroller.scrollTop).toBe(120);
  });
});
