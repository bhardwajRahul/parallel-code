import headless from '@xterm/headless';

const { Terminal } = headless;

/**
 * Lines kept above the viewport. Widening a terminal unwraps lines and pulls
 * scrollback back into view, which moves the cursor row, so the mirror needs
 * about a screen's worth to agree with the renderer's xterm. Far below the
 * renderer's 10k because one mirror runs per PTY in the main process.
 */
const SCROLLBACK_LINES = 200;

// A cursor position report: CSI row;col R, or the DEC form CSI ? row;col R.
// eslint-disable-next-line no-control-regex
const CURSOR_POSITION_REPORT = /^\x1b\[\??\d+;\d+R$/;

/** Answers a PTY's cursor-position queries from the main process. */
export interface TerminalQueryResponder {
  /** Parse process output; a cursor-position query in it is answered through `reply`. */
  feed(data: string): void;
  /**
   * Parse text the pane shows that the process did not write (a banner, replayed
   * scrollback), so the cursor stays where the renderer has it. Queries in it
   * are stale and get no answer.
   */
  feedDisplayOnly(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

/**
 * Mirror a PTY's screen in a headless xterm and answer its cursor-position
 * queries, so the answer never depends on a renderer view being mounted,
 * visible or unthrottled. Codex exits when a query goes unanswered for about
 * two seconds. The renderer's xterm leaves these queries to this responder;
 * other queries (device attributes, colors) still come from the renderer,
 * whose theme and settings they describe.
 */
export function createTerminalQueryResponder(opts: {
  cols: number;
  rows: number;
  reply: (data: string) => void;
}): TerminalQueryResponder {
  const term = new Terminal({
    cols: Math.max(1, opts.cols),
    rows: Math.max(1, opts.rows),
    scrollback: SCROLLBACK_LINES,
  });
  let muted = 0;
  let disposed = false;

  term.onData((data) => {
    if (disposed || muted > 0 || !CURSOR_POSITION_REPORT.test(data)) return;
    opts.reply(data);
  });

  return {
    feed(data) {
      if (!disposed) term.write(data);
    },
    feedDisplayOnly(data) {
      if (disposed) return;
      muted++;
      // Writes are parsed in order, so the callback runs before any later feed.
      term.write(data, () => {
        muted--;
      });
    },
    resize(cols, rows) {
      if (!disposed && cols > 0 && rows > 0) term.resize(cols, rows);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      term.dispose();
    },
  };
}
