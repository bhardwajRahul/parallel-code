/**
 * Task attention state, mirrored from the desktop's TaskAttentionState so the
 * mobile overview can show the same richer status ("needs input", "working",
 * etc.) rather than just running/exited. Kept as a string union at this shared
 * boundary; the renderer maps its TaskAttentionState onto these values.
 */
export type RemoteAttentionState = 'idle' | 'active' | 'needs_input' | 'error' | 'ready' | 'review';

/** Agent summary sent in the agents list. */
export interface RemoteAgent {
  agentId: string;
  taskId: string;
  taskName: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  lastLine: string;
  projectName?: string;
  agentName?: string;
  /** Richer, renderer-derived task status. Defaults to 'idle' when unknown. */
  attention: RemoteAttentionState;
}

// --- Server -> Client messages ---

export interface OutputMessage {
  type: 'output';
  agentId: string;
  data: string; // base64
}

export interface StatusMessage {
  type: 'status';
  agentId: string;
  status: 'running' | 'exited';
  exitCode: number | null;
}

export interface AgentsMessage {
  type: 'agents';
  list: RemoteAgent[];
}

export interface ScrollbackMessage {
  type: 'scrollback';
  agentId: string;
  data: string; // base64
  cols: number;
  rows?: number;
}

export interface InputResultMessage {
  type: 'input-result';
  requestId: string;
  ok: boolean;
  error?: string;
}

export type ServerMessage =
  | OutputMessage
  | StatusMessage
  | AgentsMessage
  | ScrollbackMessage
  | InputResultMessage;

// --- Client -> Server messages ---

export interface InputCommand {
  type: 'input';
  agentId: string;
  data: string;
  requestId?: string;
  /** Submit a composed message after pasting its text. */
  submit?: boolean;
  /**
   * Keystroke to type before the paste, in its own terminal write. Agent TUIs
   * open their shell prompt only for a `!` that arrives alone; inside a paste
   * it stays literal text.
   */
  prefixKey?: string;
}

export interface ResizeCommand {
  type: 'resize';
  agentId: string;
  cols: number;
  rows: number;
}

export interface KillCommand {
  type: 'kill';
  agentId: string;
}

export interface SubscribeCommand {
  type: 'subscribe';
  agentId: string;
}

export interface UnsubscribeCommand {
  type: 'unsubscribe';
  agentId: string;
}

export interface AuthCommand {
  type: 'auth';
  token: string;
}

export type ClientMessage =
  | AuthCommand
  | InputCommand
  | ResizeCommand
  | KillCommand
  | SubscribeCommand
  | UnsubscribeCommand;

/** Minimal validation for incoming client messages. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (typeof msg.type !== 'string') return null;

    // Auth message doesn't require agentId
    if (msg.type === 'auth') {
      if (typeof msg.token !== 'string' || msg.token.length > 200) return null;
      return { type: 'auth', token: msg.token };
    }

    if (typeof msg.agentId !== 'string' || msg.agentId.length > 100) return null;

    switch (msg.type) {
      case 'input':
        if (typeof msg.data !== 'string') return null;
        if (msg.data.length > 4096) return null;
        if (
          msg.requestId !== undefined &&
          (typeof msg.requestId !== 'string' || !msg.requestId.length || msg.requestId.length > 80)
        )
          return null;
        if (msg.submit !== undefined && typeof msg.submit !== 'boolean') return null;
        if (
          msg.prefixKey !== undefined &&
          (typeof msg.prefixKey !== 'string' || !msg.prefixKey.length || msg.prefixKey.length > 4)
        )
          return null;
        return {
          type: 'input',
          agentId: msg.agentId,
          data: msg.data,
          ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}),
          ...(typeof msg.submit === 'boolean' ? { submit: msg.submit } : {}),
          ...(typeof msg.prefixKey === 'string' ? { prefixKey: msg.prefixKey } : {}),
        };
      case 'resize':
        if (typeof msg.cols !== 'number' || typeof msg.rows !== 'number') return null;
        if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows)) return null;
        if (msg.cols < 1 || msg.cols > 500 || msg.rows < 1 || msg.rows > 500) return null;
        return {
          type: 'resize',
          agentId: msg.agentId,
          cols: msg.cols,
          rows: msg.rows,
        };
      case 'kill':
        return { type: 'kill', agentId: msg.agentId };
      case 'subscribe':
        return { type: 'subscribe', agentId: msg.agentId };
      case 'unsubscribe':
        return { type: 'unsubscribe', agentId: msg.agentId };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
