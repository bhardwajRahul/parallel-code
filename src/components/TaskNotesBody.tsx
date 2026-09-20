import { Show, createSignal, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import {
  store,
  updateTaskNotes,
  setTaskFocusedPanel,
  sendPrompt,
  isAgentAskingQuestion,
  isPanelFocused,
} from '../store/store';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { useFocusRegistration } from '../lib/focus-registration';
import { UnderstandButton, tourButtonStyle } from './understanding/UnderstandButton';
import {
  planTourSubject,
  type UnderstandingTourController,
} from '../lib/create-understanding-tour';
import type { Task } from '../store/types';

interface TaskNotesBodyProps {
  task: Task;
  agentId: string;
  onPlanFullscreen: () => void;
  understanding: UnderstandingTourController;
  onPlanTour: () => void;
  /** Opens the tour the agent published for this task, if there is one. */
  onAgentTour?: () => void;
}

/** Inset of the floating controls from the notes panel's bottom-right corner. */
const OVERLAY_INSET = '6px';

const overlayRowStyle: JSX.CSSProperties = {
  position: 'absolute',
  bottom: OVERLAY_INSET,
  right: OVERLAY_INSET,
  display: 'flex',
  'align-items': 'center',
  gap: '6px',
  'z-index': '1',
};

export function TaskNotesBody(props: TaskNotesBodyProps) {
  const [sendingNotes, setSendingNotes] = createSignal(false);

  async function handleSendNotes() {
    if (sendingNotes()) return;
    const val = props.task.notes?.trim();
    if (!val) return;
    if (!props.agentId) return;
    if (isAgentAskingQuestion(props.agentId)) return;
    setSendingNotes(true);
    try {
      await sendPrompt(props.task.id, props.agentId, val);
    } catch (e) {
      console.error('Failed to send notes to prompt:', e);
    } finally {
      setSendingNotes(false);
    }
  }

  const canSendNotes = () =>
    !sendingNotes() &&
    !!props.task.notes?.trim() &&
    !!props.agentId &&
    !isAgentAskingQuestion(props.agentId);
  let notesRef: HTMLTextAreaElement | undefined;
  onMount(() => {
    useFocusRegistration(`${props.task.id}:notes`, () => notesRef?.focus());
  });

  // Keep empty notes compact; plans open in the viewer from the button.
  const isEmpty = () => !props.task.notes?.trim();
  const intrinsicHeight = () => (isEmpty() ? '56px' : store.focusMode ? '240px' : '140px');

  return (
    <div
      class="task-notes-body focusable-panel"
      data-empty={isEmpty()}
      data-panel-focused={isPanelFocused(props.task.id, 'notes') ? 'true' : 'false'}
      style={{
        width: '100%',
        height: '100%',
        'min-height': intrinsicHeight(),
        display: 'flex',
        'flex-direction': 'column',
      }}
      onClick={() => setTaskFocusedPanel(props.task.id, 'notes')}
    >
      <div
        style={{
          flex: '1',
          display: 'flex',
          'flex-direction': 'column',
          position: 'relative',
          'min-height': '0',
        }}
      >
        <textarea
          ref={(el) => (notesRef = el)}
          value={props.task.notes}
          onInput={(e) => updateTaskNotes(props.task.id, e.currentTarget.value)}
          aria-label="Task notes"
          placeholder="Add a note…"
          style={{
            width: '100%',
            flex: '1',
            background: theme.taskPanelBg,
            border: 'none',
            padding: '6px 8px',
            color: theme.fg,
            'font-size': sf(12),
            'font-family': "'JetBrains Mono', monospace",
            resize: 'none',
            outline: 'none',
          }}
        />
        <div style={overlayRowStyle}>
          <button
            class="send-notes-btn"
            type="button"
            disabled={!canSendNotes()}
            onClick={() => void handleSendNotes()}
            title="Send notes as a prompt to the agent"
            aria-label="Send notes as a prompt to the agent"
            style={{
              width: '22px',
              height: '22px',
              padding: '0',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              background: `color-mix(in srgb, ${theme.accent} 12%, ${theme.bgInput})`,
              color: theme.fg,
              border: `1px solid color-mix(in srgb, ${theme.accent} 25%, ${theme.border})`,
              'border-radius': '50%',
              cursor: canSendNotes() ? 'pointer' : 'default',
              opacity: canSendNotes() ? '1' : '0.4',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path
                d="M7 2V12M7 12L3 8M7 12l4 -4"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <Show when={store.showPlans && props.task.planContent}>
            <button
              type="button"
              class="btn-secondary review-plan-btn"
              style={tourButtonStyle}
              title={props.task.planFileName ? `Review ${props.task.planFileName}` : 'Review plan'}
              aria-haspopup="dialog"
              onClick={() => props.onPlanFullscreen()}
            >
              Review Plan
            </button>
            {/* Same class and style as Review Plan so the pair matches exactly. */}
            <UnderstandButton
              label="Take Tour"
              tour={props.understanding}
              kind="plan"
              subject={planTourSubject(props.task)}
              onClick={() => props.onPlanTour()}
              class="btn-secondary review-plan-btn"
              style={tourButtonStyle}
              modelMenu
            />
          </Show>
          {/* The agent publishes a tour on request; the button keeps it reachable
              after the viewer is closed. */}
          <Show when={props.task.agentTour}>
            {(agentTour) => (
              <UnderstandButton
                label="Agent Tour"
                tour={props.understanding}
                kind="agent"
                subject={agentTour().payload.subject}
                onClick={() => props.onAgentTour?.()}
                class="btn-secondary review-plan-btn"
                style={tourButtonStyle}
              />
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
