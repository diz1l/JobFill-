import { useState, useEffect, useCallback, useRef } from 'react';
import type { FillSummary, JobInfo, ApplicationEntry, RemoteSyncStatus } from '../../shared/types';
import { getProfiles, getActiveProfileId, setActiveProfileId } from '../../shared/storage/sync';
import { APPLICATION_LOG_KEY, getGroqApiKey, getApplicationLog } from '../../shared/storage/local';
import { describeMissingData } from '../../shared/filler/missingData';
import type { FromBackgroundMessage, OpenQuestion } from '../../shared/messages';
import {
  fillAllFrames,
  fillFailureMessage,
  insertCoverText,
  readJobInfo,
  sendAnswers,
} from '../ui/frames';
import { clearLastFill, pageKey, readLastFill, writeLastFill } from '../ui/lastFill';
import { Select } from '../ui/Field';
import { EmptyState, ErrorBanner, Skeleton } from '../ui/Feedback';
import {
  IconSettings, IconBolt, IconUser, IconInbox, IconSparkles,
  IconClipboard, IconChevronDown, IconChevronRight, Spinner,
} from '../ui/Icons';

/**
 * one predictable way to reach the settings.
 *
 * The old popup called `chrome.windows.create({ type: 'popup', width: 1280,
 * height: 720 })`, which (a) disagreed with the dialog Chrome opens from
 * chrome://extensions and (b) sizes the *window*, not the viewport, so the
 * "16:9" window actually rendered at 1265×633. `openOptionsPage()` respects the
 * `open_in_tab` flag declared in options/index.html, so both entry points land
 * on the same full-width tab.
 */
function openSettings() {
  chrome.runtime.openOptionsPage();
}

/** The tab every popup action addresses. `undefined` when the window has none. */
function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  return new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0])),
  );
}

/** Pages without a content script — saying "no fields" there would be a lie. */
const WEB_PAGE = /^https?:/i;

/**
 * Copy for a journal entry's remote state. `pending` is *not* terminal:
 * the background retries once after 60 s and rewrites the entry, so the popup
 * re-reads the log on every storage change and swaps the line below.
 */
const LOG_NOTICE: Record<RemoteSyncStatus, string> = {
  off: 'Saved to your local application log.',
  ok: 'Saved and synced to your logging backend.',
  pending: 'Saved locally. Syncing to your backend…',
  failed: 'Saved locally — syncing to your backend failed.',
};

const SYNC_TITLE: Record<RemoteSyncStatus, string> = {
  off: 'Local copy only — no logging backend configured',
  ok: 'Synced to your logging backend',
  pending: 'Waiting for a background retry',
  failed: 'Backend sync failed — the local copy is kept',
};

type Status = 'loading' | 'ready';

interface ProfileOption { id: string; label: string }

/** What the last "Log this application" produced, and in which state it was. */
interface LogNotice { entryId: string; status: RemoteSyncStatus; text: string }

/** The tab every popup action addresses, resolved once per open. */
interface TabTarget { id: number; page: string }

const MINUTE_MS = 60_000;

/**
 * Age of a restored fill, in words.
 *
 * A restored summary is a claim about something that happened *earlier*, and the
 * popup owes the user that difference: "3 filled" from twenty minutes ago should
 * not read the same as "3 filled" from two seconds ago.
 */
function ageLabel(at: number): string {
  const minutes = Math.floor((Date.now() - at) / MINUTE_MS);
  if (minutes < 1) return 'a moment ago';
  if (minutes === 1) return '1 minute ago';
  return `${minutes} minutes ago`;
}

