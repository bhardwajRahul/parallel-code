import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let manager: typeof import('./terminalFitManager');
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function frame() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(performance.now());
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  manager = await import('./terminalFitManager');
});

afterEach(() => {
  manager.unregisterTerminal('test');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function terminal(viewportY = 5, rowChange = -6) {
  const buffer = { viewportY, baseY: 100 };
  let scrollbarY = viewportY;
  const container = document.createElement('div');
  const term = {
    rows: 20,
    cols: 80,
    buffer: { active: buffer },
    scrollToLine(line: number) {
      // xterm applies the buffer-relative delta to its scrollbar, whose
      // position is not synchronized with resized rows until the next render.
      scrollbarY = Math.max(0, scrollbarY + line - buffer.viewportY);
      buffer.viewportY = scrollbarY;
    },
  };
  const addon = {
    fit() {
      term.rows += rowChange;
      buffer.baseY -= rowChange;
      buffer.viewportY = Math.max(0, buffer.viewportY - rowChange);
      requestAnimationFrame(() => {
        scrollbarY = buffer.viewportY;
      });
    },
  };
  manager.registerTerminal('test', container, addon as FitAddon, term as Terminal);
  manager.markDirty('test');
  vi.advanceTimersByTime(150);
  frame();
  return { buffer, container, term, addon };
}

describe('terminal resize scroll position', () => {
  it.each([
    [5, -6],
    [50, -6],
    [50, 6],
  ])('keeps history at line %i when the row count changes by %i', (line, rowChange) => {
    const { buffer } = terminal(line, rowChange);
    expect(buffer.viewportY).toBe(line);
    frame();
    expect(buffer.viewportY).toBe(line);
  });

  it('leaves terminals following live output at the new bottom', () => {
    const { buffer } = terminal(100);
    frame();
    expect(buffer.viewportY).toBe(buffer.baseY);
  });
});

describe('terminal unregistration', () => {
  it('cancels pending fits once the last terminal is gone', () => {
    const container = document.createElement('div');
    const fit = vi.fn();
    const term = { buffer: { active: { viewportY: 0, baseY: 0 } } };
    manager.registerTerminal('test', container, { fit } as unknown as FitAddon, term as Terminal);
    manager.markDirty('test');
    manager.unregisterTerminal('test');

    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
  });
});
