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
    <div className="min-h-screen bg-[#111] text-[#e8e8e8] font-sans">
      {/* Top bar */}
      <header className="border-b border-[#222] px-8 py-4 flex items-center justify-between">
        <span className="font-semibold tracking-tight text-[#e8e8e8]">JobFill — Settings</span>
        <span className="text-xs text-[#444]">v1.0</span>
      </header>

      <div className="flex max-w-5xl mx-auto">
        {/* Sidebar */}
        <nav className="w-52 shrink-0 pt-8 px-4 flex flex-col gap-0.5">
          {NAV.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`w-full text-left rounded-lg px-3 py-2 text-sm transition-colors ${
                tab === id
                  ? 'bg-[#1e1e1e] text-[#e8e8e8] font-medium'
                  : 'text-[#666] hover:text-[#aaa] hover:bg-[#191919]'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <main className="flex-1 pt-8 px-8 pb-16 max-w-2xl">
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
    setProfiles(next);
    setSelected(profile);
    await saveProfiles(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this profile?')) return;
    const next = profiles.filter((p) => p.id !== id);
    setProfiles(next);
    setSelected(next[0] ?? null);
    await saveProfiles(next);
  }

  async function handleExport() {
    const json = await exportSyncData();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'jobfill-export.json';
    a.click();
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importSyncData(await file.text());
      const updated = await getProfiles();
      setProfiles(updated);
      setSelected(updated[0] ?? null);
    } catch (err) {
      alert(`Import failed: ${(err as Error).message}`);
    }
    e.target.value = '';
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-[#e8e8e8]">Profiles</h2>
          <p className="text-xs text-[#555] mt-0.5">Your applicant profiles used for autofill</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExport} className="btn-secondary">Export</button>
          <label className="btn-secondary cursor-pointer">
            Import
            <input type="file" accept=".json" className="hidden" onChange={handleImport} />
          </label>
          <button
            onClick={() => {
              const p = createEmptyProfile({ label: `Profile ${profiles.length + 1}` });
              setSelected(p);
            }}
            className="btn-secondary text-[#e8e8e8] border-[#444]"
          >
            + New
          </button>
        </div>
      </div>

      {/* Profile tabs */}
      {profiles.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelected(p)}
              className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                selected?.id === p.id
                  ? 'bg-[#e8e8e8] text-[#111] border-transparent font-medium'
                  : 'border-[#333] text-[#666] hover:border-[#555] hover:text-[#aaa]'
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
  const set = (field: keyof Profile) => (value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => { e.preventDefault(); onSave(form); }}
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Profile label" value={form.label} onChange={set('label')} required />
        <Field label="First name" value={form.firstName} onChange={set('firstName')} autoComplete="given-name" />
        <Field label="Last name" value={form.lastName} onChange={set('lastName')} autoComplete="family-name" />
        <Field label="Email" type="email" value={form.email} onChange={set('email')} autoComplete="email" />
        <Field label="Phone" type="tel" value={form.phone} onChange={set('phone')} placeholder="+420 777 000 000" autoComplete="tel" />
        <Field label="City" value={form.city} onChange={set('city')} />
        <Field label="LinkedIn URL" value={form.linkedin} onChange={set('linkedin')} />
        <Field label="GitHub URL" value={form.github} onChange={set('github')} />
        <Field label="Portfolio / Website" value={form.website} onChange={set('website')} />
        <Field label="Salary expectation" value={form.salaryExpectation} onChange={set('salaryExpectation')} placeholder="e.g. 80 000 CZK / month" />
        <Field label="Availability / Notice" value={form.availability} onChange={set('availability')} placeholder="e.g. 2 weeks" />
        <Field label="Work permit / Citizenship" value={form.workPermit} onChange={set('workPermit')} placeholder="e.g. EU citizen" />
      </div>

      <div>
        <label className="label">About / Summary</label>
        <textarea
          value={form.about}
          onChange={(e) => setForm((f) => ({ ...f, about: e.target.value }))}
          rows={4}
          className="input resize-none leading-relaxed"
          placeholder="Used by AI when generating motivations and answering open questions"
        />
      </div>

      <div className="flex items-center justify-between pt-1">
        {onDelete ? (
          <button type="button" onClick={onDelete} className="text-xs text-[#e05b5b] hover:text-[#f07070] transition-colors">
            Delete profile
          </button>
        ) : <span />}
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-[#4a9]">Saved</span>}
          <button type="submit" className="btn-primary max-w-[120px]">Save</button>
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
    setTemplates(next);
    setSelected(tmpl);
    await saveCoverTemplates(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleDelete(id: string) {
    const next = templates.filter((t) => t.id !== id);
    setTemplates(next);
    setSelected(next[0] ?? null);
    await saveCoverTemplates(next);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-[#e8e8e8]">Cover Letter Templates</h2>
          <p className="text-xs text-[#555] mt-0.5">
            Placeholders:{' '}
            <code className="text-[#777] bg-[#1e1e1e] px-1 py-0.5 rounded text-[11px]">{'{company}'}</code>{' '}
            <code className="text-[#777] bg-[#1e1e1e] px-1 py-0.5 rounded text-[11px]">{'{position}'}</code>{' '}
            <code className="text-[#777] bg-[#1e1e1e] px-1 py-0.5 rounded text-[11px]">{'{source}'}</code>
          </p>
        </div>
        <button
          onClick={() => setSelected({ id: crypto.randomUUID(), label: 'New template', body: '' })}
          className="btn-secondary text-[#e8e8e8] border-[#444]"
        >
          + New
        </button>
      </div>

      {templates.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {templates.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t)}
              className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                selected?.id === t.id
                  ? 'bg-[#e8e8e8] text-[#111] border-transparent font-medium'
                  : 'border-[#333] text-[#666] hover:border-[#555] hover:text-[#aaa]'
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
              rows={10}
              className="input resize-none leading-relaxed"
              placeholder="Dear {company} hiring team,&#10;&#10;I'm excited to apply for the {position} role…"
            />
          </div>
          <div className="flex items-center justify-between">
            {templates.some((t) => t.id === selected.id) ? (
              <button type="button" onClick={() => handleDelete(selected.id)} className="text-xs text-[#e05b5b] hover:text-[#f07070] transition-colors">
                Delete
              </button>
            ) : <span />}
            <div className="flex items-center gap-3">
              {saved && <span className="text-xs text-[#4a9]">Saved</span>}
              <button type="submit" className="btn-primary max-w-[120px]">Save</button>
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
      setGroqApiKey(groqKey),
      setGroqModel(groqModel),
      setNotionCredentials(notionToken, notionDb),
      setSheetsEndpoint(sheetsUrl),
      saveSettings({ logBackend }),
    ]);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <form className="flex flex-col gap-8" onSubmit={handleSave}>
      {/* Groq */}
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-semibold text-[#e8e8e8]">AI — Groq</h2>
          <p className="text-xs text-[#555] mt-0.5">Powers motivation generation and open question answering</p>
        </div>
        <Field
          label="API Key"
          type="password"
          value={groqKey}
          onChange={setGroqKeyState}
          placeholder="gsk_…"
          hint="Stored locally — never synced to other devices"
        />
        <Field
          label="Model"
          value={groqModel}
          onChange={setGroqModelState}
          placeholder="llama-3.3-70b-versatile"
        />
      </section>

      <div className="divider" />

      {/* Logging */}
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-semibold text-[#e8e8e8]">Application Log</h2>
          <p className="text-xs text-[#555] mt-0.5">Log filled applications to Notion or Google Sheets</p>
        </div>

        <div>
          <label className="label">Backend</label>
          <select
            value={logBackend}
            onChange={(e) => setLogBackend(e.target.value as AppSettings['logBackend'])}
            className="input"
          >
            <option value="off">Off</option>
            <option value="notion">Notion</option>
            <option value="sheets">Google Sheets</option>
          </select>
        </div>

        {logBackend === 'notion' && (
          <>
            <Field label="Integration Token" type="password" value={notionToken} onChange={setNotionToken} placeholder="secret_…" />
            <Field label="Database ID" value={notionDb} onChange={setNotionDb} placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
          </>
        )}

        {logBackend === 'sheets' && (
          <Field label="Apps Script Web App URL" value={sheetsUrl} onChange={setSheetsUrl} placeholder="https://script.google.com/macros/s/…/exec" />
        )}
      </section>

      <div className="flex items-center gap-4 pt-2">
        <button type="submit" className="btn-primary max-w-[160px]">Save settings</button>
        {saved && <span className="text-xs text-[#4a9]">Saved</span>}
      </div>
    </form>
  );
}

// ─── Reusable Field ───────────────────────────────────────────────────────────

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
    <div>
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
      {hint && <p className="mt-1.5 text-xs text-[#555]">{hint}</p>}
    </div>
  );
}
