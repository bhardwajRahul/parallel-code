# Cross-agent coordination

Status: V1 delegation and V2 held peer messaging implemented in this working tree. Existing sessions keep their launch-time tools; enabling new tools requires a conversation-preserving restart where supported. Native Electron smoke tests use isolated worktrees and local fake agents. Docker and real-provider compatibility require separate validation.

## Product direction and release boundaries

Let ordinary Parallel Code tasks delegate work without a dedicated coordinator task or a user-supplied `--coordinator-id`. Later, let agents discover eligible sessions and exchange prompts. There is no universal default coordinator: merely starting a session does not register a parent, inject backlog-processing instructions, or start children.

**V1 ships delegation:** explicit UI action, agent-initiated delegation for supported fresh sessions, review-required results, existing child supervision, and complete parent lifecycle. Peer discovery and messaging do not block this release.

**V2 adds peer discovery and held messages:** exact recipients, a recipient inbox, restricted access, and delivery receipts. Automatic peer delivery, recursive delegation, cross-project access, and durable messaging are separate follow-ups.

V1 supports top-level Git worktree tasks. Shell panes cannot initiate agent operations. Coordinated children retain completion tools but cannot create grandchildren; hide the delegation action on children and explain the limitation where capabilities are shown. Direct-checkout and non-Git delegation are deferred. UI delegation is available even when the parent's agent lacks MCP integration, provided a supported child agent can be selected. Agent-initiated delegation requires app-provisioned tools and credentials; chat-backed and unsupported custom-agent tool integration is deferred.

**Delegate task…** is available to all eligible tasks, independent of `store.coordinatorModeEnabled`. Existing coordinator mode becomes the advanced automation preset over the same task/child infrastructure: backlog guidance, configured concurrency, and existing automatic-integration defaults. Keep its existing setting and saved-task compatibility during migration. The product direction is one delegation model with an advanced preset, not permanently separate coordinator and ordinary-task implementations. Renaming/removing the old checkbox is a later migration, not a V1 prerequisite.

Agent-initiated creation by ordinary tasks requires the user to enable **Allow agents to create child tasks** once per project; it defaults off. Explain that children launch additional agent sessions that may incur provider charges, and show the configured concurrency limit (shared default: three). This is permission to launch within that limit, not a spending cap. A user's explicit **Delegate task…** submission authorizes that one child without enabling project-wide agent creation. Selecting the existing coordinator preset remains explicit authorization for that task's automation; do not implicitly enable the project setting. The two project settings for child creation and V2 peer access are separate and clearly labeled.

Check creation consent in the backend on every request and again before starting a reserved launch. Disabling it blocks new ordinary-agent creations without abandoning existing children. Show child counts and **Stop all children** on each parent. Stop first pauses that parent's automated creation/restart and cancels pending launches, then stops its children while preserving worktrees; only an explicit user resume re-enables launches. Do not introduce per-tool-call consent dialogs after the project gate is enabled.

Replace terminal-regex spawning with explicit MCP calls and **Delegate task…**. Do not interpret arbitrary output as an instruction, suppress terminal input, or launch agents because prose matches a pattern.

## V1 user experience

### Delegate from the current task

Open an editable name and assignment using existing task-form and agent-selection patterns. Default to the current project, current parent branch, and a supported child launch configuration. Show the selected agent and branch. If the parent agent is unsupported, require selecting a supported child; do not silently substitute one. Keep focus on the parent after submission.

Children receive a committed snapshot, not the parent's conversation or uncommitted edits. Include a prompt describing the concrete assignment and required context. Do not copy the whole transcript or silently commit/stage files.

When the parent is dirty, show the changed-file count and three explicit choices:

- **Review and commit first:** preserve the assignment draft and open the parent's changes/terminal so the user can review and commit through their existing workflow. Refresh status and the proposed base commit when they return. V1 does not add a one-click commit/staging subsystem or commit files while an agent is modifying them.
- **Use the last commit:** show its short SHA and require this explicit choice before submission. Explain that dirty changes will be absent from the child.
- **Cancel:** create nothing and preserve the assignment draft.

