import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PermissionUpdate,
  Query,
  Options,
  SDKUserMessage,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { ClaudeChat } from './claude.js';
import type { ChatStartOptions } from './types.js';

/** The ask the CLI sends, typed, so a fixture cannot drift from what it really sends. */
type AskOptions = Parameters<NonNullable<Options['canUseTool']>>[2];
const askOptions = (overrides: Partial<AskOptions> = {}): AskOptions => ({
  signal: new AbortController().signal,
  requestId: 'request',
  toolUseID: 'tool',
  ...overrides,
});

const chats: ClaudeChat[] = [];
afterEach(() => {
  chats.forEach((chat) => chat.stop());
  chats.length = 0;
  vi.unstubAllEnvs();
});
function harness(
  history: SessionMessage[] = [],
  threadId?: string,
  overrides: Partial<ChatStartOptions> = {},
) {
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
    setPermissionMode: vi.fn(async () => {}),
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
      env: process.env as Record<string, string>,
      threadId,
      ...overrides,
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
  it('tracks permission changes reported after initialization', async () => {
    const h = harness();
    await h.chat.start();
    await h.emit({ type: 'system', subtype: 'init', permissionMode: 'plan' });
    await h.emit({
      type: 'system',
      subtype: 'status',
      status: null,
      permissionMode: 'acceptEdits',
    });
    expect(h.chat.state.permissionMode).toBe('acceptEdits');
    await h.emit({ type: 'system', subtype: 'status', status: 'compacting' });
    expect(h.chat.state.permissionMode).toBe('acceptEdits');
  });

  it('passes the task canvas configuration to the SDK without changing other settings', async () => {
    const h = harness([], undefined, { mcpArgs: ['--mcp-config', '/tmp/canvas.json'] });
    await h.chat.start();
    expect(h.options().extraArgs).toEqual({
      'replay-user-messages': null,
      'mcp-config': '/tmp/canvas.json',
    });
  });

  it('preserves edit arguments after the result arrives', async () => {
    const h = harness();
    await h.chat.start();
    await h.emit({
      type: 'assistant',
      message: {
        id: 'reply',
        content: [
          {
            type: 'tool_use',
            id: 'edit',
            name: 'Edit',
            input: {
              file_path: '/worktree/app.ts',
              old_string: 'return false;',
              new_string: 'return true;',
            },
          },
        ],
      },
    });
    await h.emit({
      type: 'user',
      uuid: 'result',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'Updated successfully.' }],
      },
    });
    expect(h.chat.state.items[0].text).toContain('return false;');
    expect(h.chat.state.items[0].text).toContain('return true;');
    expect(h.chat.state.items[0].text).toContain('Updated successfully.');
  });

  it('starts an explicit local session, preserves normal settings, and loads model capabilities', async () => {
    const h = harness();
    await h.chat.start();
    expect(h.options()).toMatchObject({
      cwd: '/worktree',
      pathToClaudeCodeExecutable: '/usr/bin/claude',
      systemPrompt: { preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      extraArgs: { 'replay-user-messages': null },
    });
    // --permission-mode outranks permissions.defaultMode in the user's own settings,
    // so sending one would re-ask for everything their settings already auto-approve.
    expect(h.options().permissionMode).toBeUndefined();
    expect(h.options().allowDangerouslySkipPermissions).toBeUndefined();
    expect(h.options().sessionId).toBe(h.chat.state.threadId);
    expect(h.chat.state.models?.[0]).toMatchObject({
      model: 'claude-fixture',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
    });
    expect(h.chat.state.model).toBeUndefined(); // Don't guess before Claude reports its model.
    await h.emit({ type: 'system', subtype: 'init', model: 'claude-fixture' });
    expect(h.chat.state.model).toBe('claude-fixture');
  });

  it('bypasses permissions only for a task that opted out', async () => {
    const h = harness([], undefined, { skipPermissions: true });
    await h.chat.start();
    expect(h.options()).toMatchObject({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
  });

  it('runs the mode the user picked for this chat, and only then overrides their settings', async () => {
    const h = harness([], undefined, { permissionMode: 'acceptEdits' });
    await h.chat.start();
    expect(h.options().permissionMode).toBe('acceptEdits');
    expect(h.options().allowDangerouslySkipPermissions).toBeUndefined();
    expect(h.chat.state.permissionNote).toBeUndefined();
  });

  it('explains an auto mode the CLI silently drops, until the user picks a mode instead', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-chat-auto-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'config'));
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), '{"permissions":{"defaultMode":"auto"}}');
    const h = harness([], undefined, { cwd: root });
    try {
      await h.chat.start();
      // Nothing is sent to the CLI: auto is the user's setting, and the CLI still reads it.
      expect(h.options().permissionMode).toBeUndefined();
      expect(h.chat.state.permissionNote).toContain('auto mode');
      await h.emit({ type: 'system', subtype: 'init', permissionMode: 'default' });
      expect(h.chat.state.permissionMode).toBe('default');
      await h.chat.setPermissionMode('acceptEdits');
      expect(h.controls.setPermissionMode).toHaveBeenCalledWith('acceptEdits');
      expect(h.chat.state.permissionMode).toBe('acceptEdits');
      expect(h.chat.state.permissionNote).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a mode change that the task has already opted out of', async () => {
    const h = harness([], undefined, { skipPermissions: true });
    await h.chat.start();
    await expect(h.chat.setPermissionMode('plan')).rejects.toThrow('skips permissions');
    expect(h.controls.setPermissionMode).not.toHaveBeenCalled();
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

  it('keeps the words the user sent and cleans up only the turns it did not send', async () => {
    const h = harness();
    await h.chat.start();
    // The CLI replays our own turn back; a user quoting these tags still wrote them.
    const quoted = 'Why does <system-reminder>this</system-reminder> show up in my prompt?';
    await h.send(quoted);
    expect(h.chat.state.items[0].text).toBe(quoted);
    await h.emit({
      type: 'user',
      uuid: 'injected',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>Be careful.</system-reminder>' },
          {
            type: 'text',
            text: '<task-notification><status>completed</status><summary>Build finished</summary></task-notification>',
          },
        ],
      },
    });
    expect(h.chat.state.items[1].text).toBe('Build finished');
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
    expect(h.chat.state.requests[0].defaultToNo).toBe(false);
    const id = h.chat.state.requests[0].id;
    h.chat.respond(id, 'accept');
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: input,
      decisionClassification: 'user_temporary',
    });
    expect(() => h.chat.respond(id, 'accept')).toThrow('no longer pending');
    const cancelled = h.options().canUseTool?.('Bash', input, {
      signal: signal.signal,
      requestId: 'request',
      toolUseID: 'tool-2',
      defaultToNo: true,
    });
    expect(h.chat.state.requests[0].defaultToNo).toBe(true);
    signal.abort();
    await expect(cancelled).resolves.toMatchObject({ behavior: 'deny' });
    expect(h.chat.state.requests).toEqual([]);
  });

  it('shows the prompt the CLI wrote and remembers a decision on request', async () => {
    const h = harness();
    await h.chat.start();
    await h.send();
    const suggestions: PermissionUpdate[] = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ];
    const pending = h.options().canUseTool?.(
      'Bash',
      { command: 'npm test' },
      askOptions({
        title: 'Claude wants to run npm test',
        displayName: 'Run command',
        suggestions,
      }),
    );
    const request = h.chat.state.requests[0];
    expect(request).toMatchObject({ action: 'Run command', canAlwaysAllow: true });
    expect(request.text).toBe('Claude wants to run npm test');
    expect(request.details).toContain('"command": "npm test"');
    // The card has to name the settings file a click would write, not just "always".
    expect(request.alwaysAllowNote).toBe(
      'always allow Bash(npm test:*) in this checkout’s local settings',
    );
    h.chat.respond(request.id, 'accept-always');
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm test' },
      updatedPermissions: suggestions,
      decisionClassification: 'user_permanent',
    });
  });

  it('describes a call the CLI did not write a prompt for, and never offers to remember it', async () => {
    const h = harness();
    await h.chat.start();
    await h.send();
    const pending = h.options().canUseTool?.(
      'Bash',
      { command: 'npm test' },
      askOptions({
        suppressAlwaysAllowRule: true,
        suggestions: [
          { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash' }],
            behavior: 'allow',
            destination: 'userSettings',
          },
        ],
      }),
    );
    const request = h.chat.state.requests[0];
    expect(request.text).toBe('Bash: npm test');
    expect(request).toMatchObject({ canAlwaysAllow: false, alwaysAllowNote: undefined });
    // Even an "always" from a stale card writes no rule the agent withheld.
    h.chat.respond(request.id, 'accept-always');
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm test' },
      decisionClassification: 'user_temporary',
    });
  });

  it('strips terminal escapes from the sentence the user decides on', async () => {
    const h = harness();
    await h.chat.start();
    await h.send();
    void h
      .options()
      .canUseTool?.(
        'Read',
        { file_path: '/etc/hosts' },
        askOptions({ title: '\u001b[31mClaude wants to read /etc/hosts\u001b[0m' }),
      );
    expect(h.chat.state.requests[0].text).toBe('Claude wants to read /etc/hosts');
  });

  it('never treats an unanswered question as approvable, however it is accepted', async () => {
    const h = harness();
    await h.chat.start();
    await h.send();
    const pending = h
      .options()
      .canUseTool?.(
        'AskUserQuestion',
        { questions: [{ question: 'Which scope?', options: [{ label: 'Narrow' }] }] },
        askOptions({ suggestions: [{ type: 'setMode', mode: 'plan', destination: 'session' }] }),
      );
    const request = h.chat.state.requests[0];
    // An answer is not a permission: remembering it must not even be offered.
    expect(request.canAlwaysAllow).toBe(false);
    expect(() => h.chat.respond(request.id, 'accept-always', {})).toThrow('Answer every question');
    h.chat.respond(request.id, 'decline');
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
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
      decisionClassification: 'user_temporary',
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
    const h = harness([], undefined, {
      env: { ...process.env, CLAUDE_CONFIG_DIR: '/task/local' } as Record<string, string>,
    });
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

  it('reports the cause of a successful-subtype turn that ended on an API error', async () => {
    const h = harness();
    await h.chat.start();
    const sending = h.chat.send('Ask');
    const rejected = expect(sending).rejects.toThrow('Credit balance is too low');
    // subtype 'success' with is_error carries the cause in `result`, not in `errors`.
    await h.emit({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Credit balance is too low',
    });
    await rejected;
    expect(h.chat.state).toMatchObject({ status: 'ready', error: 'Credit balance is too low' });
  });
});
