import { runChatAction } from '../chat/actions.js';
import type { AgentChat } from '../chat/types.js';
import type { AgentChatState } from '../shared/agent-chat-types.js';
import type { ChatActionCommand, ServerMessage } from './protocol.js';

/** How the remote server reaches the desktop's chats. */
export interface RemoteChatSource {
  list(): { agentId: string; taskId: string; status: 'running' | 'exited' }[];
  find(agentId: string): AgentChat | undefined;
  /** Called when a chat starts or ends; returns the unsubscribe function. */
  onChange(listener: () => void): () => void;
}

// Providers publish every 50 ms while streaming, and each frame is the whole
// conversation; a phone on Wi-Fi needs far fewer.
export const CHAT_FRAME_INTERVAL_MS = 200;

/**
 * The conversation as a phone receives it.
 * shortcut: images are dropped rather than sent — base64 attachments would ride
 * along in every frame; serve them by URL if phones should show them.
 */
function phoneFrame(state: AgentChatState): AgentChatState {
  if (!state.items.some((item) => item.images?.length)) return state;
  return { ...state, items: state.items.map(({ images: _images, ...item }) => item) };
}

/**
 * One socket's chat subscriptions. Frames are throttled per chat; the latest
 * state always goes out, because providers mutate one state object in place.
 */
export function createChatSubscriptions(
  source: RemoteChatSource,
  sendMessage: (message: ServerMessage) => void,
) {
  const subscriptions = new Map<string, () => void>();

  function subscribe(agentId: string): void {
    if (subscriptions.has(agentId)) return;
    const chat = source.find(agentId);
    if (!chat) return;
    const send = () => sendMessage({ type: 'chat-state', agentId, state: phoneFrame(chat.state) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopObserving = chat.observe(() => {
      timer ??= setTimeout(() => {
        timer = undefined;
        send();
      }, CHAT_FRAME_INTERVAL_MS);
    });
    subscriptions.set(agentId, () => {
      stopObserving();
      clearTimeout(timer);
    });
    send();
  }

  function unsubscribe(agentId: string): void {
    subscriptions.get(agentId)?.();
    subscriptions.delete(agentId);
  }

  return {
    subscribe,
    unsubscribe,
    dispose(): void {
      for (const agentId of [...subscriptions.keys()]) unsubscribe(agentId);
    },
  };
}

/** Run a phone's chat action. Rejects with a message fit to show on the phone. */
export async function runRemoteChatAction(
  source: RemoteChatSource,
  command: ChatActionCommand,
): Promise<void> {
  const chat = source.find(command.agentId);
  if (!chat) throw new Error('This chat has closed. Open the task on your computer.');
  await runChatAction(chat, { ...command.params, action: command.action });
}