Capture the selected base commit and parent branch at submission. The backend validates both and branches from that commit; if branch/HEAD changed before creation, refresh the choice instead of silently using a different snapshot. Add a separate snapshot-commit field for worktree creation; keep `task.baseBranch` as the integration branch and preserve the existing merge-base-based diff calculation. Do not replace the branch field with a SHA and thereby change what the merge path reads. Agent-initiated requests receive a clear dirty-parent result and may explicitly choose the current committed state; an MCP call never implicitly authorizes a commit.

Use one submission, without an additional confirmation for each agent tool call. Preserve explicit permission-bypass propagation settings, defaulting off for ordinary parents. Do not derive permission bypass from inherited CLI arguments.

### Progress, review, and results

Children of ordinary tasks use **Review before merging** in V1. Existing explicit coordinators keep their existing integration default. Store a per-child integration policy and show it in the assignment form and child status. New automatic-integration options for ordinary tasks are deferred.

Generate matching child guidance: review-required children commit and verify their work, then call `signal_done`; they are not instructed to call `land_self`. Enforce the policy in backend landing/merge handlers too. Approval is a user action on the particular child result and target, not an agent-supplied boolean. Changed child commits or a changed integration target invalidate approval.

Reuse the child strip and sidebar grouping for any parent with children. Show starting, working, needs input, awaiting review, completed/integrated, and failed states from actual backend state. An idle agent is not proof of completion, and completion is not proof of integration. Provide **Open**, **Stop**, review/merge, and applicable recovery actions.

Show a transient assignment-attempt row before a live task exists. The existing child-created event is emitted after spawn; retain a failed attempt with the error and cleanup status for the current app run rather than making it disappear. Never label an absent PTY as running.

For ordinary parents, completion/blocker summaries appear in the task UI and through existing list/status/wait tools. They do not automatically type into the parent terminal. Reuse the staged-notification presentation with explicit review/acknowledgment, preserving the user's draft and focus. The explicit coordinator preset retains its existing notification policy. Preserve outcomes after self-landed children leave the active list.

## Architecture: build on existing ownership

### Credentials and launch identity

Extend `canvasAgents` in `electron/remote/server.ts`; do not create a parallel credential registry. Its existing main-process record already binds a token to a task, agent, and liveness check. Add the session's project membership, launch-instance identity, and a capability set decided at mint time. Legacy canvas registrations default to canvas-only rights. Update the existing token classification/route checks to consult those capabilities, retaining one registry and one revocation path.

Use the existing `pendingSpawns` / `canvasOwners` ownership object in `electron/ipc/register.ts` as the launch identity source. Add an opaque `sessionInstanceId` to that object and carry it through registration and active-session metadata. Do not invent a separate generation registry. The pane's `agentId` and the CLI conversation ID may survive a restart; neither identifies this particular PTY launch.

`registerCanvasAgent()` currently returns the existing token when task and agent IDs match. Change that behavior: reattachment to the same live instance may reuse its token; a replacement launch must mint a new token and invalidate the old one. Instance guards already exist in spawn-failure cleanup and PTY exit handling; preserve and regression-test them rather than building a new revocation mechanism. The credential change is rotation on replacement and carrying the existing ownership identity through registration. Preserve existing `isActive` users and canvas-only sessions outside this feature.

Ordinary sessions launch without `--coordinator-id`. For capability-bound session credentials, ignore `X-Coordinator-Id` as an authority source and resolve ownership from the record. Keep existing coordinator-token/header validation and phone/REST routing intact. In particular, `REST_COORDINATOR_SENTINEL` and `defaultCoordinatorTaskId` remain for existing authorized legacy routes; new session operations must not fall back to them.

