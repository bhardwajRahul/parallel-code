import { CHANGE_TOUR_TIMEOUT_MS, CHANGE_TOUR_PROMPT_LIMIT } from '../shared/change-tour-limits.js';
import {
  UNDERSTANDING_TIMEOUT_MS,
  UNDERSTANDING_PROMPT_LIMIT,
} from '../shared/understanding-limits.js';

/**
 * Purposes that ask for one JSON object instead of a prose answer. They share
 * the same handling in every provider: a schema system prompt, a large prompt
 * budget, and a longer deadline. Lives in its own module because both
 * `ask-code.ts` and `ask-code-minimax.ts` need it and `ask-code.ts` already
 * imports the MiniMax module.
 */
export type AskCodePurpose = 'tour' | 'understand';

const INLINE_SYSTEM_PROMPT = 'Answer concisely about the selected code. Use markdown.';

const STRUCTURED: Record<
  AskCodePurpose,
  { systemPrompt: string; timeoutMs: number; promptLimit: number }
> = {
  tour: {
    systemPrompt:
      'Return exactly one JSON object matching the requested tour schema. No markdown, commentary, or additional JSON objects.',
    timeoutMs: CHANGE_TOUR_TIMEOUT_MS,
    promptLimit: CHANGE_TOUR_PROMPT_LIMIT,
  },
  understand: {
    systemPrompt:
      'Return exactly one JSON object matching the requested understanding tour schema. No markdown, commentary, or additional JSON objects.',
    timeoutMs: UNDERSTANDING_TIMEOUT_MS,
    promptLimit: UNDERSTANDING_PROMPT_LIMIT,
  },
};

export function isStructuredPurpose(purpose: unknown): purpose is AskCodePurpose {
  return purpose === 'tour' || purpose === 'understand';
}

/** System prompt for a purpose; inline Q&A answers in prose. */
export function askCodeSystemPrompt(purpose?: AskCodePurpose): string {
  return isStructuredPurpose(purpose) ? STRUCTURED[purpose].systemPrompt : INLINE_SYSTEM_PROMPT;
}

/** Prompt budget override, or undefined to keep the inline Q&A limit. */
export function askCodePromptLimit(purpose?: AskCodePurpose): number | undefined {
  return isStructuredPurpose(purpose) ? STRUCTURED[purpose].promptLimit : undefined;
}

/** Deadline override, or undefined to keep the inline Q&A timeout. */
export function askCodeTimeoutMs(purpose?: AskCodePurpose): number | undefined {
  return isStructuredPurpose(purpose) ? STRUCTURED[purpose].timeoutMs : undefined;
}
