import { useState, useEffect, useRef, useCallback } from 'react';
import type { Profile, CoverTemplate, AppSettings } from '../../shared/types';
import { createEmptyProfile } from '../../shared/types';
import {
  getProfiles, saveProfiles, getCoverTemplates, saveCoverTemplates,
  getSettings, saveSettings, exportSyncData, importSyncData, getStorageUsage,
} from '../../shared/storage/sync';
import type { SyncStorageUsage } from '../../shared/storage/sync';
import {
  getGroqApiKey, setGroqApiKey, getGroqModel, setGroqModel,
  getLlmProvider, getCustomBaseUrl, setLlmProvider,
  getNotionCredentials, setNotionCredentials, getSheetsEndpoint, setSheetsEndpoint,
} from '../../shared/storage/local';
import { validateSheetsEndpoint } from '../../shared/api/sheets';
import {
  keyProviderMismatch, normalizeBaseUrl, originPattern, providerOf, resolveBaseUrl,
  validateBaseUrl, PROVIDER_IDS, PROVIDERS, type ProviderId,
} from '../../shared/api/provider';
import { Field, TextArea, Select, Toggle } from '../ui/Field';
import { EmptyState, ErrorBanner, SavedFlag, Skeleton } from '../ui/Feedback';
import { ConfirmDialog } from '../ui/Dialog';
import { NotionCheck } from '../ui/NotionCheck';
import { GroqCheck } from '../ui/GroqCheck';
import { hasHostAccess, requestHostAccess } from '../ui/hostAccess';
import {
  IconBolt, IconUser, IconFileText, IconKey, IconPlus, IconTrash,
  IconDownload, IconUpload, IconAlert,
} from '../ui/Icons';

type Tab = 'profiles' | 'templates' | 'api';

const NAV: { id: Tab; label: string; Icon: typeof IconUser }[] = [
  { id: 'profiles', label: 'Profiles', Icon: IconUser },
  { id: 'templates', label: 'Templates', Icon: IconFileText },
  { id: 'api', label: 'API & Logging', Icon: IconKey },
];

/** Mirrors --sidebar-* in globals.css; the handle needs the numbers in JS. */
const SIDEBAR = { min: 140, max: 340, default: 200, step: 16, key: 'jobfill:sidebar-width' };

const clampSidebar = (n: number) => Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, Math.round(n)));

