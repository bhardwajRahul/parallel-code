import { describe, it, expect } from 'vitest';
import { messageForTerminal, splitBashPrefix } from './terminalText';

describe('composed phone replies', () => {
  it('preserves multiline text within bracketed paste', () => {
    expect(messageForTerminal('first\r\nsecond', true)).toBe('\x1b[200~first\nsecond\x1b[201~');
  });
  it('does not accidentally submit each line in terminals without paste support', () => {
    expect(messageForTerminal('first\nsecond', false)).toBe('first second');
  });
  it('removes pasted control characters and refuses an empty message', () => {
    expect(messageForTerminal('\x03hello\x1b', true)).toBe('\x1b[200~hello\x1b[201~');
    expect(messageForTerminal(' \n\x03 ', true)).toBe('');
  });
});

describe('shell command prefix', () => {
  it('separates the prefix from the command it should run', () => {
    expect(splitBashPrefix('! ls -la')).toEqual({ bash: true, body: ' ls -la' });
    expect(splitBashPrefix('  !git status')).toEqual({ bash: true, body: 'git status' });
    expect(splitBashPrefix('!')).toEqual({ bash: true, body: '' });
  });
  it('leaves an ordinary message untouched, including a mid-sentence bang', () => {
    expect(splitBashPrefix('nice work!')).toEqual({ bash: false, body: 'nice work!' });
    expect(splitBashPrefix('first\nsecond')).toEqual({ bash: false, body: 'first\nsecond' });
  });
});
