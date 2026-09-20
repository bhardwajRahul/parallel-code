import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import type { Project } from '../store/types';
import { EditProjectDialog } from './EditProjectDialog';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  setStore('projects', []);
  vi.clearAllMocks();
});

it('saves project fields even when the peer-access update fails', async () => {
  const project: Project = {
    id: 'project',
    name: 'Old name',
    path: '/repo',
    color: 'hsl(0, 70%, 75%)',
  };
  setStore('projects', [project]);
  vi.mocked(invoke).mockRejectedValue(new Error('backend unavailable'));
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <EditProjectDialog project={store.projects[0]} onClose={onClose} />, host);

  const name = document.querySelector<HTMLInputElement>('input.input-field');
  if (!name) throw new Error('Missing project name input');
  name.value = 'New name';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  const peerAccess = document.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]');
  if (!peerAccess) throw new Error('Missing peer access checkbox');
  peerAccess.click();
  const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === 'Save',
  );
  if (!save) throw new Error('Missing Save button');
  save.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('backend unavailable'));

  expect(store.projects[0].name).toBe('New name');
  expect(store.projects[0].allowPeerAccess).toBeUndefined();
  // The unsaved choice stays so Save can retry it.
  expect(peerAccess.checked).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
});
