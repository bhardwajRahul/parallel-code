import type { AgentTourPayload } from '../../electron/shared/agent-tour';
import {
  TOUR_CARD_LIMITS,
  TOUR_TONES,
  toleratedCap,
} from '../../electron/shared/understanding-limits';
import { readSingleJsonObject } from './tour-json';

/**
 * Understanding tour data model. Plan tours and file tours share one shape:
 * a spine of cards read one at a time, opening with the gist, plus optional
 * dynamically generated branches. The wire format keeps `gist` as its own field
 * so the model is asked to compress the whole subject into one card; parsing
 * puts that card at the head of the spine, where it is just card one.
 * See docs/guided-understanding-plan.md.
 */

export type TourTone = (typeof TOUR_TONES)[number];

export interface TourDiagram {
  kind: 'text' | 'mermaid';
  source: string;
}

export interface TourRef {
  filePath: string;
  line?: number;
}

export interface TourCard {
  /** Short uppercase label such as "KEY DECISION" or "BOTTOM LINE". */
  label: string;
  title: string;
  /** Markdown, kept short by TOUR_CARD_LIMITS.body. */
  body: string;
  whyItMatters?: string;
  tone: TourTone;
  diagram?: TourDiagram;
  refs: TourRef[];
}

/** 'agent' tours are written by the coding agent and published through MCP. */
export type UnderstandingTourKind = 'plan' | 'file' | 'agent';

export interface UnderstandingTour {
  subject: string;
  kind: UnderstandingTourKind;
  /** The spine, read one card at a time; the gist is always `cards[0]`. */
  cards: TourCard[];
}

export interface TourBranch {
  /** Index of the spine card the branch was opened from. */
  fromIndex: number;
  question: string;
  cards: TourCard[];
}

export type { FileTourContext } from '../../electron/shared/file-tour-context-types';

/** The opening card always carries this label, whatever the model returned. */
export const GIST_LABEL = 'THE GIST';

function isTone(value: unknown): value is TourTone {
  return typeof value === 'string' && (TOUR_TONES as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireText(value: unknown, cap: number, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} is missing.`);
  const text = value.trim();
  if (text.length > toleratedCap(cap)) throw new Error(`${what} is too long.`);
  return text;
}

function parseTone(value: unknown, where: string): TourTone {
  if (value === undefined || value === null) return 'neutral';
  if (!isTone(value)) throw new Error(`${where} has an unknown tone.`);
  return value;
}

function parseDiagram(value: unknown, where: string): TourDiagram | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  const kind = record?.kind;
  if (kind !== 'text' && kind !== 'mermaid')
    throw new Error(`${where} has an unsupported diagram.`);
  const source = record?.source;
  if (typeof source !== 'string' || !source.trim())
    throw new Error(`${where} has an empty diagram.`);
  const cap = kind === 'text' ? TOUR_CARD_LIMITS.textDiagram : TOUR_CARD_LIMITS.mermaidDiagram;
  if (source.length > toleratedCap(cap)) throw new Error(`${where} diagram is too long.`);
  // Indentation carries meaning in text diagrams, so the source stays as sent.
  return { kind, source };
}

/** Refs are hints that only open a file, so a bad ref is dropped, never fatal (D4). */
function parseRefs(value: unknown): TourRef[] {
  if (!Array.isArray(value)) return [];
  const refs: TourRef[] = [];
  for (const entry of value) {
    if (refs.length >= TOUR_CARD_LIMITS.refs) break;
    const record = asRecord(entry);
    const filePath = record?.filePath;
    if (typeof filePath !== 'string' || !filePath.trim()) continue;
    const path = filePath.trim();
    if (path.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(path)) continue;
    const line = record?.line;
    if (line === undefined || line === null) {
      refs.push({ filePath: path });
      continue;
    }
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) continue;
    refs.push({ filePath: path, line });
  }
  return refs;
}

function parseWhyItMatters(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${where} why-it-matters is invalid.`);
  // An empty string is the model omitting the field, not a validation failure.
  if (!value.trim()) return undefined;
  return requireText(value, TOUR_CARD_LIMITS.whyItMatters, `${where} why-it-matters`);
}

function parseCard(value: unknown, where: string): TourCard {
  const record = asRecord(value);
  if (!record) throw new Error(`${where} is not a card.`);
  const base = {
    label: requireText(record.label, TOUR_CARD_LIMITS.label, `${where} label`),
    title: requireText(record.title, TOUR_CARD_LIMITS.title, `${where} title`),
    body: requireText(record.body, TOUR_CARD_LIMITS.body, `${where} body`),
    tone: parseTone(record.tone, where),
    refs: parseRefs(record.refs),
  };
  const diagram = parseDiagram(record.diagram, where);
  const whyItMatters = parseWhyItMatters(record.whyItMatters, where);
  return { ...base, ...(diagram && { diagram }), ...(whyItMatters && { whyItMatters }) };
}

function parseCards(value: unknown, what: string, min: number, max: number): TourCard[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new Error(`The ${what} needs between ${min} and ${max} cards.`);
  return value.map((entry, index) => parseCard(entry, `Card ${index + 1}`));
}

/** Validate a generated tour: `{ "gist": Card, "cards": [Card, ...] }`. */
export function parseUnderstandingTour(
  response: string,
  kind: UnderstandingTourKind,
  subject: string,
): UnderstandingTour {
  const data = asRecord(readSingleJsonObject(response, 'gist'));
  if (!data) throw new Error('The tour response was not a JSON object.');
  if (data.gist === undefined || data.gist === null)
    throw new Error('The tour is missing its gist.');
  const gist = parseCard(data.gist, 'The gist');
  const cards = parseCards(
    data.cards,
    'tour',
    TOUR_CARD_LIMITS.minCards,
    TOUR_CARD_LIMITS.maxCards,
  );
  return { subject, kind, cards: [{ ...gist, label: GIST_LABEL }, ...cards] };
}

/**
 * Validate a tour an agent published through MCP. The payload already passed the
 * shape and size checks in electron/shared/agent-tour.ts; the cards face exactly
 * the same validation as a generated tour.
 */
export function parseAgentTour(payload: AgentTourPayload): UnderstandingTour {
  const gist = parseCard(payload.gist, 'The gist');
  const cards = parseCards(
    payload.cards,
    'tour',
    TOUR_CARD_LIMITS.minCards,
    TOUR_CARD_LIMITS.maxCards,
  );
  return {
    subject: payload.subject,
    kind: 'agent',
    cards: [{ ...gist, label: GIST_LABEL }, ...cards],
  };
}

/** Validate a follow-up answer: `{ "cards": [Card, ...] }`. */
export function parseTourBranch(response: string, fromIndex: number, question: string): TourBranch {
  const data = asRecord(readSingleJsonObject(response, 'cards'));
  if (!data) throw new Error('The answer was not a JSON object.');
  const cards = parseCards(data.cards, 'answer', 1, TOUR_CARD_LIMITS.branchMaxCards);
  return { fromIndex, question, cards };
}
