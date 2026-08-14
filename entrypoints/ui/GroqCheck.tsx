import { useCallback, useEffect, useRef, useState } from 'react';
import type { GroqCheckReport } from '../../shared/messages';
import { providerOf, type ProviderId } from '../../shared/api/provider';
import { checkGroqConnection, maskApiKey, type GroqCheckResult } from './groqConnection';
import { ErrorBanner } from './Feedback';
import { IconAlert, IconBolt, IconCheck, Spinner } from './Icons';

/**
 * "Check key" for the LLM credentials. The button separates four failures the
 * extension used to report as one sentence ("Groq API key is invalid or
 * expired"):
 *
 *   • the key was never saved — answered *without* a request, by comparing the
 *     field with what is in storage;
 *   • the key belongs to a different provider — also answered without a request,
 *     from its prefix (`sk-or-v1-…` is an OpenRouter key). This is the case that
 *     cost the first live run an hour;
 *   • the key is rejected by the provider — a 401 on `GET /models`;
 *   • the key is fine and the *model* is not — a retired or foreign id, which
 *     comes back as a 400 on the completions endpoint and nowhere else.
 *
 * The model list comes back with the answer, so the last case ends with ids the
 * user can click instead of a name they have to guess.
 */

interface GroqCheckProps {
  /** Key currently typed in the form. */
  apiKey: string;
  /** Model currently typed in the form; empty means "the provider's default". */
  model: string;
  /** Provider currently selected in the form. */
  provider: ProviderId;
  /** Base URL currently typed in the form; only used when `provider` is custom. */
  baseUrl: string;
  /** Key in `chrome.storage.local` — what JobFill actually uses right now. */
  savedApiKey: string;
  /** Model in `chrome.storage.local`. */
  savedModel: string;
  /** Fill the Model field from the list of what the account can serve. */
  onPickModel: (model: string) => void;
}

/**
 * A finished check belongs to the key it was run with, and is discarded when
 * that key is edited. It deliberately survives an edit of the *model*: picking a
 * model out of the list this very card renders is the common case, and throwing
 * the card away in response would delete the answer the user is acting on. The
 * card marks the model row untested instead (see {@link ReportCard}).
 */
type Phase = { status: 'idle' } | { status: 'checking' } | { status: 'done'; result: GroqCheckResult };

/**
 * The model ids on offer. An account-scoped answer (Groq, OpenAI) is a couple of
 * dozen valid choices and is rendered whole; a catalogue answer (OpenRouter) is
 * presented as what it is — a count, a link to browse it, and the handful of ids
 * resembling what the user typed. The shortlisting and the reasoning behind it
 * live in the worker (`offeredModels` in entrypoints/background.ts).
 */
