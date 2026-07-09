import { useState, useEffect } from 'react';
import type { Profile, CoverTemplate, AppSettings } from '../../shared/types';
import { createEmptyProfile } from '../../shared/types';
import {
  getProfiles, saveProfiles, getCoverTemplates, saveCoverTemplates,
  getSettings, saveSettings, exportSyncData, importSyncData,
} from '../../shared/storage/sync';
import {
  getGroqApiKey, setGroqApiKey, getGroqModel, setGroqModel,
  getNotionCredentials, setNotionCredentials, getSheetsEndpoint, setSheetsEndpoint,
} from '../../shared/storage/local';

type Tab = 'profiles' | 'templates' | 'api';
const NAV: { id: Tab; label: string }[] = [
  { id: 'profiles', label: 'Profiles' },
  { id: 'templates', label: 'Templates' },
  { id: 'api', label: 'API & Logging' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('profiles');

  return (
    <div className="min-h-screen bg-[#1e1e1e] text-[#cccccc] font-sans flex flex-col">
      {/* Header */}
      <header className="bg-[#252526] border-b border-[#3e3e42] px-6 py-3 flex items-center justify-between shrink-0">
        <span className="font-semibold text-[#e8e8e8] tracking-tight">JobFill</span>
        <a
          href="https://www.instagram.com/dias_nur420/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[#767676] hover:text-[#aaa] transition-colors"
        >
          @dias_nur420
        </a>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-44 shrink-0 bg-[#252526] border-r border-[#3e3e42] pt-5 px-2 flex flex-col gap-0.5">
          {NAV.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                tab === id
                  ? 'bg-[#37373d] text-[#e8e8e8]'
                  : 'text-[#858585] hover:text-[#cccccc] hover:bg-[#2d2d2d]'
              }`}
            >
              {label}
            </button>
          ))}
        </aside>

        {/* Main content — fills the rest of the page width */}
        <main className="flex-1 overflow-y-auto p-8">
          {tab === 'profiles' && <ProfilesTab />}
          {tab === 'templates' && <TemplatesTab />}
          {tab === 'api' && <ApiTab />}
        </main>
      </div>
    </div>
  );
}

// ─── Profiles ─────────────────────────────────────────────────────────────────

function ProfilesTab() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<Profile | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getProfiles().then((p) => { setProfiles(p); setSelected(p[0] ?? null); });
  }, []);

  async function handleSave(profile: Profile) {
    const next = profiles.some((p) => p.id === profile.id)
      ? profiles.map((p) => (p.id === profile.id ? profile : p))
      : [...profiles, profile];
    setProfiles(next); setSelected(profile);
    await saveProfiles(next);
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this profile?')) return;
    const next = profiles.filter((p) => p.id !== id);
    setProfiles(next); setSelected(next[0] ?? null);
    await saveProfiles(next);
  }

  async function handleExport() {
    const json = await exportSyncData();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'jobfill-export.json'; a.click();
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      await importSyncData(await file.text());
      const u = await getProfiles(); setProfiles(u); setSelected(u[0] ?? null);
    } catch (err) { alert(`Import failed: ${(err as Error).message}`); }
    e.target.value = '';
  }

  return (
    <div className="max-w-3xl">
      {/* Section header */}
      <div className="mb-5">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <p className="section-title">Profiles</p>
          <div className="flex items-center gap-2">
            <button onClick={handleExport} className="btn-secondary">Export</button>
            <label className="btn-secondary cursor-pointer">
              Import
              <input type="file" accept=".json" className="hidden" onChange={handleImport} />
            </label>
            <button
              onClick={() => setSelected(createEmptyProfile({ label: `Profile ${profiles.length + 1}` }))}
              className="btn-secondary"
            >+ New</button>
          </div>
        </div>
        <p className="section-desc">Applicant profiles used for autofill. Add fields for better detection coverage.</p>
      </div>

      {/* Profile switcher pills */}
      {profiles.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelected(p)}
              className={`px-3.5 py-1.5 rounded-full text-[13px] border transition-colors ${
                selected?.id === p.id
                  ? 'border-[#0e639c] bg-[#0e639c] text-white'
                  : 'border-[#505050] text-[#858585] hover:border-[#777] hover:text-[#cccccc]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <ProfileForm
          key={selected.id}
          profile={selected}
          onSave={handleSave}
          onDelete={profiles.some((p) => p.id === selected.id) ? () => handleDelete(selected.id) : undefined}
          saved={saved}
        />
      )}
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
    <form onSubmit={(e) => { e.preventDefault(); onSave(form); }} className="flex flex-col gap-5">
      {/* Row 1: label (full width) */}
      <Field label="Profile label" value={form.label} onChange={f('label')} required />

      {/* Row 2+: 2-col grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        <Field label="First name"           value={form.firstName}         onChange={f('firstName')}         autoComplete="given-name" />
        <Field label="Last name"            value={form.lastName}          onChange={f('lastName')}          autoComplete="family-name" />
        <Field label="Email"  type="email"  value={form.email}             onChange={f('email')}             autoComplete="email" />
        <Field label="Phone"  type="tel"    value={form.phone}             onChange={f('phone')}             placeholder="+420 777 000 000" autoComplete="tel" />
        <Field label="City"                 value={form.city}              onChange={f('city')} />
        <Field label="Salary expectation"  value={form.salaryExpectation} onChange={f('salaryExpectation')} placeholder="e.g. 80 000 CZK / month" />
        <Field label="LinkedIn URL"         value={form.linkedin}          onChange={f('linkedin')} />
        <Field label="GitHub URL"           value={form.github}            onChange={f('github')} />
        <Field label="Portfolio / Website" value={form.website}           onChange={f('website')} />
        <Field label="Availability / Notice" value={form.availability}    onChange={f('availability')}      placeholder="e.g. 2 weeks" />
        <Field label="Work permit / Citizenship" value={form.workPermit}  onChange={f('workPermit')}        placeholder="e.g. EU citizen" />
      </div>

      <div>
        <label className="label">About / Summary</label>
        <textarea
          value={form.about}
          onChange={(e) => setForm((x) => ({ ...x, about: e.target.value }))}
          rows={5}
          className="input resize-y leading-relaxed"
          placeholder="Used by AI for motivation generation and answering open-ended application questions"
        />
      </div>

      <div className="flex items-center justify-between pt-1 border-t border-[#3e3e42]">
        {onDelete ? (
          <button type="button" onClick={onDelete} className="text-[13px] text-[#cc6666] hover:text-[#e07070] transition-colors">
            Delete profile
          </button>
        ) : <span />}
        <div className="flex items-center gap-3">
          {saved && <span className="text-[13px] text-[#4ec9b0]">Saved</span>}
          <button type="submit" className="btn-primary">Save changes</button>
        </div>
      </div>
    </form>
  );
}

// ─── Templates ────────────────────────────────────────────────────────────────

function TemplatesTab() {
  const [templates, setTemplates] = useState<CoverTemplate[]>([]);
  const [selected, setSelected] = useState<CoverTemplate | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getCoverTemplates().then((t) => { setTemplates(t); setSelected(t[0] ?? null); });
  }, []);

  async function handleSave(tmpl: CoverTemplate) {
    const next = templates.some((t) => t.id === tmpl.id)
      ? templates.map((t) => (t.id === tmpl.id ? tmpl : t))
      : [...templates, tmpl];
    setTemplates(next); setSelected(tmpl);
    await saveCoverTemplates(next);
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  }

  async function handleDelete(id: string) {
    const next = templates.filter((t) => t.id !== id);
    setTemplates(next); setSelected(next[0] ?? null);
    await saveCoverTemplates(next);
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-5">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <p className="section-title">Cover Letter Templates</p>
          <button
            onClick={() => setSelected({ id: crypto.randomUUID(), label: 'New template', body: '' })}
            className="btn-secondary"
          >+ New</button>
        </div>
        <p className="section-desc">
          Placeholders auto-resolved at fill time:{' '}
          <code className="bg-[#2d2d2d] px-1.5 py-0.5 rounded text-[#ce9178] text-[12px]">{'{company}'}</code>{' '}
          <code className="bg-[#2d2d2d] px-1.5 py-0.5 rounded text-[#ce9178] text-[12px]">{'{position}'}</code>{' '}
          <code className="bg-[#2d2d2d] px-1.5 py-0.5 rounded text-[#ce9178] text-[12px]">{'{source}'}</code>
        </p>
      </div>

      {templates.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {templates.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t)}
              className={`px-3.5 py-1.5 rounded-full text-[13px] border transition-colors ${
                selected?.id === t.id
                  ? 'border-[#0e639c] bg-[#0e639c] text-white'
                  : 'border-[#505050] text-[#858585] hover:border-[#777] hover:text-[#cccccc]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => { e.preventDefault(); handleSave(selected); }}
        >
          <Field
            label="Template name"
            value={selected.label}
            onChange={(v) => setSelected((t) => t ? { ...t, label: v } : t)}
            required
          />
          <div>
            <label className="label">Body</label>
            <textarea
              value={selected.body}
              onChange={(e) => setSelected((t) => t ? { ...t, body: e.target.value } : t)}
              rows={12}
              className="input resize-y leading-relaxed font-mono text-[13px]"
              placeholder={'Dear {company} hiring team,\n\nI\'m excited to apply for the {position} role…'}
            />
          </div>
          <div className="flex items-center justify-between pt-1 border-t border-[#3e3e42]">
            {templates.some((t) => t.id === selected.id) ? (
              <button type="button" onClick={() => handleDelete(selected.id)} className="text-[13px] text-[#cc6666] hover:text-[#e07070] transition-colors">
                Delete template
              </button>
            ) : <span />}
            <div className="flex items-center gap-3">
              {saved && <span className="text-[13px] text-[#4ec9b0]">Saved</span>}
              <button type="submit" className="btn-primary">Save changes</button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

// ─── API & Logging ────────────────────────────────────────────────────────────

function ApiTab() {
  const [groqKey, setGroqKeyState] = useState('');
  const [groqModel, setGroqModelState] = useState('llama-3.3-70b-versatile');
  const [notionToken, setNotionToken] = useState('');
  const [notionDb, setNotionDb] = useState('');
  const [sheetsUrl, setSheetsUrl] = useState('');
  const [logBackend, setLogBackend] = useState<AppSettings['logBackend']>('off');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([getGroqApiKey(), getGroqModel(), getNotionCredentials(), getSheetsEndpoint(), getSettings()])
      .then(([key, model, notion, sheets, settings]) => {
        if (key) setGroqKeyState(key);
        setGroqModelState(model);
        if (notion.notionToken) setNotionToken(notion.notionToken);
        if (notion.notionDatabaseId) setNotionDb(notion.notionDatabaseId);
        if (sheets) setSheetsUrl(sheets);
        setLogBackend(settings.logBackend);
      });
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await Promise.all([
      setGroqApiKey(groqKey), setGroqModel(groqModel),
      setNotionCredentials(notionToken, notionDb),
      setSheetsEndpoint(sheetsUrl), saveSettings({ logBackend }),
    ]);
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  }

  return (
    <form className="max-w-xl flex flex-col gap-8" onSubmit={handleSave}>
      {/* Groq */}
      <section className="flex flex-col gap-4">
        <div>
          <p className="section-title">AI — Groq</p>
          <p className="section-desc">Powers motivation generation and open-question answering</p>
        </div>
        <Field
          label="API Key"
          type="password"
          value={groqKey}
          onChange={setGroqKeyState}
          placeholder="gsk_…"
          hint="Stored locally in this browser only — never synced"
        />
        <Field
          label="Model"
          value={groqModel}
          onChange={setGroqModelState}
          placeholder="llama-3.3-70b-versatile"
        />
      </section>

      <div className="border-t border-[#3e3e42]" />

      {/* Logging */}
      <section className="flex flex-col gap-4">
        <div>
          <p className="section-title">Application Log</p>
          <p className="section-desc">Sync filled applications to Notion or Google Sheets. A local copy is always kept.</p>
        </div>
        <div>
          <label className="label">Backend</label>
          <select value={logBackend} onChange={(e) => setLogBackend(e.target.value as AppSettings['logBackend'])} className="input">
            <option value="off">Off — local only</option>
            <option value="notion">Notion</option>
            <option value="sheets">Google Sheets</option>
          </select>
        </div>
        {logBackend === 'notion' && (
          <div className="flex flex-col gap-4">
            <Field label="Integration Token" type="password" value={notionToken} onChange={setNotionToken} placeholder="secret_…" />
            <Field label="Database ID" value={notionDb} onChange={setNotionDb} placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
          </div>
        )}
        {logBackend === 'sheets' && (
          <Field label="Apps Script Web App URL" value={sheetsUrl} onChange={setSheetsUrl} placeholder="https://script.google.com/macros/s/…/exec" />
        )}
      </section>

      <div className="flex items-center gap-4">
        <button type="submit" className="btn-primary">Save settings</button>
        {saved && <span className="text-[13px] text-[#4ec9b0]">Saved</span>}
      </div>
    </form>
  );
}

// ─── Shared Field component ───────────────────────────────────────────────────

function Field({
  label, value, onChange, type = 'text', placeholder, required, hint, autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  autoComplete?: string;
}) {
  return (
    <div className="flex flex-col gap-0">
      <label className="label">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete ?? 'off'}
        className="input"
      />
      {hint && <p className="mt-1.5 text-[12px] text-[#767676]">{hint}</p>}
    </div>
  );
}
