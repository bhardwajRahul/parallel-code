import { Show } from 'solid-js';
import { agentStatusDisplay } from './attention';
import { ConnectionBanner } from './ConnectionBanner';
import { agents, canControl, status } from './ws';

/** Title, status and connection banners shared by a task's terminal and chat screens. */
export function TaskHeader(props: {
  agentId: string;
  taskName: string;
  onBack: () => void;
  onNeedsPairing: () => void;
}) {
  const agent = () => agents().find((a) => a.agentId === props.agentId);
  const display = () => agentStatusDisplay(agent() ?? { status: 'exited', attention: 'idle' });
  return (
    <>
      <header class="mobile-header mobile-task-header">
        <button
          class="mobile-button quiet"
          onClick={() => props.onBack()}
          aria-label="Back to tasks"
        >
          ←
        </button>
        <div class="heading">
          <h1 title={props.taskName}>{props.taskName}</h1>
          <div class="mobile-task-meta">
            <p class="mobile-task-context">
              {[agent()?.projectName, agent()?.agentName].filter(Boolean).join(' · ')}
            </p>
            <span class="agent-status" style={{ color: display().color }}>
              <span class="status-dot" aria-hidden="true" />
              {display().label}
            </span>
          </div>
        </div>
      </header>
      <ConnectionBanner />
      <Show when={status() === 'connected' && !canControl()}>
        <div class="mobile-banner info">
          <span>View only</span>
          <button class="mobile-button quiet" onClick={() => props.onNeedsPairing()}>
            Enable replies
          </button>
        </div>
      </Show>
    </>
  );
}
