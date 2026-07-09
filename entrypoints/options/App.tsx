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

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('profiles');

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center gap-4">
        <h1 className="text-lg font-bold">
          <span className="text-blue-600">Job</span>Fill — Settings
        </h1>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <nav className="w-48 bg-white border-r border-slate-200 min-h-screen pt-4 px-2">
          {(['profiles', 'templates', 'api'] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`w-full text-left rounded-lg px-3 py-2 text-sm mb-1 transition-colors ${
                activeTab === tab
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </nav>

        {/* Content */}
        <main className="flex-1 p-6 max-w-2xl">
          {activeTab === 'profiles' && <ProfilesTab />}
          {activeTab === 'templates' && <TemplatesTab />}
          {activeTab === 'api' && <ApiTab />}
        </main>
      </div>
    </div>
  );
}

const TAB_LABELS: Record<Tab, string> = {
  profiles: '👤 Profiles',
  templates: '📄 Templates',
  api: '🔑 API & Logging',
};

// ─── Profiles Tab ─────────────────────────────────────────────────────────────

function ProfilesTab() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<Profile | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getProfiles().then((p) => {
      setProfiles(p);
      setSelected(p[0] ?? null);
    });
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
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'jobfill-export.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      await importSyncData(text);
      const updated = await getProfiles();
      setProfiles(updated);
      setSelected(updated[0] ?? null);
      alert('Profiles imported successfully.');
    } catch (err) {
      alert(`Import failed: ${(err as Error).message}`);
    }
    e.target.value = '';
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-800">Profiles</h2>
        <div className="flex gap-2">
          <button
            onClick={() => {
              const p = createEmptyProfile({ label: `Profile ${profiles.length + 1}` });
              setSelected(p);
            }}
            className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-100"
          >
            + New
          </button>
          <button onClick={handleExport} className="btn-outline text-xs">Export</button>
          <label className="btn-outline text-xs cursor-pointer">
            Import
            <input type="file" accept=".json" className="hidden" onChange={handleImport} />
          </label>
        </div>
      </div>

      {/* Profile list */}
      {profiles.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelected(p)}
              className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                selected?.id === p.id
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'border-slate-200 text-slate-600 hover:border-blue-300'
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
  profile: initial,
  onSave,
  onDelete,
  saved,
}: {
  profile: Profile;
  onSave: (p: Profile) => Promise<void>;
  onDelete?: () => void;
  saved: boolean;
}) {
  const [form, setForm] = useState(initial);

  const set = (field: keyof Profile, value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  return (
    <form
      className="bg-white rounded-xl border border-slate-200 p-5 space-y-4"
      onSubmit={(e) => { e.preventDefault(); onSave(form); }}
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Label" value={form.label} onChange={(v) => set('label', v)} required />
        <Field label="First name" value={form.firstName} onChange={(v) => set('firstName', v)} />
        <Field label="Last name" value={form.lastName} onChange={(v) => set('lastName', v)} />
        <Field label="Email" type="email" value={form.email} onChange={(v) => set('email', v)} />
        <Field label="Phone" type="tel" value={form.phone} onChange={(v) => set('phone', v)} placeholder="+420 777 000 000" />
        <Field label="City" value={form.city} onChange={(v) => set('city', v)} />
        <Field label="LinkedIn URL" value={form.linkedin} onChange={(v) => set('linkedin', v)} />
        <Field label="GitHub URL" value={form.github} onChange={(v) => set('github', v)} />
        <Field label="Portfolio / Website" value={form.website} onChange={(v) => set('website', v)} />
        <Field label="Salary expectation" value={form.salaryExpectation} onChange={(v) => set('salaryExpectation', v)} placeholder="e.g. 80 000 CZK" />
        <Field label="Availability / Notice" value={form.availability} onChange={(v) => set('availability', v)} placeholder="e.g. 2 weeks" />
        <Field label="Work permit / Citizenship" value={form.workPermit} onChange={(v) => set('workPermit', v)} placeholder="e.g. EU citizen" />
      </div>

      <div>
        <label className="label">About / Summary</label>
        <textarea
          value={form.about}
          onChange={(e) => set('about', e.target.value)}
          rows={4}
          className="input resize-none"
          placeholder="Short professional bio used for AI-generated motivations"
        />
      </div>

      <div className="flex items-center justify-between pt-2">
        {onDelete && (
          <button type="button" onClick={onDelete} className="text-xs text-red-500 hover:text-red-700">
            Delete profile
          </button>
        )}
        <div className="flex items-center gap-3 ml-auto">
          {saved && <span className="text-xs text-green-600">Saved ✓</span>}
          <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            Save
          </button>
        </div>
      </div>
    </form>
  );
}

// ─── Templates Tab ────────────────────────────────────────────────────────────

function TemplatesTab() {
  const [templates, setTemplates] = useState<CoverTemplate[]>([]);
  const [selected, setSelected] = useState<CoverTemplate | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getCoverTemplates().then((t) => {
      setTemplates(t);
      setSelected(t[0] ?? null);
    });
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Cover Letter Templates</h2>
        <button
          onClick={() => setSelected({ id: crypto.randomUUID(), label: 'New template', body: '' })}
          className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-100"
        >
          + New
        </button>
      </div>
      <p className="text-xs text-slate-400">
        Use placeholders: <code className="bg-slate-100 px-1 rounded">{'{company}'}</code>,{' '}
        <code className="bg-slate-100 px-1 rounded">{'{position}'}</code>,{' '}
        <code className="bg-slate-100 px-1 rounded">{'{source}'}</code>
      </p>

      <div className="flex gap-2 flex-wrap">
        {templates.map((t) => (
          <button
            key={t.id}
            onClick={() => setSelected(t)}
            className={`rounded-full px-3 py-1 text-xs font-medium border ${
              selected?.id === t.id ? 'bg-blue-600 text-white border-blue-600' : 'border-slate-200 text-slate-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {selected && (
        <form
          className="bg-white rounded-xl border border-slate-200 p-5 space-y-4"
          onSubmit={(e) => { e.preventDefault(); handleSave(selected); }}
        >
          <Field label="Template name" value={selected.label} onChange={(v) => setSelected((t) => t ? { ...t, label: v } : t)} required />
          <div>
            <label className="label">Body</label>
            <textarea
              value={selected.body}
              onChange={(e) => setSelected((t) => t ? { ...t, body: e.target.value } : t)}
              rows={8}
              className="input resize-none"
              placeholder="Dear {company} team, I am excited to apply for the {position} role…"
            />
          </div>
          <div className="flex justify-between items-center">
            {templates.some((t) => t.id === selected.id) && (
              <button type="button" onClick={() => handleDelete(selected.id)} className="text-xs text-red-500">Delete</button>
            )}
            <div className="flex items-center gap-3 ml-auto">
              {saved && <span className="text-xs text-green-600">Saved ✓</span>}
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Save</button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

// ─── API & Logging Tab ────────────────────────────────────────────────────────

function ApiTab() {
  const [groqKey, setGroqKeyState] = useState('');
  const [groqModel, setGroqModelState] = useState('llama-3.3-70b-versatile');
  const [notionToken, setNotionToken] = useState('');
  const [notionDb, setNotionDb] = useState('');
  const [sheetsUrl, setSheetsUrl] = useState('');
  const [logBackend, setLogBackend] = useState<AppSettings['logBackend']>('off');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      getGroqApiKey(), getGroqModel(),
      getNotionCredentials(), getSheetsEndpoint(),
      getSettings(),
    ]).then(([key, model, notion, sheets, settings]) => {
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
    <form className="space-y-6" onSubmit={handleSave}>
      <section className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <h3 className="font-semibold text-sm">AI (Groq)</h3>
        <Field
          label="API Key"
          type="password"
          value={groqKey}
          onChange={setGroqKeyState}
          placeholder="gsk_…"
          hint="Stored locally — never synced."
        />
        <Field
          label="Model"
          value={groqModel}
          onChange={setGroqModelState}
          placeholder="llama-3.3-70b-versatile"
        />
      </section>

      <section className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <h3 className="font-semibold text-sm">Application Log</h3>
        <div>
          <label className="label">Backend</label>
          <select value={logBackend} onChange={(e) => setLogBackend(e.target.value as AppSettings['logBackend'])} className="input">
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

      <div className="flex items-center gap-3">
        {saved && <span className="text-sm text-green-600">Saved ✓</span>}
        <button type="submit" className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700">
          Save settings
        </button>
      </div>
    </form>
  );
}

// ─── Reusable Field ───────────────────────────────────────────────────────────

function Field({
  label, value, onChange, type = 'text', placeholder, required, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  hint?: string;
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
        className="input"
        autoComplete="off"
      />
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}
