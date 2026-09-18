/**
 * Split a leading `!` off a composed message.
 *
 * Agent TUIs switch to their shell prompt only when `!` arrives as a keystroke;
 * inside a bracketed paste it stays literal text, which is why a phone reply of
 * "! ls" used to reach the agent as a message instead of running a command.
 */
export function splitBashPrefix(text: string): { bash: boolean; body: string } {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('!')) return { bash: false, body: text };
  return { bash: true, body: trimmed.slice(1) };
}

export function messageForTerminal(text: string, bracketedPaste: boolean): string {
  // Clipboard controls must not escape the pasted region or submit midway.
  const clean = text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim();
  if (!clean) return '';
  return bracketedPaste ? `\x1b[200~${clean}\x1b[201~` : clean.replace(/\n/g, ' ');
}