function ModelPicker({
  report,
  current,
  onPick,
}: {
  report: GroqCheckReport;
  current: string;
  onPick: (model: string) => void;
}) {
  const { models, modelsAreCatalogue, modelCount, modelsPageUrl } = report;
  if (models.length === 0 && !modelsPageUrl) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <p className="text-sm text-fg-subtle">
        {modelsAreCatalogue ? (
          <>
            {report.provider} brokers {modelCount} models — too many to list.
            {models.length > 0 ? ' Closest to what you typed:' : ''}{' '}
            {modelsPageUrl && (
              <a
                className="text-accent underline underline-offset-2"
                href={modelsPageUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Browse them all
              </a>
            )}
          </>
        ) : (
          'Models this key can use — select one to put it in the Model field, then save.'
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {models.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            aria-current={id === current ? 'true' : undefined}
            className={`pill ${id === current ? 'pill-active' : ''}`}
          >
            {id}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * `gsk_…f6a7 with llama-3.3-70b-versatile` — one inline phrase, no trailing
 * punctuation, so the caller owns the sentence it sits in. (JSX inserts a space
 * for every newline between elements, which is how a stray " ." appears.)
 */
function SavedCredentials({ apiKey, model }: { apiKey: string; model: string }) {
  return (
    <>
      <code className="code-chip">{maskApiKey(apiKey)}</code>
      {model ? (
        <>
          {' with '}
          <code className="code-chip">{model}</code>
        </>
      ) : null}
    </>
  );
}

function ReportCard({
  report,
  currentModel,
  onPickModel,
}: {
  report: GroqCheckReport;
  /** Model in the form now — not necessarily the one that was probed. */
  currentModel: string;
  onPickModel: (model: string) => void;
}) {
  // The user picked a different model out of the list below (or typed one). The
  // key verdict still stands; the model verdict does not, and saying otherwise
  // would be the same "green tick for something else" this button exists to end.
  const stale = currentModel !== '' && currentModel !== report.model;

  return (
    <div className="card flex flex-col gap-3">
      {/* The key gets its own line even when the model failed: "your key is
          fine" is the single most useful thing to know at that moment. */}
      <p className="flex items-start gap-2 font-medium text-fg">
        <IconCheck className="mt-0.5 size-4 text-conf-high" />
        <span>
          Key <code className="code-chip">{report.keyHint}</code> accepted —{' '}
          {report.modelCount > 0
            ? `${report.provider} answered with ${report.modelCount} model${report.modelCount === 1 ? '' : 's'}.`
            : `${report.provider} lists no models for it.`}
        </span>
      </p>

      <p className="flex items-start gap-2">
        {stale ? (
          <IconAlert className="mt-0.5 size-4 text-conf-medium" />
        ) : report.modelOk ? (
          <IconCheck className="mt-0.5 size-4 text-conf-high" />
        ) : (
          <IconAlert className="mt-0.5 size-4 text-danger" />
        )}
        <span className="min-w-0 flex-1 break-words">
          <code className="code-chip">{stale ? currentModel : report.model}</code>{' '}
          <span className={!stale && report.modelOk ? 'text-fg' : 'text-fg-muted'}>
            {stale
              ? 'has not been tested — press “Check key” again, then save.'
              : report.modelOk
                ? 'answered a test request — motivation letters, answers and field recognition will work.'
                : (report.modelProblem ?? 'could not be used.')}
          </span>
        </span>
      </p>

      <ModelPicker report={report} current={currentModel || report.model} onPick={onPickModel} />
    </div>
  );
}

export function GroqCheck({
  apiKey,
  model,
  provider,
  baseUrl,
  savedApiKey,
  savedModel,
  onPickModel,
}: GroqCheckProps) {
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  // Trimmed here as well as on save: a pasted key almost always brings a space
  // or a newline with it, and a check that passes must be a check of what gets
  // stored — otherwise this button becomes another way to be lied to.
  const cleanKey = apiKey.trim();
  const cleanModel = model.trim();
  const providerInfo = providerOf(provider);
  const runId = useRef(0);

  // A result is about one key. Editing the key makes it stale, and a stale
  // "accepted" is worse than no answer at all. (Editing the *model* is handled
  // inside the card, which keeps the key verdict and drops only the model one.)
  useEffect(() => {
    runId.current += 1;
    setPhase({ status: 'idle' });
  }, [cleanKey, provider]);

  const run = useCallback(
    async (busy: boolean) => {
      if (busy) return;
      const id = ++runId.current;
      setPhase({ status: 'checking' });
      const result = await checkGroqConnection(cleanKey, cleanModel, provider, baseUrl);
      // The key changed while the request was in flight — drop the answer.
      if (runId.current === id) setPhase({ status: 'done', result });
    },
    [cleanKey, cleanModel, provider, baseUrl],
  );

  const checking = phase.status === 'checking';
  const result = phase.status === 'done' ? phase.result : null;

  // The trap this whole section exists for: a key pasted into the field is not a
  // key JobFill has. Nothing above tells the user that, because the field looks
  // exactly the same either way.
  const unsavedKey = cleanKey !== savedApiKey.trim();
  const unsavedModel = cleanModel !== savedModel.trim();
  const unsaved = unsavedKey || unsavedModel;
  const nothingSaved = savedApiKey.trim() === '';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* `aria-disabled`, not `disabled`: a control that is disabled mid-press
            drops keyboard focus to <body>, so the user loses their place for the
            whole request and never sees the focus ring come back. */}
        <button
          type="button"
          onClick={() => void run(checking)}
          aria-disabled={checking}
          aria-busy={checking}
          className="btn btn-secondary"
        >
          {checking ? (
            <>
              <Spinner className="size-4" />
              Checking…
            </>
          ) : (
            <>
              <IconBolt className="size-4" />
              Check key
            </>
          )}
        </button>
        <p className="text-sm text-fg-subtle">
          Asks {providerInfo.inSentence} which models it serves and sends one test token to the
          model above. Costs nothing and stores nothing.
        </p>
      </div>

      {/* Status of the *stored* credentials, always visible — this is the answer
          to "did my key even save?", which no amount of checking can give. */}
      <p className="text-sm text-fg-muted" role="status">
        {nothingSaved ? (
          <>
            <span className="text-warning">No API key is saved in this browser yet.</span> Typing
            one above is not enough — press “Save settings” at the bottom.
          </>
        ) : unsaved ? (
          <>
            <span className="text-warning">Unsaved changes.</span> JobFill is still using{' '}
            <SavedCredentials apiKey={savedApiKey} model={savedModel} />
            {'. Press “Save settings” to switch to what is typed above.'}
          </>
        ) : (
          <>
            Saved in this browser: <SavedCredentials apiKey={savedApiKey} model={savedModel} />
            {'.'}
          </>
        )}
      </p>

      {/* `ErrorBanner` is a role="alert" of its own, so it stays outside the
          polite region below — nested live regions announce twice. */}
      {result && !result.ok && <ErrorBanner message={result.message} />}

      {/* A rejected *model* is not a transport error: it comes back `ok`, and
          the card states that the key works before explaining the model. */}
      <div aria-live="polite">
        {result?.ok && (
          <ReportCard report={result.report} currentModel={cleanModel} onPickModel={onPickModel} />
        )}
      </div>
    </div>
  );
}
