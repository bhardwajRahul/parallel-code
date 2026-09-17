import { spawn, execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ClaudeChat } from './claude.js';
import { CodexChat } from '../ipc/codex-chat.js';
import type { AgentChatState } from '../shared/agent-chat-types.js';
import type { AgentChat, ChatStartOptions } from './types.js';

const chats = new Map<string, { provider: ChatStartOptions['provider']; chat: AgentChat }>();

/** Use the user's unmodified executable and its own authentication flow. */
async function resolveExecutable(opts: ChatStartOptions): Promise<string> {
  if (opts.command.includes('/')) return resolve(opts.cwd, opts.command);
  try {
    const { stdout } = await promisify(execFile)('which', [opts.command], {
      env: opts.env,
      encoding: 'utf8',
      timeout: 3000,
    });
    const found = stdout.split('\n')[0]?.trim();
    if (found) return found;
  } catch (error) {
    throw new Error(
      `Could not find "${opts.command}" on PATH: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  throw new Error(`Could not find "${opts.command}" on PATH. Use its full path instead.`);
}

export async function startAgentChat(
  opts: ChatStartOptions,
  publish: (state: AgentChatState) => void,
): Promise<void> {
  const existing = chats.get(opts.agentId);
  if (existing?.provider === opts.provider && existing.chat.state.status !== 'closed') {
    existing.chat.subscribe(publish);
    return;
  }
  existing?.chat.stop();
  let chat: AgentChat;
  let start: () => Promise<void>;
  if (opts.provider === 'claude') {
    const command = await resolveExecutable(opts);
    const claude = new ClaudeChat(undefined, { ...opts, command }, publish);
    chat = claude;
    start = () => claude.start();
  } else {
    const proc = spawn(opts.command, ['app-server'], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: 'pipe',
      detached: true,
    });
    const codex = new CodexChat(proc, publish);
    chat = codex;
    start = () => codex.start(opts.cwd, opts.threadId, opts.skipPermissions);
  }
  chats.set(opts.agentId, { provider: opts.provider, chat });
  chat.subscribe(publish);
  try {
    await start();
  } catch (error) {
    chat.stop();
    if (chats.get(opts.agentId)?.chat === chat) chats.delete(opts.agentId);
    throw error;
  }
}

export function getAgentChat(agentId: string): AgentChat {
  const chat = chats.get(agentId)?.chat;
  if (!chat) throw new Error('Open Chat before sending a message.');
  return chat;
}
export function stopAgentChat(agentId: string): void {
  chats.get(agentId)?.chat.stop();
  chats.delete(agentId);
}
export function stopAllAgentChats(): void {
  for (const id of chats.keys()) stopAgentChat(id);
}
export function runningAgentChatIds(): string[] {
  return [...chats].filter(([, entry]) => entry.chat.state.status !== 'closed').map(([id]) => id);
}

/** Stop the app-server before the native CLI can resume its conversation. */
export async function releaseCodexChat(agentId: string) {
  const entry = chats.get(agentId);
  if (!entry) return {};
  if (!(entry.chat instanceof CodexChat))
    throw new Error('Only Codex supports conversation handoff.');
  try {
    return await entry.chat.release();
  } finally {
    // A timed-out release has already stopped the app-server. Only a refusal to
    // release at all (a running turn, a pending request) leaves a usable chat.
    if (chats.get(agentId) === entry && entry.chat.state.status === 'closed') chats.delete(agentId);
  }
}
