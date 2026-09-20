import { describe, expect, it } from 'vitest';
import {
  GIST_LABEL,
  parseAgentTour,
  parseTourBranch,
  parseUnderstandingTour,
} from './understanding-tour';
import { TOUR_CARD_LIMITS, toleratedCap } from '../../electron/shared/understanding-limits';

const card = {
  label: 'KEY DECISION',
  title: 'Buffering happens before IPC',
  body: 'The PTY writes into a buffer that flushes on a timer.',
  tone: 'important',
  refs: [{ filePath: 'electron/ipc/pty.ts', line: 189 }],
};
const gist = { label: 'SUMMARY', title: 'Output is batched', body: 'Fewer IPC messages.' };

function response(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ gist, cards: [card], ...extra });
}

function parse(extra: Record<string, unknown> = {}) {
  return parseUnderstandingTour(response(extra), 'file', 'pty.ts');
}

describe('parseUnderstandingTour', () => {
  it('opens the spine with the gist and keeps the sent cards after it', () => {
    const tour = parse();
    expect(tour.subject).toBe('pty.ts');
    expect(tour.kind).toBe('file');
    expect(tour.cards).toHaveLength(2);
    expect(tour.cards[0]).toMatchObject({
      label: GIST_LABEL,
      title: gist.title,
      tone: 'neutral',
    });
    expect(tour.cards[1]).toMatchObject({ tone: 'important', refs: [card.refs[0]] });
  });

  it('accepts a text diagram and a mermaid diagram', () => {
    const text = parse({ cards: [{ ...card, diagram: { kind: 'text', source: 'PTY → Buffer' } }] });
    expect(text.cards[1]?.diagram).toEqual({ kind: 'text', source: 'PTY → Buffer' });
    const mermaid = parse({
      cards: [{ ...card, diagram: { kind: 'mermaid', source: 'graph TD;A-->B;' } }],
    });
    expect(mermaid.cards[1]?.diagram).toEqual({ kind: 'mermaid', source: 'graph TD;A-->B;' });
  });

  it('keeps an optional why-it-matters and drops an empty one', () => {
    expect(parse({ cards: [{ ...card, whyItMatters: 'Order matters.' }] }).cards[1]).toMatchObject({
      whyItMatters: 'Order matters.',
    });
    expect(parse({ cards: [{ ...card, whyItMatters: '  ' }] }).cards[1]).not.toHaveProperty(
      'whyItMatters',
    );
  });

  it('reads a tour out of fenced output with commentary', () => {
    const tour = parseUnderstandingTour(
      `Here you go:\n\`\`\`json\n${response()}\n\`\`\``,
      'plan',
      'T',
    );
    expect(tour.cards).toHaveLength(2);
  });

  it('rejects a missing gist', () => {
    expect(() => parseUnderstandingTour(JSON.stringify({ cards: [card] }), 'plan', 'T')).toThrow(
      'The tour is missing its gist.',
    );
  });

  it('rejects a non-object response', () => {
    expect(() => parseUnderstandingTour('[{"gist":1}]', 'plan', 'T')).toThrow('not a JSON object');
  });

  it.each([
    ['label', { label: '' }],
    ['title', { title: '   ' }],
    ['body', { body: 42 }],
  ])('rejects a card with a missing %s', (field, patch) => {
    expect(() => parse({ cards: [{ ...card, ...patch }] })).toThrow(`Card 1 ${field} is missing.`);
  });

  it.each([
    ['label', 'label', TOUR_CARD_LIMITS.label],
    ['title', 'title', TOUR_CARD_LIMITS.title],
    ['body', 'body', TOUR_CARD_LIMITS.body],
    ['why-it-matters', 'whyItMatters', TOUR_CARD_LIMITS.whyItMatters],
  ])('rejects an over-long %s', (name, field, cap) => {
    expect(() =>
      parse({ cards: [{ ...card, [field]: 'x'.repeat(toleratedCap(cap) + 1) }] }),
    ).toThrow(`Card 1 ${name} is too long.`);
    expect(() =>
      parse({ cards: [{ ...card, [field]: 'x'.repeat(toleratedCap(cap)) }] }),
    ).not.toThrow();
  });

  it('names the failing card by its position', () => {
    expect(() => parse({ cards: [card, card, { ...card, body: '' }] })).toThrow(
      'Card 3 body is missing.',
    );
  });

  it('defaults a missing tone to neutral and rejects an unknown one', () => {
    const { tone, ...withoutTone } = card;
    expect(tone).toBe('important');
    expect(parse({ cards: [withoutTone] }).cards[1]?.tone).toBe('neutral');
    expect(() => parse({ cards: [{ ...card, tone: 'excited' }] })).toThrow(
      'Card 1 has an unknown tone.',
    );
  });

  it.each([
    [{ kind: 'sketch', source: 'x' }, 'unsupported diagram'],
    [{ source: 'x' }, 'unsupported diagram'],
    ['PTY → Buffer', 'unsupported diagram'],
    [{ kind: 'text', source: '  ' }, 'empty diagram'],
    [
      { kind: 'text', source: 'x'.repeat(toleratedCap(TOUR_CARD_LIMITS.textDiagram) + 1) },
      'diagram is too long',
    ],
    [
      { kind: 'mermaid', source: 'x'.repeat(toleratedCap(TOUR_CARD_LIMITS.mermaidDiagram) + 1) },
      'diagram is too long',
    ],
  ])('rejects an invalid diagram (%o)', (diagram, message) => {
    expect(() => parse({ cards: [{ ...card, diagram }] })).toThrow(message);
  });

  it('accepts a text diagram that would be too long as mermaid only when under its own cap', () => {
    const source = 'x'.repeat(toleratedCap(TOUR_CARD_LIMITS.textDiagram));
    expect(() => parse({ cards: [{ ...card, diagram: { kind: 'text', source } }] })).not.toThrow();
  });

  it('drops malformed refs instead of failing the tour', () => {
    const refs = [
      { filePath: 'src/a.ts' },
      { filePath: '/etc/passwd' },
      { filePath: '../outside.ts' },
      { filePath: 'src/../../outside.ts' },
      { filePath: '' },
      { filePath: 'src/b.ts', line: 0 },
      { filePath: 'src/b.ts', line: 1.5 },
      { filePath: 'src/b.ts', line: '12' },
      { line: 3 },
      'src/c.ts',
      null,
      { filePath: 'src/d.ts', line: 7 },
    ];
    expect(parse({ cards: [{ ...card, refs }] }).cards[1]?.refs).toEqual([
      { filePath: 'src/a.ts' },
      { filePath: 'src/d.ts', line: 7 },
    ]);
  });

  it('ignores a non-array refs field and truncates long ref lists', () => {
    expect(parse({ cards: [{ ...card, refs: 'src/a.ts' }] }).cards[1]?.refs).toEqual([]);
    const many = Array.from({ length: TOUR_CARD_LIMITS.refs + 4 }, (_unused, index) => ({
      filePath: `src/file-${index}.ts`,
    }));
    expect(parse({ cards: [{ ...card, refs: many }] }).cards[1]?.refs).toHaveLength(
      TOUR_CARD_LIMITS.refs,
    );
  });

  it('rejects too few or too many cards', () => {
    const message = `The tour needs between ${TOUR_CARD_LIMITS.minCards} and ${TOUR_CARD_LIMITS.maxCards} cards.`;
    expect(() => parse({ cards: [] })).toThrow(message);
    expect(() => parse({ cards: undefined })).toThrow(message);
    expect(() =>
      parse({ cards: Array.from({ length: TOUR_CARD_LIMITS.maxCards + 1 }, () => card) }),
    ).toThrow(message);
    expect(() =>
      parse({ cards: Array.from({ length: TOUR_CARD_LIMITS.maxCards }, () => card) }),
    ).not.toThrow();
  });

  it('rejects a card that is not an object', () => {
    expect(() => parse({ cards: ['a card'] })).toThrow('Card 1 is not a card.');
  });
});

