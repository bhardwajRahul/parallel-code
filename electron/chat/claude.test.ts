import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Query,
  Options,
  SDKUserMessage,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { ClaudeChat } from './claude.js';

const chats: ClaudeChat[] = [];
afterEach(() => {
  chats.forEach((chat) => chat.stop());
  chats.length = 0;
});
function harness(history: SessionMessage[] = [], threadId?: string, env = process.env) {
  const output = new PassThrough({ objectMode: true });
  const controls = {
    initializationResult: vi.fn(async () => ({})),
    supportedModels: vi.fn(async () => [
      {
        value: 'sonnet',
        resolvedModel: 'claude-fixture',
        displayName: 'Claude Fixture',
        supportedEffortLevels: ['low', 'high'],
      },
    ]),
    applyFlagSettings: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(() => output.end()),
  };
  const sdk = {
    query: vi.fn(
      (_args: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) =>
        Object.assign(output, controls) as unknown as Query,
    ),
    getSessionMessages: vi.fn(async () => history),
  };
  const publish = vi.fn();
  const chat = new ClaudeChat(
    sdk,
    {
      provider: 'claude',
      agentId: 'agent',
      command: '/usr/bin/claude',
      cwd: '/worktree',
      env: env as Record<string, string>,
      threadId,
    },
    publish,
  );
  chats.push(chat);
  const emit = async (event: unknown) => {
    output.write(event);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const options = () => sdk.query.mock.calls[0][0].options as Options;
  async function send(text = 'Fix tests') {
    const pending = chat.send(text);
    const prompt = sdk.query.mock.calls[0][0].prompt as AsyncIterable<SDKUserMessage>;
    const iterator = prompt[Symbol.asyncIterator]();
    const { value } = await iterator.next();
    await emit(value);
    await pending;
    return value as SDKUserMessage;
  }
  return { chat, sdk, controls, emit, options, send, publish, output };
}

describe('Claude chat adapter', () => {
  it('starts an explicit local session, preserves normal settings, and loads model capabilities', async () => {
    const h = harness();
    await h.chat.start();
    expect(h.options()).toMatchObject({
      cwd: '/worktree',
      pathToClaudeCodeExecutable: '/usr/bin/claude',
      systemPrompt: { preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      extraArgs: { 'replay-user-messages': null },
    });
    expect(h.options().sessionId).toBe(h.chat.state.threadId);
    expect(h.chat.state.models?.[0]).toMatchObject({
      model: 'claude-fixture',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
    });
    expect(h.chat.state.model).toBeUndefined(); // Don't guess before Claude reports its model.
    await h.emit({ type: 'system', subtype: 'init', model: 'claude-fixture' });
    expect(h.chat.state.model).toBe('claude-fixture');
  });

  it('acknowledges prompts and reconciles partial and complete messages without duplicates', async () => {
    const h = harness();
    await h.chat.start();
    const input = await h.send();
    await h.emit({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'reply' } },
    });
    await h.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
    });
    await h.emit({
      type: 'assistant',
      uuid: 'reply-uuid',
      message: { id: 'reply', content: [{ type: 'text', text: 'Hello world' }] },
    });
    await h.emit(input);
    await h.emit({ type: 'result', subtype: 'success', is_error: false });
    expect(h.chat.state.items).toEqual([
      { id: input.uuid, kind: 'user', text: 'Fix tests' },
      { id: 'reply:0', kind: 'assistant', text: 'Hello world' },
    ]);
    expect(h.chat.state.status).toBe('ready');
  });

  it('records tools and their final results, including replay and subagent events', async () => {
    const h = harness();
    await h.chat.start();
    await h.send();
    await h.emit({
      type: 'assistant',
      uuid: 'a',
      message: {
        content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'npm test' } }],
      },
    });
    expect(h.chat.state.items[h.chat.state.items.length - 1]?.activity).toMatchObject({
      status: 'running',
      label: 'npm test',
    });
    await h.emit({
      type: 'assistant',
      parent_tool_use_id: 'tool',
      uuid: 'child',
      message: { content: [{ type: 'text', text: 'Subagent detail' }] },
    });
    const result = {
      type: 'user',
      uuid: 'result',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool', content: 'Test failed', is_error: true },
        ],
      },
    };
    await h.emit(result);
    await h.emit(result);
    expect(h.chat.state.items).toHaveLength(2);
    expect(h.chat.state.items[1].activity?.status).toBe('failed');
    expect(h.chat.state.items[1].text.match(/Test failed/g)).toHaveLength(1);
  });

  it('waits for explicit approval, returns the exact input, and clears aborted requests', async () => {
    const h = harness();
    await h.chat.start();
    await h.send();
    const signal = new AbortController();
    const input = { command: 'npm test' };
    const pending = h.options().canUseTool?.('Bash', input, {
      signal: signal.signal,
      requestId: 'request',
      toolUseID: 'tool',
    });
    expect(h.chat.state.requests).toHaveLength(1);
    const id = h.chat.state.requests[0].id;
    h.chat.respond(id, 'accept');
    await expect(pending).resolves.toEqual({ behavior: 'allow', updatedInput: input });
    expect(() => h.chat.respond(id, 'accept')).toThrow('no longer pending');
    const cancelled = h.options().canUseTool?.('Bash', input, {
      signal: signal.signal,
      requestId: 'request',
      toolUseID: 'tool-2',
    });
    signal.abort();
    await expect(cancelled).resolves.toMatchObject({ behavior: 'deny' });
    expect(h.chat.state.requests).toEqual([]);
  });

  it('maps Claude questions and validates answers before returning them', async () => {
    const h = harness();
    await h.chat.start();
    await h.send();
    const questions = [
      {
        question: 'Which features?',
        multiSelect: true,
        options: [
          { label: 'A', description: 'First' },
          { label: 'B', description: 'Second' },
        ],
      },
    ];
    const pending = h
      .options()
      .canUseTool?.(
        'AskUserQuestion',
        { questions },
        { signal: new AbortController().signal, requestId: 'request', toolUseID: 'q' },
      );
    const request = h.chat.state.requests[0];
    expect(request.questions?.[0]).toMatchObject({ id: 'Which features?', multiSelect: true });
    expect(() => h.chat.respond(request.id, 'accept', {})).toThrow('Answer every question');
    h.chat.respond(request.id, 'accept', { 'Which features?': 'A, B' });
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { questions, answers: { 'Which features?': 'A, B' } },
    });
  });

  it('applies model and effort atomically, and keeps the selection on rejection', async () => {
    const h = harness();
    await h.chat.start();
    await h.chat.selectModel('claude-fixture', 'high');
    expect(h.controls.applyFlagSettings).toHaveBeenCalledWith({
      model: 'claude-fixture',
      effortLevel: 'high',
    });
    await expect(h.chat.selectModel('unknown')).rejects.toThrow('not available');
    await expect(h.chat.selectModel('claude-fixture', 'max')).rejects.toThrow('not supported');
    h.controls.applyFlagSettings.mockRejectedValueOnce(new Error('Not supported by this CLI'));
    await expect(h.chat.selectModel('claude-fixture', 'low')).rejects.toThrow('Not supported');
    expect(h.chat.state).toMatchObject({
      model: 'claude-fixture',
      reasoningEffort: 'high',
      status: 'ready',
    });
    await h.chat.selectModel('claude-fixture');
    expect(h.controls.applyFlagSettings).toHaveBeenLastCalledWith({
      model: 'claude-fixture',
      effortLevel: null,
    });
    await h.send();
    await expect(h.chat.selectModel('claude-fixture')).rejects.toThrow('Wait for Claude');
  });

  it('explains a launch failure with the CLI output', async () => {
    const h = harness();
    h.controls.initializationResult.mockImplementationOnce(async () => {
      h.options().stderr?.('claude: command not found\n');
      throw new Error('Claude Code exited before it was ready.');
    });
    await expect(h.chat.start()).rejects.toThrow(
      /exited before it was ready[\s\S]*command not found/,
    );
  });

  it('refuses a task-specific config directory before opening a session', async () => {
    const h = harness([], undefined, { ...process.env, CLAUDE_CONFIG_DIR: '/task/local' });
    await expect(h.chat.start()).rejects.toThrow('task-specific CLAUDE_CONFIG_DIR');
    expect(h.sdk.query).not.toHaveBeenCalled();
  });

  it('restores the saved session and its history without starting a replacement conversation', async () => {
    const h = harness(
      [
        {
          type: 'assistant',
          uuid: 'old',
          session_id: 'saved',
          parent_tool_use_id: null,
          parent_agent_id: null,
          message: { id: 'old-message', content: [{ type: 'text', text: 'Earlier answer' }] },
        },
      ],
      'saved',
    );
    await h.chat.start();
    expect(h.sdk.getSessionMessages).toHaveBeenCalledWith('saved', { dir: '/worktree' });
    expect(h.options().resume).toBe('saved');
    expect(h.options().sessionId).toBeUndefined();
    expect(h.chat.state.items[0].text).toBe('Earlier answer');
  });

  it('interrupts an acknowledged turn and waits for its result before accepting another prompt', async () => {
    const h = harness();
    await h.chat.start();
    await h.send();
    await h.chat.interrupt();
    expect(h.controls.interrupt).toHaveBeenCalled();
    await expect(h.chat.send('Another')).rejects.toThrow('Wait for Claude');
    await h.emit({ type: 'result', subtype: 'success', is_error: false });
    expect(h.chat.state.status).toBe('ready');
  });

  it('rejects unacknowledged sends and pending approvals on close, without reviving the session', async () => {
    const h = harness();
    await h.chat.start();
    const sending = h.chat.send('Unconfirmed');
    h.chat.stop();
    await expect(sending).rejects.toThrow('stopped');
    expect(h.chat.state.status).toBe('closed');
    expect(h.controls.close).toHaveBeenCalled();
    const other = harness();
    await other.chat.start();
    await other.send();
    const approval = other
      .options()
      .canUseTool?.(
        'Bash',
        {},
        { signal: new AbortController().signal, requestId: 'request', toolUseID: 'x' },
      );
    other.chat.stop();
    await expect(approval).resolves.toMatchObject({ behavior: 'deny' });
    expect(other.chat.state.requests).toEqual([]);
  });

  it('preserves failed-send feedback and allows catalog retry without closing chat', async () => {
    const h = harness();
    await h.chat.start();
    const sending = h.chat.send('Fail');
    const rejected = expect(sending).rejects.toThrow('Usage limit');
    await h.emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Usage limit'],
    });
    await rejected;
    expect(h.chat.state).toMatchObject({ status: 'ready', error: 'Usage limit' });
    h.controls.supportedModels.mockRejectedValueOnce(new Error('No catalog'));
    await h.chat.loadModels();
    expect(h.chat.state.modelsError).toBe('No catalog');
    await h.chat.loadModels();
    expect(h.chat.state.modelsError).toBeUndefined();
  });
});
