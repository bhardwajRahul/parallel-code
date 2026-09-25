# Runtime separation plan

Status: revised after three reviews (two focused, one adversarial). Steps 0 and 1 are done. Everything else is a proposal.

## Why

The desktop renderer is the source of truth for tasks, and the main process co-owns some of their state:

- Agent processes are spawned when `TerminalView` mounts (`src/components/TerminalView.tsx:1137`). Agent terminals pass `preserveSessionOnCleanup` (`src/components/TaskAITerminal.tsx:916`), so unmounting a view does not kill its agent. After a renderer reload, main reattaches the running PTY and replays its scrollback (`electron/ipc/pty.ts:726`). Agents are killed on purpose when a task is collapsed or closed (`src/store/tasks.ts:986`).
- The renderer persists task state as one JSON blob (`src/store/persistence.ts:429`). Main also writes that file: it normalizes every renderer save and does its own read-modify-write for delegation state (`electron/ipc/register.ts:642`, `:1220`; `electron/mcp/delegation.ts:912`).
- The phone and MCP agents reach task, reasoning, mind-map and notes state through the renderer (`callRenderer`, `electron/ipc/register.ts:1739`), with a 120-second timeout.
- Tasks are created three ways. Desktop and phone tasks go through the renderer store (`src/store/tasks.ts:257`). Coordinator tasks are created in main (`electron/mcp/coordinator.ts:1183`). Every path provisions the worktree before the task is durably saved: autosave is debounced by 1–5 s (`src/store/autosave.ts:134`), and coordinator children are saved only after the renderer adopts them. Nothing reconciles worktrees at startup, so a crash in that window leaves an orphaned worktree.
- Question detection and trust-dialog acceptance run in the renderer (`src/store/taskStatus.ts:705`). The coordinator has a separate readiness monitor (`electron/mcp/coordinator.ts:597`).
- Only xterm in the renderer answers terminal queries (`TerminalView.tsx:955`). Codex exits if its cursor-position query goes unanswered for about 2 s (commit `1204de82`, patched by disabling background throttling in `electron/main.ts:196`). Coordinator sub-tasks are spawned in main before any view exists (`coordinator.ts:1356`), so they rely on a view mounting in time. **This is the only user-facing bug in the history that this ownership split has caused.**
- `registerAllHandlers` is a single closure of about 2,100 lines that also runs the remote-server, coordinator and delegation lifecycles.
- Precedent: document workspaces already run headless agents in worktrees from main, with their own records and `reconcileInterrupted` (`electron/documents/runs.ts:513`). Use them as the template for runtime-owned tasks.

## Target

| Area               | Owns                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Runtime            | Projects, tasks, agent sessions, worktrees, coordination, operational status, durable task state. No Electron, no Solid. |
| Desktop shell      | Windows, menus, dialogs, notifications, updates, native browser views.                                                   |
| UI                 | Rendering, navigation, selection, layout, local drafts.                                                                  |
| Transport adapters | IPC and HTTP/WebSocket validation, commands, subscriptions.                                                              |

Invariant: a task can be created, run, inspected and stopped without a mounted desktop UI. Desktop and phone observe the same runtime-owned state.

Separate ownership first. Add a process boundary only when a goal requires it (step 8).

## Step 0 — Enforce the renderer boundary for type imports (this pass)

dependency-cruiser ignores `import type` today, so `no-renderer-importing-main` does not see type-only imports from `src/` into `electron/`. Enabling `tsPreCompilationDeps` exposes 13 existing violations.

1. Allowlist the three pure type modules the renderer already relies on: `electron/remote/protocol.ts`, `electron/ipc/shared-types.ts` and `electron/documents/types.ts`. None imports Node or Electron. → verify: `npm run lint:arch`.
2. Move `UpdateStatus` out of `electron/ipc/updater.ts`, which imports Electron, into `electron/ipc/shared-types.ts`. → verify: `npm run typecheck` and `npm run compile`.
3. Break the type-only cycle between `DocumentViewer.tsx` and `PageBlocks.tsx` (`BlockRange`). → verify: `npm run lint:arch`.
4. → verify: `npm run check`, `npm run check:static`, `npm test`.

This is static only and makes the existing renderer/main rule mean what it says. It is also a prerequisite for the runtime rule in step 3.

## Later steps, in dependency order

Each of these changes runtime behavior and needs a smoke test in the real app.

