import { For, Show, createEffect, createUniqueId, onCleanup } from 'solid-js';
import { Dialog } from './Dialog';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, RedoIcon } from './icons';
import { TourAskBar } from './understanding/TourAskBar';
import { TourCard } from './understanding/TourCard';
import { TourIconButton } from './understanding/TourIconButton';
import { TourProgress } from './understanding/TourProgress';
import type { UnderstandingTourController } from '../lib/create-understanding-tour';
import type { TourRef } from '../lib/understanding-tour';
import { errMessage, warn as logWarn } from '../lib/log';
import { openFileInEditor } from '../lib/shell';

/** The panel is only a layout box here: the card inside it is the one surface. */
const PANEL_STYLE = {
  padding: '0',
  gap: '0',
  background: 'transparent',
  border: 'none',
  'box-shadow': 'none',
  overflow: 'hidden',
} as const;

/** Reading one card is the whole task, so the rest of the app goes dark. */
const OVERLAY_STYLE = {
  background: 'rgba(0,0,0,0.78)',
  'backdrop-filter': 'blur(6px) saturate(1.1)',
} as const;

/** Three lines standing in for the card that is still generating. */
const SKELETON_WIDTHS = ['100%', '92%', '64%'];

/** Viewer for a generated understanding tour: the spine and one branch level. */
export function UnderstandingTourDialog(props: {
  tour: UnderstandingTourController;
  open: boolean;
  onClose: () => void;
  worktreePath: string;
  /** Raised above another open dialog, e.g. when started from the plan viewer. */
  zIndex?: number;
}) {
  const headingId = createUniqueId();
  /** The action the reader is most likely to press next; see the focus effect. */
  let primaryRef: HTMLButtonElement | undefined;
  const controller = () => props.tour;
  /** The scrolling column of the current card and the threads under it. */
  let stageRef: HTMLDivElement | undefined;
  const tour = () => props.tour.tour();
  const cards = () => tour()?.cards ?? [];
  const spineCard = () => cards()[props.tour.step()];
  const onLastCard = () => props.tour.step() >= cards().length - 1;
  /** Answered follow-ups under the card on screen. */
  const threads = () => props.tour.threadsFor(props.tour.step());

  // Give the primary action focus as soon as a tour is on screen, so Enter and
  // the arrow keys move on without reaching for the pointer.
  createEffect(() => {
    if (props.open && tour() && !props.tour.loading()) primaryRef?.focus();
  });

  // A new answer (or the question waiting for one) appears below the card, so
  // bring it into view. Arriving at a card that already has threads must not
  // scroll: the card itself is what the reader came for.
  let seen = { step: -1, count: 0 };
  createEffect(() => {
    const step = props.tour.step();
    const count = threads().length + (props.tour.pendingQuestion() ? 1 : 0);
    const grew = step === seen.step && count > seen.count;
    seen = { step, count };
    if (!grew) return;
    const last = stageRef?.querySelector('.understanding-thread:last-child');
    last?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  function openRef(ref: TourRef): void {
    void openFileInEditor(props.worktreePath, ref.filePath).catch((error) =>
      logWarn('understandingTour', 'Could not open reference', { error: errMessage(error) }),
    );
  }

  /** Arrow keys navigate, except while typing a question. */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    )
      return;
    if (!tour()) return;
    event.preventDefault();
    if (event.key === 'ArrowLeft') props.tour.previous();
    else props.tour.next();
  }

  // Reading means clicking on the card, which hands focus to the dialog panel
  // rather than to a control inside it, so the keys are listened for on the
  // document instead of on this component.
  createEffect(() => {
    if (!props.open) return;
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });

  /**
   * The ask affordance and the follow-up controls shared by spine and branch.
   * Only the card the question came from shows it in flight, so the Cancel next
   * to it always belongs to the request it aborts. Every card's input stays
   * disabled meanwhile: one question is answered at a time.
   */
  function askBar() {
    return (
      <TourAskBar
        disabled={props.tour.asking()}
        asking={props.tour.pendingQuestion() !== ''}
        onAsk={(question) => void controller().ask(question)}
        onGoDeeper={() => controller().goDeeper()}
        onCancel={() => controller().cancel()}
      />
    );
  }

  function closeButton() {
    return (
      <TourIconButton label="Close tour" tooltip="Close" onClick={() => props.onClose()}>
        <CloseIcon size={14} />
      </TourIconButton>
    );
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="620px"
      zIndex={props.zIndex}
      panelStyle={PANEL_STYLE}
      overlayStyle={OVERLAY_STYLE}
      labelledBy={headingId}
    >
      <div class="understanding-dialog">
        {/* No visible header: the card carries every word the reader needs. The
            heading exists so the dialog still has an accessible name. */}
        <h1 id={headingId} class="dialog-sr-only">
          Understanding tour of {props.tour.subject()}
        </h1>

        <div class="understanding-top">
          <Show
            when={!props.tour.loading() && tour()}
            fallback={<span class="understanding-footer-fill" />}
          >
            <TourProgress
              subject={props.tour.subject()}
              total={cards().length}
              current={props.tour.step()}
            />
          </Show>
          {closeButton()}
        </div>

        <Show when={props.tour.loading()}>
          <div class="understanding-stage" aria-busy="true">
            <div class="understanding-card understanding-card--message">
              <p class="understanding-status">
                <span class="inline-spinner" aria-hidden="true" />
                {props.tour.progress()}
              </p>
              <p role="status" class="understanding-substatus">
                {props.tour.receiving() ? 'Receiving response' : 'Waiting for provider'} ·{' '}
                {props.tour.elapsedSeconds()}s
              </p>
              <div class="understanding-skeleton" aria-hidden="true">
                <For each={SKELETON_WIDTHS}>{(width) => <span style={{ width }} />}</For>
              </div>
            </div>
          </div>
          <div class="understanding-footer">
            <span class="understanding-footer-fill" />
            <TourIconButton
              label="Cancel generation"
              tooltip="Cancel generation"
              onClick={() => controller().cancel()}
            >
              <CloseIcon size={14} />
            </TourIconButton>
          </div>
        </Show>

        <Show when={!tour() && !props.tour.loading()}>
          <div class="understanding-stage understanding-stage--message">
            <div class="understanding-card understanding-card--message">
              <Show
                when={props.tour.error()}
                fallback={<p class="understanding-status">Generation cancelled.</p>}
              >
                {(message) => (
                  <p role="alert" class="understanding-alert">
                    {message()}
                  </p>
                )}
              </Show>
            </div>
          </div>
          {/* Cancelling was deliberate, so only a failure offers another attempt. */}
          <Show when={props.tour.error()}>
            <div class="understanding-footer">
              <span class="understanding-footer-fill" />
              <TourIconButton
                primary
                label="Retry"
                tooltip="Retry"
                onClick={() => controller().retry()}
              >
                <RedoIcon />
              </TourIconButton>
            </div>
          </Show>
        </Show>

        {/* A failed follow-up keeps the tour on screen, so its message sits above the card. */}
        <Show when={tour() && !props.tour.loading() ? props.tour.error() : ''}>
          {(message) => (
            <div class="understanding-alert-row">
              <p role="alert" class="understanding-alert">
                {message()}
              </p>
            </div>
          )}
        </Show>

        <Show when={spineCard()}>
          {(card) => (
            <>
              <div class="understanding-stage understanding-stage--thread" ref={stageRef}>
                <TourCard card={card()} onOpenRef={openRef} />
                {/* Every question asked here stays, in the order asked, under the card. */}
                <For each={threads()}>
                  {(thread) => (
                    <section class="understanding-thread" aria-label={thread.question}>
                      <p class="understanding-thread-question" title={thread.question}>
                        ↳ {thread.question}
                      </p>
                      <For each={thread.cards}>
                        {(answer) => <TourCard card={answer} onOpenRef={openRef} />}
                      </For>
                    </section>
                  )}
                </For>
                <Show when={props.tour.pendingQuestion()}>
                  {(question) => (
                    <section class="understanding-thread" aria-label={question()} aria-busy="true">
                      <p class="understanding-thread-question" title={question()}>
                        ↳ {question()}
                      </p>
                      <div class="understanding-card understanding-card--message">
                        <span class="inline-spinner" aria-hidden="true" />
                        <span class="dialog-sr-only">Thinking…</span>
                      </div>
                    </section>
                  )}
                </Show>
              </div>
              <div class="understanding-footer">
                <TourIconButton
                  label="Previous card"
                  tooltip="Previous card"
                  disabled={props.tour.step() === 0}
                  onClick={() => controller().previous()}
                >
                  <ChevronLeftIcon />
                </TourIconButton>
                {askBar()}
                <TourIconButton
                  primary
                  ref={(element) => (primaryRef = element)}
                  label={onLastCard() ? 'Finish tour' : 'Next card'}
                  tooltip={onLastCard() ? 'Finish' : 'Next card · Arrow keys navigate'}
                  onClick={() => (onLastCard() ? props.onClose() : controller().next())}
                >
                  <Show when={onLastCard()} fallback={<ChevronRightIcon />}>
                    <CheckIcon />
                  </Show>
                </TourIconButton>
              </div>
            </>
          )}
        </Show>
      </div>
    </Dialog>
  );
}
