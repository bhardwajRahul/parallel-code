import { warn, errMessage } from '../../lib/log';

/** Chrome scopes a shadow tree's selection to the root; the DOM lib does not type it. */
function selectionIn(root: ShadowRoot): Selection | null {
  const scoped = (root as { getSelection?: () => Selection | null }).getSelection;
  return typeof scoped === 'function' ? scoped.call(root) : document.getSelection();
}

const EDITABLE = 'textarea, input, [contenteditable="true"]';

/**
 * Put a finished selection on the clipboard the way a terminal does. The chat log
 * rebuilds itself while the agent streams, so a selection can disappear before the
 * user reaches a copy shortcut.
 *
 * Returns a teardown function.
 */
export function enableCopyOnSelect(root: ShadowRoot): () => void {
  const onMouseUp = (event: Event) => {
    const target = event.target;
    // Selecting inside the composer usually precedes replacing or cutting that
    // draft, so leave whatever the user is about to paste on the clipboard.
    if (target instanceof Element && target.closest(EDITABLE)) return;
    const text = selectionIn(root)?.toString() ?? '';
    if (!text.trim()) return;
    void navigator.clipboard.writeText(text).catch((err: unknown) => {
      warn('chat', 'Copy on select failed', { error: errMessage(err) });
    });
  };
  root.addEventListener('mouseup', onMouseUp);
  return () => root.removeEventListener('mouseup', onMouseUp);
}
