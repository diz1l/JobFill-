import { useState, useEffect, useCallback } from 'react';
import type { Profile, FillSummary, JobInfo } from '../../shared/types';
import { getProfiles, getActiveProfileId, setActiveProfileId } from '../../shared/storage/sync';
import { getGroqApiKey, getApplicationLog } from '../../shared/storage/local';
import type { ApplicationEntry } from '../../shared/types';

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState('');
  const [filling, setFilling] = useState(false);
  const [summary, setSummary] = useState<FillSummary | null>(null);
  const [jobInfo, setJobInfo] = useState<JobInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generatedText, setGeneratedText] = useState('');
  const [hasGroqKey, setHasGroqKey] = useState(false);
  const [recentLogs, setRecentLogs] = useState<ApplicationEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  useEffect(() => {
    Promise.all([getProfiles(), getActiveProfileId(), getGroqApiKey(), getApplicationLog()]).then(
      ([profs, aid, key, logs]) => {
        setProfiles(profs);
        setActiveId(aid || profs[0]?.id || '');
        setHasGroqKey(Boolean(key));
        setRecentLogs(logs.slice(0, 10));
      },
    );

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;
      chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_JOB_INFO' }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp?.jobInfo) setJobInfo(resp.jobInfo);
      });
    });
  }, []);

  const handleProfileChange = useCallback(async (id: string) => {
    setActiveId(id);
    await setActiveProfileId(id);
  }, []);

  const handleFill = useCallback(async () => {
    setFilling(true);
    setSummary(null);
    setError(null);

    const [tab] = await new Promise<chrome.tabs.Tab[]>((res) =>
      chrome.tabs.query({ active: true, currentWindow: true }, res),
    );

    if (!tab?.id) {
      setError('No active tab found.');
      setFilling(false);
      return;
    }

    chrome.tabs.sendMessage(
      tab.id,
      { type: 'FILL_FORM', profileId: activeId || '__active__' },
      (resp) => {
        setFilling(false);
        if (chrome.runtime.lastError) {
          setError('Could not connect to page. Refresh and try again.');
          return;
        }
        if (resp?.error) { setError(resp.error); return; }
        if (resp?.summary) setSummary(resp.summary);
      },
    );
  }, [activeId]);

  const handleGenerate = useCallback(async () => {
    if (!jobInfo) return;
    setGenerating(true);
    setGeneratedText('');
    setError(null);

    chrome.runtime.sendMessage(
      { type: 'GENERATE_COVER', jobInfo, profileId: activeId },
      (resp) => {
        setGenerating(false);
        if (resp?.type === 'GENERATION_RESULT') setGeneratedText(resp.text);
        else if (resp?.type === 'API_ERROR') setError(resp.message);
      },
    );
  }, [jobInfo, activeId]);

  const activeProfile = profiles.find((p) => p.id === activeId);

  if (profiles.length === 0) {
    return (
      <div className="w-[360px] p-5 flex flex-col items-center gap-3 text-center">
        <Logo />
        <p className="text-sm text-slate-500 mt-1">No profiles yet. Set one up to get started.</p>
        <button
          onClick={() => chrome.runtime.openOptionsPage()}
          className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
        >
          Open Settings →
        </button>
      </div>
    );
  }

  return (
    <div className="w-[360px] flex flex-col bg-white text-slate-800 font-sans text-sm">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <Logo />
        {activeProfile && (
          <span className="text-xs text-slate-400 max-w-[180px] truncate">{activeProfile.label}</span>
        )}
        <button
          onClick={() => chrome.runtime.openOptionsPage()}
          className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 transition-colors"
          title="Settings"
          aria-label="Open Settings"
        >
          ⚙
        </button>
      </header>

      <div className="flex flex-col gap-3 p-4">
        {/* Job info banner */}
        {jobInfo && (jobInfo.company || jobInfo.position) && (
          <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 text-xs text-slate-500 leading-snug">
            {jobInfo.position && (
              <span className="font-semibold text-slate-700">{jobInfo.position}</span>
            )}
            {jobInfo.position && jobInfo.company && (
              <span className="mx-1 text-slate-300">·</span>
            )}
            {jobInfo.company && <span>{jobInfo.company}</span>}
          </div>
        )}

        {/* Profile selector (multiple profiles) */}
        {profiles.length > 1 && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">Profile</label>
            <select
              value={activeId}
              onChange={(e) => handleProfileChange(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* Fill button */}
        <button
          onClick={handleFill}
          disabled={filling || !activeId}
          className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 active:scale-[.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        >
          {filling ? (
            <span className="flex items-center justify-center gap-2">
              <Spinner /> Filling…
            </span>
          ) : (
            '⚡ Fill Form'
          )}
        </button>

        {/* Error */}
        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2.5 text-xs text-red-700 leading-snug">
            {error}
          </div>
        )}

        {/* Fill summary */}
        {summary && <SummaryCard summary={summary} />}

        {/* AI generation */}
        {hasGroqKey && (
          <div className="flex flex-col gap-2 pt-0.5">
            <button
              onClick={handleGenerate}
              disabled={generating || !jobInfo}
              className="w-full rounded-xl border border-violet-200 bg-violet-50 py-2 text-xs font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title={!jobInfo ? 'No job info detected on this page' : undefined}
            >
              {generating ? '✨ Generating…' : '✨ Generate motivation'}
            </button>
            {generatedText && (
              <>
                <textarea
                  value={generatedText}
                  onChange={(e) => setGeneratedText(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 p-3 text-xs text-slate-700 h-28 resize-none focus:outline-none focus:ring-2 focus:ring-violet-400 leading-relaxed"
                />
                <button
                  onClick={() => {
                    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
                      if (tab?.id) {
                        chrome.tabs.sendMessage(tab.id, { type: 'FILL_COVER_TEXT', text: generatedText });
                      }
                    });
                  }}
                  className="w-full rounded-xl bg-violet-600 py-2 text-xs font-semibold text-white hover:bg-violet-700 transition-colors"
                >
                  Insert into field
                </button>
              </>
            )}
          </div>
        )}

        {/* Recent logs */}
        {recentLogs.length > 0 && (
          <div className="border-t border-slate-100 pt-3">
            <button
              onClick={() => setShowLogs((v) => !v)}
              className="flex w-full items-center justify-between text-xs text-slate-400 hover:text-slate-600 transition-colors"
            >
              <span>Recent applications ({recentLogs.length})</span>
              <span>{showLogs ? '▲' : '▼'}</span>
            </button>
            {showLogs && (
              <div className="mt-2 flex flex-col gap-1 max-h-36 overflow-y-auto">
                {recentLogs.map((e) => (
                  <div key={e.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs gap-2">
                    <span className="truncate text-slate-600 min-w-0">
                      {e.position || e.company || e.url}
                    </span>
                    <SyncBadge status={e.remoteSync} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Logo() {
  return (
    <span className="text-[15px] font-extrabold tracking-tight leading-none">
      <span className="text-blue-600">Job</span>
      <span className="text-slate-800">Fill</span>
    </span>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function SummaryCard({ summary }: { summary: FillSummary }) {
  const total = summary.high + summary.medium;
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-600">Fill result</span>
        <span className="text-xs text-slate-400">{summary.total} fields scanned</span>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {total > 0 && (
          <Pill color="green" label={`✓ ${summary.high} filled`} />
        )}
        {summary.medium > 0 && (
          <Pill color="yellow" label={`⚠ ${summary.medium} review`} />
        )}
        {summary.unrecognized > 0 && (
          <Pill color="gray" label={`○ ${summary.unrecognized} skipped`} />
        )}
        {summary.fileInputs > 0 && (
          <Pill color="blue" label={`📎 ${summary.fileInputs} attach manually`} />
        )}
        {summary.aiQuestions > 0 && (
          <Pill color="violet" label={`✨ ${summary.aiQuestions} AI questions`} />
        )}
      </div>
    </div>
  );
}

type PillColor = 'green' | 'yellow' | 'gray' | 'blue' | 'violet';
const pillClasses: Record<PillColor, string> = {
  green: 'bg-green-50 text-green-700 border-green-200',
  yellow: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  gray: 'bg-slate-100 text-slate-500 border-slate-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
};
function Pill({ color, label }: { color: PillColor; label: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${pillClasses[color]}`}>
      {label}
    </span>
  );
}

function SyncBadge({ status }: { status: ApplicationEntry['remoteSync'] }) {
  const map = {
    ok: 'text-green-600',
    pending: 'text-yellow-600',
    failed: 'text-red-500',
  };
  return <span className={`shrink-0 text-[10px] font-medium ${map[status]}`}>{status}</span>;
}

