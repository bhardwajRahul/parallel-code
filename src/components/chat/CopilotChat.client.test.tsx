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
