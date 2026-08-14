import type { ApplicationEntry } from '../types';
import { httpJson, HttpError } from './http';
import { RemoteLogError, toRemoteLogError } from './remoteLog';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const TIMEOUT_MS = 15_000;
/** Schema is re-read at most this often per service-worker lifetime. */
const SCHEMA_TTL_MS = 10 * 60_000;

// ─── Notion schema shapes (only what we read) ─────────────────────────────────

interface NotionPropertyDef {
  id?: string;
  name?: string;
  type?: string;
  status?: { options?: Array<{ name?: string }> };
  select?: { options?: Array<{ name?: string }> };
}

interface NotionDatabase {
  properties?: Record<string, NotionPropertyDef>;
}

// ─── Logical slots ────────────────────────────────────────────────────────────

export type NotionSlot = 'title' | 'company' | 'url' | 'date' | 'status' | 'profile';

interface SlotSpec {
  slot: NotionSlot;
  /** Property types that can hold this value, best first. */
  types: string[];
  /** Lower-cased name fragments that identify the property. */
  aliases: string[];
  required: boolean;
  /** Shown to the user when the slot cannot be mapped. */
  describe: string;
}

const SLOTS: SlotSpec[] = [
  {
    slot: 'title',
    types: ['title'],
    aliases: ['name', 'title', 'position', 'role', 'pozice', 'název'],
    required: true,
    describe: 'a Title property (any name) for the position',
  },
  {
    slot: 'company',
    types: ['rich_text', 'select', 'title'],
    aliases: ['company', 'employer', 'organisation', 'organization', 'firma', 'společnost'],
    required: false,
    describe: 'a Text or Select property named "Company"',
  },
  {
    slot: 'url',
    types: ['url', 'rich_text'],
    aliases: ['url', 'link', 'posting', 'odkaz'],
    required: false,
    describe: 'a URL property named "URL"',
  },
  {
    slot: 'date',
    types: ['date'],
    aliases: ['date', 'applied', 'datum', 'when'],
    required: false,
    describe: 'a Date property named "Date"',
  },
  {
    slot: 'status',
    types: ['select', 'status', 'rich_text'],
    aliases: ['status', 'stage', 'state', 'stav'],
    required: false,
    describe: 'a Select or Status property named "Status"',
  },
  {
    slot: 'profile',
    types: ['rich_text', 'select'],
    aliases: ['profile', 'profil', 'persona'],
    required: false,
    describe: 'a Text property named "Profile"',
  },
];

export interface NotionPropertyInfo {
  name: string;
  type: string;
  options?: string[];
}

export type NotionMapping = Partial<Record<NotionSlot, NotionPropertyInfo>>;

export interface NotionSchemaReport {
  /** Property chosen for each logical slot. `title` is present iff `usable`. */
  mapping: NotionMapping;
  /** Slots with no suitable property, in "describe" wording. */
  missing: string[];
  /** Everything the database offers — lets the options UI show a hint. */
  available: NotionPropertyInfo[];
  /** `false` when a required slot could not be mapped. */
  usable: boolean;
}

// ─── Schema discovery ─────────────────────────────────────────────────────────

const schemaCache = new Map<string, { at: number; report: NotionSchemaReport }>();

function propertyInfo(name: string, def: NotionPropertyDef): NotionPropertyInfo {
  const type = def.type ?? 'unknown';
  const rawOptions = def.status?.options ?? def.select?.options;
  const options = rawOptions
    ?.map((o) => o.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  return options?.length ? { name, type, options } : { name, type };
}

function pickProperty(spec: SlotSpec, props: NotionPropertyInfo[]): NotionPropertyInfo | undefined {
  // 1. Preferred type + name match, honouring the type preference order.
  for (const type of spec.types) {
    const byName = props.find(
      (p) => p.type === type && spec.aliases.some((a) => p.name.toLowerCase().includes(a)),
    );
    if (byName) return byName;
  }
  // 2. Same name match across all acceptable types at once, in property order.
  const looseName = props.find(
    (p) => spec.types.includes(p.type) && spec.aliases.some((a) => p.name.toLowerCase().includes(a)),
  );
  if (looseName) return looseName;
  // 3. Unique property of the preferred type (covers renamed columns, e.g. the
  //    mandatory Title property called "Job" or "Úloha").
  for (const type of spec.types) {
    const sameType = props.filter((p) => p.type === type);
    if (sameType.length === 1) return sameType[0];
  }
  return undefined;
}

export function buildMapping(properties: NotionPropertyInfo[]): NotionSchemaReport {
  const mapping: NotionMapping = {};
  const missing: string[] = [];
  const taken = new Set<string>();

  for (const spec of SLOTS) {
    const free = properties.filter((p) => !taken.has(p.name));
    const chosen = pickProperty(spec, free);
    if (chosen) {
      mapping[spec.slot] = chosen;
      taken.add(chosen.name);
    } else {
      missing.push(spec.describe);
    }
  }

  return {
    mapping,
    missing,
    available: properties,
    usable: Boolean(mapping.title),
  };
}

/**
 * Read the database schema and work out which property receives which value.
 * Called before every write (cached per worker lifetime) and by the options page.
 */
export async function inspectNotionDatabase(
  token: string,
  databaseId: string,
): Promise<NotionSchemaReport> {
  if (!token || !databaseId) {
    throw new RemoteLogError(
      'NOT_CONFIGURED',
      'Notion is selected as the logging backend, but the token or database ID is empty.',
    );
  }

  const cached = schemaCache.get(databaseId);
  if (cached && Date.now() - cached.at < SCHEMA_TTL_MS) return cached.report;

  let database: NotionDatabase;
  try {
    database = await httpJson<NotionDatabase>(
      `${NOTION_API}/databases/${encodeURIComponent(databaseId)}`,
      {
        service: 'Notion',
        method: 'GET',
        timeoutMs: TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
        },
      },
    );
  } catch (err) {
    throw toNotionError(err);
  }

  const properties = Object.entries(database.properties ?? {}).map(([name, def]) =>
    propertyInfo(def.name ?? name, def),
  );

  const report = buildMapping(properties);
  schemaCache.set(databaseId, { at: Date.now(), report });
  return report;
}

