import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import { SettingsDialog } from './SettingsDialog';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../lib/fonts', () => ({
  DEFAULT_TERMINAL_FONT: 'monospace',
  getAvailableTerminalFonts: () => ['monospace'],
  fetchAvailableTerminalFonts: async () => ['monospace'],
  getTerminalFontFamily: () => 'monospace',
  LIGATURE_FONTS: new Set(),
}));

let dispose: (() => void) | undefined;

function selectTab(label: string): void {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (element) => element.textContent === label,
  );
  if (!tab) throw new Error(`Missing ${label} tab`);
  tab.click();
}

function orchestrationCheckbox(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    '#settings-tab-mcp input[type="checkbox"]',
  );
  if (!input) throw new Error('Missing agent orchestration switch');
  return input;
}

beforeEach(() => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  setStore('mcpOrchestrationEnabled', true);
  setStore('preferUiMode', false);
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <SettingsDialog open onClose={() => {}} />, host);
});

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it('groups agent orchestration and automatic child update controls in the MCP tab', () => {
  selectTab('MCP');
  expect(document.querySelector('#settings-tab-mcp')?.textContent).toContain(
    'Allow agents to orchestrate tasks',
  );
  expect(document.querySelector('#settings-tab-mcp')?.textContent).toContain(
    'Automatic child updates',
  );
  expect(document.querySelector('#settings-tab-mcp')?.textContent).not.toContain(
    'Coordinator mode',
  );
  selectTab('Experimental');
  expect(document.querySelector('#settings-tab-experimental')?.textContent).toContain(
    'Document workspaces',
  );
  expect(document.querySelector('#settings-tab-experimental')?.textContent).not.toContain(
    'Coordinator mode',
  );
});

it('waits for backend acknowledgement before displaying the disabled setting', async () => {
  let acknowledge: (() => void) | undefined;
  vi.mocked(invoke).mockImplementation(
    () => new Promise<void>((resolve) => (acknowledge = resolve)),
  );
  selectTab('MCP');
  const checkbox = orchestrationCheckbox();
  checkbox.click();
  expect(invoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
    action: 'orchestrationSetting',
    enabled: false,
  });
  expect(store.mcpOrchestrationEnabled).toBe(true);
  expect(checkbox.checked).toBe(true);
  expect(checkbox.disabled).toBe(true);
  acknowledge?.();
  await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
  expect(store.mcpOrchestrationEnabled).toBe(false);
  expect(checkbox.checked).toBe(false);
});

it('keeps the setting enabled and reports a rejected backend change', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('Backend unavailable'));
  selectTab('MCP');
  const checkbox = orchestrationCheckbox();
  checkbox.click();
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Backend unavailable'),
  );
  expect(store.mcpOrchestrationEnabled).toBe(true);
  expect(checkbox.checked).toBe(true);
  expect(checkbox.disabled).toBe(false);
});

it('toggles the global UI mode preference in General settings', () => {
  const label = [...document.querySelectorAll('label')].find((element) =>
    element.textContent?.includes('Always prefer UI mode'),
  );
  const checkbox = label?.querySelector('input');
  expect(checkbox).toBeDefined();
  expect(checkbox?.checked).toBe(false);
  checkbox?.click();
  expect(store.preferUiMode).toBe(true);
  expect(checkbox?.checked).toBe(true);
  checkbox?.click();
  expect(store.preferUiMode).toBe(false);
});
