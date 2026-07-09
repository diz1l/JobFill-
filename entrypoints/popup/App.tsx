import { useState, useEffect, useCallback } from 'react';
import type { FillSummary, JobInfo } from '../../shared/types';
import { getProfiles, getActiveProfileId, setActiveProfileId } from '../../shared/storage/sync';
import { getGroqApiKey, getApplicationLog } from '../../shared/storage/local';
import type { ApplicationEntry } from '../../shared/types';
import type { OpenQuestion } from '../../shared/messages';

function openSettings() {
  const url = chrome.runtime.getURL('options.html');
  chrome.windows.create({ url, type: 'popup', width: 1280, height: 720, focused: true });
}

export default function App() {
  const [profiles, setProfiles] = useState<Array<{ id: string; label: string }>>([]);
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

  useEffect(() => {
    Promise.all([getProfiles(), getActiveProfileId(), getGroqApiKey(), getApplicationLog()]).then(
      ([profs, aid, key, logs]) => {
        setProfiles(profs.map((p) => ({ id: p.id, label: p.label })));
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
    setFilling(true); setSummary(null); setOpenQuestions([]); setError(null);
    const [tab] = await new Promise<chrome.tabs.Tab[]>((res) =>
      chrome.tabs.query({ active: true, currentWindow: true }, res),
    );
    if (!tab?.id) { setError('No active tab.'); setFilling(false); return; }
    chrome.tabs.sendMessage(tab.id, { type: 'FILL_FORM', profileId: activeId || '__active__' }, (resp) => {
      setFilling(false);
      if (chrome.runtime.lastError) { setError('Cannot connect. Refresh the page.'); return; }
      if (resp?.error) { setError(resp.error); return; }
      if (resp?.summary) setSummary(resp.summary);
      if (resp?.openQuestions?.length) setOpenQuestions(resp.openQuestions);
    });
  }, [activeId]);

  const handleAnswerQuestions = useCallback(async () => {
    if (!openQuestions.length || !hasGroqKey) return;
    setAnsweringQuestions(true); setError(null);
    chrome.runtime.sendMessage(
      { type: 'ANSWER_QUESTIONS', questions: openQuestions, profileId: activeId, jobInfo: jobInfo ?? {} },
      async (resp) => {
        if (resp?.type === 'ANSWERS_RESULT') {
          const [tab] = await new Promise<chrome.tabs.Tab[]>((res) =>
            chrome.tabs.query({ active: true, currentWindow: true }, res),
          );
          if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { type: 'FILL_ANSWERS', answers: resp.answers }, () => {
              setAnsweringQuestions(false);
              setOpenQuestions([]);
              setSummary((s) => s ? { ...s, aiQuestions: 0 } : s);
            });
          }
        } else {
          setAnsweringQuestions(false);
          if (resp?.type === 'API_ERROR') setError(resp.message);
        }
      },
    );
  }, [openQuestions, hasGroqKey, activeId, jobInfo]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true); setGeneratedText(''); setError(null);
    chrome.runtime.sendMessage(
      { type: 'GENERATE_COVER', jobInfo: jobInfo ?? {}, profileId: activeId },
      (resp) => {
        setGenerating(false);
        if (resp?.type === 'GENERATION_RESULT') setGeneratedText(resp.text);
        else if (resp?.type === 'API_ERROR') setError(resp.message);
      },
    );
  }, [jobInfo, activeId]);

  if (profiles.length === 0) {
    return (
      <div className="w-[380px] h-[214px] bg-[#1e1e1e] text-[#cccccc] flex flex-col items-center justify-center gap-4 text-center p-8">
        <span className="font-semibold text-[#e8e8e8]">JobFill</span>
        <p className="text-[13px] text-[#767676]">No profiles yet. Add one in settings to get started.</p>
        <button onClick={openSettings} className="btn-primary w-full max-w-[200px]">
          Open Settings
        </button>
      </div>
    );
  }

  return (
    <div className="w-[380px] bg-[#1e1e1e] text-[#cccccc] flex flex-col font-sans text-[13px] overflow-hidden">
      {/* Header */}
      <header className="bg-[#252526] border-b border-[#3e3e42] px-4 py-3 flex items-center justify-between">
        <span className="font-semibold text-[#e8e8e8] text-sm">JobFill</span>
        <div className="flex items-center gap-3">
          {profiles.length > 1 ? (
            <select
              value={activeId}
              onChange={(e) => handleProfileChange(e.target.value)}
              className="bg-[#3c3c3c] border border-[#505050] text-[#cccccc] text-xs rounded px-2 py-1 focus:outline-none focus:border-[#777]"
            >
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          ) : (
            <span className="text-xs text-[#767676]">{profiles[0]?.label}</span>
          )}
          <button
            onClick={openSettings}
            className="text-[#767676] hover:text-[#cccccc] transition-colors text-base leading-none"
            title="Settings"
          >⚙</button>
        </div>
      </header>

      {/* Job info bar */}
      {jobInfo && (jobInfo.company || jobInfo.position) && (
        <div className="px-4 py-2 bg-[#252526] border-b border-[#3e3e42]">
          <p className="text-xs text-[#767676] truncate">
            {[jobInfo.position, jobInfo.company].filter(Boolean).join('  ·  ')}
          </p>
        </div>
      )}

      {/* Content — scrollable */}
      <div className="flex-1 overflow-y-auto flex flex-col divide-y divide-[#2d2d2d]">        {/* Fill */}
        <div className="p-4 flex flex-col gap-3">
          <button
            onClick={handleFill}
            disabled={filling || !activeId}
            className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {filling ? <><Spinner />Filling…</> : 'Fill Form'}
          </button>

          {error && (
            <div className="bg-[#2d1b1b] border border-[#6b2b2b] rounded px-3 py-2 text-xs text-[#f48771]">
              {error}
            </div>
          )}

          {summary && <SummaryRow summary={summary} />}
        </div>

        {/* AI */}
        {hasGroqKey && (
          <div className="p-4 flex flex-col gap-2">
            {openQuestions.length > 0 && (
              <ActionButton
                onClick={handleAnswerQuestions}
                loading={answeringQuestions}
                loadingLabel="Answering…"
                label={`Answer ${openQuestions.length} open question${openQuestions.length > 1 ? 's' : ''}`}
              />
            )}
            <ActionButton
              onClick={handleGenerate}
              loading={generating}
              loadingLabel="Generating…"
              label="Generate motivation"
            />
            {generatedText && (
              <div className="flex flex-col gap-2 pt-1">
                <textarea
                  value={generatedText}
                  onChange={(e) => setGeneratedText(e.target.value)}
                  className="input h-28 resize-none text-[13px] leading-relaxed"
                />
                <button
                  onClick={() => {
                    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
                      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'FILL_COVER_TEXT', text: generatedText });
                    });
                  }}
                  className="btn-primary w-full"
                >Insert into field</button>
              </div>
            )}
          </div>
        )}

        {/* Recent logs */}
        {recentLogs.length > 0 && (
          <div className="px-4 py-3">
            <button
              onClick={() => setShowLogs((v) => !v)}
              className="flex w-full items-center justify-between text-xs text-[#767676] hover:text-[#cccccc] transition-colors"
            >
              <span>Recent applications ({recentLogs.length})</span>
              <span>{showLogs ? '−' : '+'}</span>
            </button>
            {showLogs && (
              <div className="mt-2 flex flex-col max-h-36 overflow-y-auto">
                {recentLogs.map((e) => (
                  <div key={e.id} className="flex items-center justify-between py-1.5 border-b border-[#2d2d2d] last:border-0 gap-2">
                    <span className="truncate text-xs text-[#858585] min-w-0">{e.position || e.company || e.url}</span>
                    <span className={`shrink-0 text-[11px] ${
                      e.remoteSync === 'ok' ? 'text-[#4ec9b0]' : e.remoteSync === 'failed' ? 'text-[#f48771]' : 'text-[#767676]'
                    }`}>{e.remoteSync}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="px-4 py-2.5 flex items-center justify-end">
          <a
            href="https://www.instagram.com/dias_nur420/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-[#585858] hover:text-[#767676] transition-colors"
          >@dias_nur420</a>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SummaryRow({ summary }: { summary: FillSummary }) {
  const items = [
    { value: summary.high, label: 'filled', color: '#4ec9b0' },
    ...(summary.medium > 0 ? [{ value: summary.medium, label: 'review', color: '#ce9178' }] : []),
    ...(summary.unrecognized > 0 ? [{ value: summary.unrecognized, label: 'skipped', color: '#585858' }] : []),
    ...(summary.fileInputs > 0 ? [{ value: summary.fileInputs, label: 'attach', color: '#767676' }] : []),
    ...(summary.aiQuestions > 0 ? [{ value: summary.aiQuestions, label: 'AI', color: '#9cdcfe' }] : []),
  ].filter((i) => i.value > 0);

  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-5 px-0.5 pt-0.5">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1.5">
          <span className="text-[15px] font-semibold tabular-nums leading-none" style={{ color: item.color }}>
            {item.value}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-[#585858]">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function ActionButton({
  onClick, loading, loadingLabel, label,
}: { onClick: () => void; loading: boolean; loadingLabel: string; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="w-full rounded border border-[#505050] bg-transparent py-2 text-xs text-[#cccccc] hover:border-[#777] hover:bg-[#2d2d2d] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
    >
      {loading ? <><Spinner size="sm" />{loadingLabel}</> : label}
    </button>
  );
}

function Spinner({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const s = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  return (
    <svg className={`animate-spin ${s} shrink-0`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-70" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
