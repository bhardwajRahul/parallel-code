/** Understanding tours inline their whole context, so they share the change-tour timeout. */
export const UNDERSTANDING_TIMEOUT_MS = 5 * 60_000;
/** Character budget for one understanding prompt (instructions plus inlined context). */
export const UNDERSTANDING_PROMPT_LIMIT = 500_000;

/**
 * A canvas document shorter than this gets no Take Tour button: reading it
 * outright is faster than a tour, which targets 30 seconds to 2 minutes.
 */
export const TOUR_MIN_DOCUMENT_CHARS = 1500;

/** File tours inline the file plus its direct relative imports; caps keep prompts bounded. */
export const FILE_TOUR_MAX_FILE_CHARS = 60_000;
export const FILE_TOUR_MAX_TOTAL_CHARS = 200_000;
export const FILE_TOUR_MAX_IMPORTS = 12;

/** Card tones, shared so the validator and the MCP tool description cannot drift. */
export const TOUR_TONES = ['neutral', 'important', 'risk', 'uncertainty', 'mechanical'] as const;

/**
 * Per-card caps enforce the product constraint that a tour reads in 30 seconds to 2 minutes.
 * Characters, not tokens; the prompt states the same numbers so the model can comply.
 */
export const TOUR_CARD_LIMITS = {
  label: 40,
  title: 120,
  body: 700,
  whyItMatters: 300,
  textDiagram: 1200,
  mermaidDiagram: 1500,
  refs: 6,
  minCards: 1,
  maxCards: 8,
  branchMaxCards: 3,
} as const;

/**
 * The prompt asks for the caps above; the validator rejects only when a field
 * overshoots by more than this factor. A title a few words too long must not
 * cost the user a retry after a paid call; a card twice the size is a real
 * failure to compress.
 */
export const TOUR_CAP_TOLERANCE = 1.5;

/** Hard limit for a field whose prompt cap is `cap`; see TOUR_CAP_TOLERANCE. */
export function toleratedCap(cap: number): number {
  return Math.floor(cap * TOUR_CAP_TOLERANCE);
}

/** JSON keys, quoting, escaping and brackets around one card's text. */
const CARD_JSON_OVERHEAD_CHARS = 200;

/**
 * Ceiling for one tour response: every text field of every card at its tolerated
 * size, plus one spare card, so the provider's output allowance never truncates
 * a tour the validator would have accepted.
 */
export const UNDERSTANDING_MAX_OUTPUT_CHARS =
  (TOUR_CARD_LIMITS.maxCards + 1) *
  (toleratedCap(TOUR_CARD_LIMITS.label) +
    toleratedCap(TOUR_CARD_LIMITS.title) +
    toleratedCap(TOUR_CARD_LIMITS.body) +
    toleratedCap(TOUR_CARD_LIMITS.whyItMatters) +
    toleratedCap(TOUR_CARD_LIMITS.mermaidDiagram) +
    CARD_JSON_OVERHEAD_CHARS);