export default function App() {
  const [tab, setTab] = useState<Tab>('profiles');
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    // the width survives reloads. Page-local storage, not chrome.storage:
    // it is a per-display preference and must not burn the sync quota.
    const stored = Number(window.localStorage.getItem(SIDEBAR.key));
    return Number.isFinite(stored) && stored > 0 ? clampSidebar(stored) : SIDEBAR.default;
  });
  const [dragging, setDragging] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR.key, String(sidebarWidth));
  }, [sidebarWidth]);

  const resizeFromClientX = useCallback((clientX: number) => {
    const left = bodyRef.current?.getBoundingClientRect().left ?? 0;
    setSidebarWidth(clampSidebar(clientX - left));
  }, []);

  // Pointer events (not mouse events) so the handle also works with touch and pen.
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    resizeFromClientX(e.clientX);
  }, [dragging, resizeFromClientX]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  }, []);

  const onSeparatorKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const map: Record<string, number> = {
      ArrowLeft: -SIDEBAR.step,
      ArrowRight: SIDEBAR.step,
    };
    if (e.key in map) {
      e.preventDefault();
      setSidebarWidth((w) => clampSidebar(w + map[e.key]));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setSidebarWidth(SIDEBAR.min);
    } else if (e.key === 'End') {
      e.preventDefault();
      setSidebarWidth(SIDEBAR.max);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSidebarWidth(SIDEBAR.default);
    }
  }, []);

  return (
    /* h-screen + overflow-hidden. The page itself must never scroll:
       <main> below is the only scroll container, which keeps the header and
       the sidebar permanently on screen. */
    <div className="flex h-screen flex-col overflow-hidden bg-surface text-fg">
      <header className="shrink-0 border-b border-line bg-surface-raised">
        <div className="flex items-center gap-2 px-4 py-3 md:px-6">
          <IconBolt className="size-5 text-accent" />
          <span className="text-lg font-semibold text-fg">JobFill</span>
          <span className="text-base text-fg-muted">Settings</span>
        </div>

        {/* below `md` (the ~600px options dialog) the sidebar collapses
            into a horizontal tab strip so the content keeps its full width. */}
        <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto px-2 pb-2 md:hidden">
          {NAV.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id ? 'page' : undefined}
              className={`nav-item w-auto ${tab === id ? 'nav-item-active' : ''}`}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div ref={bodyRef} className="flex min-h-0 flex-1">
        <aside
          aria-label="Settings sections"
          style={{ width: sidebarWidth }}
          className="hidden h-full shrink-0 overflow-y-auto bg-surface-raised p-2 md:block"
        >
          <nav className="flex flex-col gap-1">
            {NAV.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={tab === id ? 'page' : undefined}
                className={`nav-item ${tab === id ? 'nav-item-active' : ''}`}
              >
                <Icon className="size-4" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </nav>
        </aside>

        {/* a real separator: reachable by Tab, resizable with the arrow
            keys, resettable with Enter, and pointer-driven on touch screens. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={sidebarWidth}
          aria-valuemin={SIDEBAR.min}
          aria-valuemax={SIDEBAR.max}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => setSidebarWidth(SIDEBAR.default)}
          onKeyDown={onSeparatorKeyDown}
          className={`hidden w-1.5 shrink-0 cursor-col-resize touch-none transition-theme md:block ${
            dragging ? 'bg-accent' : 'bg-line hover:bg-accent'
          }`}
        />

        {/* The only scroll port on the page. */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="content-column p-4 md:p-6">
            {tab === 'profiles' && <ProfilesTab />}
            {tab === 'templates' && <TemplatesTab />}
            {tab === 'api' && <ApiTab />}
          </div>
        </main>
      </div>
    </div>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────────────

function SectionHeader({
  title, description, children,
}: { title: string; description?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="section-title">{title}</h1>
        {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      </div>
      {description && <p className="section-desc">{description}</p>}
    </div>
  );
}

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-5 w-40" />
      <div className="field-grid">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Warn before chrome.storage.sync fills up. */
function QuotaWarning({ usage }: { usage: SyncStorageUsage | null }) {
  if (!usage?.warn) return null;
  return (
    <div className="banner-error mb-4" role="status">
      <IconAlert className="mt-px size-4" />
      <span>
        Synced storage is {usage.percent}% full ({Math.round(usage.bytes / 1024)} KB of{' '}
        {Math.round(usage.quotaBytes / 1024)} KB). Remove a profile or shorten your templates
        before adding more.
      </span>
    </div>
  );
}

// ─── Profiles ─────────────────────────────────────────────────────────────────

function ProfilesTab() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Profile | null>(null);
  const [usage, setUsage] = useState<SyncStorageUsage | null>(null);

  const refreshUsage = useCallback(() => {
    getStorageUsage().then(setUsage).catch(() => undefined);
  }, []);

  useEffect(() => {
    getProfiles()
      .then((p) => { setProfiles(p); setSelected(p[0] ?? null); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
    refreshUsage();
  }, [refreshUsage]);

  async function handleSave(profile: Profile) {
    const next = profiles.some((p) => p.id === profile.id)
      ? profiles.map((p) => (p.id === profile.id ? profile : p))
      : [...profiles, profile];
    setProfiles(next); setSelected(profile); setError(null);
    try {
      await saveProfiles(next);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
      refreshUsage();
    } catch (err) {
      setError(`Could not save: ${(err as Error).message}`);
    }
  }

  async function confirmDelete() {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    const next = profiles.filter((p) => p.id !== target.id);
    setProfiles(next); setSelected(next[0] ?? null);
    await saveProfiles(next);
    refreshUsage();
  }

  async function handleExport() {
    const json = await exportSyncData();
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'jobfill-export.json'; a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null); setNotice(null);
    try {
      const report = await importSyncData(await file.text());
      const u = await getProfiles();
      setProfiles(u); setSelected(u[0] ?? null);
      refreshUsage();
      const warn = report.warnings.length ? ` · ${report.warnings.length} field(s) repaired` : '';
      setNotice(`Imported ${report.profiles} profile(s) and ${report.coverTemplates} template(s)${warn}.`);
    } catch (err) {
      // inline banner instead of a system alert() dialog.
      setError(`Import failed: ${(err as Error).message}`);
    }
  }

  return (
    <div>
      <SectionHeader
        title="Profiles"
        description="Applicant details used for autofill. The more fields you complete, the more of a form JobFill can recognise."
      >
        <button type="button" onClick={handleExport} className="btn btn-secondary">
          <IconDownload className="size-4" />Export
        </button>
        <label className="btn btn-secondary btn-file cursor-pointer">
          <IconUpload className="size-4" />Import
          <input type="file" accept=".json,application/json" className="sr-only" onChange={handleImport} />
        </label>
        <button
          type="button"
          onClick={() => setSelected(createEmptyProfile({ label: `Profile ${profiles.length + 1}` }))}
          className="btn btn-secondary"
        >
          <IconPlus className="size-4" />New
        </button>
      </SectionHeader>

      <QuotaWarning usage={usage} />

      {error && <div className="mb-4"><ErrorBanner message={error} onDismiss={() => setError(null)} /></div>}
      {notice && (
        <p className="mb-4 text-base text-success" role="status">{notice}</p>
      )}

      {loading ? (
        <FormSkeleton />
      ) : (
        <>
          {profiles.length > 0 && (
            <div className="mb-6 flex flex-wrap gap-2">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelected(p)}
                  aria-current={selected?.id === p.id ? 'true' : undefined}
                  className={`pill ${selected?.id === p.id ? 'pill-active' : ''}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}

          {selected ? (
            <ProfileForm
              key={selected.id}
              profile={selected}
              onSave={handleSave}
              onDelete={
                profiles.some((p) => p.id === selected.id) ? () => setPendingDelete(selected) : undefined
              }
              saved={saved}
            />
          ) : (
            <EmptyState
              icon={<IconUser className="size-8" />}
              title="No profiles yet"
              description="A profile holds the answers JobFill types into application forms — name, contacts, salary expectation and a short summary."
              action={
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setSelected(createEmptyProfile({ label: 'My Profile' }))}
                >
                  <IconPlus className="size-4" />Create a profile
                </button>
              }
            />
          )}
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this profile?"
        description={
          pendingDelete
            ? `“${pendingDelete.label}” will be removed from every synced browser. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete profile"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function ProfileForm({
  profile: initial, onSave, onDelete, saved,
}: {
  profile: Profile;
  onSave: (p: Profile) => Promise<void>;
  onDelete?: () => void;
  saved: boolean;
}) {
  const [form, setForm] = useState(initial);
  const f = (field: keyof Profile) => (value: string) => setForm((x) => ({ ...x, [field]: value }));

  return (
    <form onSubmit={(e) => { e.preventDefault(); void onSave(form); }} className="flex flex-col gap-6">
      {/* .field-grid caps every control at one `minmax(280px, 1fr)`
          column, so nothing stretches to the full window width any more. */}
      <div className="field-grid">
        <Field label="Profile label" value={form.label} onChange={f('label')} required />
      </div>

      <div className="field-grid">
        <Field label="First name" value={form.firstName} onChange={f('firstName')} autoComplete="given-name" />
        <Field label="Last name" value={form.lastName} onChange={f('lastName')} autoComplete="family-name" />
        <Field label="Email" type="email" value={form.email} onChange={f('email')} autoComplete="email" />
        <Field label="Phone" type="tel" value={form.phone} onChange={f('phone')} placeholder="+420 777 000 000" autoComplete="tel" />
        <Field label="City" value={form.city} onChange={f('city')} autoComplete="address-level2" />
        <Field label="Salary expectation" value={form.salaryExpectation} onChange={f('salaryExpectation')} placeholder="e.g. 80 000 CZK / month" />
        <Field label="LinkedIn URL" value={form.linkedin} onChange={f('linkedin')} placeholder="https://linkedin.com/in/…" />
        <Field label="GitHub URL" value={form.github} onChange={f('github')} placeholder="https://github.com/…" />
        <Field label="Portfolio / Website" value={form.website} onChange={f('website')} placeholder="https://…" />
        <Field label="Availability / Notice" value={form.availability} onChange={f('availability')} placeholder="e.g. 2 weeks" />
        <Field label="Work permit / Citizenship" value={form.workPermit} onChange={f('workPermit')} placeholder="e.g. EU citizen" />
      </div>

      <TextArea
        label="About / Summary"
        value={form.about}
        onChange={f('about')}
        rows={5}
        placeholder="Used by AI to write motivation letters and answer open-ended application questions."
        hint="Two or three sentences work best — role, key skills, what you are looking for."
      />

      <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
        {onDelete ? (
          <button type="button" onClick={onDelete} className="btn btn-danger">
            <IconTrash className="size-4" />Delete profile
          </button>
        ) : <span />}
        <div className="flex items-center gap-3">
          <SavedFlag show={saved} />
          <button type="submit" className="btn btn-primary">Save changes</button>
        </div>
      </div>
    </form>
  );
}

// ─── Templates ────────────────────────────────────────────────────────────────

function TemplatesTab() {
  const [templates, setTemplates] = useState<CoverTemplate[]>([]);
  const [selected, setSelected] = useState<CoverTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CoverTemplate | null>(null);

  useEffect(() => {
    getCoverTemplates()
      .then((t) => { setTemplates(t); setSelected(t[0] ?? null); })
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(tmpl: CoverTemplate) {
    const next = templates.some((t) => t.id === tmpl.id)
      ? templates.map((t) => (t.id === tmpl.id ? tmpl : t))
      : [...templates, tmpl];
    setTemplates(next); setSelected(tmpl);
    await saveCoverTemplates(next);
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  }

  async function confirmDelete() {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    const next = templates.filter((t) => t.id !== target.id);
    setTemplates(next); setSelected(next[0] ?? null);
    await saveCoverTemplates(next);
  }

  const newTemplate = () =>
    setSelected({ id: crypto.randomUUID(), label: `Template ${templates.length + 1}`, body: '' });

  return (
    <div>
      <SectionHeader
        title="Cover letter templates"
        description={
          <>
            Placeholders are resolved at fill time:{' '}
            <code className="code-chip">{'{company}'}</code>{' '}
            <code className="code-chip">{'{position}'}</code>{' '}
            <code className="code-chip">{'{source}'}</code>
          </>
        }
      >
        <button type="button" onClick={newTemplate} className="btn btn-secondary">
          <IconPlus className="size-4" />New
        </button>
      </SectionHeader>

      {loading ? (
        <FormSkeleton />
      ) : (
        <>
          {templates.length > 0 && (
            <div className="mb-6 flex flex-wrap gap-2">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelected(t)}
                  aria-current={selected?.id === t.id ? 'true' : undefined}
                  className={`pill ${selected?.id === t.id ? 'pill-active' : ''}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {selected ? (
            <form
              className="flex flex-col gap-6"
              onSubmit={(e) => { e.preventDefault(); void handleSave(selected); }}
            >
              <div className="field-grid">
                <Field
                  label="Template name"
                  value={selected.label}
                  onChange={(v) => setSelected((t) => (t ? { ...t, label: v } : t))}
                  required
                />
              </div>
              <TextArea
                label="Body"
                value={selected.body}
                onChange={(v) => setSelected((t) => (t ? { ...t, body: v } : t))}
                rows={12}
                mono
                placeholder={'Dear {company} hiring team,\n\nI am excited to apply for the {position} role…'}
                hint="Kept to a 70-character measure so the text reads the way a recruiter will see it."
              />
              <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
                {templates.some((t) => t.id === selected.id) ? (
                  <button type="button" onClick={() => setPendingDelete(selected)} className="btn btn-danger">
                    <IconTrash className="size-4" />Delete template
                  </button>
                ) : <span />}
                <div className="flex items-center gap-3">
                  <SavedFlag show={saved} />
                  <button type="submit" className="btn btn-primary">Save changes</button>
                </div>
              </div>
            </form>
          ) : (
            /* Templates used to render nothing at all when empty. */
            <EmptyState
              icon={<IconFileText className="size-8" />}
              title="No templates yet"
              description="A template is the cover letter JobFill pastes into the application, with the company and position filled in automatically."
              action={
                <button type="button" className="btn btn-primary" onClick={newTemplate}>
                  <IconPlus className="size-4" />Create a template
                </button>
              }
            />
          )}
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this template?"
        description={pendingDelete ? `“${pendingDelete.label}” will be removed from every synced browser.` : undefined}
        confirmLabel="Delete template"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

// ─── API & Logging ────────────────────────────────────────────────────────────

const LOG_BACKENDS: { value: AppSettings['logBackend']; label: string }[] = [
  { value: 'off', label: 'Off — keep a local copy only' },
  { value: 'notion', label: 'Notion' },
  { value: 'sheets', label: 'Google Sheets' },
];

/**
 * The Groq credentials as they exist in `chrome.storage.local` — i.e. the ones
 * JobFill actually fills forms with.
 *
 * Kept next to the form state on purpose. A settings form that shows a pasted
 * key indistinguishably from a stored one is a trap: the first live run ended
 * with "I pasted the API key but nothing works", and the field looked identical
 * in both cases. Everything that can say "…but not saved" is derived from this.
 */
interface SavedGroq {
  key: string;
  model: string;
}

/** The Provider dropdown, in the order `PROVIDER_IDS` declares. */
const PROVIDER_OPTIONS: { value: ProviderId; label: string }[] = PROVIDER_IDS.map((id) => ({
  value: id,
  label: PROVIDERS[id].label,
}));

function ApiTab() {
  const [groqKey, setGroqKeyState] = useState('');
  const [groqModel, setGroqModelState] = useState('');
  const [provider, setProvider] = useState<ProviderId>('groq');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [hostGranted, setHostGranted] = useState(true);
  const [savedGroq, setSavedGroq] = useState<SavedGroq>({ key: '', model: '' });
  const [notionToken, setNotionToken] = useState('');
  const [notionDb, setNotionDb] = useState('');
  const [sheetsUrl, setSheetsUrl] = useState('');
  const [logBackend, setLogBackend] = useState<AppSettings['logBackend']>('off');
  const [llmClassification, setLlmClassification] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set by a rejected save, so an untouched empty field is not scolded on load. */
  const [sheetsBlockedSave, setSheetsBlockedSave] = useState(false);

  /**
   * Fingerprint of everything this form writes. Comparing it with the value
   * taken at load / after save is what turns "the button did nothing visible"
   * into an explicit "unsaved changes" — see {@link SavedGroq}.
   */
  const snapshot = JSON.stringify([
    groqKey.trim(), groqModel.trim(), provider, normalizeBaseUrl(customBaseUrl),
    notionToken.trim(), notionDb.trim(),
    sheetsUrl.trim(), logBackend, llmClassification,
  ]);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const dirty = savedSnapshot !== null && savedSnapshot !== snapshot;

  const providerInfo = providerOf(provider);
  const baseUrl = resolveBaseUrl(providerInfo, customBaseUrl);
  const baseUrlProblem = provider === 'custom' ? validateBaseUrl(customBaseUrl) : undefined;
  const showBaseUrlProblem = !!baseUrlProblem && customBaseUrl.trim() !== '';
  /**
   * The one check that pays for this whole section: a key's prefix says which
   * company issued it, so a mismatch is knowable at paste time. The alternative
   * — and what actually happened — is a valid key, a confident "invalid key"
   * from the wrong provider, and an hour spent re-copying it.
   */
  const keyMismatch = keyProviderMismatch(provider, groqKey);

  // `validateSheetsEndpoint` catches http://, a non-Apps-Script host and the
  // /dev URL (which only works for its author) *before* the value is stored.
  // Previously the first sign of a wrong URL was a failed application log.
  const sheetsProblem = validateSheetsEndpoint(sheetsUrl.trim());
  const showSheetsProblem =
    logBackend === 'sheets' && !!sheetsProblem && (sheetsUrl.trim() !== '' || sheetsBlockedSave);

  useEffect(() => {
    Promise.all([
      getGroqApiKey(), getGroqModel(), getLlmProvider(), getCustomBaseUrl(),
      getNotionCredentials(), getSheetsEndpoint(), getSettings(),
    ])
      .then(([key, model, storedProvider, storedBaseUrl, notion, sheets, settings]) => {
        if (key) setGroqKeyState(key);
        setGroqModelState(model);
        setProvider(storedProvider);
        setCustomBaseUrl(storedBaseUrl);
        setSavedGroq({ key: key ?? '', model });
        if (notion.notionToken) setNotionToken(notion.notionToken);
        if (notion.notionDatabaseId) setNotionDb(notion.notionDatabaseId);
        if (sheets) setSheetsUrl(sheets);
        setLogBackend(settings.logBackend);
        setLlmClassification(settings.llmFieldClassification);
        setSavedSnapshot(
          JSON.stringify([
            (key ?? '').trim(), model.trim(), storedProvider, normalizeBaseUrl(storedBaseUrl),
            (notion.notionToken ?? '').trim(),
            (notion.notionDatabaseId ?? '').trim(), (sheets ?? '').trim(),
            settings.logBackend, settings.llmFieldClassification,
          ]),
        );
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // A provider whose origin is not in `host_permissions` cannot be reached until
  // the user grants it. Checked on every change so the button appears next to the
  // choice that needs it, and disappears the moment it is answered.
  useEffect(() => {
    let live = true;
    void hasHostAccess(originPattern(baseUrl)).then((ok) => {
      if (live) setHostGranted(ok);
    });
    return () => {
      live = false;
    };
  }, [baseUrl]);

  /**
   * Ask for the origin from the click itself — Chrome refuses
   * `permissions.request()` without a user gesture, and an `await` before it
   * spends the one we have.
   */
  async function grantHostAccess() {
    setHostGranted(await requestHostAccess(originPattern(baseUrl)));
  }

  /**
   * Switching provider clears the model id, always.
   *
   * Model ids do not transfer: `llama-3.3-70b-versatile` is meaningless to
   * OpenRouter and `meta-llama/llama-3.3-70b-instruct` is meaningless to Groq, so
   * a field carried across produces a 404 that reads exactly like a broken key.
   * Empty means "the provider's default", which is always a working id, and the
   * placeholder shows which one that is.
   */
  function switchProvider(next: ProviderId) {
    setProvider(next);
    setGroqModelState('');
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Refuse to store an endpoint that cannot work. The message is rendered
    // under the field itself, where the fix is.
    if (logBackend === 'sheets' && sheetsProblem) {
      setSheetsBlockedSave(true);
      return;
    }
    setSheetsBlockedSave(false);

    // Same rule for the LLM endpoint: an unusable base URL is refused here
    // rather than stored and discovered on the next fill. `validateBaseUrl`
    // rejects http:// and anything that is not a URL, so nothing arbitrary
    // reaches `fetch`.
    if (provider === 'custom' && validateBaseUrl(customBaseUrl)) {
      setError('Fix the API URL before saving — see the message under the field.');
      return;
    }

    // Credentials are trimmed on the way in: a pasted token or URL almost always
    // carries a space, and it must not be the difference between a passing
    // "Check connection" and a failing log.
    const endpoint = sheetsUrl.trim();
    const token = notionToken.trim();
    const database = notionDb.trim();
    const key = groqKey.trim();
    const model = groqModel.trim();
    const llmUrl = normalizeBaseUrl(customBaseUrl);
    setSheetsUrl(endpoint); setNotionToken(token); setNotionDb(database);
    setGroqKeyState(key); setGroqModelState(model); setCustomBaseUrl(llmUrl);

    const classification = llmClassification && key !== '';

    try {
      await Promise.all([
        setGroqApiKey(key), setGroqModel(model),
        setLlmProvider(provider, llmUrl),
        setNotionCredentials(token, database),
        setSheetsEndpoint(endpoint),
        // Force the flag off when the key is gone: leaving it true would arm a
        // feature the user cannot see the switch for.
        saveSettings({ logBackend, llmFieldClassification: classification }),
      ]);
      // Only now are the stored values what the form shows, so the "unsaved"
      // notices are cleared from the same place that made them true.
      setSavedGroq({ key, model });
      setSavedSnapshot(
        JSON.stringify([key, model, provider, llmUrl, token, database, endpoint, logBackend, classification]),
      );
      setLlmClassification(classification);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(`Could not save: ${(err as Error).message}`);
    }
  }

  if (loading) return <FormSkeleton />;

  return (
    /* no `max-w-lg` here any more: all three tabs share the same
       `.content-column`, so switching tabs no longer resizes the layout. */
    <form className="flex flex-col gap-8" onSubmit={handleSave}>
      <section className="flex flex-col gap-4">
        <SectionHeader
          title="AI provider"
          description="Powers motivation letters, open-question answering and field recognition. Any OpenAI-compatible service will do."
        />
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        <div className="field-grid">
          <Select
            label="Provider"
            value={provider}
            onChange={switchProvider}
            options={PROVIDER_OPTIONS}
            hint={
              providerInfo.keysUrl ? (
                <>
                  Get a key at{' '}
                  <a
                    className="text-accent underline underline-offset-2"
                    href={providerInfo.keysUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {providerInfo.keysUrl.replace(/^https:\/\//, '')}
                  </a>
                </>
              ) : (
                'Any endpoint that serves POST /chat/completions the way OpenAI does.'
              )
            }
          />
          <Field
            label={provider === 'custom' ? 'API key' : `${providerInfo.label} API key`}
            type="password"
            value={groqKey}
            onChange={setGroqKeyState}
            placeholder={provider === 'groq' ? 'gsk_…' : provider === 'openrouter' ? 'sk-or-v1-…' : 'sk-…'}
            hint="Stored in this browser only — never synced to other devices."
          />
        </div>
        {/* The sentence the first live run needed and did not get. A prefix says
            which company issued a key, so this is answerable at paste time —
            before a round-trip that can only ever say "invalid key". */}
        {keyMismatch && (
          <p className="flex items-start gap-1.5 text-sm text-warning" role="alert">
            <IconAlert className="mt-0.5 size-4 shrink-0" />
            <span>{keyMismatch}</span>
          </p>
        )}
        {provider === 'custom' && (
          <div className="field-grid">
            <div>
              <Field
                label="API base URL"
                value={customBaseUrl}
                onChange={setCustomBaseUrl}
                placeholder="https://example.com/v1"
                hint="JobFill appends /chat/completions and /models. Must be https."
              />
              {showBaseUrlProblem && (
                <p className="mt-1.5 flex items-start gap-1.5 text-sm text-danger" role="alert">
                  <IconAlert className="mt-0.5 size-4 shrink-0" />
                  <span>{baseUrlProblem}</span>
                </p>
              )}
            </div>
          </div>
        )}
        <div className="field-grid">
          <Field
            label="Model"
            value={groqModel}
            onChange={setGroqModelState}
            placeholder={providerInfo.defaultModel || 'model id'}
            hint={providerInfo.modelHint}
          />
        </div>
        {/* Hosts other than Groq's are optional permissions, requested from this
            click so the browser has the user gesture it insists on. */}
        {!hostGranted && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <button type="button" className="btn btn-secondary" onClick={() => void grantHostAccess()}>
              Allow access to {originPattern(baseUrl) ?? 'this endpoint'}
            </button>
            <p className="text-sm text-fg-subtle">
              JobFill asks for one host at a time, so choosing {providerInfo.label} does not widen
              anything for anyone who does not.
            </p>
          </div>
        )}
        {/* The provider counterpart of NotionCheck: the key, the model and
            whether either of them is actually saved, answered separately. */}
        <GroqCheck
          apiKey={groqKey}
          model={groqModel}
          provider={provider}
          baseUrl={customBaseUrl}
          savedApiKey={savedGroq.key}
          savedModel={savedGroq.model}
          onPickModel={setGroqModelState}
        />
        {/* Opt-in, off by default. Gated on a key being present: without one the
            pass is a no-op, and a switch that does nothing is worse than a
            disabled switch that says why. */}
        <Toggle
          label="Identify unrecognized fields with AI"
          checked={llmClassification}
          disabled={groqKey.trim() === ''}
          disabledReason="Add an API key above to enable this."
          onChange={setLlmClassification}
          description={`When JobFill cannot recognise a field, it sends that field's attributes — name, label, placeholder — to ${providerInfo.inSentence}, together with the names of your profile entries. Never their values, and never the page content. The answer is a recipe such as “first name + last name”, so one box can take two entries at once; JobFill assembles the text here in the browser. It is not asked about consent boxes, employer or reference questions, money, or dates of birth, and anything it does fill is highlighted amber for you to check.`}
        />
      </section>

      <section className="flex flex-col gap-4 border-t border-line pt-8">
        <SectionHeader
          title="Application log"
          description="Mirror filled applications to Notion or Google Sheets. A local copy is always kept, and a failed send is retried once."
        />
        <div className="field-grid">
          <Select
            label="Backend"
            value={logBackend}
            onChange={setLogBackend}
            options={LOG_BACKENDS}
          />
        </div>
        {logBackend === 'notion' && (
          <>
            <div className="field-grid">
              <Field label="Integration token" type="password" value={notionToken} onChange={setNotionToken} placeholder="secret_…" />
              <Field
                label="Database ID"
                value={notionDb}
                onChange={setNotionDb}
                placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                hint="Share the database with your integration, then copy the ID from its URL."
              />
            </div>
            {/* The schema reader in shared/api/notion.ts, reachable at last. */}
            <NotionCheck token={notionToken} databaseId={notionDb} />
          </>
        )}
        {logBackend === 'sheets' && (
          <div className="field-grid">
            <div>
              <Field
                label="Apps Script Web App URL"
                value={sheetsUrl}
                onChange={setSheetsUrl}
                placeholder="https://script.google.com/macros/s/…/exec"
                hint="Deploy the Apps Script as a Web App with access set to “Anyone”."
              />
              {showSheetsProblem && (
                <p className="mt-1.5 flex items-start gap-1.5 text-sm text-danger" role="alert">
                  <IconAlert className="mt-0.5 size-4" />
                  <span>{sheetsProblem}</span>
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button type="submit" className="btn btn-primary">Save settings</button>
        <SavedFlag show={saved} />
        {/* Nothing on this page used to distinguish "typed" from "stored", so a
            pasted key that was never saved looked exactly like a working one.
            Hidden while the acknowledgement is on screen, so the two never
            contradict each other. */}
        {dirty && !saved && (
          <p className="flex items-center gap-1.5 text-base text-warning" role="status">
            <IconAlert className="size-4" />
            Unsaved changes — JobFill still uses the previously saved values.
          </p>
        )}
        {/* Without this, pressing Save with an already-visible field error looks
            like a dead button: the inline message does not change, so nothing
            is announced and nothing moves. */}
        {sheetsBlockedSave && showSheetsProblem && (
          <p className="flex items-center gap-1.5 text-base text-danger" role="alert">
            <IconAlert className="size-4" />
            Not saved — fix the Web App URL above.
          </p>
        )}
      </div>
    </form>
  );
}
