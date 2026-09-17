import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableCopyOnSelect } from './copy-on-select';

let host: HTMLDivElement;
let shadow: ShadowRoot;
let message: HTMLParagraphElement;
let composer: HTMLTextAreaElement;
let stop: () => void;
const writeText = vi.fn(async () => undefined);
let selected = '';

/** happy-dom has no selection model, so drive the text the root reports directly. */
function select(text: string) {
  selected = text;
}
function mouseUpOn(node: Element) {
  node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

beforeEach(() => {
  selected = '';
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  host = document.createElement('div');
  document.body.append(host);
  shadow = host.attachShadow({ mode: 'open' });
  Object.defineProperty(shadow, 'getSelection', {
    value: () => ({ toString: () => selected }),
    configurable: true,
  });
  message = document.createElement('p');
  message.textContent = 'Hello';
  composer = document.createElement('textarea');
  shadow.append(message, composer);
  stop = enableCopyOnSelect(shadow);
});
afterEach(() => {
  stop();
  host.remove();
});

describe('copy on select', () => {
  it('copies a finished selection from the log', () => {
    select('npm run check');
    mouseUpOn(message);
    expect(writeText).toHaveBeenCalledWith('npm run check');
  });

  it('ignores a click that selected nothing', () => {
    select('   ');
    mouseUpOn(message);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('leaves the clipboard alone while selecting inside the composer', () => {
    select('half-written message');
    mouseUpOn(composer);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('stops listening once disposed', () => {
    stop();
    select('npm run check');
    mouseUpOn(message);
    expect(writeText).not.toHaveBeenCalled();
  });
});