/** Test hook / settings "re-check" button: forget the cached schema. */
export function clearNotionSchemaCache(databaseId?: string): void {
  if (databaseId) schemaCache.delete(databaseId);
  else schemaCache.clear();
}

// ─── Value building ───────────────────────────────────────────────────────────

function richText(value: string) {
  return { rich_text: [{ text: { content: value.slice(0, 2000) } }] };
}

function valueForSlot(
  slot: NotionSlot,
  info: NotionPropertyInfo,
  entry: ApplicationEntry,
): Record<string, unknown> | undefined {
  const text = {
    title: entry.position || entry.company || 'Job application',
    company: entry.company,
    url: entry.url,
    date: entry.timestamp,
    status: entry.status,
    profile: entry.profileId,
  }[slot];

  if (!text) return undefined;

  switch (info.type) {
    case 'title':
      return { title: [{ text: { content: text.slice(0, 2000) } }] };
    case 'rich_text':
      return richText(text);
    case 'url':
      return { url: text };
    case 'date':
      return { date: { start: text } };
    case 'select':
      // Notion creates missing select options automatically.
      return { select: { name: text.slice(0, 100) } };
    case 'status': {
      // Status options CANNOT be created through the API — only reuse existing.
      const match = info.options?.find((o) => o.toLowerCase() === text.toLowerCase());
      return match ? { status: { name: match } } : undefined;
    }
    default:
      return undefined;
  }
}

export function buildNotionProperties(
  entry: ApplicationEntry,
  mapping: NotionMapping,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const spec of SLOTS) {
    const info = mapping[spec.slot];
    if (!info) continue;
    const value = valueForSlot(spec.slot, info, entry);
    if (value) properties[info.name] = value;
  }
  return properties;
}

// ─── Error translation ────────────────────────────────────────────────────────

/** Notion answers with `{ object: "error", code, message }`. */
function notionMessage(body?: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}

function toNotionError(err: unknown): RemoteLogError {
  if (err instanceof HttpError) {
    const detail = notionMessage(err.body);
    if (err.kind === 'UNAUTHORIZED' || err.kind === 'FORBIDDEN') {
      return new RemoteLogError(
        'UNAUTHORIZED',
        'Notion rejected the token. Check the integration secret and share the database with the integration (••• → Connections).',
        detail,
      );
    }
    if (err.kind === 'NOT_FOUND') {
      return new RemoteLogError(
        'NOT_FOUND',
        'Notion could not find that database. Check the database ID and that the integration has access to it.',
        detail,
      );
    }
    if (err.kind === 'BAD_REQUEST') {
      return new RemoteLogError(
        'SCHEMA_MISMATCH',
        detail
          ? `Notion rejected the entry: ${detail}`
          : 'Notion rejected the entry — the database properties do not match what JobFill sends.',
        err.body,
      );
    }
  }
  return toRemoteLogError(err, 'Notion');
}

// ─── Public write path ────────────────────────────────────────────────────────

/**
 * Append an entry to a Notion database. Property names and types are discovered
 * from the database itself rather than hard-coded, so any reasonable board works
 * and an unusable one produces an explanation instead of a raw 400.
 */
export async function logToNotion(
  entry: ApplicationEntry,
  token: string,
  databaseId: string,
): Promise<void> {
  const report = await inspectNotionDatabase(token, databaseId);

  if (!report.usable) {
    throw new RemoteLogError(
      'SCHEMA_MISMATCH',
      `The Notion database has no Title property, so JobFill cannot create pages in it. Add ${report.missing.join(', ')}.`,
      `available: ${report.available.map((p) => `${p.name}:${p.type}`).join(', ')}`,
    );
  }

  const properties = buildNotionProperties(entry, report.mapping);

  try {
    await httpJson<unknown>(`${NOTION_API}/pages`, {
      service: 'Notion',
      method: 'POST',
      timeoutMs: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
      },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties,
      }),
    });
  } catch (err) {
    // A rejected write usually means the cached schema is stale.
    clearNotionSchemaCache(databaseId);
    throw toNotionError(err);
  }
}

/**
 * Human-readable summary for the options page: which property gets what, and
 * what is missing. Never throws for a merely incomplete schema.
 */
export function describeMapping(report: NotionSchemaReport): string[] {
  const lines = SLOTS.map((spec) => {
    const info = report.mapping[spec.slot];
    return info
      ? `${spec.slot} → "${info.name}" (${info.type})`
      : `${spec.slot} → not mapped — add ${spec.describe}`;
  });
  return lines;
}
