import './disable-telemetry.js';
import { randomUUID } from 'node:crypto';
import { AbstractAgent } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable, of } from 'rxjs';
import {
  AgentRunner,
  CopilotRuntime,
  createCopilotRuntimeHandler,
  type AgentRunnerRunRequest,
  type AgentRunnerConnectRequest,
  type AgentRunnerStopRequest,
  type AgentRunnerIsRunningRequest,
} from '@copilotkit/runtime/v2';
import type { AgentChat } from './types.js';
import type { AgentChatState } from '../shared/agent-chat-types.js';
import { chatMessages } from '../shared/chat-messages.js';

/** Each provider owns history and execution. The runtime retains no replay log or second session store. */
class ChatRunner extends AgentRunner {
  private runId: string = randomUUID();
  constructor(private chat: AgentChat) {
    super();
  }
  private assertThread(threadId: string): void {
    if (threadId !== this.chat.state.threadId)
      throw new Error('Conversation does not belong to this task.');
  }
  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    try {
      this.assertThread(request.threadId);
      if (this.chat.state.status !== 'ready')
        throw new Error('Wait for the agent to finish or reconnect.');
      const user = [...request.input.messages].reverse().find((m) => m.role === 'user');
      if (
        !user ||
        typeof user.content !== 'string' ||
        !user.content.trim() ||
        user.content.length > 100_000
      )
        throw new Error('Enter a message of at most 100,000 characters.');
      this.runId = request.input.runId;
      return this.stream(request.threadId, user.content);
    } catch (error) {
      return of({
        type: EventType.RUN_ERROR,
        message: error instanceof Error ? error.message : String(error),
      } as BaseEvent);
    }
  }
  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    this.assertThread(request.threadId);
    return this.stream(request.threadId);
  }
  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    this.assertThread(request.threadId);
    return this.chat.state.status === 'working';
  }
  async stop(request: AgentRunnerStopRequest): Promise<boolean> {
    this.assertThread(request.threadId);
    if (request.runId && request.runId !== this.runId) return false;
    await this.chat.interrupt();
    return true;
  }
  private stream(threadId: string, text?: string): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const runId = this.runId;
      let started = text === undefined;
      // A reconnect attaches to a chat that may still hold the last turn's error; a send
      // clears it first, so there is nothing to carry on that path.
      const carriedError = text === undefined ? this.chat.state.error : undefined;
      let previous: AgentChatState['items'] = [];
      let streamingId: string | undefined;
      const endText = () => {
        if (streamingId)
          subscriber.next({
            type: EventType.TEXT_MESSAGE_END,
            messageId: streamingId,
          } as BaseEvent);
        streamingId = undefined;
      };
      const publish = (state: AgentChatState) => {
        const last = state.items[state.items.length - 1];
        const oldLast = previous[previous.length - 1];
        const prefixUnchanged = state.items
          .slice(0, -1)
          .every((item, i) => item.id === previous[i]?.id && item.text === previous[i]?.text);
        if (
          last?.kind === 'assistant' &&
          prefixUnchanged &&
          state.items.length === previous.length + 1
        ) {
          endText();
          streamingId = last.id;
          subscriber.next({
            type: EventType.TEXT_MESSAGE_START,
            messageId: last.id,
            role: 'assistant',
          } as BaseEvent);
          if (last.text)
            subscriber.next({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: last.id,
              delta: last.text,
            } as BaseEvent);
        } else if (
          last &&
          streamingId === last.id &&
          oldLast?.id === last.id &&
          prefixUnchanged &&
          last.text.startsWith(oldLast.text)
        ) {
          const delta = last.text.slice(oldLast.text.length);
          if (delta)
            subscriber.next({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: last.id,
              delta,
            } as BaseEvent);
        } else if (
          state.items.length !== previous.length ||
          state.items.some(
            (item, i) => item.id !== previous[i]?.id || item.text !== previous[i]?.text,
          )
        ) {
          endText();
          subscriber.next({
            type: EventType.MESSAGES_SNAPSHOT,
            messages: chatMessages(state),
          } as BaseEvent);
        }
        previous = state.items.map((item) => ({ ...item }));
        if (state.status === 'working') started = true;
        // The chat keeps a failed turn's error until the next successful send, and a
        // reconnect is `started` from its first frame — only a newly raised error is ours.
        const failure = state.error && state.error !== carriedError ? state.error : undefined;
        if (state.status === 'closed' || (started && state.status === 'ready' && failure)) {
          endText();
          subscriber.next({
            type: EventType.RUN_ERROR,
            message: failure ?? state.error ?? 'Agent disconnected.',
          } as BaseEvent);
          subscriber.complete();
        } else if (started && state.status === 'ready') {
          endText();
          subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
          subscriber.complete();
        }
      };
      subscriber.next({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);
      const dispose = this.chat.observe(publish);
      publish(this.chat.state);
      if (text !== undefined)
        void this.chat
          .send(text)
          .then(() => {
            subscriber.next({
              type: EventType.CUSTOM,
              name: 'parallel-code/accepted',
              value: null,
            } as BaseEvent);
          })
          .catch((error: unknown) => {
            subscriber.next({
              type: EventType.RUN_ERROR,
              message: error instanceof Error ? error.message : String(error),
            } as BaseEvent);
            subscriber.complete();
          });
      return dispose;
    });
  }
}

class ChatAgent extends AbstractAgent {
  constructor(private runner: ChatRunner) {
    super({ agentId: 'default', description: 'Coding agent in this task worktree' });
  }
  override clone(): ChatAgent {
    return new ChatAgent(this.runner);
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return this.runner.run({ threadId: input.threadId, agent: this, input });
  }
}

export function createChatRuntime(chat: AgentChat) {
  process.env.COPILOTKIT_TELEMETRY_DISABLED = 'true';
  const runner = new ChatRunner(chat);
  return createCopilotRuntimeHandler({
    runtime: new CopilotRuntime({ agents: { default: new ChatAgent(runner) }, runner }),
    basePath: '/runtime',
  });
}
