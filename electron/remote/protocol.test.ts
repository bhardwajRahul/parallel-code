import { describe, expect, it } from 'vitest';
import { parseClientMessage } from './protocol.js';

describe('acknowledged input validation', () => {
  const input = {
    type: 'input',
    agentId: 'agent-1',
    data: 'hello',
    requestId: 'reply-1',
    submit: true,
  };
  it('retains delivery IDs and the submit flag', () => {
    expect(parseClientMessage(JSON.stringify(input))).toEqual(input);
  });
  it('retains a shell prefix keystroke', () => {
    const shell = { ...input, prefixKey: '!' };
    expect(parseClientMessage(JSON.stringify(shell))).toEqual(shell);
  });
  it.each([
    { requestId: 12 },
    { requestId: '' },
    { requestId: 'x'.repeat(81) },
    { submit: 'true' },
    { data: 'x'.repeat(4097) },
    { prefixKey: 33 },
    { prefixKey: '' },
    { prefixKey: 'rm -rf /' },
  ])('rejects invalid delivery fields %j', (invalid) => {
    expect(parseClientMessage(JSON.stringify({ ...input, ...invalid }))).toBeNull();
  });
});