New child sessions need their existing completion scope and the appropriate session capabilities. Compose those tools without giving children the full coordinator set. Preserve legacy subtask, coordinator, mobile, and paired-device credentials under their existing rules. Do not put bearer credentials in renderer task state, logs, shared URLs, or persisted parent records.

### Authoritative project and task membership

Neither `getAgentMeta()` nor the renderer-pushed display `projectName` currently establishes project membership. Add a separate main-process `taskAuthority` map, owned by IPC registration/lifecycle code, for `(taskId, projectId, projectRoot, worktreePath, parentTaskId)` and lifecycle state. Do not extend `taskContext`: that display map is cleared and rebuilt by each `Remote_UpdateTaskStatus` broadcast. Partial, missing, or reordered display broadcasts must never grant or revoke authority.

The trust boundary is explicit: the desktop renderer and validated Electron IPC are trusted to supply the app's project/task identities; agent-facing HTTP callers are not. Project records currently live in renderer state; asking the renderer for them again is not an independent security check. Do not claim an independently loaded main-process project catalog. Register/update authority only on acknowledged create, import, restore, detach, and close lifecycle operations; backend-created children register directly. Complete registration before minting delegation capabilities, and reject conflicting updates rather than replacing the whole map.

Independently validate paths and Git ownership in the main process: resolve canonical paths, confirm the directory is a registered worktree of the supplied project repository using Git's worktree/common-directory metadata, and validate the branch/snapshot. Newly created worktrees must also satisfy the existing managed-path rules. Do not require every imported worktree to be beneath `projectRoot`; legitimate external worktrees are supported. HTTP request bodies and display-name broadcasts cannot supply or alter authority records.

If context is missing, conflicting, closing, or not restored yet, fail closed for delegation/peer operations; canvas-only access may continue under its existing rules. Removal and detach update this registry before new requests can observe the old relationship. Do not infer membership from an agent's current working directory or a display name.

### Access rules

| Operation                        | Required authority                                                                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas tools                     | Own task, preserving current behavior.                                                                                                                                                                   |
| Create child                     | Eligible top-level owning task; validated project, snapshot, and branch. No nested creation.                                                                                                             |
| List/status/wait/manage children | Own direct children, with existing ownership checks and the integration policy. Empty child lists are valid.                                                                                             |
| Merge/close/land                 | Operation-specific ownership and verification. Ordinary-child integration additionally requires user approval. Peer rights confer none of these.                                                         |
| V2 discovery/output              | Only recipients in the caller's allowed relationship/scope; permission checks apply to discovery as well as reads.                                                                                       |
| V2 prompts                       | Children may contact only their own parent. Top-level tasks may contact their own children. Unrelated top-level peers require a project-level opt-in. All new peer prompts are held for user acceptance. |

In V2, **Allow peer access between tasks** defaults off and explicitly enables discovery, output access, and held messages between eligible top-level sessions in that project. It does not expand a child's scope beyond its parent. No cross-project grants in this design. Treat output and prompts as untrusted peer content, not system instructions.

### Exact V1 tool exposure and completion loop

Use these named sets in `selectTools()` and capability-based dispatch. Tool discovery is not the security boundary: HTTP handlers enforce the same scope and current consent/policy, including calls to hidden or legacy handler names.