export default function App() {
  const [status, setStatus] = useState<Status>('loading');
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [activeId, setActiveId] = useState('');
  const [filling, setFilling] = useState(false);
  const [summary, setSummary] = useState<FillSummary | null>(null);
  const [openQuestions, setOpenQuestions] = useState<OpenQuestion[]>([]);
  const [jobInfo, setJobInfo] = useState<JobInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generatedText, setGeneratedText] = useState('');
  const [answeringQuestions, setAnsweringQuestions] = useState(false);
  const [hasGroqKey, setHasGroqKey] = useState(false);
  const [recentLogs, setRecentLogs] = useState<ApplicationEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [logging, setLogging] = useState(false);
  const [logNotice, setLogNotice] = useState<LogNotice | null>(null);
  const [coverNotice, setCoverNotice] = useState<string | null>(null);
  /** Frame that owned the form in the last fill — target for every follow-up. */
  const [formFrameId, setFormFrameId] = useState<number | null>(null);
  /** When the displayed fill happened; `null` means there is no fill to keep. */
  const [filledAt, setFilledAt] = useState<number | null>(null);
  /** The fill on screen came from storage, not from this popup session. */
  const [restored, setRestored] = useState(false);
  /** Storage has been consulted — until then nothing may be written back. */
  const [hydrated, setHydrated] = useState(false);
  const tabRef = useRef<TabTarget | null>(null);

  useEffect(() => {
    // the popup used to render "No profiles yet" on the first frame of
    // every open, because chrome.storage resolves asynchronously. It now stays
    // in `loading` until the real answer arrives.
    Promise.all([getProfiles(), getActiveProfileId(), getGroqApiKey(), getApplicationLog()])
      .then(([profs, aid, key, logs]) => {
        setProfiles(profs.map((p) => ({ id: p.id, label: p.label })));
        setActiveId(aid || profs[0]?.id || '');
        setHasGroqKey(Boolean(key));
        setRecentLogs(logs.slice(0, 10));
      })
      .catch(() => setError('Could not read your profiles from storage.'))
      .finally(() => setStatus('ready'));

    void (async () => {
      const tab = await activeTab();
      if (!tab?.id) { setHydrated(true); return; }
      tabRef.current = { id: tab.id, page: pageKey(tab.url) };

      // The popup is destroyed every time it loses focus, so the result of a
      // fill has to be read back rather than remembered. Done before the job-info
      // broadcast below, which takes a 400 ms collection window — the restored
      // summary must not wait for it.
      const previous = await readLastFill(tab.id, tabRef.current.page);
      if (previous) {
        setSummary(previous.summary);
        setOpenQuestions(previous.openQuestions);
        setFormFrameId(previous.formFrameId);
        setGeneratedText(previous.generatedText);
        setLogNotice(previous.logNotice);
        setJobInfo(previous.jobInfo);
        setFilledAt(previous.at);
        setRestored(true);
      }
      setHydrated(true);

      // The posting may be described in an iframe (Greenhouse / Workable
      // embeds). Ask every frame and keep the richest answer; a live reading is
      // better than the one stored with the fill, so it wins when it arrives.
      const info = await readJobInfo(tab.id);
      if (info) setJobInfo(info);
    })();
  }, []);

  // Mirror of the state above, so that closing the popup does not destroy it.
  // Everything a follow-up action needs — the summary that reveals "Log this
  // application", the frame id, the questions, the generated letter — is one
  // record, written whenever any part of it moves.
  useEffect(() => {
    const tab = tabRef.current;
    if (!hydrated || !tab) return;

    if (filledAt === null || !summary) {
      void clearLastFill(tab.id);
      return;
    }
    void writeLastFill(tab.id, {
      page: tab.page,
      at: filledAt,
      summary,
      openQuestions,
      formFrameId,
      jobInfo,
      generatedText,
      logNotice,
    });
  }, [hydrated, filledAt, summary, openQuestions, formFrameId, jobInfo, generatedText, logNotice]);

  useEffect(() => {
    // A queued remote write resolves up to a minute later, in the background
    // worker. It rewrites the journal in chrome.storage.local, so re-reading on
    // every local change is what turns a `pending` badge into `ok` / `failed`
    // while the popup is open. Narrowed to the journal's own key so the fill
    // record above cannot make this fire on every keystroke when it falls back
    // to `local` (Firefox < 115).
    const onStorageChanged = (changes: Record<string, unknown>, areaName: string) => {
      if (areaName !== 'local' || !(APPLICATION_LOG_KEY in changes)) return;
      void getApplicationLog().then((logs) => setRecentLogs(logs.slice(0, 10)));
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => chrome.storage.onChanged.removeListener(onStorageChanged);
  }, []);

  const handleProfileChange = useCallback(async (id: string) => {
    setActiveId(id);
    await setActiveProfileId(id);
  }, []);

  /**
   * One broadcast reaches every frame of the tab and the counters of all frames
   * that answer are summed, because the form is regularly inside an iframe while
   * the top frame holds nothing. Frames with nothing to say never answer, so
   * "nobody answered" means "no form here"; a tab with no content script at all
   * is a different message again (`fillFailureMessage`).
   */
  const handleFill = useCallback(async () => {
    setFilling(true);
    setSummary(null); setOpenQuestions([]); setError(null);
    setLogNotice(null); setCoverNotice(null); setFormFrameId(null);
    setFilledAt(null); setRestored(false);

    const tab = await activeTab();
    if (!tab?.id) { setError('No active tab.'); setFilling(false); return; }
    if (tab.url && !WEB_PAGE.test(tab.url)) {
      setError('JobFill only works on regular web pages.');
      setFilling(false);
      return;
    }
    // The tab may have navigated since the popup opened, and the record is keyed
    // by where the fill actually happened.
    tabRef.current = { id: tab.id, page: pageKey(tab.url) };

    const outcome = await fillAllFrames(tab.id, activeId || '__active__');
    setFilling(false);
    setFormFrameId(outcome.primaryFrameId);

    if (outcome.answered === 0) {
      setError(fillFailureMessage(outcome));
      return;
    }
    setSummary(outcome.summary);
    setOpenQuestions(outcome.openQuestions);
    setFilledAt(Date.now());
  }, [activeId]);

  const handleAnswerQuestions = useCallback(() => {
    if (!openQuestions.length || !hasGroqKey) return;
    setAnsweringQuestions(true); setError(null);
    chrome.runtime.sendMessage(
      { type: 'ANSWER_QUESTIONS', questions: openQuestions, profileId: activeId, jobInfo: jobInfo ?? {} },
      async (resp: FromBackgroundMessage | undefined) => {
        if (resp?.type !== 'ANSWERS_RESULT') {
          setAnsweringQuestions(false);
          if (resp?.type === 'API_ERROR') setError(resp.message);
          return;
        }
        // Question ids carry the frame they were collected in, so each frame
        // gets its own answers back — never a sibling frame's.
        const tab = await activeTab();
        if (tab?.id) await sendAnswers(tab.id, resp.answers);
        setAnsweringQuestions(false);
        setOpenQuestions([]);
        setSummary((s) => (s ? { ...s, aiQuestions: 0 } : s));
      },
    );
  }, [openQuestions, hasGroqKey, activeId, jobInfo]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true); setGeneratedText(''); setError(null);
    chrome.runtime.sendMessage(
      { type: 'GENERATE_COVER', jobInfo: jobInfo ?? {}, profileId: activeId },
      (resp: FromBackgroundMessage | undefined) => {
        setGenerating(false);
        if (resp?.type === 'GENERATION_RESULT') setGeneratedText(resp.text);
        else if (resp?.type === 'API_ERROR') setError(resp.message);
      },
    );
  }, [jobInfo, activeId]);

  /**
   * The insert used to be fire-and-forget: when no field could be justified the
   * user was told nothing at all. It is now addressed to the frame that owned
   * the form and always reports back.
   */
  const handleInsertCover = useCallback(async () => {
    setError(null); setCoverNotice(null);
    const tab = await activeTab();
    if (!tab?.id) { setError('No active tab.'); return; }

    const result = await insertCoverText(tab.id, generatedText, formFrameId);
    if (result.success) setCoverNotice('Inserted into the page.');
    else setError(result.error ?? 'No cover letter field found.');
  }, [generatedText, formFrameId]);

  /** The only path that creates an ApplicationEntry. */
  const handleLogApplication = useCallback(async () => {
    setLogging(true); setLogNotice(null); setError(null);
    const tab = await activeTab();
    chrome.runtime.sendMessage(
      { type: 'LOG_APPLICATION', jobInfo: jobInfo ?? {}, profileId: activeId, url: tab?.url ?? '' },
      (resp: FromBackgroundMessage | undefined) => {
        setLogging(false);
        if (resp?.type !== 'LOG_RESULT') {
          setError(resp?.type === 'API_ERROR' ? resp.message : 'The application could not be saved.');
          return;
        }
        // `success: false` means even the local copy failed — there is no entry
        // worth listing, only an error to explain.
        if (!resp.success) {
          setError(resp.message ?? 'The application could not be saved.');
          return;
        }
        // The background appends before it answers, so the storage subscription
        // may have listed this entry already: replace, never duplicate.
        setRecentLogs((logs) =>
          [resp.entry, ...logs.filter((e) => e.id !== resp.entry.id)].slice(0, 10),
        );
        setShowLogs(true);
        setLogNotice({
          entryId: resp.entry.id,
          status: resp.remoteSync,
          text: resp.message ?? LOG_NOTICE[resp.remoteSync],
        });
      },
    );
  }, [jobInfo, activeId]);

  // A `pending` entry is resolved by a background retry (60 s). Once the stored
  // status moves on, the notice follows it instead of claiming "syncing…" for
  // the rest of the session.
  const liveSync = logNotice
    ? recentLogs.find((e) => e.id === logNotice.entryId)?.remoteSync
    : undefined;
  const logNoticeText = logNotice
    ? liveSync && liveSync !== logNotice.status
      ? LOG_NOTICE[liveSync]
      : logNotice.text
    : null;

  if (status === 'loading') return <PopupSkeleton />;

  if (profiles.length === 0) {
    return (
      <Shell>
        <div className="flex flex-1 flex-col justify-center gap-3 p-4">
          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
          <EmptyState
            compact
            icon={<IconUser className="size-8" />}
            title="No profiles yet"
            description="Add your details once, then fill any application form in a click."
            action={
              <button type="button" onClick={openSettings} className="btn btn-primary">
                Open settings
              </button>
            }
          />
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      header={
        <>
          {profiles.length > 1 ? (
            <Select
              label="Active profile"
              hideLabel
              value={activeId}
              onChange={handleProfileChange}
              options={profiles.map((p) => ({ value: p.id, label: p.label }))}
              className="min-w-0 flex-1"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-right text-sm text-fg-muted">
              {profiles[0]?.label}
            </span>
          )}
          <button type="button" onClick={openSettings} className="btn-icon" title="Settings" aria-label="Settings">
            <IconSettings className="size-5" />
          </button>
        </>
      }
    >
      {jobInfo && (jobInfo.company || jobInfo.position) && (
        <div className="shrink-0 border-b border-line bg-surface-raised px-4 py-2">
          <p className="truncate text-sm text-fg-muted">
            {[jobInfo.position, jobInfo.company].filter(Boolean).join('  ·  ')}
          </p>
        </div>
      )}

      {/* this is the popup's single scroll port. It only works because
          html/body carry the 600px ceiling (globals.css) and every ancestor
          here sets min-h-0. */}
      <div className="flex min-h-0 flex-1 flex-col divide-y divide-line overflow-y-auto">
        <section className="flex flex-col gap-3 p-4">
          <button
            type="button"
            onClick={handleFill}
            disabled={filling || !activeId}
            className="btn btn-primary w-full"
          >
            {filling ? <><Spinner className="size-4" />Filling…</> : <><IconBolt className="size-4" />Fill form</>}
          </button>

          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
          {summary && <SummaryRow summary={summary} />}
          {/* A restored summary describes something that already happened, and
              says so — the alternative is a stale claim about the page. */}
          {summary && restored && filledAt !== null && (
            <p className="text-sm text-fg-subtle">Filled on this page {ageLabel(filledAt)}.</p>
          )}
          {summary && (
            <button type="button" onClick={handleLogApplication} disabled={logging} className="btn btn-secondary w-full">
              {logging ? <><Spinner className="size-4" />Saving…</> : <><IconClipboard className="size-4" />Log this application</>}
            </button>
          )}
          {logNoticeText && <p className="text-sm text-fg-muted" role="status">{logNoticeText}</p>}
        </section>

        {hasGroqKey && (
          <section className="flex flex-col gap-3 p-4">
            {openQuestions.length > 0 && (
              <button
                type="button"
                onClick={handleAnswerQuestions}
                disabled={answeringQuestions}
                className="btn btn-secondary w-full"
              >
                {answeringQuestions
                  ? <><Spinner className="size-4" />Answering…</>
                  : <><IconSparkles className="size-4" />
                      {`Answer ${openQuestions.length} open question${openQuestions.length > 1 ? 's' : ''}`}
                    </>}
              </button>
            )}
            <button type="button" onClick={handleGenerate} disabled={generating} className="btn btn-secondary w-full">
              {generating
                ? <><Spinner className="size-4" />Generating…</>
                : <><IconSparkles className="size-4" />Generate motivation</>}
            </button>
            {generatedText && (
              <div className="flex flex-col gap-2">
                <label className="sr-only" htmlFor="jf-cover">Generated motivation letter</label>
                <textarea
                  id="jf-cover"
                  value={generatedText}
                  onChange={(e) => setGeneratedText(e.target.value)}
                  rows={6}
                  className="input resize-none"
                />
                <button type="button" onClick={handleInsertCover} className="btn btn-primary w-full">
                  Insert into field
                </button>
                {coverNotice && (
                  <p className="text-sm text-fg-muted" role="status">{coverNotice}</p>
                )}
              </div>
            )}
          </section>
        )}

        <section className="p-4">
          <button
            type="button"
            onClick={() => setShowLogs((v) => !v)}
            aria-expanded={showLogs}
            className="flex w-full items-center justify-between gap-2 text-sm text-fg-muted hover:text-fg"
          >
            <span>Recent applications{recentLogs.length > 0 ? ` (${recentLogs.length})` : ''}</span>
            {showLogs ? <IconChevronDown className="size-4" /> : <IconChevronRight className="size-4" />}
          </button>

          {showLogs && (
            recentLogs.length > 0 ? (
              <ul className="mt-3 flex flex-col">
                {recentLogs.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-2 border-b border-line py-1.5 last:border-0"
                  >
                    <span className="min-w-0 truncate text-sm text-fg-muted">
                      {entry.position || entry.company || entry.url}
                    </span>
                    <SyncBadge status={entry.remoteSync} />
                  </li>
                ))}
              </ul>
            ) : (
              /* the list used to render nothing at all when empty. */
              <div className="mt-3">
                <EmptyState
                  compact
                  icon={<IconInbox className="size-6" />}
                  title="Nothing logged yet"
                  description="Fill a form, then use “Log this application” to keep a record of it."
                />
              </div>
            )
          )}
        </section>
      </div>
    </Shell>
  );
}

