import { createSignal, onCleanup } from 'solid-js';
import { Channel, invoke } from './ipc';
import { IPC } from '../../electron/ipc/channels';
import { askCodeEnvFile } from '../../electron/shared/ask-code-models';
import { CHANGE_TOUR_TIMEOUT_MS } from '../../electron/shared/change-tour-limits';
import { store } from '../store/store';
import { errMessage, info as logInfo, warn as logWarn } from './log';
import { buildChangeTourPrompts, parseChangeTour, type TourStop } from './change-tour';
import { parseUnifiedDiff, type FileDiff } from './unified-diff-parser';
import { loadTaskDiff, type TaskDiffInput } from './load-task-diff';

interface TourMessage {
  type: 'chunk' | 'error' | 'done';
  text?: string;
  exitCode?: number;
}

export function createChangeTour() {
  const [stops, setStops] = createSignal<TourStop[]>([]);
  const [files, setFiles] = createSignal<FileDiff[]>([]);
  const [step, setStep] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [progress, setProgress] = createSignal('');
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);
  const [receiving, setReceiving] = createSignal(false);
  let cancelRequest: (() => void) | undefined;

  const [sourceDiff, setSourceDiff] = createSignal('');
  function cancel() {
    cancelRequest?.();
    setLoading(false);
    setProgress('');
  }
  function reset() {
    cancel();
    setStops([]);
    setFiles([]);
    setStep(0);
    setError('');
    setSourceDiff('');
  }
  function reconcile(rawDiff: string) {
    if (sourceDiff() !== rawDiff) reset();
  }
  onCleanup(cancel);

  function navigate(index: number) {
    setStep(index);
  }

  async function generateForTask(input: TaskDiffInput & { taskName: string }) {
    reset();
    setLoading(true);
    setProgress('Reading changes…');
    setElapsedSeconds(0);
    setReceiving(false);
    let active = true;
    // A cancelled read must not start generation after IPC resolves.
    cancelRequest = () => {
      active = false;
    };
    try {
      const { rawDiff, cwd } = await loadTaskDiff({
        ...input,
      });
      if (!active) return;
      generate({
        rawDiff,
        files: parseUnifiedDiff(rawDiff),
        taskName: input.taskName,
        worktreePath: cwd,
      });
    } catch (error) {
      if (!active) return;
      setLoading(false);
      setProgress('');
      setError(errMessage(error));
    }
  }

  function generate(input: {
    rawDiff: string;
    files: FileDiff[];
    taskName: string;
    worktreePath: string;
  }) {
    setSourceDiff(input.rawDiff);
    cancel();
    setFiles(input.files);
    setError('');
    setStops([]);
    let prompts: string[];
    try {
      prompts = buildChangeTourPrompts(input.taskName, input.rawDiff);
    } catch (error) {
      setError(errMessage(error));
      return;
    }
    const files = input.files;
    const worktreePath = input.worktreePath;
    const provider = store.askCodeProvider;
    const model = store.askCodeModel || undefined;
    const envFile = askCodeEnvFile(provider, store.agentEnvFiles);
    const collected: TourStop[] = [];
    function generatePart(index: number) {
      setProgress(
        prompts.length > 1
          ? `Generating part ${index + 1} of ${prompts.length}…`
          : 'Generating tour…',
      );
      const requestId = crypto.randomUUID();
      const channel = new Channel<TourMessage>();
      let active = true;
      let response = '';
      let providerError = '';
      const startedAt = Date.now();
      let firstOutputMs: number | null = null;
      let outcome = 'cancelled';
      let timingLogged = false;
      setElapsedSeconds(0);
      setReceiving(false);
      const ticker = setInterval(
        () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
        1000,
      );
      // Allow the backend's tour timeout to report first, and cover lost IPC events.
      const deadline = setTimeout(() => {
        if (!active) return;
        outcome = 'timeout';
        cancelRequest?.();
        setLoading(false);
        setError(
          `Tour part ${index + 1} did not finish within five minutes. Check the code Q&A provider in Settings, then try again.`,
        );
      }, CHANGE_TOUR_TIMEOUT_MS + 5000);
      function cleanup() {
        clearInterval(ticker);
        clearTimeout(deadline);
        channel.dispose();
        if (!timingLogged) {
          timingLogged = true;
          logInfo('changeTour', 'Tour request finished', {
            requestId,
            provider,
            part: index + 1,
            parts: prompts.length,
            promptChars: prompts[index].length,
            responseChars: response.length,
            firstOutputMs,
            durationMs: Date.now() - startedAt,
            outcome,
          });
        }
      }
      setLoading(true);
      cancelRequest = () => {
        cleanup();
        if (!active) return;
        active = false;
        void invoke(IPC.CancelAskAboutCode, { requestId }).catch((error) =>
          logWarn('changeTour', 'Could not cancel tour', { error }),
        );
      };
      channel.onmessage = (message) => {
        if (!active) return;
        if (message.type === 'chunk') {
          if (message.text) {
            firstOutputMs ??= Date.now() - startedAt;
            setReceiving(true);
          }
          response += message.text ?? '';
          if (response.length > 40_000) {
            outcome = 'response-too-long';
            cancelRequest?.();
            setLoading(false);
            setError('The tour response was too long. Try again.');
          }
        } else if (message.type === 'error') {
          providerError = (providerError + (message.text ?? '')).slice(0, 4000);
          setError(providerError);
        } else if (message.type === 'done') {
          active = false;
          try {
            if (message.exitCode !== 0)
              throw new Error(providerError || 'The tour provider failed. Try again.');
            collected.push(...parseChangeTour(response, files));
            outcome = 'completed';
            cleanup();
            setError('');
            if (index + 1 < prompts.length) {
              generatePart(index + 1);
            } else {
              setStops(collected);
              setLoading(false);
              setProgress('');
              navigate(0);
            }
          } catch (error) {
            outcome = 'failed';
            cleanup();
            setLoading(false);
            setError(errMessage(error));
          }
        }
      };
      void invoke(IPC.AskAboutCode, {
        requestId,
        purpose: 'tour',
        prompt: prompts[index],
        cwd: worktreePath,
        onOutput: channel,
        provider,
        model,
        envFile,
      }).catch((error) => {
        if (!active) return;
        active = false;
        outcome = 'failed';
        cleanup();
        setLoading(false);
        setError(errMessage(error));
      });
    }
    generatePart(0);
  }

  return {
    omittedFileCount: () =>
      files().filter(
        (file) =>
          !stops().some((stop) =>
            stop.locations.some((location) => location.filePath === file.path),
          ),
      ).length,
    stops,
    step,
    loading,
    error,
    progress,
    elapsedSeconds,
    receiving,
    sourceDiff,
    generateForTask,
    generate,
    cancel,
    reset,
    reconcile,
    navigate,
  };
}
export type ChangeTourController = ReturnType<typeof createChangeTour>;
