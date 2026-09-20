import { store } from '../../store/core';
import { ASK_CODE_MODELS, type AskCodeProvider } from '../../../electron/shared/ask-code-models';

const PROVIDER_NAMES: Record<AskCodeProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  minimax: 'MiniMax',
};

/** Provider and model as one line, for callers that hold their own store. */
export function askCodeLabel(provider: AskCodeProvider, model: string): string {
  const name = PROVIDER_NAMES[provider];
  if (provider === 'minimax') return `${name} · ${ASK_CODE_MODELS.minimax}`;
  // Codex may run without a chosen slug, on whatever its own default is.
  return model ? `${name} · ${model}` : `${name} · default model`;
}

/**
 * Provider and model currently chosen for tours and code Q&A. The tour hint,
 * the change-tour popover and the model menu all name it, so they cannot drift
 * apart.
 */
export function askCodeModelLabel(): string {
  return askCodeLabel(store.askCodeProvider, store.askCodeModel);
}