| Capability/profile                                    | Advertised tools                                                                                                                                                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Own-task canvas                                       | `mindmap_read`, `mindmap_update`, `reasoning_read`, `reasoning_update`, `canvas_open`.                                                                                                                                                        |
| Ordinary top-level child supervision                  | Canvas tools plus `list_tasks`, `get_task_status`, `get_task_output`, `get_task_diff`, `send_prompt`, `wait_for_idle`, `wait_for_signal_done`, scoped to own direct children. No parent registration is needed for an empty list/wait result. |
| Ordinary agent creation enabled at launch             | Supervision tools plus `create_task`, subject to the current project consent and parent pause gates on every call.                                                                                                                            |
| Review-required child                                 | Canvas tools plus `signal_done`. Do not advertise `land_self` or any create/manage-child tools; reject those calls server-side as well.                                                                                                       |
| Child under the existing automatic-integration policy | Canvas tools plus `signal_done` and `land_self`, with current ownership/verification rules.                                                                                                                                                   |
| Explicit coordinator preset                           | Canvas tools plus the current coordinator set: `create_task`, `list_tasks`, `get_task_status`, `get_task_output`, `get_task_diff`, `send_prompt`, `wait_for_idle`, `wait_for_signal_done`, `merge_task`, `close_task`.                        |

Ordinary parents do not receive `merge_task`, `close_task`, or the unadvertised `review_and_merge_task` handler. Review, integration, and cleanup use explicit desktop actions in V1. Disabling agent creation does not remove supervision of children already authorized by the user. Newly enabled creation tools follow the restart rollout below; a still-running session never acquires authority merely by inventing a tool name or header.

Ordinary agents use `wait_for_signal_done` as their primary completion loop: inspect `list_tasks`, wait for an unconsumed child completion, then inspect that child's status/diff and report the review-ready outcome. For this profile, use a 30-second default and 60-second maximum timeout. On timeout, inspect status once for failure/blocker changes, then wait again if work remains. Do not repeatedly poll status or resend assignments. `wait_for_idle` is only for readiness after a follow-up that was actually sent, not task completion. Its ordinary-session timeout uses the same bounds; guidance requires at least 10 seconds between unchanged status checks when no blocking wait is available.

Expose the wait tool without requiring `--coordinator-id`; bind it to the caller's owning task and lazy parent record. With no children, return an empty result immediately and instruct the agent to stop waiting. Receipt/consumption of a completion is not merge approval: `remaining === 0` does not mean all results are integrated, and multiple panes must reconcile against `list_tasks` rather than assume every pane receives every completion event.

Preserve the existing wait suppression behavior for the explicit coordinator preset. For ordinary parents, active waiters and consumption must not clear or suppress the visible review queue: gate the suppression in `stageBatch`, `beginSignalWait`, and completion-consumption helpers on automatic-terminal-delivery policy. Waiting agents can consume completion events while the user still sees the result until explicit UI acknowledgment/review. Update ordinary tool descriptions and launch guidance to teach this loop without importing the backlog preamble.

## V1 backend workflow and lifecycle

### Shared creation and admission

Expose one main-process delegation operation to the desktop IPC action and MCP-backed HTTP request. The UI does not require the parent's MCP token or call `store/tasks.createTask()` to create a top-level substitute.

1. Validate task/project membership, eligibility, creation consent or explicit UI authorization, parent pause state, assignment, child agent, permission settings, and the chosen base snapshot.
2. Lazily register the parent using explicit project/root, branch/worktree, launch defaults, environment-file reference, verification command, and integration settings. Today's `registerCoordinator()` snapshots mutable global defaults; extend its API instead of racing `setDefaultProject()` calls. Repeated registration must not reset existing state.
3. Reserve concurrency, publish the in-memory starting attempt, and call the shared coordinator creation path. Retain existing worktree validation, prompt delivery, and best-effort cleanup.
4. Publish the child-created event with its explicit parent relationship and link the attempt to the task. Return the child task/agent IDs.

Use the current concurrency setting or the shared default. Apply admission to creation, restart, restore, and recovery: restarting an exited child cannot reclaim a slot already used by another child. Do not release a failed child's capacity while its PTY remains alive. Surface capacity errors; do not add a hidden creation queue or descendant-budget system.

For duplicate tool calls and lost HTTP responses, use parent-task-scoped request IDs with an in-memory map of pending operations/results. Repeated IDs join/return the same operation; differing payloads fail. Disable repeat submission in the UI. Retain compact results for the current app run until that parent closes; requests against a closed parent fail rather than replaying an old operation.