// ─── Shell & states ───────────────────────────────────────────────────────────

/** Fixed chrome shared by every popup state, so opening never shifts the layout. */
function Shell({ header, children }: { header?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface text-fg">
      <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-raised px-4 py-2.5">
        <IconBolt className="size-4 text-accent" />
        <span className="font-semibold text-fg">JobFill</span>
        {header}
      </header>
      {children}
    </div>
  );
}

/** same silhouette as the loaded popup, so nothing jumps on arrival. */
function PopupSkeleton() {
  return (
    <Shell>
      <div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </Shell>
  );
}

/**
 * The counters, plus the one thing a counter cannot say.
 *
 * `noData` is "we recognised this field and your profile has nothing for it",
 * which used to be folded into `unrecognized` — so a blank cover-letter box on a
 * first run was reported as *skipped*, indistinguishable from a control JobFill
 * could not read. It shares the amber of `review` deliberately: both mean "this
 * one needs you", and the labels tell them apart. `missingFields` names them, and
 * that sentence is the only part of this row that is actionable, so it is the
 * only part rendered in full prose.
 *
 * Both fields are optional on the wire (a frame on an older build omits them),
 * hence the `?? 0` / `?? []`.
 */
function SummaryRow({ summary }: { summary: FillSummary }) {
  const items = [
    { value: summary.high, label: 'filled', className: 'text-conf-high' },
    { value: summary.medium, label: 'review', className: 'text-conf-medium' },
    { value: summary.noData ?? 0, label: 'no data', className: 'text-conf-medium' },
    { value: summary.unrecognized, label: 'skipped', className: 'text-conf-none' },
    { value: summary.fileInputs, label: 'attach', className: 'text-conf-file' },
    { value: summary.aiQuestions, label: 'AI', className: 'text-conf-ai' },
  ].filter((i) => i.value > 0);

  const missing = describeMissingData(summary.missingFields ?? []);

  if (items.length === 0) {
    return <p className="text-sm text-fg-muted">Nothing recognised on this page.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        {items.map((item) => (
          <div key={item.label} className="flex items-baseline gap-1.5">
            <span className={`text-lg font-semibold tabular-nums ${item.className}`}>{item.value}</span>
            <span className="text-xs uppercase tracking-wider text-fg-subtle">{item.label}</span>
          </div>
        ))}
      </div>
      {missing && <p className="text-sm text-fg-muted">{missing}</p>}
    </div>
  );
}

/** `pending` is a live state — the background retries once and rewrites it. */
function SyncBadge({ status }: { status: RemoteSyncStatus }) {
  const tone =
    status === 'ok'
      ? 'text-success'
      : status === 'failed'
        ? 'text-danger'
        : status === 'pending'
          ? 'text-warning'
          : 'text-fg-subtle';
  return (
    <span className={`shrink-0 text-xs ${tone}`} title={SYNC_TITLE[status]}>
      {status}
    </span>
  );
}
