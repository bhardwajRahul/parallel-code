/** Every Enter typed into an agent terminal records a prompt, and the whole array is
 *  re-serialized on each save, so a task keeps only its most recent prompts. */
export const MAX_PROMPT_HISTORY = 100;