Do not build a persistent creation-attempt journal in V1. After an app crash, never replay an unacknowledged creation automatically. Explain that an untracked worktree may remain and direct the user to the existing worktree import/inspection workflow (`ImportWorktreesDialog`). Reuse normal deletion/cleanup only after the user chooses to remove a verified candidate, preserving symlink handling in `worktree-cleanup.ts`. Import recovers work; it does not guess the old parent or automatically rerun the assignment. This explicitly trades automatic crash recovery for a smaller implementation.

### Restore and close belong to the backend

Extend app-task persistence for ordinary-parent metadata, child relationships, and integration policy, using existing atomic-write helpers. Restore and validate those relationships before admitting delegation or recovery launches. Credentials and launch handles stay runtime state.

Closing a parent with children keeps the existing explicit warning that children become independent tasks. Move detach-and-close orchestration into the main process: the renderer requests one operation and renders progress. The backend marks the parent closing, blocks creation/restart, waits for or safely blocks in-flight landing, disables old parent-targeted integration/notifications, persists child detachments, and only then removes the parent worktree.

Serialize these relationship changes with app-state saves so a stale renderer snapshot cannot restore the old parent link. Git deletion is not atomic with persistence: if deletion fails after detach, retain the parent with a visible cleanup error and children safely independent; retry is idempotent. A renderer crash must not be able to leave children targeting a deleted parent. Do not retarget merges to main or delete child worktrees as an implicit consequence of closing the parent.

If the parent agent exits, keep the task and child results available. Multiple panes share task ownership, but unsolicited notifications must not jump to an arbitrary replacement pane. V1 summaries are task UI state; sessions can explicitly inspect their task's results. When the parent branch changes, pause integration for user review rather than retargeting it silently. Detached children keep their work and finish independently; enabling them as new parents requires a user action.

## V2: exact-session discovery and held prompts

### Tools and addressing

Discover live sessions from the PTY registry joined with validated task context. Exclude shells, unsupported targets, and sessions outside the caller's allowed scope. Do not reuse the coordinator child map or an agent-list endpoint that deduplicates by task. Return labels, branch, state, capabilities, `agentId`, and `sessionInstanceId`; unknown readiness is reported as unknown.

| Tool                    | Input                                                                        | Result                                                                 |
| ----------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `list_agent_sessions`   | Caller-scoped; no project override.                                          | Eligible sessions and their supported actions.                         |
| `get_agent_output`      | Exact agent and instance IDs; bounded size.                                  | Decoded plain-text output, observation time, and truncation indicator. |
| `send_agent_prompt`     | Exact target IDs, prompt, sender-scoped request ID.                          | Held delivery ID and recipient-review status; no PTY write.            |
| `wait_for_agent_prompt` | Delivery ID, optional last observed state, and bounded timeout; sender only. | Current/changed receipt state, timeout, or expired/unavailable.        |

Require both recipient IDs and revalidate them at acceptance and delivery. A restarted pane is a different recipient even when `agentId` stays the same. Never redirect automatically. Decode scrollback, strip terminal control sequences, and enforce size limits. Validate membership, IDs, and payloads at the HTTP boundary; URL encoding is not authorization.

### Inbox and acceptance

Use the staged-notification UI pattern with acknowledgment, extended to a list of held incoming prompts per recipient instance. Store bounded held entries in main-process runtime state so panel unmount/remount does not lose them; the renderer subscribes to snapshots/updates. Show sender/task attribution, preview, arrival time, and **Review** / **Dismiss**. Keep pending counts visible without stealing focus. Child summaries and the inbox start collapsed; expanded content scrolls within a bounded area so the task terminal remains usable. App restart may expire these entries; V2 does not promise a durable inbox.

