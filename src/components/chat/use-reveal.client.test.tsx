import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReveal } from './use-reveal.react';

let container: HTMLDivElement;
let root: Root;
let motion: MediaQueryList;
let now: number;
let frameId: number;
const frames = new Map<number, FrameRequestCallback>();
function Text({ text, running }: { text: string; running: boolean }) {
  return createElement('span', null, useReveal(text, running));
}
async function update(text: string, running: boolean) {
  await act(async () => root.render(createElement(Text, { text, running })));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  now = 0;
  frameId = 0;
  frames.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  motion = matchMedia('(prefers-reduced-motion: reduce)');
  vi.stubGlobal('matchMedia', () => motion);
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(frames.size).toBe(0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('smooth reveal', () => {
  it('reveals appended text without splitting emoji and flushes on completion', async () => {
    await update('Start ', true);
    const text = 'Start ' + '🙂'.repeat(100);
    await update(text, true);
    expect(container.textContent).toBe('Start ');
    await act(async () => {
      now = 50;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(now));
    });
    const partial = container.textContent ?? '';
    expect(partial.length).toBeGreaterThan('Start '.length);
    expect(partial.length).toBeLessThan(text.length);
    expect(partial).toMatch(/^Start (🙂)+$/u);
    await update(text, false);
    expect(container.textContent).toBe(text);
  });
  it('shows history immediately and honors reduced motion during a response', async () => {
    await update('History', false);
    expect(container.textContent).toBe('History');
    await update('New response', true);
    expect(container.textContent).toBe('New response');
    Object.defineProperty(motion, 'matches', { value: true, configurable: true });
    await update('New response plus a large update', true);
    expect(container.textContent).toBe('New response plus a large update');
  });
});
