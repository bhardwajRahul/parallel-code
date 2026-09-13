import {
  batch,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  Show,
  untrack,
} from 'solid-js';
import { unwrap } from 'solid-js/store';
import { MindMapGraph } from './MindMapGraph';
import {
  applyMapOperations,
  graphDifference,
  nodeTrail,
  visibleNodes,
  type MapNodeKind,
  type MapNode,
  type MapOperation,
  type MindMapDocument,
} from './model';
import { createInlineEditing } from './inlineEditing';
import type { BranchIntent, BranchRequest } from './agentActions';
import { createEditHistory } from './editHistory';
import { createReducedMotion } from './reducedMotion';
import { focusRecord } from './focus';
import type { MapOrientation } from './layout';
import { NodeContextMenu, type NodeAction } from './NodeContextMenu';
import { nodeActions, type NodeCommands } from './editorActions';
import { isProtected } from './ownership';
import { downloadText, graphToJson, graphToMarkdown } from './exportText';
import { ConfirmDialog } from '../components/ConfirmDialog';
import './editor.css';

/** Hands the user's manual changes to the agent; omit it when there is nothing new to send. */
export interface ChangeDelivery {
  /** Why sending is unavailable right now; the menu item stays visible but disabled. */
  blocker?: string;
  send: () => Promise<void>;
}

interface Props {
  document: MindMapDocument;
  visible: boolean;
  defaultZoom?: number;
  /** Session layout direction shared by every editor of the same map. */
  orientation?: MapOrientation;
  onOrientationChange?: (orientation: MapOrientation) => void;
  onReference?: (node: MapNode) => void;
  onBranchRequest?: (request: BranchRequest) => void;
  /** Marks ideas the user edited and offers to release them to the agent. */
  showOwnership?: boolean;
  sendChanges?: ChangeDelivery;
  onChange: (document: MindMapDocument) => void;
}

const handled = (event: Event) => {
  event.preventDefault();
  event.stopPropagation();
};