**Review** opens a preview and leaves the entry waiting. After preview, an explicit **Use in composer** action claims the entry for manual handling and places it only in an empty app `PromptInput` belonging to the exact recipient session. If that field already has a draft, keep the incoming prompt in the inbox and offer preview/copy; never replace or concatenate the draft. Neither action sends Enter. For direct xterm input, terminal-composer contents are unknowable: always use manual copy, with no terminal-clearance detection or automatic PTY submission. The user chooses when to paste and submit.

Keep sender receipts to three states: `waiting` (still in the inbox), `handled` (the user took it into `PromptInput` or copied it), and `closed` (dismissed, failed, or expired, with a reason). Preview alone leaves it waiting. Handled means a human took responsibility; it never claims submission, agent acceptance, or task completion. Both handled and closed end the receipt wait loop. No per-keystroke submission tracking is required.

Use sender-scoped in-memory request deduplication and existing prompt-byte/queue limits. Reject reuse with different target/content. A recipient exit expires held entries; do not replay them on restart. Provide long-poll delivery receipts using existing wait conventions: after the initial state, callers supply their last observed state and wait for a change or timeout. Use a 30-second default wait and a 60-second maximum; agent-facing descriptions prohibit immediate polling/resending after a timeout and require another bounded wait. Receipt state describes transport only, not task completion.

### Automatic delivery is a separate follow-up

The current delivery implementation is largely task-keyed: `controlMap`, `writingPromptTaskIds`, `task.pendingPrompts`, `automationWriteInFlight`, and renderer draft/activity flags. Two panes cannot safely gain independent automatic delivery merely by changing tool parameters.

Before adding an explicit per-task automatic-peer-delivery opt-in, move recipient queues, write locks, readiness, and input/draft holds to `(agentId, sessionInstanceId)`. Task-wide pause remains a gate over all its panes. Task-scoped legacy operations must resolve the intended pane and pass through the same serialization. Preserve legacy coordinator behavior during that migration.

A hold sent after the first keystroke through asynchronous IPC does not eliminate the first-keystroke race. Auto-delivery requires a concrete shared input-arbitration mechanism covering terminal keystrokes, app composer submissions, coordinator writes, and peer writes, plus trustworthy composer/readiness state. Echo verification after writing is insufficient. Integrations lacking that contract remain manual; do not advertise auto-delivery just because they support MCP. This work is not a V1/V2 release gate.

## Rollout and implementation sequence

Existing MCP startup arguments and tool selection describe a launch-time capability set. Do not rely on runtime tool-list refresh for this rollout. After project consent is enabled, show **Restart and resume conversation to enable delegation tools** only when app-managed MCP configuration and the integration's resume path support it. Use the existing `restartAgent(agentId, true)` flow, preserving the pane/conversation while issuing a new launch identity and credential. Do not promise context preservation where resume is unsupported or fails; explain the limitation and keep UI delegation available. Never restart automatically or silently fall back to a new conversation. Using **Delegate task…** through IPC never requires restarting the parent.

Explicit user-owned `--mcp-config` / related configuration currently prevents automatic injection in `canConfigureCanvasMcp()`. Preserve that configuration. A restart alone does not fix it: explain that the Parallel Code integration must be configured separately, and keep UI delegation available. Unsupported integrations show an accurate limitation rather than tools that always fail.

**V1 release:**

1. Extend the existing credential/spawn lifecycle with explicit capabilities and the separate lifecycle-owned authority map. Keep legacy roles and phone routing covered by negative authorization tests.
2. Add lazy parent registration and shared creation/admission with in-memory dedupe, project consent, and parent pause gates. Implement the exact tool sets, bounded completion loop, independent UI review state, and review-required child guidance/policy. Keep starting/failure UI state independent of successful child creation.
3. Move parent detach/close orchestration backend-side and implement restore. Add **Delegate task…**, dirty-worktree choices, child counts/stop-all, review/result handling, and conversation-preserving rollout affordances. Ship only after lifecycle and UX checks pass.

