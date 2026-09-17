import { randomUUID } from 'node:crypto';
import type {
  CanUseTool,
  PermissionResult,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatState, ChatItem } from '../shared/agent-chat-types.js';
import type { AgentChat, ChatStartOptions } from './types.js';

type ClaudeSDK = Pick<
  typeof import('@anthropic-ai/claude-agent-sdk'),
  'query' | 'getSessionMessages'
>;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
const contentText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value
          .map((block) => string(record(block).text))
          .filter(Boolean)
          .join('\n')
      : '';

/** Owns one local Claude Code session. The SDK and binary own authentication and execution. */
export class ClaudeChat implements AgentChat {
  readonly state: AgentChatState = { status: 'starting', items: [], requests: [] };
  private query?: Query;
  private input?: SDKUserMessage;
  private wake?: () => void;
  private pendingSend?: {
    id: string;
    text: string;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  private observers = new Set<(state: AgentChatState) => void>();
  private permissions = new Map<
    string,
    {
      input: Record<string, unknown>;
      finish: (result: PermissionResult, cancelled?: boolean) => void;
    }
  >();
  private streamId = '';
  // Both only have to survive the turn that produced them: a denied tool's result
  // arrives in the same turn, and replays repeat a message within its own turn.
  private seenToolResults = new Set<string>();
  private toolDecisions = new Map<string, 'declined' | 'interrupted'>();
  private publishTimer?: ReturnType<typeof setTimeout>;
  /** Launch output only: before the first prompt it cannot contain tool arguments. */
  private launchDiagnostics: string[] = [];
  private connecting = true;

  constructor(
    private sdk: ClaudeSDK | undefined,
    private opts: ChatStartOptions,
    private sendState: (state: AgentChatState) => void,
  ) {}

  async start(): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const launch = this.launchDiagnostics.join('').trim();
      throw launch ? new Error(`${detail}\n${launch}`) : error;
    } finally {
      this.connecting = false;
      this.launchDiagnostics = [];
    }
  }

  private async connect(): Promise<void> {
    // The SDK history reader uses the host's config directory, not query.env. A task
    // override would write a session this app can never read back, so refuse before
    // the user has a conversation to lose rather than on the next resume.
    if (this.opts.env.CLAUDE_CONFIG_DIR !== process.env.CLAUDE_CONFIG_DIR)
      throw new Error(
        'Claude chat does not support a task-specific CLAUDE_CONFIG_DIR. Set it for Parallel Code itself.',
      );
    const sdk = this.sdk ?? (await import('@anthropic-ai/claude-agent-sdk'));
    if (this.isClosed()) throw new Error('Claude chat stopped while connecting.');
    this.sdk = sdk;
    const sessionId = this.opts.threadId ?? randomUUID();
    this.state.threadId = sessionId;
    if (this.opts.threadId) {
      const history = await sdk.getSessionMessages(sessionId, { dir: this.opts.cwd });
      for (const message of history) this.receive(message);
      this.settleActivities();
    }
    if (this.state.status === 'closed') throw new Error('Claude chat stopped while connecting.');
    this.query = sdk.query({
      prompt: this.prompts(),
      options: {
        cwd: this.opts.cwd,
        env: this.opts.env,
        pathToClaudeCodeExecutable: this.opts.command,
        ...(this.opts.threadId ? { resume: sessionId } : { sessionId }),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        extraArgs: { 'replay-user-messages': null },
        executable: 'node',
        permissionMode: this.opts.skipPermissions ? 'bypassPermissions' : 'default',
        allowDangerouslySkipPermissions: !!this.opts.skipPermissions,
        canUseTool: this.canUseTool,
        // Diagnostics can include private tool arguments once a session is running.
        // Keep the launch output only, and never forward the rest to the UI or log.
        stderr: (line) => {
          if (this.connecting && this.launchDiagnostics.length < 20)
            this.launchDiagnostics.push(line);
        },
      },
    });
    void this.read();
    await this.query.initializationResult();
    if (this.isClosed())
      throw new Error(this.state.error ?? 'Claude disconnected while connecting.');
    await this.loadModels();
    if (this.isClosed())
      throw new Error(this.state.error ?? 'Claude disconnected while connecting.');
    this.state.status = 'ready';
    this.publish();
  }

  subscribe(publish: (state: AgentChatState) => void): void {
    this.sendState = publish;
    this.publish();
  }
  observe(listener: (state: AgentChatState) => void): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }

  async loadModels(): Promise<void> {
    try {
      if (!this.query) throw new Error('Claude is not connected.');
      const models = await this.query.supportedModels();
      this.state.models = models
        .map((model) => ({
          model: model.resolvedModel ?? model.value,
          displayName: model.displayName,
          supportedReasoningEfforts: (model.supportedEffortLevels ?? []).map((reasoningEffort) => ({
            reasoningEffort,
            description: '',
          })),
        }))
        .filter(
          (model, index, all) => all.findIndex((other) => other.model === model.model) === index,
        );
      if (!this.state.models.length) throw new Error('Claude returned no selectable models.');
      this.state.modelsError = undefined;
    } catch (error) {
      this.state.modelsError = error instanceof Error ? error.message : String(error);
    }
    this.publish();
  }

  async selectModel(model: string, reasoningEffort?: string): Promise<void> {
    if (this.state.status !== 'ready' || !this.query)
      throw new Error('Wait for Claude to finish before changing models.');
    const choice = this.state.models?.find((option) => option.model === model);
    if (!choice) throw new Error('This model is not available.');
    const effort = reasoningEffort || undefined;
    if (
      effort &&
      !choice.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)
    )
      throw new Error('This reasoning effort is not supported by the selected model.');
    // One control request applies both overrides; never write the user's settings files.
    this.state.status = 'starting';
    this.publish();
    try {
      await this.query.applyFlagSettings({
        model,
        effortLevel: (effort ?? null) as Parameters<Query['applyFlagSettings']>[0]['effortLevel'],
      });
      if (!this.isClosed()) {
        this.state.model = model;
        this.state.reasoningEffort = effort;
      }
    } finally {
      if (!this.isClosed()) this.state.status = 'ready';
      this.publish();
    }
  }

  send(text: string): Promise<void> {
    if (this.state.status !== 'ready' || !this.query)
      return Promise.reject(new Error('Wait for Claude to finish or reconnect.'));
    this.state.status = 'working';
    this.state.error = undefined;
    const id = randomUUID();
    const accepted = new Promise<void>((resolve, reject) => {
      this.pendingSend = { id, text, resolve, reject };
    });
    this.input = {
      type: 'user',
      uuid: id,
      session_id: this.state.threadId,
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    this.publish();
    this.wake?.();
    return accepted;
  }

  async interrupt(): Promise<void> {
    if (this.state.status !== 'working' || !this.query) return;
    // A queued prompt may not have reached the CLI yet. Closing is the only certain
    // cancellation before its receipt; keep the draft and allow a clean reconnect.
    if (this.pendingSend) {
      this.stop();
      return;
    }
    await this.query.interrupt();
    // The result event marks the turn finished. Keep Send disabled until it arrives.
  }

  respond(
    id: string | number,
    decision: 'accept' | 'decline',
    answers?: Record<string, string>,
  ): void {
    const permission = this.permissions.get(String(id));
    if (!permission) throw new Error('This request is no longer pending.');
    const request = this.state.requests.find((request) => request.id === id);
    if (
      decision === 'accept' &&
      request?.questions?.some((question) => !answers?.[question.id]?.trim())
    )
      throw new Error('Answer every question before continuing.');
    permission.finish(
      decision === 'decline'
        ? { behavior: 'deny', message: 'User declined this request.' }
        : {
            behavior: 'allow',
            updatedInput:
              request?.kind === 'question' ? { ...permission.input, answers } : permission.input,
          },
    );
  }

  stop(): void {
    if (this.isClosed()) return;
    this.fail('Claude chat stopped. Reopen Chat to reconnect.');
    this.query?.close();
  }

  private isClosed(): boolean {
    return this.state.status === 'closed';
  }
  private async *prompts(): AsyncGenerator<SDKUserMessage> {
    while (!this.isClosed()) {
      if (!this.input)
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      this.wake = undefined;
      if (this.isClosed()) return;
      const input = this.input;
      this.input = undefined;
      if (input) yield input;
    }
  }
  private async read(): Promise<void> {
    try {
      if (!this.query) return;
      for await (const message of this.query) {
        if (this.isClosed()) return;
        this.receive(message);
      }
      if (!this.isClosed()) this.fail('Claude chat disconnected. Reopen Chat to reconnect.');
    } catch (error) {
      if (!this.isClosed()) this.fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.query?.close();
    }
  }
  private acceptSend(): void {
    const pending = this.pendingSend;
    if (!pending) return;
    this.pendingSend = undefined;
    this.upsert({ id: pending.id, kind: 'user', text: pending.text });
    pending.resolve();
  }
  private fail(message: string): void {
    if (this.isClosed()) return;
    this.state.status = 'closed';
    this.state.error = message;
    this.pendingSend?.reject(new Error(message));
    this.pendingSend = undefined;
    this.input = undefined;
    this.wake?.();
    this.clearPermissions();
    this.settleActivities();
    this.publish();
  }
  private clearPermissions(): void {
    for (const permission of this.permissions.values())
      permission.finish({ behavior: 'deny', message: 'The request was cancelled.' }, true);
  }
  private settleActivities(): void {
    for (const item of this.state.items)
      if (item.activity?.status === 'running')
        item.activity = { ...item.activity, status: 'interrupted' };
  }
  private publish(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = undefined;
    this.sendState(this.state);
    for (const listener of this.observers) listener(this.state);
  }
  private upsert(item: ChatItem): void {
    const index = this.state.items.findIndex((existing) => existing.id === item.id);
    if (index < 0) this.state.items.push(item);
    else this.state.items[index] = item;
  }

  private canUseTool: CanUseTool = async (tool, input, options) => {
    this.acceptSend();
    if (this.isClosed() || options.signal.aborted)
      return { behavior: 'deny', message: 'Request cancelled.' };
    const id = randomUUID();
    const questions =
      tool === 'AskUserQuestion' && Array.isArray(input.questions)
        ? input.questions.map((value) => {
            const question = record(value);
            return {
              id: string(question.question),
              question: string(question.question),
              isSecret: false,
              multiSelect: question.multiSelect === true,
              options: (Array.isArray(question.options) ? question.options : []).map((value) => ({
                label: string(record(value).label),
                description: string(record(value).description),
              })),
            };
          })
        : undefined;
    if (
      tool === 'AskUserQuestion' &&
      (!questions?.length || questions.some((question) => !question.id))
    )
      return {
        behavior: 'deny',
        message: 'Unsupported question format. Ask the user in a normal message.',
      };
    return new Promise<PermissionResult>((resolve) => {
      const cancel = () => finish({ behavior: 'deny', message: 'Request cancelled.' }, true);
      const finish = (result: PermissionResult, cancelled = false) => {
        if (result.behavior === 'deny')
          this.toolDecisions.set(options.toolUseID, cancelled ? 'interrupted' : 'declined');
        options.signal.removeEventListener('abort', cancel);
        this.permissions.delete(id);
        this.state.requests = this.state.requests.filter((request) => request.id !== id);
        resolve(result);
        this.publish();
      };
      this.permissions.set(id, { input, finish });
      this.state.requests.push({
        id,
        since: Date.now(),
        kind: questions ? 'question' : 'approval',
        questions,
        text: [
          options.decisionReason,
          `${tool}\n${JSON.stringify(input, null, 2)}`,
          options.blockedPath,
        ]
          .filter(Boolean)
          .join('\n'),
      });
      options.signal.addEventListener('abort', cancel, { once: true });
      this.publish();
    });
  };

  private receive(value: unknown): void {
    const message = record(value);
    if (message.parent_tool_use_id) return; // Subagents are represented by their parent tool activity.
    if (message.type === 'system' && message.subtype === 'init') {
      this.state.model = string(message.model) || this.state.model;
    } else if (message.type === 'stream_event') {
      this.acceptSend();
      const event = record(message.event);
      if (event.type === 'message_start') this.streamId = string(record(event.message).id);
      if (
        event.type === 'content_block_delta' &&
        this.streamId &&
        record(event.delta).type === 'text_delta'
      ) {
        const id = `${this.streamId}:${event.index}`;
        const item = this.state.items.find((item) => item.id === id);
        this.upsert({
          id,
          kind: 'assistant',
          text: (item?.text ?? '') + string(record(event.delta).text),
        });
        if (!this.publishTimer) this.publishTimer = setTimeout(() => this.publish(), 50);
        return;
      }
    } else if (message.type === 'assistant' || message.type === 'user') {
      if (message.type === 'assistant' || message.uuid === this.pendingSend?.id) this.acceptSend();
      const body = record(message.message);
      const id = string(body.id) || string(message.uuid);
      if (!id) return;
      const content = Array.isArray(body.content)
        ? body.content
        : [{ type: 'text', text: string(body.content) }];
      if (message.type === 'user' && !message.isSynthetic) {
        const text = contentText(content);
        if (text) this.upsert({ id, kind: 'user', text });
      }
      content.forEach((value, index) => {
        const block = record(value);
        if (message.type === 'assistant' && block.type === 'text')
          this.upsert({ id: `${id}:${index}`, kind: 'assistant', text: string(block.text) });
        if (block.type === 'tool_use') {
          const tool = string(block.name),
            input = record(block.input);
          const type =
            tool === 'Bash'
              ? 'command'
              : ['Edit', 'Write', 'MultiEdit'].includes(tool)
                ? 'files'
                : 'tool';
          this.upsert({
            id: string(block.id),
            kind: 'tool',
            text: JSON.stringify(input, null, 2),
            activity: {
              type,
              label: string(input.command) || string(input.file_path) || tool,
              status: 'running',
            },
          });
        }
        if (block.type === 'tool_result') {
          const resultId = `${string(message.uuid)}:${string(block.tool_use_id)}`;
          if (this.seenToolResults.has(resultId)) return;
          this.seenToolResults.add(resultId);
          const toolId = string(block.tool_use_id);
          const previous = this.state.items.find((item) => item.id === toolId);
          this.upsert({
            id: toolId,
            kind: 'tool',
            text: [previous?.text, contentText(block.content)].filter(Boolean).join('\n'),
            activity: {
              type: previous?.activity?.type ?? 'tool',
              label: previous?.activity?.label ?? 'Tool activity',
              status: this.toolDecisions.get(toolId) ?? (block.is_error ? 'failed' : 'completed'),
            },
          });
        }
      });
    } else if (message.type === 'result') {
      if (message.is_error) {
        const error =
          contentText(message.errors) ||
          (Array.isArray(message.errors) ? message.errors.join('\n') : '') ||
          'Claude could not complete this turn.';
        this.pendingSend?.reject(new Error(error));
        this.pendingSend = undefined;
        this.state.error = error;
      } else this.acceptSend();
      this.state.status = 'ready';
      this.clearPermissions();
      this.settleActivities();
      this.seenToolResults.clear();
      this.toolDecisions.clear();
    } else return;
    this.publish();
  }
}
