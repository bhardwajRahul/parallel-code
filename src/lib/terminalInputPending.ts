function isCsiTerminator(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function skipEscapeSequence(data: string, index: number): number {
  const kind = data[index + 1];
  // xterm sends OSC color replies and DCS capability replies through onData,
  // just like keystrokes. Their payload is not a composer draft.
  if (kind === ']' || kind === 'P') {
    for (let i = index + 2; i < data.length; i++) {
      if (data[i] === '\x07') return i;
      if (data[i] === '\x1b' && data[i + 1] === '\\') return i + 1;
    }
    return data.length - 1;
  }
  if (kind === '[' || kind === 'O') {
    let i = index + 2;
    while (i < data.length) {
      if (isCsiTerminator(data[i])) return i;
      i++;
    }
    return data.length - 1;
  }
  // Alt/Meta keys are ESC followed by one character. Consume both so word
  // navigation isn't a draft and Shift+Enter isn't mistaken for submission.
  return kind === undefined ? index : index + 1;
}

function isTerminalReport(data: string, start: number, end: number): boolean {
  const seq = data.slice(start, end + 1);
  return (
    seq === '\x1b[I' ||
    seq === '\x1b[O' ||
    seq.startsWith('\x1b]') ||
    seq.startsWith('\x1bP') ||
    // Device attributes, cursor position, status and keyboard-protocol replies.
    // eslint-disable-next-line no-control-regex
    /^\x1b\[(?:[?>]?[\d;]*c|\??\d+;\d+R|\d+n|\?\d+u)$/.test(seq)
  );
}

export function hasTerminalUserActivity(data: string): boolean {
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\x1b') {
      const end = skipEscapeSequence(data, i);
      if (!isTerminalReport(data, i, end)) return true;
      i = end;
    } else if (ch === '\r' || ch === '\n' || ch === '\x03' || ch === '\x15') {
      return true;
    } else if (ch === '\x7f') {
      return true;
    } else if (ch >= ' ') {
      return true;
    }
  }
  return false;
}

export function nextTerminalInputPending(currentPending: boolean, data: string): boolean {
  let pending = currentPending;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\r' || ch === '\n' || ch === '\x03' || ch === '\x15') {
      pending = false;
    } else if (ch === '\x1b') {
      i = skipEscapeSequence(data, i);
    } else if (ch === '\x7f') {
      // Backspace: can't know if line is now empty without a char counter; leave pending unchanged.
    } else if (ch >= ' ') {
      pending = true;
    }
  }
  return pending;
}
