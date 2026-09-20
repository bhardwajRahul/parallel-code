import { act, createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountChat, type ChatProps } from './CopilotChat.react';
import { chatMessages } from '../../../electron/shared/chat-messages';
import { getDeepActiveElement } from '../../lib/dom-focus';

vi.mock('@copilotkit/react-core/v2/styles.css?inline', () => ({ default: '' }));

// Keep the real composer, transcript, slots, and approval cards. Only the agent
// connection is local so these tests cannot launch a CLI or contact a service.
vi.mock('@copilotkit/react-core/v2', async (original) => {
  const actual = await original<typeof import('@copilotkit/react-core/v2')>();
  const { HttpAgent } = await import('@ag-ui/client');
  const agent = new HttpAgent({ url: 'http://unused.test' });
  return {
    ...actual,
    useAgent: () => ({ agent, isReady: true }),
    CopilotKitProvider: (props: Parameters<typeof actual.CopilotKitProvider>[0]) =>
      createElement(actual.CopilotKitProvider, {
        ...props,
        runtimeUrl: undefined,
        selfManagedAgents: { conversation: agent },
      }),
  };
});

let host: HTMLDivElement;
let shadow: ShadowRoot;
let view: ReturnType<typeof mountChat>;
let props: ChatProps;
const send = vi.fn(async () => {});
const respond = vi.fn(async () => {});
async function update(patch: Partial<ChatProps> = {}) {
  props = { ...props, ...patch };
  props.messages = chatMessages(props.state);
  await act(async () => view.update(props));
}
const composer = () => {
  const input = shadow.querySelector('textarea');
  if (!input) throw new Error('Chat composer is missing');
  return input;
};

/** Types `text` at the end of the draft one character at a time, as a keyboard does. */
async function type(text: string) {
  for (const data of text) {
    const input = composer();
    const value = input.value + data;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      input,
      value,
    );
    input.setSelectionRange(value.length, value.length);
    await act(async () =>
      input.dispatchEvent(new InputEvent('input', { data, bubbles: true, composed: true })),
    );
    await update();
  }
}
async function pickFile(path: string) {
  await type(' @');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => button(path).click());
  await act(async () => button('Done').click());
  await update();
}
async function drop(files: File[]) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } });
  await act(async () => {
    composer().dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  shadow = host.attachShadow({ mode: 'open' });
  view = mountChat(shadow);
  props = {
    agentName: 'Claude',
    connection: { url: 'http://unused.test/runtime', token: 'test' },
    state: {
      status: 'ready',
      threadId: 'thread',
      items: [{ id: 'u', kind: 'user', text: 'Earlier prompt' }],
      requests: [],
    },
    messages: [],
    draft: 'Keep my draft',
    dark: false,
    disabled: false,
    active: true,
    onDraft: (draft) => {
      props = { ...props, draft };
    },
    onSend: send,
    onStop: vi.fn(async () => {}),
    onRespond: respond,
    onActions: vi.fn(),
    onSelectModel: vi.fn(async () => {}),
    onReloadModels: vi.fn(async () => {}),
  };
});
afterEach(async () => {
  await act(async () => view.dispose());
  host.remove();
  vi.unstubAllGlobals();
});

it('keeps a rejected draft in the real composer and exposes its shadow focus to the app', async () => {
  send.mockRejectedValueOnce(new Error('Agent disconnected'));
  await update();
  composer().focus();
  expect(getDeepActiveElement()).toBe(composer());
  await act(async () =>
    composer().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    ),
  );
  await update();
  expect(send).toHaveBeenCalledWith('Keep my draft', expect.any(Function));
  expect(composer().value).toBe('Keep my draft');
  expect(shadow.querySelector('[role="alert"]')?.textContent).toContain('Agent disconnected');
});

it('keeps an in-progress draft focused when a request arrives', async () => {
  await update();
  composer().focus();
  await update({
    state: {
      ...props.state,
      status: 'working',
      requests: [{ id: 'approval', kind: 'approval', text: 'Run tests?', since: 1 }],
    },
  });
  expect(getDeepActiveElement()).toBe(composer());
  expect(composer().value).toBe('Keep my draft');
  expect(shadow.querySelector('.chat-request')?.textContent).toContain('Run tests?');
});

it('returns focus to the surviving composer after a streamed request disappears', async () => {
  let release = () => {};
  respond.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await update({ draft: '' });
  composer().focus();
  await update({
    state: {
      ...props.state,
      status: 'working',
      requests: [{ id: 'approval', kind: 'approval', text: 'Run tests?', since: 1 }],
    },
  });
  expect(shadow.activeElement?.textContent).toBe('Allow once');
  await act(async () => (shadow.activeElement as HTMLButtonElement).click());
  await update({ state: { ...props.state, requests: [] } });
  await act(async () => release());
  expect(getDeepActiveElement()).toBe(composer());
});