export function MindMapEditor(props: Props) {
  let root!: HTMLElement;
  let moreButton!: HTMLButtonElement;
  let disposed = false;
  let focusInside = false;
  let knownRevision = untrack(() => props.document.revision);
  const hintId = createUniqueId();
  const [selected, setSelected] = createSignal(untrack(() => props.document.records[0].id));
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const history = createEditHistory<MindMapDocument>(50);
  const [details, setDetails] = createSignal(false);
  const [menu, setMenu] = createSignal<{ x: number; y: number }>();
  const [confirmRemoval, setConfirmRemoval] = createSignal<string>();
  const [noteDrafts, setNoteDrafts] = createSignal<
    ReadonlyMap<string, { text: string; base: string }>
  >(new Map());
  const [error, setError] = createSignal('');
  const [locateRequest, setLocateRequest] = createSignal(0);
  // Undo and redo bring ideas back; a fresh key keeps the graph from announcing them as arrivals.
  const [restoreKey, setRestoreKey] = createSignal(0);
  const reducedMotion = createReducedMotion();
  const find = (id: string | undefined) =>
    props.document.records.find((record) => record.id === id);
  const node = () => find(selected());
  const siblingsOf = (id: string) => {
    const parent = find(id)?.parent;
    return props.document.records.filter((record) => record.parent === parent);
  };
  const descendantsOf = (id: string) =>
    props.document.records.filter(
      (record) =>
        record.id !== id &&
        nodeTrail(props.document.records, record.id).some((ancestor) => ancestor.id === id),
    );
  const protectedIds = () =>
    [...props.document.records, ...props.document.relations]
      .filter(isProtected)
      .map((item) => item.id);

  onCleanup(() => {
    disposed = true;
    // Unmounting must not lose typed text; conflicting drafts are dropped like a failed blur.
    saveTitle();
    // A draft for an idea that no longer exists has nowhere to go.
    for (const [id, draft] of untrack(noteDrafts)) if (find(id)) saveNotes(id, draft.text);
  });
  createEffect(() => {
    const records = props.document.records;
    const shown = new Set(visibleNodes(records, collapsed()).map((record) => record.id));
    if (props.document.revision !== knownRevision) {
      knownRevision = props.document.revision;
      history.reset();
    }
    const exists = (id: string | undefined) => records.some((record) => record.id === id);
    // Capture before resetting the editor: removing the title input leaves nothing focused.
    const held = focusInside || root.contains(document.activeElement);
    // An agent may remove the node under edit; a draft without an input would block every action.
    if (!exists(untrack(editing)?.id)) inline.reset();
    dropOrphanedNoteDrafts(exists);
    const id = untrack(selected);
    if (shown.has(id)) return;
    // A hidden selection cannot be reached; fall back to its nearest visible ancestor. The
    // error about that change must survive, so this bypasses the clearing in select().
    const trail = exists(id) ? nodeTrail(records, id) : [];
    const next = [...trail].reverse().find((ancestor) => shown.has(ancestor.id))?.id;
    setSelected(next ?? records[0].id);
    if (held) focusSoon(next ?? records[0].id);
  });

  /** The notes panel would otherwise show the draft on whichever idea the selection falls back to. */
  function dropOrphanedNoteDrafts(exists: (id: string) => boolean) {
    if ([...untrack(noteDrafts).keys()].every(exists)) return;
    setNoteDrafts((before) => new Map([...before].filter(([id]) => exists(id))));
    setError(
      'These notes changed while you were editing: the idea was removed, so the unsaved notes were discarded.',
    );
  }
  /** Moving to another idea leaves behind an error about the previous one. */
  function select(id: string) {
    if (id !== untrack(selected)) setError('');
    setSelected(id);
  }
  function focusSoon(id: string) {
    queueMicrotask(() => {
      if (!disposed && untrack(() => props.visible)) focusRecord(root, id);
    });
  }
  function focus(id: string, locate = false) {
    select(id);
    if (locate) setLocateRequest((request) => request + 1);
    focusSoon(id);
  }
  /** Collapsed ancestors would hide the node the user just acted on. */
  function reveal(id: string) {
    setCollapsed((before) => {
      const next = new Set(before);
      for (const ancestor of nodeTrail(props.document.records, id)) next.delete(ancestor.id);
      return next;
    });
  }
  const inline = createInlineEditing({
    label: 'Idea title',
    visible: () => props.visible,
    read: (id) => {
      const record = find(id);
      return record && { title: record.title, base: record.title };
    },
    onStart: (id) => {
      setSelected(id);
      setError('');
    },
    onSave: (draft) => {
      const current = find(draft.id);
      if (!current) return true;
      if (!draft.title.trim()) {
        setError('An idea needs a title. Type one, or press Escape to keep the previous title.');
        return false;
      }
      if (current.title !== draft.base && current.title !== draft.title) {
        setError(
          'This title changed while you were editing. Copy your text, then press Escape to see the latest version.',
        );
        return false;
      }
      return (
        draft.title === current.title ||
        commit([{ type: 'update', id: draft.id, changes: { title: draft.title } }])
      );
    },
    onCancel: (id) => {
      setError('');
      focus(id);
    },
    onFinish: focus,
    onAdd: (id, placement) => add(placement, id),
  });
  const { editing, edit, save: saveTitle } = inline;
  function commit(operations: MapOperation[]): boolean {
    try {
      const before = structuredClone(unwrap(props.document));
      const next = applyMapOperations(before, operations);
      knownRevision = next.revision;
      props.onChange(next);
      // The store may mutate `next` in place later; history keeps detached copies only.
      history.push({ before, after: structuredClone(next) });
      setError('');
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not edit the map.');
      return false;
    }
  }
  function discardNoteDraft(id: string) {
    setNoteDrafts((before) => {
      const next = new Map(before);
      next.delete(id);
      return next;
    });
    setError('');
  }
  function saveNotes(id: string, text: string) {
    const current = find(id);
    const draft = noteDrafts().get(id);
    if (!current || (draft && current.detail !== draft.base && current.detail !== text)) {
      setError(
        'These notes changed while you were editing. Copy your text, then press Escape in the notes to see the latest version.',
      );
      return;
    }
    if (text === current.detail || commit([{ type: 'update', id, changes: { detail: text } }]))
      discardNoteDraft(id);
  }
  function add(placement: 'child' | 'sibling', target = selected()) {
    if (!saveTitle()) return;
    const anchor = find(target);
    if (!anchor) return;
    const id = crypto.randomUUID();
    // The central topic has no siblings: a sibling request there adds a child instead.
    const sibling = placement === 'sibling' && !!anchor.parent;
    const parent = (sibling && anchor.parent) || anchor.id;
    const node = { id, parent, title: 'New idea', detail: '' };
    if (!commit([{ type: 'insert', node, after: sibling ? anchor.id : undefined }])) return;
    reveal(id);
    setSelected(id);
    setLocateRequest((request) => request + 1);
    edit(id);
  }
  function undo(redo = false) {
    // Cancel an unfinished title first; native text undo stays inside the input.
    inline.reset();
    const current = structuredClone(unwrap(props.document));
    const entry = history.step(redo);
    if (!entry) return;
    const next = redo ? entry.after : entry.before;
    try {
      const restored = applyMapOperations(
        current,
        graphDifference(current, next, { restore: true }),
      );
      knownRevision = restored.revision;
      batch(() => {
        props.onChange(restored);
        setRestoreKey((key) => key + 1);
      });
    } catch (error) {
      history.reset();
      setError(error instanceof Error ? error.message : 'Could not undo the map edit.');
      return;
    }
    setError('');
    const id = next.records.some((record) => record.id === selected())
      ? selected()
      : next.records[0].id;
    reveal(id);
    focus(id);
  }
  function remove(id = selected()) {
    if (!find(id)?.parent || !saveTitle()) return;
    // Whole branches are easy to delete by accident, so confirm when children would go too.
    if (descendantsOf(id).length) setConfirmRemoval(id);
    else removeBranch(id);
  }
  function removeBranch(id: string) {
    const parent = find(id)?.parent;
    setConfirmRemoval(undefined);
    if (parent && commit([{ type: 'remove', id }])) focus(parent);
  }
  function moveSibling(id: string, direction: -1 | 1) {
    const current = find(id);
    if (!current?.parent || !saveTitle()) return;
    const siblings = siblingsOf(id);
    const index = siblings.findIndex((record) => record.id === id);
    const neighbour = siblings[index + direction];
    if (!neighbour) return;
    const parent = current.parent;
    // Positions are expressed as "after a sibling": the first place has none, so the
    // previous sibling moves behind this node instead.
    const operation: MapOperation =
      direction > 0
        ? { type: 'move', id, parent, after: neighbour.id }
        : index > 1
          ? { type: 'move', id, parent, after: siblings[index - 2].id }
          : { type: 'move', id: neighbour.id, parent, after: id };
    if (commit([operation])) focus(id, true);
  }
  /** Nest under the previous sibling, or move one level up beside the parent. */
  function move(id: string, indent: boolean) {
    const current = find(id);
    if (!current?.parent || !saveTitle()) return;
    const parent = find(current.parent);
    const siblings = siblingsOf(id);
    const previous = siblings[siblings.findIndex((record) => record.id === id) - 1];
    const target = indent ? previous?.id : parent?.parent;
    if (!target) return;
    if (commit([{ type: 'move', id, parent: target, after: indent ? undefined : parent?.id }])) {
      setCollapsed((before) => {
        const next = new Set(before);
        next.delete(target);
        return next;
      });
      focus(id, true);
    }
  }
  function setKind(id: string, kind: MapNodeKind) {
    if (saveTitle() && (find(id)?.kind ?? 'idea') !== kind)
      commit([{ type: 'update', id, changes: { kind } }]);
    focus(id);
  }
  function toggle(id: string) {
    setCollapsed((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    focus(id);
  }
  function release(ids: string[]) {
    if (!ids.length || !saveTitle()) return;
    const records = new Set(props.document.records.map((record) => record.id));
    commit(
      ids.map((id) =>
        records.has(id)
          ? { type: 'update', id, changes: {}, userEdited: [] }
          : { type: 'update_relation', id, changes: {}, userEdited: [] },
      ),
    );
  }
  function openNotes(id: string) {
    setSelected(id);
    setDetails(true);
    queueMicrotask(() => {
      if (!disposed && untrack(() => props.visible))
        root.querySelector<HTMLTextAreaElement>('[aria-label="Idea notes"]')?.focus();
    });
  }
  function ask(id: string, intent: BranchIntent) {
    if (!saveTitle()) return;
    props.onBranchRequest?.({
      intent,
      rootId: id,
      map: props.document,
      revision: props.document.revision,
    });
  }
  function reference(id: string) {
    const record = find(id);
    if (record && saveTitle()) props.onReference?.(record);
  }
  function exportMap(format: 'md' | 'json') {
    const name =
      props.document.records[0].title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'mind-map';
    if (format === 'md')
      downloadText(`${name}.md`, graphToMarkdown(props.document), 'text/markdown');
    else downloadText(`${name}.json`, graphToJson(props.document), 'application/json');
  }
  async function sendChanges() {
    const delivery = props.sendChanges;
    if (!delivery || delivery.blocker || !saveTitle()) return;
    try {
      await delivery.send();
    } catch (cause) {
      if (!disposed)
        setError(cause instanceof Error ? cause.message : 'Could not send the changes.');
    }
  }
  function commands(id: string): NodeCommands {
    return {
      rename: () => edit(id),
      notes: () => openNotes(id),
      addChild: () => add('child', id),
      addSibling: () => add('sibling', id),
      moveSibling: (direction) => moveSibling(id, direction),
      nest: () => move(id, true),
      outdent: () => move(id, false),
      setKind: (kind) => setKind(id, kind),
      toggle: () => toggle(id),
      release: () => release([id]),
      remove: () => remove(id),
      // eslint-disable-next-line solid/reactivity -- rebuilt whenever a menu opens
      ask: props.onBranchRequest && ((intent) => ask(id, intent)),
      // eslint-disable-next-line solid/reactivity -- rebuilt whenever a menu opens
      reference: props.onReference && (() => reference(id)),
    };
  }
  const actionsFor = (id: string) =>
    nodeActions({
      document: props.document,
      id,
      collapsed: collapsed().has(id),
      showOwnership: !!props.showOwnership,
      commands: commands(id),
    });
  const moreActions = (): NodeAction[] => [
    ...actionsFor(selected()),
    ...(props.showOwnership && protectedIds().length
      ? [
          {
            label: 'Release all to agent',
            separator: true,
            title: 'Let the agent change or remove every idea you edited.',
            run: () => release(protectedIds()),
          },
        ]
      : []),
    {
      label: 'Export',
      separator: true,
      children: [
        { label: 'Markdown outline', run: () => exportMap('md') },
        { label: 'JSON', run: () => exportMap('json') },
      ],
    },
    ...(props.sendChanges
      ? [
          {
            label: 'Send manual changes to agent',
            disabled: !!props.sendChanges.blocker,
            title: props.sendChanges.blocker,
            run: () => void sendChanges(),
          },
        ]
      : []),
  ];
  function closeMenu() {
    setMenu(undefined);
    moreButton.focus({ preventScroll: true });
  }
  function keydown(id: string, event: KeyboardEvent) {
    if (event.isComposing || event.ctrlKey || event.metaKey || !find(id)) return;
    if (event.altKey) {
      if (event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        handled(event);
        moveSibling(id, event.key === 'ArrowUp' ? -1 : 1);
      }
      return;
    }
    if (inline.keydown(id, event)) return;
    if (event.key === 'Tab' && event.shiftKey && find(find(id)?.parent)?.parent) {
      handled(event);
      move(id, false);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      handled(event);
      remove(id);
    } else if (event.key === 'Escape') {
      handled(event);
      root.querySelector<HTMLElement>('.mindmap-add')?.focus();
    }
  }

  return (
    <section
      ref={root}
      class="mindmap-editor"
      aria-label="Mind map editor"
      aria-describedby={hintId}
      onFocusIn={() => (focusInside = true)}
      onFocusOut={(event) => {
        const next = event.relatedTarget;
        // A removed node fires no useful target; only a real move elsewhere releases the map.
        if (next instanceof Node ? !root.contains(next) : event.target.isConnected)
          focusInside = false;
      }}
      onKeyDown={(event) => {
        const input = event.target instanceof Element && event.target.closest('input, textarea');
        if (input || event.isComposing || !(event.ctrlKey || event.metaKey)) return;
        const key = event.key.toLowerCase();
        if (key === 'z' || key === 'y') {
          handled(event);
          undo(key === 'y' || event.shiftKey);
        }
      }}
    >
      <div class="mindmap-toolbar" role="toolbar" aria-label="Mind map actions">
        <button class="mindmap-add" onClick={() => add('child')} title="Add child (Tab)">
          + Idea
        </button>
        <button
          disabled={!node()?.parent}
          onClick={() => add('sibling')}
          title="Add sibling (Enter)"
        >
          + Sibling
        </button>
        <button disabled={!history.canUndo()} onClick={() => undo()} title="Undo (Ctrl/Cmd+Z)">
          Undo
        </button>
        <button
          disabled={!history.canRedo()}
          onClick={() => undo(true)}
          title="Redo (Ctrl/Cmd+Shift+Z or Ctrl+Y)"
        >
          Redo
        </button>
        <button aria-pressed={details()} onClick={() => setDetails(!details())}>
          Notes
        </button>
        <button
          ref={moreButton}
          class="mindmap-more"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={!!menu()}
          onClick={() => {
            if (menu()) return setMenu(undefined);
            const bounds = moreButton.getBoundingClientRect();
            setMenu({ x: bounds.left, y: bounds.bottom + 4 });
          }}
        >
          •••
        </button>
      </div>
      <Show when={menu()} keyed>
        {(anchor) => (
          <NodeContextMenu
            anchor={anchor}
            label="Map actions"
            owner={moreButton}
            actions={moreActions()}
            onClose={closeMenu}
          />
        )}
      </Show>
      <Show when={error()}>
        <p class="mindmap-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="mindmap-stage">
        <MindMapGraph
          snapshot={props.document}
          selected={selected()}
          locateId={selected()}
          collapsed={collapsed()}
          follow={false}
          reducedMotion={reducedMotion()}
          pulseWork={false}
          visible={props.visible}
          defaultZoom={props.defaultZoom}
          orientation={props.orientation}
          onOrientationChange={props.onOrientationChange}
          locateRequest={locateRequest()}
          locateOnlyIfOutside
          reserveCollapsedSpace={false}
          dimUnselected={false}
          showOwnership={props.showOwnership}
          changeKey={String(restoreKey())}
          onSelect={select}
          onHold={() => {}}
          onEdit={edit}
          onNodeKeyDown={keydown}
          nodeActions={actionsFor}
          onToggle={toggle}
          editingId={editing()?.id}
          renderEditor={inline.renderEditor}
        />
        <Show when={details() && node()}>
          {(record) => (
            <aside class="mindmap-notes">
              <div>
                <strong>{record().title}</strong>
                <button aria-label="Close notes" onClick={() => setDetails(false)}>
                  ×
                </button>
              </div>
              <textarea
                aria-label="Idea notes"
                placeholder="Add a note…"
                maxLength={8000}
                value={noteDrafts().get(record().id)?.text ?? record().detail}
                onInput={(event) => {
                  const id = record().id;
                  const text = event.currentTarget.value;
                  setNoteDrafts((before) =>
                    new Map(before).set(id, {
                      text,
                      base: before.get(id)?.base ?? record().detail,
                    }),
                  );
                }}
                onChange={(event) => saveNotes(record().id, event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !event.isComposing) {
                    handled(event);
                    discardNoteDraft(record().id);
                  }
                }}
              />
            </aside>
          )}
        </Show>
      </div>
      <p id={hintId} class="mindmap-hint">
        Right-click for actions · F2 rename · Ctrl+wheel zoom
      </p>
      <ConfirmDialog
        open={!!confirmRemoval()}
        title="Delete this branch?"
        message={`“${find(confirmRemoval())?.title ?? ''}” and the ${descendantsOf(confirmRemoval() ?? '').length} ideas below it will be removed. Undo can bring them back.`}
        confirmLabel="Delete branch"
        danger
        onConfirm={() => {
          const id = confirmRemoval();
          if (id) removeBranch(id);
        }}
        onCancel={() => {
          const id = confirmRemoval();
          setConfirmRemoval(undefined);
          if (id) focus(id);
        }}
      />
    </section>
  );
}