**V2 release:**

4. Add relationship-scoped discovery/output and the optional top-level project peer-access setting. Verify exact panes, stale launch IDs, and permission enforcement.
5. Add the held inbox, explicit user handling, bounded receipts/long polling, and cancellation/expiry. No automatic terminal injection.

No generic coordination service, persistent creation journal, automatic commit UI, nested delegation, or automatic peer-delivery engine is required for these releases.

## Verification and acceptance criteria

- **Identity:** same-instance attachment reuses the live credential; restart rotates it. Old tokens and delayed cleanup cannot affect the replacement. Missing lifecycle authority fails closed; partial/empty display broadcasts leave authority untouched. Validate actual Git membership, including legitimate external worktrees. Agent-supplied headers/body paths cannot choose another owner.
- **Compatibility:** existing canvas-only, coordinator/subtask, mobile/paired-device, Docker, and user-owned MCP configuration paths retain their policy. Legacy REST sentinel routing remains functional.
- **Ordinary delegation:** an app with no prior coordinator creates children from an eligible ordinary task. UI delegation works without parent MCP support. Child/grandchild and unsupported-task limitations are visible and enforced server-side.
- **Consent and stopping:** ordinary agent creation is denied before project consent; explicit UI creation does not enable it. Revocation and stop-all block pending/new launches; worktrees survive stopping and only user resume releases the pause. The explicit coordinator preset remains a separate deliberate opt-in.
- **Tools and feedback:** exact tool names match each profile and hidden handlers cannot bypass permissions. Ordinary completion waits work without a coordinator header, use bounded waits, and never hide the user's review queue. Empty/no-work responses stop the loop; consumed events do not imply integration. Existing coordinator wait suppression is preserved.
- **Ownership and capacity:** concurrent parents in different projects and multiple panes in one task keep correct branches, limits, and child scope. Create/restart/restore cannot exceed capacity or race closing.
- **Snapshots and review:** dirty parents show choices; chosen commits are honored or refreshed on change. Review-required preambles direct completion to `signal_done` and do not instruct `land_self`; tool tests reject unapproved landing. Real-agent smoke checks should confirm normal completion does not waste a turn trying to self-land, without treating model obedience as a security guarantee.
- **Creation recovery:** duplicate requests return one result during the app run. Startup failures stay visible until dismissal/recovery. Simulated crash residue can be inspected/imported without automatic replay or deletion; no cross-crash exactly-once guarantee is claimed.
- **Close/restore:** a renderer crash during parent close cannot restore children targeting a deleted parent. Landing/close races, partial deletion, and retry preserve child work and integration policy.
- **V2 access:** children can contact only their parent, unrelated top-level peers require opt-in, and cross-project requests fail. Test discovery/output as well as sends; disabling opt-in prevents further access and cancels unaccepted unrelated-peer entries.
- **V2 delivery:** distinct panes and restarted instances stay distinct. Held prompts survive panel remount, remain visible beside an existing `PromptInput` draft, and use manual copy for xterm. Three-state receipts never claim delivery/completion; bounded waits report handling or closure with a reason.
- **UX:** keyboard-only delegation, dirty-worktree cancellation, preserved drafts/focus, visible startup/errors, review and integration, resume-preserving restarts with fresh credentials, and parent-close warnings work in Electron.

Run focused unit tests for startup/tool dispatch, HTTP authorization, coordinator lifecycle, and delivery. Pure logic tests use `npm run test:unit`; DOM tests use `*.client.test.tsx` through `npm run test:client`. Extend and run the opt-in PTY suite for changed delivery paths and perform native Electron smoke checks. Report unavailable Docker/native verification and skipped paid real-agent suites.

For implementation handoff, run `npm run check` and relevant tests, `npm run check:static` when exports/dependencies change, and the preload allowlist test when named IPC channels change. Check `docs/design-doc.md` with Prettier when updating this specification.
