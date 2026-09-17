import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestCard } from './RequestCard.react';
import type { ChatRequest } from '../../../electron/shared/agent-chat-types';

// The chat mounts into a shadow root in the app, and focus reads differently there:
// `shadowRoot.activeElement` is null whenever focus sits outside it.
let host: HTMLDivElement;
let shadow: ShadowRoot;
let composer: HTMLTextAreaElement;
let container: HTMLDivElement;
let root: Root;
const respond = vi.fn(async () => undefined);
const onResolved = vi.fn(() => composer.focus());
const approval = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  id: 7,
  since: 1,
  kind: 'approval',
  text: 'Run npm test?',
  ...overrides,
});
const question = (): ChatRequest =>
  approval({
    kind: 'question',
    text: 'Claude needs your input',
    questions: [
      {
        id: 'scope',
        question: 'Which scope?',
        isSecret: false,
        options: [{ label: 'Narrow', description: 'Only this file' }],
      },
    ],
  });
const focused = () => shadow.activeElement?.textContent;
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((node) => node.textContent === label);
async function show(request: ChatRequest, autoFocus = true) {
  await act(async () =>
    root.render(
      createElement(RequestCard, { request, respond, agentName: 'Claude', autoFocus, onResolved }),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  shadow = host.attachShadow({ mode: 'open' });
  container = document.createElement('div');
  composer = document.createElement('textarea');
  shadow.append(container, composer);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('approval card keyboard handling', () => {
  it('leaves focus in an external input, including an empty dialog input', async () => {
    const outside = document.createElement('input');
    document.body.append(outside);
    try {
      outside.focus();
      await show(approval());
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  it('does not focus an approval behind a modal even if its input has not focused yet', async () => {
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    try {
      composer.focus();
      await show(approval());
      expect(shadow.activeElement).toBe(composer);
    } finally {
      modal.remove();
    }
  });

  it('restores focus when the state update removes the card before IPC resolves', async () => {
    let release = () => {};
    respond.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    await show(approval());
    await act(async () => button('Allow once')?.click());
    await act(async () => root.render(null));
    await act(async () => release());
    expect(onResolved).toHaveBeenCalledOnce();
    expect(shadow.activeElement).toBe(composer);
  });

  it('does not restore focus after removal if the user moved to another input', async () => {
    let release = () => {};
    respond.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    await show(approval());
    await act(async () => button('Allow once')?.click());
    await act(async () => root.render(null));
    composer.focus();
    await act(async () => release());
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('opens on Allow once so Enter approves, then hands the keyboard back', async () => {
    await show(approval());
    expect(focused()).toBe('Allow once');
    expect(button('Allow once')?.className).toContain('chat-request-default');
    // A focused button is what makes Enter mean "allow"; prove it reaches respond.
    await act(async () => (shadow.activeElement as HTMLButtonElement).click());
    expect(respond).toHaveBeenCalledWith(approval(), 'accept', {});
    expect(onResolved).toHaveBeenCalled();
  });

  it('opens on Decline when the agent forbids a one-keystroke approval', async () => {
    await show(approval({ defaultToNo: true }));
    expect(focused()).toBe('Decline');
    expect(button('Decline')?.className).toContain('chat-request-default');
    expect(button('Allow once')?.className).not.toContain('chat-request-default');
  });

  it('leaves the keyboard alone for a chat the user is not working in', async () => {
    composer.focus();
    await show(approval(), false);
    expect(shadow.activeElement).toBe(composer);
  });

  it('never pulls the caret out of a half-written message', async () => {
    composer.value = 'also please check the';
    composer.focus();
    await show(approval());
    expect(shadow.activeElement).toBe(composer);
    // The card still marks its default, so Enter in the card means allow once.
    expect(button('Allow once')?.className).toContain('chat-request-default');
  });

  it('takes focus from an empty composer, which is how a chat panel idles', async () => {
    // Focusing the composer is how the app hands this panel the keyboard, so an
    // empty focused composer must not be mistaken for the user typing.
    composer.focus();
    await show(approval());
    expect(focused()).toBe('Allow once');
  });

  it('keeps the keyboard where the user moved it during the response round-trip', async () => {
    let release = () => {};
    respond.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    );
    await show(approval());
    await act(async () => (shadow.activeElement as HTMLButtonElement).click());
    composer.focus(); // The user clicked away while the IPC call was in flight.
    await act(async () => {
      release();
    });
    expect(onResolved).not.toHaveBeenCalled();
    expect(shadow.activeElement).toBe(composer);
  });

  it('does not re-grab focus when an older request resolves ahead of it', async () => {
    await show(approval(), false);
    const decline = button('Decline');
    decline?.focus();
    // The card ahead of this one resolved, so this one becomes the first request.
    await show(approval(), true);
    expect(shadow.activeElement).toBe(decline);
  });

  it('starts a question on its first answer control instead of a default choice', async () => {
    await show(question());
    expect(focused()).toBe('Narrow');
    expect(button('Submit answers')?.disabled).toBe(true);
  });
});

describe('approval card contents', () => {
  it('offers Always allow only when the agent said this ask can be remembered', async () => {
    await show(approval());
    expect(button('Always allow')).toBeUndefined();
    const remembered = approval({
      canAlwaysAllow: true,
      alwaysAllowNote: 'always allow Bash(npm test:*) in this checkout’s local settings',
    });
    await show(remembered);
    // Remembering is never one keystroke away: Enter still allows once.
    expect(focused()).toBe('Allow once');
    // What it writes is on the card, not only in a tooltip.
    expect(container.querySelector('.chat-request-note')?.textContent).toContain(
      'this checkout’s local settings',
    );
    await act(async () => button('Always allow')?.click());
    expect(respond).toHaveBeenCalledWith(remembered, 'accept-always', {});
  });

  it('never offers to remember an answer to a question', async () => {
    await show({ ...question(), canAlwaysAllow: true, alwaysAllowNote: 'always allow Read' });
    expect(button('Always allow')).toBeUndefined();
    expect(container.querySelector('.chat-request-note')).toBeNull();
  });

  it('leads with the prompt sentence and keeps the raw arguments folded away', async () => {
    const request = approval({
      action: 'Run command',
      text: 'Claude wants to run npm test',
      details: 'Bash\n{\n  "command": "npm test"\n}',
    });
    await show(request);
    // Naming the action must not cost the card its "this is a gate" framing.
    expect(container.querySelector('strong')?.textContent).toBe('Approval needed: Run command');
    expect(container.querySelector('.chat-request-text')?.textContent).toBe(
      'Claude wants to run npm test',
    );
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('pre')?.textContent).toContain('"command": "npm test"');
  });
});
