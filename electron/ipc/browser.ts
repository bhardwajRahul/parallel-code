import {
  ipcMain,
  WebContentsView,
  session,
  type BrowserWindow,
  type Input,
  type IpcMainInvokeEvent,
} from 'electron';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { IPC } from './channels.js';
import {
  normalizeBrowserUrl,
  parseBrowserBounds,
  parsePickedElement,
  formatElementReference,
  type BrowserState,
} from '../shared/browser.js';

export function isBrowserCloseShortcut(
  input: Pick<Input, 'type' | 'key' | 'control' | 'meta' | 'alt' | 'shift'>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const primary =
    platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  return (
    input.type === 'keyDown' &&
    input.key.toLowerCase() === 'w' &&
    primary &&
    !input.alt &&
    !input.shift
  );
}

/** Native views need explicit bounds and disposal; they are not DOM children.
 * https://www.electronjs.org/docs/latest/tutorial/web-embeds#webcontentsview */
export function registerBrowserHandlers(win: BrowserWindow): void {
  const previews = new Map<
    string,
    { view: WebContentsView; state: BrowserState; visible: boolean }
  >();
  const owner = win.webContents;
  const trusted = (event: IpcMainInvokeEvent): void => {
    if (event.sender !== owner || event.senderFrame !== owner.mainFrame)
      throw new Error('Browser command is not from the app.');
  };
  const argsFor = (value: unknown): Record<string, unknown> & { id: string } => {
    if (!value || typeof value !== 'object') throw new Error('Invalid browser command.');
    const args = value as Record<string, unknown>;
    if (typeof args.id !== 'string' || !/^[\w-]{1,80}$/.test(args.id))
      throw new Error('Invalid preview ID.');
    return args as Record<string, unknown> & { id: string };
  };
  function close(id: string, detach = true): void {
    const entry = previews.get(id);
    if (!entry) return;
    previews.delete(id);
    if (detach) win.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  }
  const closeAll = (): void => {
    for (const id of previews.keys()) close(id);
  };

  ipcMain.handle(IPC.BrowserCommand, (event, value: unknown) => {
    trusted(event);
    const args = argsFor(value);
    if (args.action === 'close') {
      close(args.id);
      return;
    }
    if (args.action === 'create') {
      if (previews.has(args.id)) return previews.get(args.id)?.state;
      // In-memory, separate from the app and every other preview. No inherited clipboard/mic
      // grants. The name is minted here, not taken from the renderer, so isolation cannot be
      // weakened by whatever ID the caller supplies.
      // known cost: Electron cannot destroy a Session, so each open leaks a network context
      // and cache. Fixing that needs a stable, reused partition name — which also decides
      // whether a reopened preview keeps its cookies — so it is a deliberate change, not this one.
      const previewSession = session.fromPartition(`preview-${randomUUID()}`);
      previewSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      previewSession.setPermissionCheckHandler(() => false);
      previewSession.on('will-download', (e) => e.preventDefault());
      const view = new WebContentsView({
        webPreferences: {
          preload: fileURLToPath(new URL('../../electron/browser-preload.cjs', import.meta.url)),
          session: previewSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          navigateOnDragDrop: false,
        },
      });
      const wc = view.webContents;
      const state: BrowserState = {
        id: args.id,
        url: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        picking: false,
        error: null,
      };
      const entry = { view, state, visible: false };
      previews.set(args.id, entry);
      view.setVisible(false);
      win.contentView.addChildView(view);
      const publish = (
        event: Pick<BrowserState, 'reference' | 'focused' | 'closeRequested'> = {},
      ): void => {
        if (previews.get(args.id) !== entry || owner.isDestroyed() || wc.isDestroyed()) return;
        state.loading = wc.isLoading();
        state.canGoBack = wc.navigationHistory.canGoBack();
        state.canGoForward = wc.navigationHistory.canGoForward();
        owner.send(IPC.BrowserState, { ...state, ...event });
      };
      wc.on('focus', () => publish({ focused: true }));
      wc.on('before-input-event', (event, input) => {
        if (!entry.visible || !isBrowserCloseShortcut(input)) return;
        event.preventDefault();
        if (!input.isAutoRepeat) publish({ closeRequested: true });
      });
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', (e, url) => {
        try {
          normalizeBrowserUrl(url);
        } catch {
          e.preventDefault();
        }
      });
      wc.on('will-redirect', (e, url) => {
        try {
          normalizeBrowserUrl(url);
        } catch {
          e.preventDefault();
        }
      });
      wc.on('will-attach-webview', (e) => e.preventDefault());
      wc.on('content-bounds-updated', (e) => e.preventDefault());
      wc.on('did-start-navigation', (_e, url, inPlace, mainFrame) => {
        if (!mainFrame) return;
        state.url = url;
        state.error = null;
        if (!inPlace) state.picking = false;
        publish();
      });
      wc.on('did-navigate', (_e, url) => {
        state.url = url;
        publish();
      });
      wc.on('did-navigate-in-page', (_e, url, mainFrame) => {
        if (mainFrame) {
          state.url = url;
          publish();
        }
      });
      wc.on('did-start-loading', () => publish());
      wc.on('did-stop-loading', () => publish());
      wc.on('did-fail-load', (_e, code, _description, _url, mainFrame) => {
        if (!mainFrame || code === -3) return; // A newer navigation can cancel an older one.
        state.error =
          'Could not load this page. Check the address and that your dev server is running.';
        state.picking = false;
        view.setVisible(false);
        publish();
      });
      wc.on('render-process-gone', () => {
        state.error = 'The preview stopped. Reload to try again.';
        state.picking = false;
        view.setVisible(false);
        publish();
      });
      // Only this guest's main-frame isolated preload may return a selection, and only while armed.
      wc.ipc.on('browser:pick-result', (e, payload: unknown) => {
        if (e.senderFrame !== wc.mainFrame || !state.picking || !entry.visible) return;
        state.picking = false;
        if (payload === null) {
          publish();
          return;
        }
        try {
          const element = parsePickedElement(payload);
          owner.focus();
          publish({ reference: formatElementReference(wc.getURL(), element) });
        } catch {
          publish();
        }
      });
      return state;
    }
    const entry = previews.get(args.id);
    if (!entry) throw new Error('Preview is closed.');
    const { view, state } = entry;
    const wc = view.webContents;
    switch (args.action) {
      case 'navigate': {
        const url = normalizeBrowserUrl(args.url);
        state.error = null;
        state.url = url;
        // did-fail-load provides the UI error, including for reload/history navigations.
        void wc.loadURL(url).catch(() => undefined);
        break;
      }
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;
      case 'forward':
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        break;
      case 'reload':
        state.error = null;
        wc.reload();
        break;
      case 'pick':
        if (!entry.visible || wc.isLoading() || state.error) break;
        state.picking = !state.picking;
        wc.send('browser:set-picking', state.picking);
        if (state.picking) wc.focus();
        owner.send(IPC.BrowserState, { ...state });
        break;
      default:
        throw new Error('Unknown browser command.');
    }
  });
  ipcMain.handle(IPC.BrowserBounds, (event, value: unknown) => {
    trusted(event);
    const args = argsFor(value);
    const bounds = parseBrowserBounds(args.bounds);
    const entry = previews.get(args.id);
    if (!entry) return;
    const zoom = owner.getZoomFactor();
    const windowBounds = win.getContentBounds();
    const visible =
      bounds !== null &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      (bounds.x + bounds.width) * zoom <= windowBounds.width + 1 &&
      (bounds.y + bounds.height) * zoom <= windowBounds.height + 1 &&
      !entry.state.error;
    entry.visible = visible;
    if (bounds && visible)
      entry.view.setBounds({
        x: Math.round(bounds.x * zoom),
        y: Math.round(bounds.y * zoom),
        width: Math.round(bounds.width * zoom),
        height: Math.round(bounds.height * zoom),
      });
    entry.view.setVisible(visible);
    if (!visible && entry.state.picking) {
      entry.state.picking = false;
      entry.view.webContents.send('browser:set-picking', false);
      owner.send(IPC.BrowserState, { ...entry.state });
    }
  });
  owner.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) closeAll();
  });
  owner.on('render-process-gone', closeAll);
  win.on('closed', () => {
    // The parent native view is already destroyed; guest WebContents still need closing.
    for (const id of previews.keys()) close(id, false);
    ipcMain.removeHandler(IPC.BrowserCommand);
    ipcMain.removeHandler(IPC.BrowserBounds);
  });
}
