import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TourTone } from '../../lib/understanding-tour';
import { TourCard } from './TourCard';

vi.mock('../../lib/mermaid', () => ({ renderMermaidIn: vi.fn() }));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
});

function mountCard(tone: TourTone): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const card = { label: 'PLUMBING', title: 'Title', body: 'Body text.', tone, refs: [] };
  dispose = render(() => <TourCard card={card} />, host);
  const article = host.querySelector('article');
  if (!article) throw new Error('card not rendered');
  return article;
}

describe('TourCard', () => {
  it.each<TourTone>(['neutral', 'important', 'risk', 'uncertainty', 'mechanical'])(
    'reads %s cards at full text contrast',
    (tone) => {
      expect(mountCard(tone).style.color).toBe('var(--fg)');
    },
  );
});
