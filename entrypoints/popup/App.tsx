import { useState, useEffect, useCallback } from 'react';
import type { FillSummary, JobInfo } from '../../shared/types';
import { getProfiles, getActiveProfileId, setActiveProfileId } from '../../shared/storage/sync';
import { getGroqApiKey, getApplicationLog } from '../../shared/storage/local';
import type { ApplicationEntry } from '../../shared/types';
import type { OpenQuestion } from '../../shared/messages';

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
        setProfiles(profs.map(p => ({ id: p.id, label: p.label })));
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
    setOpenQuestions([]);
    setError(null);
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
    setAnsweringQuestions(true);
    setError(null);
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
    setGenerating(true);
    setGeneratedText('');
    setError(null);
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
      <div className="w-[400px] h-[200px] bg-[#111] flex flex-col items-center justify-center gap-4 p-6">
        <span className="text-[#e8e8e8] font-semibold tracking-tight">JobFill</span>
        <p className="text-sm text-[#666] text-center">No profiles yet. Add one in settings to get started.</p>
        <button onClick={() => chrome.runtime.openOptionsPage()} className="btn-primary max-w-[180px]">
          Open Settings
        </button>
      </div>
    );
  }

  return (
    <div className="w-[400px] bg-[#111] text-[#e8e8e8] flex flex-col font-sans text-sm select-none">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-[#222]">
        <span className="font-semibold tracking-tight text-[#e8e8e8]">JobFill</span>
        <div className="flex items-center gap-3">
          {profiles.length > 1 && (
            <select
              value={activeId}
              onChange={(e) => handleProfileChange(e.target.value)}
              className="bg-[#1e1e1e] border border-[#333] text-[#aaa] text-xs rounded-md px-2 py-1 focus:outline-none focus:border-[#555]"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          )}
          {profiles.length === 1 && (
            <span className="text-xs text-[#555]">{profiles[0].label}</span>
          )}
          <button
            onClick={() => chrome.runtime.openOptionsPage()}
            className="text-[#444] hover:text-[#888] transition-colors text-lg leading-none"
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-0">
        {/* Job info */}
        {jobInfo && (jobInfo.company || jobInfo.position) && (
          <div className="px-4 py-2.5 border-b border-[#1e1e1e] bg-[#161616]">
            <p className="text-xs text-[#666] truncate">
              {[jobInfo.position, jobInfo.company].filter(Boolean).join('  ·  ')}
            </p>
          </div>
        )}

        {/* Main fill area */}
        <div className="p-4 flex flex-col gap-3">
          <button
            onClick={handleFill}
            disabled={filling || !activeId}
            className="btn-primary flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {filling ? <><Spinner /> Filling…</> : 'Fill Form'}
          </button>

          {error && (
            <p className="text-xs text-[#e05b5b] bg-[#1e1414] border border-[#3a2020] rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {summary && <SummaryRow summary={summary} />}
        </div>

        {/* AI section */}
        {hasGroqKey && (
          <div className="border-t border-[#1e1e1e] px-4 py-3 flex flex-col gap-2">
            {openQuestions.length > 0 && (
              <button
                onClick={handleAnswerQuestions}
                disabled={answeringQuestions}
                className="w-full rounded-lg border border-[#333] bg-[#1a1a1a] py-2 text-xs text-[#aaa] hover:border-[#555] hover:text-[#e8e8e8] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                {answeringQuestions
                  ? <><Spinner size="sm" /> Answering…</>
                  : `Answer ${openQuestions.length} question${openQuestions.length > 1 ? 's' : ''} with AI`}
              </button>
            )}

            <button
              onClick={handleGenerate}
              disabled={generating}
              className="w-full rounded-lg border border-[#333] bg-[#1a1a1a] py-2 text-xs text-[#aaa] hover:border-[#555] hover:text-[#e8e8e8] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {generating ? <><Spinner size="sm" /> Generating…</> : 'Generate motivation'}
            </button>

            {generatedText && (
              <div className="flex flex-col gap-2 pt-1">
                <textarea
                  value={generatedText}
                  onChange={(e) => setGeneratedText(e.target.value)}
                  className="input h-28 resize-none text-xs leading-relaxed"
                />
                <button
                  onClick={() => {
                    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
                      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'FILL_COVER_TEXT', text: generatedText });
                    });
                  }}
                  className="btn-primary text-xs py-2"
                >
                  Insert into field
                </button>
              </div>
            )}
          </div>
        )}

        {/* Recent logs */}
        {recentLogs.length > 0 && (
          <div className="border-t border-[#1e1e1e] px-4 py-3">
            <button
              onClick={() => setShowLogs((v) => !v)}
              className="flex w-full items-center justify-between text-xs text-[#444] hover:text-[#888] transition-colors"
            >
              <span>Recent ({recentLogs.length})</span>
              <span className="font-mono">{showLogs ? '−' : '+'}</span>
            </button>
            {showLogs && (
              <div className="mt-2 flex flex-col gap-1 max-h-32 overflow-y-auto">
                {recentLogs.map((e) => (
                  <div key={e.id} className="flex items-center justify-between py-1.5 border-b border-[#1e1e1e] last:border-0 gap-2">
                    <span className="truncate text-xs text-[#666] min-w-0">
                      {e.position || e.company || e.url}
                    </span>
                    <span className={`shrink-0 text-[10px] tabular-nums ${
                      e.remoteSync === 'ok' ? 'text-[#4a9] '
                      : e.remoteSync === 'failed' ? 'text-[#e05b5b]'
                      : 'text-[#888]'
                    }`}>{e.remoteSync}</span>
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

function SummaryRow({ summary }: { summary: FillSummary }) {
  const items = [
    { value: summary.high, label: 'filled', color: 'text-[#4a9]' },
    { value: summary.medium, label: 'review', color: 'text-[#a83]' },
    { value: summary.unrecognized, label: 'skipped', color: 'text-[#555]' },
    ...(summary.fileInputs > 0 ? [{ value: summary.fileInputs, label: 'attach', color: 'text-[#666]' }] : []),
    ...(summary.aiQuestions > 0 ? [{ value: summary.aiQuestions, label: 'AI', color: 'text-[#888]' }] : []),
  ].filter(i => i.value > 0);

  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-4 px-1">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1">
          <span className={`text-base font-semibold tabular-nums leading-none ${item.color}`}>{item.value}</span>
          <span className="text-[10px] text-[#444] uppercase tracking-wide">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function Spinner({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const s = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  return (
    <svg className={`animate-spin ${s} shrink-0`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