1. **Terminal-query responder (done).** Every PTY session keeps a headless xterm mirror in main (`electron/ipc/terminal-query-responder.ts`), fed the process output and resized with the PTY. It answers cursor-position queries (`CSI 6 n`, `CSI ? 6 n`) itself. The renderer's xterm no longer answers them (`src/lib/terminalQueries.ts`), so there is exactly one answer, whether a view is mounted, hidden, reloading or blocked by an automation write. This design was chosen over attach/detach tracking because it also covers hidden, throttled views and stale replies to replayed scrollback. Banners and replayed scrollback are parsed without answering, so the mirror's cursor matches the pane. Device-attribute, color and keyboard queries still come from the renderer, because the answers depend on its theme and settings and their order matters. Verified: a real-PTY program that exits when its cursor query goes unanswered for 2 s runs with no renderer; with the reply disabled, it fails.
2. **Startup worktree reconciliation.** Compare the managed worktrees from `git worktree list` with the tasks in `state.json`, and write an intent record before provisioning. Report orphans rather than deleting them, because they may hold user work. This covers all three creation paths. → verify: a unit test kills the process between provisioning and save, and the orphan is reported on the next start.
3. **Split `registerAllHandlers` and add the runtime boundary.** Wait for #279 (pooled workspaces, which changes task creation) to be decided, and announce a freeze window: 7 open PRs touch `register.ts`, with hunks across the whole file. Before the split:
   - Commit a wiring test against the old code. It records every `ipcMain.handle` channel, throws on duplicates, asserts the `win.on` events and exactly one registration-time `onPtyEvent('exit')`, and triggers `ensureCoordinator` twice so the lazily registered `MCP_*` handlers are seen exactly once.

   Design rules from review:
   - Mutations of remote-server and coordinator state stay inside `mcp-runtime` methods (`startRemoteAccess`, `stopRemoteAccess`). `remoteServer()` and `coordinator()` are methods, never destructurable fields, so callers cannot capture a stale `null`.
   - MCP path helpers move into `mcp-runtime.ts` or `mcp-paths.ts`, including one `hostMcpServerPath()` in place of five copies, so no `register-*` module is imported by the runtime.
   - Late-bound callbacks are created per `registerAllHandlers` call, and `coordinatorHandlersRegistered` lives in that closure.
   - Hoisted `function` declarations stay hoisted.
   - No Electron API access at module scope.
   - The coordinator import stays lazy.
   - `DelegationRequest` and `CheckPathExists` need an explicit home.
   - Add the new files to the Semgrep scopes (Arena `writeFileSync`, the two `copyFileSync` sites; keep `nosemgrep` on the same line), and keep `register.ts` in scope.
   - Update `AGENTS.md:39`, `electron/ipc/git.ts:906`, `docs/design-doc.md:69` and the comments in `src/store/remoteStatusSync.ts`, `src/store/remoteTaskHandler.ts` and `electron/ipc/pr-checks.ts`.
   - Keep new files flat in `electron/ipc/` because of the `import.meta.url` path depth.
   - Review the diff with `git diff --color-moved`.

   Runtime boundary: replace `BrowserWindow` in `pty.ts`, `git.ts`, `plans.ts`, `steps.ts` and the coordinator with a notify port first. Then add `electron/runtime/` with a dependency-cruiser rule that uses `reachable: true`, because a direct-import rule misses transitive Electron imports.

4. **Main-side agent launch.** Extract the `SpawnAgent` handler body into `launchAgent()`, used by both IPC and the coordinator. Today the coordinator bypasses canvas MCP, the watchers and admission. Move `buildTaskAgentArgs` into shared code. Merge the renderer's question and trust detection with the coordinator's output monitor into one main-side `PromptDeliverer` instead of adding a third. Trust acceptance depends on the `autoTrustFolders` setting, which main must be able to read.
5. **Runtime task registry.** Main writes task records it creates and reconciles them at startup. It extends the existing `normalizeState` overlay rather than adding a second writer with no ordering.
6. **One task-creation path.** `TaskRuntime.createTask(spec)` provisions, registers authority, launches, delivers the prompt, records the task and emits `TaskCreated`. The renderer adopts the task with `attachExisting`, generalizing `MCP_TaskCreated`. The phone stops using `callRenderer` for creation.
7. **Runtime-owned task state.** Split `state.json` into runtime task state and UI layout, with versioning and a downgrade path. Remove the remaining `callRenderer` uses. Define what collapsing a task means once the runtime owns agent lifetime.
8. **Separate runtime process.** Only needed if agents must survive app exit or update, the phone must work without Electron, or execution moves to another machine.

## Deferred: typed IPC contracts

`invoke<T>` lets every caller choose its result type, but the history shows no bugs from mismatched types. The task store has about 7 explicit `invoke<T>` calls and already uses the shared result types. A contract on the renderer side only moves the casts into one file.

Do this only together with a compile-only `handleContract` on the main side (after step 3), so that both ends are checked. Design notes from review:

- Mocked `invoke` takes the last overload's types, so client tests need a `LooseInvoke` type.
- `fireAndForget` and `CHANNELS` in `src/store/usage.ts` pass variables of type `IPC`, so a private `invokeUnchecked` is needed.
- Channels without arguments use `[args?: undefined]`.
- Key the contract by manifest name and remap it to channel values, so a mistyped key fails to compile.
- Arguments must be JSON-safe; exclude channels that take a `Channel<T>`.
- Put the type test in `src/lib/ipc-contract.test.ts` with described `@ts-expect-error` directives.

## Alternatives considered

- **Split only `register.ts`.** Cheap, but it leaves every ownership problem in place and conflicts with 7 open PRs. It is kept as step 3.
- **Move straight to a separate runtime process.** That adds reconnect, shutdown and protocol work before ownership is untangled. It is deferred to step 8.
- **Move shared contracts out of `electron/`.** `electron/shared/` already acts as the shared package (21 of the 31 `electron/` modules imported by `src/` live there). Moving everything would touch about 180 files for little gain.
