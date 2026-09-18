import { render } from 'solid-js/web';
import { Show } from 'solid-js';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { applyBlockWrite } from '../lib/canvas-blocks';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import type { CanvasWrite } from '../components/TaskCanvasEditor';
import { DocumentWorkspacePanel } from './DocumentWorkspacePanel';
import {
  closeDocumentWorkspace,
  documentStore,
  openDocumentFile,
  openDocumentWorkspace,
  openDocumentCompare,
  setDocumentView,
  commitDocumentEdits,
} from './store';

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
  Channel: class {
    dispose() {}
  },
}));
vi.mock('../lib/shell', () => ({ openInEditor: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock('./RightPanel', () => ({ RightPanel: () => <div /> }));

let dispose: (() => void) | undefined;
let host: HTMLElement;
let files: Record<string, string>;

beforeEach(() => {
  localStorage.clear();
  files = { 'notes.md': '# Notes\n', 'other.markdown': '# Other\n', 'page.html': '<h1>HTML</h1>' };
  vi.mocked(invoke).mockImplementation(async (channel, args) => {
    const path = String(args?.documentPath);
    if (channel === IPC.ReadDocument)
      return {
        content: files[path] ?? '',
        missing: !(path in files),
        headSha: 'abc',
        branch: 'main',
        dirty: false,
      };
    if (channel === IPC.WriteDocumentBlock) {
      const write = args as unknown as CanvasWrite;
      if (write.expectedContent !== files[path]) throw new Error('Document changed on disk');
      files[path] = applyBlockWrite(files[path], write);
    }
    return [];
  });
  setStore({
    documentWorkspacesEnabled: true,
    availableAgents: [],
    projects: [
      {
        id: 'docs',
        name: 'Docs',
        path: '/docs',
        color: '',
        kind: 'document',
        documentPath: 'notes.md',
      },
    ],
  });
});

afterEach(() => {
  closeDocumentWorkspace();
  dispose?.();
  document.body.replaceChildren();
  localStorage.clear();
  setStore({
    projects: [],
    activeDocumentProjectId: null,
    documentWorkspacesEnabled: false,
    tasks: {},
    agents: {},
    activeTaskId: null,
    activeAgentId: null,
  });
  vi.restoreAllMocks();
});

async function mount() {
  await openDocumentWorkspace('docs');
  host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <Show when={store.activeDocumentProjectId}>
        <DocumentWorkspacePanel />
      </Show>
    ),
    host,
  );
}

function button(label: string) {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
}

function edit(text = 'My edit\n') {
  button('Edit')?.click();
  const content = host.querySelector<HTMLElement>('.cm-content');
  expect(content).not.toBeNull();
  if (!content) throw new Error('Editor did not mount');
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error('Editor view is missing');
  view.dispatch({ changes: { from: 0, insert: text } });
  return view;
}

it('offers editing only for Markdown and saves before returning to Preview', async () => {
  await mount();
  edit();
  button('Preview')?.click();
  await vi.waitFor(() => expect(files['notes.md']).toContain('My edit'));
  await vi.waitFor(() => expect(button('Preview')?.getAttribute('aria-pressed')).toBe('true'));
  expect(documentStore.snapshot?.content).toContain('My edit');
  await openDocumentFile('page.html');
  expect(button('Edit')).toBeUndefined();
  await openDocumentFile('other.markdown');
  expect(button('Edit')).toBeDefined();
});

it('keeps a draft when switching files and when closing the workspace immediately', async () => {
  await mount();
  edit('Unfinished\n');
  await openDocumentFile('other.markdown');
  await openDocumentFile('notes.md');
  expect(host.querySelector('.cm-content')?.textContent).toContain('Unfinished');
  closeDocumentWorkspace();
  await openDocumentWorkspace('docs');
  expect(host.querySelector('.cm-content')?.textContent).toContain('Unfinished');
});

it('flushes edits before opening comparison or history', async () => {
  await mount();
  edit();
  openDocumentCompare('run');
  await vi.waitFor(() => expect(documentStore.compareRunId).toBe('run'));
  expect(files['notes.md']).toContain('My edit');
  edit('Another edit\n');
  setDocumentView('history');
  await vi.waitFor(() => expect(documentStore.view).toBe('history'));
  expect(files['notes.md']).toContain('Another edit');
});

it('flushes edits before committing them, so the commit includes what is on screen', async () => {
  await mount();
  edit('Committed edit\n');
  expect(await commitDocumentEdits()).toBe(true);
  // The editor holds the newest text until autosave fires. Committing without flushing first
  // would commit the file as it was before the user's last keystrokes.
  expect(files['notes.md']).toContain('Committed edit');
  const order = vi
    .mocked(invoke)
    .mock.calls.map(([channel]) => channel)
    .filter((channel) => channel === IPC.WriteDocumentBlock || channel === IPC.CommitDocumentEdits);
  expect(order.at(-1)).toBe(IPC.CommitDocumentEdits);
  expect(order).toContain(IPC.WriteDocumentBlock);
});

it('stays in Edit on save conflict and does not open a comparison against stale text', async () => {
  await mount();
  edit();
  files['notes.md'] = '# Agent revision\n';
  button('Preview')?.click();
  await vi.waitFor(() => expect(host.textContent).toContain('Document changed on disk'));
  expect(button('Edit')?.getAttribute('aria-pressed')).toBe('true');
  openDocumentCompare('run');
  await Promise.resolve();
  expect(documentStore.compareRunId).toBeNull();
  expect(files['notes.md']).toBe('# Agent revision\n');
});
