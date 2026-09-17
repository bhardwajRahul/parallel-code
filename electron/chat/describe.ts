/** Readable renderings of agent traffic: the chat view shows prose, not protocol. */
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

const string = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Arguments that read as a headline, in the order a person would look for them. */
const HEADLINE_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'prompt'];
const HEADLINE_LENGTH = 200;

/**
 * One line naming what a tool call does, such as `Bash: npm test`. A tool whose
 * arguments carry no headline is named on its own; the raw arguments stay available
 * separately for anyone who wants them.
 *
 * What it leaves out, it says it left out: this line heads an approval card, and a
 * summary that reads like the whole call would have the user approve the part they
 * cannot see.
 */
export function describeToolCall(tool: string, input: Record<string, unknown>): string {
  const key = HEADLINE_KEYS.find((key) => string(input[key]).trim());
  const [first = '', ...rest] = key ? string(input[key]).trim().split('\n') : [];
  if (!first) return tool;
  const dropped = rest.filter((line) => line.trim()).length;
  const short =
    first.length > HEADLINE_LENGTH ? `${first.slice(0, HEADLINE_LENGTH).trim()}…` : first;
  const more = dropped ? ` … (+${dropped} more ${dropped === 1 ? 'line' : 'lines'})` : '';
  return `${tool}: ${short}${more}`;
}

const DESTINATIONS: Record<PermissionUpdate['destination'], string> = {
  userSettings: 'your user settings',
  projectSettings: 'this project’s settings',
  localSettings: 'this checkout’s local settings',
  session: 'this session',
  cliArg: 'this session',
};
const RULE_VERBS = { allow: 'allow', deny: 'deny', ask: 'ask about' };
const ruleText = (rules: { toolName: string; ruleContent?: string }[]): string =>
  rules
    .map((rule) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName))
    .join(', ');

/**
 * What approving for good would actually change. The agent's suggestion can reach
 * past this one call — into a settings file that outlives the session, or into a
 * permission mode covering every later call — so the card has to say which.
 */
export function describePermissionUpdates(updates: PermissionUpdate[]): string {
  return updates
    .map((update) => {
      const where = DESTINATIONS[update.destination];
      if (update.type === 'setMode') return `switch to ${update.mode} for ${where}`;
      if (update.type === 'addDirectories')
        return `add ${update.directories.join(', ')} to ${where}`;
      if (update.type === 'removeDirectories')
        return `remove ${update.directories.join(', ')} from ${where}`;
      const verb = RULE_VERBS[update.behavior];
      return update.type === 'removeRules'
        ? `drop the ${verb} rule for ${ruleText(update.rules)} in ${where}`
        : `always ${verb} ${ruleText(update.rules)} in ${where}`;
    })
    .join('; ');
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const NOTIFICATION = /<task-notification>[\s\S]*?<\/task-notification>/g;
const tag = (block: string, name: string): string =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1]?.trim() ?? '';

/**
 * The part of a user turn the user would recognise as theirs. The CLI injects
 * machine-readable blocks alongside it — reminders nobody typed, and background-task
 * notifications whose own summary line says more than their XML.
 */
export function visibleUserText(text: string): string {
  return text
    .replace(REMINDER, '')
    .replace(NOTIFICATION, (block) => {
      const summary = tag(block, 'summary');
      const status = tag(block, 'status');
      return summary || (status ? `Background task ${status}.` : '');
    })
    .trim();
}
