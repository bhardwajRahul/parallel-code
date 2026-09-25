import { describe, expect, it, vi } from 'vitest';
import { createTerminalQueryResponder } from './terminal-query-responder.js';

function setup(cols = 80, rows = 24) {
  const replies: string[] = [];
  const responder = createTerminalQueryResponder({
    cols,
    rows,
    reply: (data) => replies.push(data),
  });
  return { responder, replies };
}

// Give the headless parser time to emit any reply it is going to emit.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('createTerminalQueryResponder', () => {
  it('answers a cursor-position query with the position after the preceding output', async () => {
    const { responder, replies } = setup();
    responder.feed('hello\r\nworld\x1b[6n');
    await vi.waitFor(() => expect(replies).toEqual(['\x1b[2;6R']));
  });

  it('answers the DEC form of the query', async () => {
    const { responder, replies } = setup();
    responder.feed('ab\x1b[?6n');
    await vi.waitFor(() => expect(replies).toEqual(['\x1b[?1;3R']));
  });

  it('leaves device-attribute and status queries to the renderer', async () => {
    const { responder, replies } = setup();
    responder.feed('\x1b[c\x1b[>c\x1b[5n\x1b[?1004$p\x1b[6n');
    await vi.waitFor(() => expect(replies).toEqual(['\x1b[1;1R']));
    await settle();
    expect(replies).toEqual(['\x1b[1;1R']);
  });

  it('tracks display-only text but does not answer queries in it', async () => {
    const { responder, replies } = setup();
    responder.feedDisplayOnly('[docker] banner\r\n\x1b[6n');
    responder.feed('\x1b[6n');
    await vi.waitFor(() => expect(replies).toEqual(['\x1b[2;1R']));
    await settle();
    expect(replies).toEqual(['\x1b[2;1R']);
  });

  it('follows the PTY size', async () => {
    const { responder, replies } = setup(80, 10);
    responder.feed('\r\n'.repeat(8));
    responder.resize(40, 5);
    responder.feed('\x1b[6n');
    await vi.waitFor(() => expect(replies).toEqual(['\x1b[5;1R']));
  });

  it('stops answering once disposed', async () => {
    const { responder, replies } = setup();
    responder.dispose();
    responder.feed('\x1b[6n');
    responder.dispose();
    await settle();
    expect(replies).toEqual([]);
  });
});
