import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The settings files Claude Code reads for a working directory, lowest precedence first. */
function settingsFiles(cwd: string): string[] {
  const userDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return [
    join(userDir, 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
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
 * local settings winning over project and project over user. Read only to explain
 * the running mode to the user; the CLI still applies the settings on its own.
 */
export function settingsDefaultMode(cwd: string): string | undefined {
  return settingsFiles(cwd).reduce<string | undefined>(
    (mode, file) => defaultModeIn(file) ?? mode,
    undefined,
  );
}