describe('parseAgentTour', () => {
  const payload = { subject: 'the retry bug', gist, cards: [card] };

  it('validates an agent payload, forces kind and opens with the gist', () => {
    const tour = parseAgentTour(payload);
    expect(tour).toMatchObject({ subject: 'the retry bug', kind: 'agent' });
    expect(tour.cards).toHaveLength(2);
    expect(tour.cards[0]).toMatchObject({ label: GIST_LABEL, title: gist.title });
    expect(tour.cards[1]).toMatchObject({ tone: 'important', refs: [card.refs[0]] });
  });

  it('rejects a card the generated tours would also reject', () => {
    expect(() => parseAgentTour({ ...payload, cards: [{ ...card, body: '' }] })).toThrow(
      'Card 1 body is missing.',
    );
    expect(() => parseAgentTour({ ...payload, cards: [{ ...card, tone: 'urgent' }] })).toThrow(
      'unknown tone',
    );
  });
});

describe('parseTourBranch', () => {
  const question = 'Why is the buffer flushed on a timer?';

  it('returns the originating index, the question and the cards', () => {
    const branch = parseTourBranch(JSON.stringify({ cards: [card, card] }), 2, question);
    expect(branch).toMatchObject({ fromIndex: 2, question });
    expect(branch.cards).toHaveLength(2);
    expect(branch.cards[0]?.tone).toBe('important');
  });

  it('validates branch cards with the same rules', () => {
    expect(() =>
      parseTourBranch(JSON.stringify({ cards: [{ ...card, title: '' }] }), 0, question),
    ).toThrow('Card 1 title is missing.');
  });

  it('rejects zero cards or more than the branch maximum', () => {
    const message = `The answer needs between 1 and ${TOUR_CARD_LIMITS.branchMaxCards} cards.`;
    expect(() => parseTourBranch('{"cards":[]}', 0, question)).toThrow(message);
    expect(() =>
      parseTourBranch(
        JSON.stringify({
          cards: Array.from({ length: TOUR_CARD_LIMITS.branchMaxCards + 1 }, () => card),
        }),
        0,
        question,
      ),
    ).toThrow(message);
  });

  it('rejects a non-object response', () => {
    expect(() => parseTourBranch('[1]', 0, question)).toThrow('not a JSON object');
  });
});
