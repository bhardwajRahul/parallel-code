import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchPermissionMode, settingsDefaultMode } from './settings-mode.js';

let root: string;
let cwd: string;
const write = (dir: string, name: string, contents: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), contents);
};
const project = () => join(cwd, '.claude');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'settings-mode-'));
  cwd = join(root, 'worktree');
  mkdirSync(cwd, { recursive: true });
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'config'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('settingsDefaultMode', () => {
  it('reads nothing when no settings file sets a mode', () => {
    expect(settingsDefaultMode(cwd)).toBeUndefined();
    write(join(root, 'config'), 'settings.json', '{"permissions":{"allow":["Read"]}}');
    expect(settingsDefaultMode(cwd)).toBeUndefined();
  });

  it('lets project settings override user settings, and local override both', () => {
    write(join(root, 'config'), 'settings.json', '{"permissions":{"defaultMode":"auto"}}');
    expect(settingsDefaultMode(cwd)).toBe('auto');
    write(project(), 'settings.json', '{"permissions":{"defaultMode":"plan"}}');
    expect(settingsDefaultMode(cwd)).toBe('plan');
    write(project(), 'settings.local.json', '{"permissions":{"defaultMode":"acceptEdits"}}');
    expect(settingsDefaultMode(cwd)).toBe('acceptEdits');
  });

  it('keeps the readable settings when one file is malformed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    write(join(root, 'config'), 'settings.json', '{"permissions":{"defaultMode":"auto"}}');
    write(project(), 'settings.json', '{ not json');
    expect(settingsDefaultMode(cwd)).toBe('auto');
    expect(warn).toHaveBeenCalled();
  });
});

describe('launchPermissionMode', () => {
  it('passes on the modes a session may launch itself in', () => {
    expect(launchPermissionMode('auto')).toBe('auto');
    expect(launchPermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(launchPermissionMode('plan')).toBe('plan');
    expect(launchPermissionMode('dontAsk')).toBe('dontAsk');
    // The command line's name for the asking mode, which the SDK calls 'default'.
    expect(launchPermissionMode('manual')).toBe('default');
  });

  it('adopts neither bypassPermissions nor a mode it does not know', () => {
    expect(launchPermissionMode('bypassPermissions')).toBeUndefined();
    expect(launchPermissionMode('yolo')).toBeUndefined();
    expect(launchPermissionMode(undefined)).toBeUndefined();
  });
});
