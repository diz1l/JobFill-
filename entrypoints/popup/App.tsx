import { useState, useEffect, useCallback } from 'react';
import type { Profile, FillSummary, JobInfo } from '../../shared/types';
import { getProfiles, getActiveProfileId, setActiveProfileId } from '../../shared/storage/sync';
import { getGroqApiKey, getApplicationLog } from '../../shared/storage/local';
import type { ApplicationEntry } from '../../shared/types';

// ─── Popup App ───────────────────────────────────────────────────────────────

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
    async function init() {
      const [profs, aid, key, logs] = await Promise.all([
        getProfiles(),
        getActiveProfileId(),
        getGroqApiKey(),
        getApplicationLog(),
      ]);
      setProfiles(profs);
      setActiveId(aid || profs[0]?.id || '');
      setHasGroqKey(Boolean(key));
      setRecentLogs(logs.slice(0, 10));
    }
    init();
  }, []);

  // Extract job info from the active tab
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;
      chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_JOB_INFO' }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp?.jobInfo) setJobInfo(resp.jobInfo);
      });
    });
  }, []);

  const handleProfileChange = useCallback(
    async (id: string) => {
      setActiveId(id);
      await setActiveProfileId(id);
    },
    [],
  );

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
          setError('Could not connect to page. Try refreshing.');
          return;
        }
        if (resp?.error) {
          setError(resp.error);
          return;
        }
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
        if (resp?.type === 'GENERATION_RESULT') {
          setGeneratedText(resp.text);
        } else if (resp?.type === 'API_ERROR') {
          setError(resp.message);
        }
      },
    );
  }, [jobInfo, activeId]);

  const activeProfile = profiles.find((p) => p.id === activeId);

  if (profiles.length === 0) {
    return (
      <div className="w-80 p-4 text-center">
        <Logo />
        <p className="mt-3 text-sm text-slate-600">No profiles found.</p>
        <button
          onClick={() => chrome.runtime.openOptionsPage()}
          className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Open Settings →
        </button>
      </div>
    );
  }

  return (
    <div className="w-80 bg-white text-slate-800 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <Logo />
        <button
          onClick={() => chrome.runtime.openOptionsPage()}
          className="text-xs text-slate-400 hover:text-slate-600"
          title="Open Settings"
        >
          ⚙
        </button>
      </div>

      <div className="p-4 space-y-3">
        {/* Job info banner */}
        {jobInfo && (jobInfo.company || jobInfo.position) && (
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            {jobInfo.position && <span className="font-medium text-slate-700">{jobInfo.position}</span>}
            {jobInfo.position && jobInfo.company && ' · '}
            {jobInfo.company && <span>{jobInfo.company}</span>}
          </div>
        )}

        {/* Profile selector */}
        {profiles.length > 1 && (
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Profile</label>
            <select
              value={activeId}
              onChange={(e) => handleProfileChange(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
        )}

        {profiles.length === 1 && (
          <div className="text-xs text-slate-500">
            Profile: <span className="font-medium text-slate-700">{activeProfile?.label}</span>
          </div>
        )}

        {/* Fill button */}
        <button
          onClick={handleFill}
          disabled={filling || !activeId}
          className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {filling ? 'Filling…' : '⚡ Fill Form'}
        </button>

        {/* Error */}
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {/* Fill summary */}
        {summary && <FillSummaryCard summary={summary} />}

        {/* AI generation */}
        {hasGroqKey && jobInfo && (
          <div className="space-y-2">
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="w-full rounded-lg border border-violet-200 bg-violet-50 px-4 py-2 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50 transition-colors"
            >
              {generating ? 'Generating…' : '✨ Generate motivation'}
            </button>
            {generatedText && (
              <div className="space-y-1.5">
                <textarea
                  value={generatedText}
                  onChange={(e) => setGeneratedText(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 p-2 text-xs text-slate-700 h-24 resize-none focus:outline-none focus:ring-2 focus:ring-violet-400"
                />
                <button
                  onClick={() => {
                    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
                      if (tab?.id) {
                        chrome.tabs.sendMessage(tab.id, {
                          type: 'FILL_COVER_TEXT',
                          text: generatedText,
                        });
                      }
                    });
                  }}
                  className="w-full rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700"
                >
                  Insert into field
                </button>
              </div>
            )}
          </div>
        )}

        {/* Recent logs toggle */}
        {recentLogs.length > 0 && (
          <div>
            <button
              onClick={() => setShowLogs((v) => !v)}
              className="flex w-full items-center justify-between text-xs text-slate-400 hover:text-slate-600"
            >
              <span>Recent applications</span>
              <span>{showLogs ? '▲' : '▼'}</span>
            </button>
            {showLogs && (
              <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                {recentLogs.map((e) => (
                  <div key={e.id} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-xs">
                    <span className="truncate max-w-[180px] text-slate-600">
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
    <span className="text-sm font-bold tracking-tight">
      <span className="text-blue-600">Job</span>
      <span className="text-slate-800">Fill</span>
    </span>
  );
}

function FillSummaryCard({ summary }: { summary: FillSummary }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
      <p className="text-xs font-medium text-slate-500 mb-2">Fill result</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <Stat label="Detected" value={summary.total} />
        <Stat label="High confidence" value={summary.high} color="text-green-600" />
        <Stat label="Review needed" value={summary.medium} color="text-yellow-600" />
        <Stat label="Unrecognized" value={summary.unrecognized} color="text-slate-400" />
        {summary.fileInputs > 0 && (
          <div className="col-span-2 mt-1 text-blue-600">
            📎 {summary.fileInputs} file input{summary.fileInputs > 1 ? 's' : ''} — attach CV manually
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color = 'text-slate-700' }: { label: string; value: number; color?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-500">{label}</span>
      <span className={`font-semibold ${color}`}>{value}</span>
    </div>
  );
}

function SyncBadge({ status }: { status: ApplicationEntry['remoteSync'] }) {
  const map = {
    ok: { cls: 'text-green-600', label: 'synced' },
    pending: { cls: 'text-yellow-600', label: 'pending' },
    failed: { cls: 'text-red-500', label: 'failed' },
  };
  const { cls, label } = map[status];
  return <span className={`${cls} text-[10px]`}>{label}</span>;
}