const button = (label: string) => {
  const element = Array.from(shadow.querySelectorAll('button')).find(
    (button) => button.textContent === label || button.getAttribute('aria-label') === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
};

it('queues during execution, then sends once after the agent becomes ready', async () => {
  await update({ state: { ...props.state, status: 'working' } });
  await act(async () => button('Queue message').click());
  expect(send).not.toHaveBeenCalled();
  expect(props.draft).toBe('');
  expect(shadow.querySelector('.chat-queue')?.textContent).toContain('Keep my draft');
  await update({ state: { ...props.state, status: 'ready' } });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('Keep my draft', expect.any(Function));
  expect(shadow.querySelector('.chat-queue')).toBeNull();
});

it('retains a failed queued message and only retries on request', async () => {
  await update({ state: { ...props.state, status: 'working' } });
  await act(async () => button('Queue message').click());
  send.mockRejectedValueOnce(new Error('Disconnected'));
  await update({ state: { ...props.state, status: 'ready' } });
  await update();
  expect(send).toHaveBeenCalledTimes(1);
  expect(shadow.querySelector('.chat-queue')?.textContent).toContain('Queue paused');
  await act(async () => button('Retry queued message').click());
  expect(send).toHaveBeenCalledTimes(2);
  expect(shadow.querySelector('.chat-queue')).toBeNull();
});

it('interrupts first and waits for confirmed idle before sending a follow-up', async () => {
  await update({ state: { ...props.state, status: 'working' } });
  await act(async () => button('Interrupt and send now').click());
  expect(props.onStop).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  await update({ state: { ...props.state, status: 'ready' } });
  expect(send).toHaveBeenCalledTimes(1);
});

it('preserves the draft if interruption fails', async () => {
  await update({
    state: { ...props.state, status: 'working' },
    onStop: vi.fn(async () => {
      throw new Error('Could not stop');
    }),
  });
  await act(async () => button('Interrupt and send now').click());
  expect(props.draft).toBe('Keep my draft');
  expect(send).not.toHaveBeenCalled();
  expect(shadow.querySelector('.chat-queue')).toBeNull();
});

it('blocks Enter during interruption and sends the original prompt while preserving a newer draft', async () => {
  let release = () => {};
  await update({
    state: { ...props.state, status: 'working' },
    onStop: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    onListFiles: async () => ['src/app.ts'],
  });
  await pickFile('src/app.ts');
  await act(async () => button('Interrupt and send now').click());
  await act(async () =>
    composer().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(shadow.querySelector('.chat-queue')).toBeNull();
  expect(props.draft).toBe('Keep my draft ');
  await update({ draft: 'Still writing this' });
  await act(async () => release());
  await update({ state: { ...props.state, status: 'ready' } });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(
    'Keep my draft\n\nReferenced files:\n"src/app.ts"',
    expect.any(Function),
  );
  expect(props.draft).toBe('Still writing this');
  expect(shadow.querySelector('.chat-queue')).toBeNull();
});

it('routes markdown file links with locations without intercepting external links', async () => {
  const onOpenFile = vi.fn();
  await update({
    onOpenFile,
    state: {
      ...props.state,
      items: [
        {
          id: 'links',
          kind: 'assistant',
          text: '[Source](/worktree/src/app.ts:12:3) [Readme](README.md:12) [Relative](src/app.ts:4) [Space](docs/design%20notes.md:9) [Web](https://example.com:123) [Email](mailto:dev@example.com) [Unsafe](javascript:alert%281%29) `README.md:12`',
        },
      ],
    },
  });
  const links = Array.from(shadow.querySelectorAll('a'));
  for (const label of ['Source', 'Readme', 'Relative', 'Space', 'Web', 'Email']) {
    const link = links.find((link) => link.textContent === label);
    expect(link, label).toBeDefined();
    await act(async () =>
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    );
  }
  expect(onOpenFile.mock.calls).toEqual([
    ['/worktree/src/app.ts:12:3'],
    ['README.md:12'],
    ['src/app.ts:4'],
    ['docs/design notes.md:9'],
  ]);
  expect(links.some((link) => link.getAttribute('href')?.startsWith('javascript:'))).toBe(false);
  expect(shadow.querySelector('code')?.textContent).toBe('README.md:12');
});

it('keeps a cancelled queue edit and the existing draft intact', async () => {
  await update({ state: { ...props.state, status: 'working' } });
  await act(async () => button('Queue message').click());
  await update({ draft: 'A different draft' });
  vi.stubGlobal(
    'confirm',
    vi.fn(() => false),
  );
  await act(async () => button('Edit').click());
  expect(props.draft).toBe('A different draft');
  expect(shadow.querySelector('.chat-queue')?.textContent).toContain('Keep my draft');
});

it('groups activity and preserves open details when another operation arrives', async () => {
  const tool = (id: string) => ({
    id,
    kind: 'tool' as const,
    text: 'output',
    activity: {
      type: 'command' as const,
      label: 'npm test',
      status: 'completed' as const,
      exitCode: 0,
    },
  });
  await update({
    state: { ...props.state, items: [...props.state.items, tool('one'), tool('two')] },
  });
  const group = shadow.querySelector<HTMLDetailsElement>('.chat-activity-group > details');
  if (!group) throw new Error('Missing activity group');
  group.open = true;
  const row = shadow.querySelector<HTMLDetailsElement>('.chat-tool');
  if (!row) throw new Error('Missing activity row');
  row.open = true;
  await update({ state: { ...props.state, items: [...props.state.items, tool('three')] } });
  expect(shadow.querySelectorAll('.chat-activity-group')).toHaveLength(1);
  expect(shadow.querySelector('.chat-activity-group > details')).toBe(group);
  expect(group.open).toBe(true);
  expect(shadow.querySelector('.chat-tool')).toBe(row);
  expect(row.open).toBe(true);
  expect(group.textContent).toContain('3 operations');
});

it('opens failed activity and connects file actions to the existing review surface', async () => {
  const onReview = vi.fn();
  const onOpenFile = vi.fn();
  await update({
    onReview,
    onOpenFile,
    state: {
      ...props.state,
      items: [
        {
          id: 'failed',
          kind: 'tool',
          text: 'Patch failed',
          activity: { type: 'files', files: ['src/app.ts'], label: 'src/app.ts', status: 'failed' },
        },
      ],
    },
  });
  expect(shadow.querySelector<HTMLDetailsElement>('.chat-activity-group > details')?.open).toBe(
    true,
  );
  expect(shadow.querySelector<HTMLDetailsElement>('.chat-tool')?.open).toBe(true);
  await act(async () => button('Review diff').click());
  expect(onReview).toHaveBeenCalledWith('src/app.ts');
  await act(async () => button('src/app.ts').click());
  expect(onOpenFile).toHaveBeenCalledWith('src/app.ts');
});

it('renders effective model and permission settings together in the composer', async () => {
  const onPermissionMode = vi.fn(async () => {});
  await update({
    permissionMode: 'plan',
    onPermissionMode,
    state: {
      ...props.state,
      model: 'model-a',
      models: [
        {
          model: 'model-a',
          displayName: 'Model A',
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Thorough' }],
        },
      ],
    },
  });
  expect(shadow.querySelector<HTMLSelectElement>('[aria-label="Model"]')?.value).toBe('model-a');
  expect(shadow.querySelector<HTMLSelectElement>('[aria-label="Reasoning effort"]')?.value).toBe(
    'high',
  );
  const mode = shadow.querySelector<HTMLSelectElement>('[aria-label="Permission mode"]');
  if (!mode) throw new Error('Missing permission control');
  expect(mode.value).toBe('plan');
  await act(async () => {
    mode.value = 'auto';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(onPermissionMode).toHaveBeenCalledWith('auto');
});

it('retains queued follow-ups across reconnects and requires an explicit retry', async () => {
  await update({ state: { ...props.state, status: 'working' } });
  await act(async () => button('Queue message').click());
  await update({
    connection: { ...props.connection, url: 'http://reconnected.test/runtime' },
    state: { ...props.state, status: 'ready' },
  });
  expect(send).not.toHaveBeenCalled();
  expect(shadow.querySelector('.chat-queue')?.textContent).toContain('Queue paused');
  await act(async () => button('Retry queued message').click());
  expect(send).toHaveBeenCalledTimes(1);
});

it('does not submit while an IME composition is active', async () => {
  await update();
  await act(async () =>
    composer().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(send).not.toHaveBeenCalled();
});

it('allows file references to be removed and sends selected paths as visible context', async () => {
  await update({ onListFiles: async () => ['src/app.ts', 'README.md'] });
  await pickFile('src/app.ts');
  expect(shadow.querySelector('.chat-context-chips')?.textContent).toContain('src/app.ts');
  expect(props.draft).toBe('Keep my draft ');
  expect(getDeepActiveElement()).toBe(composer());
  expect(composer().selectionStart).toBe('Keep my draft '.length);
  await act(async () => button('Send message').click());
  expect(send).toHaveBeenCalledWith(
    'Keep my draft\n\nReferenced files:\n"src/app.ts"',
    expect.any(Function),
  );
  expect(shadow.querySelector('.chat-context-chips')?.textContent).not.toContain('src/app.ts');
});

it('keeps a typed @ when the file search closes without a choice', async () => {
  await update({ onListFiles: async () => ['src/app.ts'] });
  await type('a@');
  expect(shadow.querySelector('.chat-file-picker')).toBeNull();
  await type(' @');
  await act(async () => button('Done').click());
  expect(shadow.querySelector('.chat-file-picker')).toBeNull();
  expect(props.draft).toBe('Keep my drafta@ @');
  await update();
  expect(composer().selectionStart).toBe('Keep my drafta@ @'.length);
});

it('puts the caret where the @ was when a file is picked mid-draft', async () => {
  await update({ onListFiles: async () => ['src/app.ts'] });
  const input = composer();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
    input,
    'Keep @my draft',
  );
  input.setSelectionRange(6, 6);
  await act(async () =>
    input.dispatchEvent(new InputEvent('input', { data: '@', bubbles: true, composed: true })),
  );
  await update();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => button('src/app.ts').click());
  await act(async () => button('Done').click());
  await update();
  expect(props.draft).toBe('Keep my draft');
  expect(composer().selectionStart).toBe(5);
});

it('references dropped files by path and rejects files with none', async () => {
  const paths = new Map([
    ['app.ts', 'src/app.ts'],
    ['report.pdf', '/home/me/Downloads/report.pdf'],
  ]);
  await update({ dropPathFor: (file) => paths.get(file.name) });
  await drop([new File(['x'], 'app.ts'), new File(['x'], 'report.pdf')]);
  const chips = shadow.querySelector('.chat-context-chips')?.textContent;
  expect(chips).toContain('src/app.ts');
  expect(chips).toContain('/home/me/Downloads/report.pdf');
  await drop([new File(['x'], 'from-browser.txt')]);
  expect(shadow.querySelector('[role="alert"]')?.textContent).toContain('from-browser.txt');
});

it('keeps the usable part of a drop that also holds a file without a path', async () => {
  const onDisk = new File(['x'], 'app.ts');
  await update({ dropPathFor: (file) => (file === onDisk ? 'src/app.ts' : undefined) });
  await drop([
    new File(['image data'], 'screen.png', { type: 'image/png' }),
    onDisk,
    new File(['x'], 'notes.txt'),
  ]);
  const chips = shadow.querySelector('.chat-context-chips')?.textContent;
  expect(chips).toContain('screen.png');
  expect(chips).toContain('src/app.ts');
  expect(shadow.querySelector('[role="alert"]')?.textContent).toContain('notes.txt');
});

it('finds tool output inside collapsed activity and opens the matching entry', async () => {
  const scrollIntoView = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scrollIntoView);
  await update({
    state: {
      ...props.state,
      items: [
        {
          id: 'tool',
          kind: 'tool',
          text: 'needle in command output',
          activity: { type: 'command', label: 'npm test', status: 'completed' },
        },
      ],
    },
  });
  await act(async () => button('Search conversation').click());
  const input = shadow.querySelector<HTMLInputElement>('[aria-label="Search conversation"]');
  if (!input) throw new Error('Missing search field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'needle',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const result = shadow.querySelector<HTMLButtonElement>('.chat-search-results button');
  expect(result?.textContent).toContain('needle');
  await act(async () => result?.click());
  expect(shadow.querySelector<HTMLDetailsElement>('.chat-tool')?.open).toBe(true);
  expect(shadow.querySelector<HTMLDetailsElement>('.chat-activity-group > details')?.open).toBe(
    true,
  );
  expect(scrollIntoView).toHaveBeenCalled();
});

it('keeps queued work when the chat view is remounted and pauses delivery', async () => {
  await update({ state: { ...props.state, status: 'working' } });
  await act(async () => button('Queue message').click());
  await act(async () => view.dispose());
  view = mountChat(shadow);
  await update({ state: { ...props.state, status: 'ready' } });
  expect(send).not.toHaveBeenCalled();
  expect(shadow.querySelector('.chat-queue')?.textContent).toContain('Keep my draft');
  expect(shadow.querySelector('.chat-queue')?.textContent).toContain('Queue paused');
});

it('reuses a prompt as a new draft without changing earlier messages', async () => {
  await update({ draft: '' });
  await act(async () => button('Use as new prompt').click());
  expect(props.draft).toBe('Earlier prompt');
  expect(props.state.items).toEqual([{ id: 'u', kind: 'user', text: 'Earlier prompt' }]);
  expect(send).not.toHaveBeenCalled();
  expect(getDeepActiveElement()).toBe(composer());
});

it('retains image context when delivery fails', async () => {
  await update();
  await drop([new File(['image data'], 'screen.png', { type: 'image/png' })]);
  expect(shadow.querySelector('.chat-context-chips')?.textContent).toContain('screen.png');
  send.mockRejectedValueOnce(new Error('Disconnected'));
  await act(async () => button('Send message').click());
  expect(shadow.querySelector('.chat-context-chips')?.textContent).toContain('screen.png');
  expect(props.draft).toBe('Keep my draft');
});
