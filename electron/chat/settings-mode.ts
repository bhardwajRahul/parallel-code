import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

/** Where an administrator's managed settings live, which outrank every other file. */
const MANAGED_SETTINGS =
  process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : '/etc/claude-code/managed-settings.json';

/** The settings files Claude Code reads for a working directory, lowest precedence first. */
function settingsFiles(cwd: string): string[] {
  const userDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return [
    join(userDir, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
    MANAGED_SETTINGS,
  ];
}

function defaultModeIn(file: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    return undefined; // No settings at this level is the normal case.
  }
  try {
    const settings: unknown = JSON.parse(contents);
    const permissions = (settings as { permissions?: unknown })?.permissions;
    const mode = (permissions as { defaultMode?: unknown })?.defaultMode;
    return typeof mode === 'string' ? mode : undefined;
  } catch (error) {
    // Malformed settings are the user's to fix; Claude Code reports them itself.
    // Never let one stop the chat from opening.
    console.warn(`Ignoring unreadable settings file ${file}:`, error);
    return undefined;
  }
}

/**
 * The `permissions.defaultMode` Claude Code itself would resolve for `cwd`, with
 * managed settings winning over local, local over project, and project over user.
 *
 * The chat has to resolve this itself: the SDK sends `--permission-mode` on every
 * session it starts, and that flag outranks the settings file, so the CLI never
 * gets to apply `defaultMode` on its own the way it does in a terminal.
 */
export function settingsDefaultMode(cwd: string): string | undefined {
  return settingsFiles(cwd).reduce<string | undefined>(
    (mode, file) => defaultModeIn(file) ?? mode,
    undefined,
  );
}

/** The modes a chat session may launch itself in on the strength of a settings file. */
const LAUNCHABLE = new Set<string>(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk']);

/**
 * A settings `defaultMode` as a mode the session can launch in, or `undefined`
 * when the session should not adopt it.
 *
 * `bypassPermissions` is the one mode deliberately left behind: running a whole
 * session unprompted belongs to the task's own "skip permissions" switch, which
 * is also what passes the CLI's opt-in flag for it.
 */
export function launchPermissionMode(mode: string | undefined): PermissionMode | undefined {
  // 'manual' is what the CLI calls the asking mode on the command line; the SDK
  // and the session's own reports still call the same mode 'default'.
  if (mode === 'manual') return 'default';
  return mode && LAUNCHABLE.has(mode) ? (mode as PermissionMode) : undefined;
}
