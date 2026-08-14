import { useCallback, useEffect, useRef, useState } from 'react';
import { describeMapping, type NotionSchemaReport, type NotionSlot } from '../../shared/api/notion';
import { checkNotionConnection, type NotionCheckResult } from './notionConnection';
import { ErrorBanner } from './Feedback';
import { IconAlert, IconBolt, IconCheck, Spinner } from './Icons';

/**
 * P1-13 — "Check connection" for the Notion backend.
 *
 * Until this existed, `inspectNotionDatabase` / `describeMapping` were written,
 * tested and unreachable: the user pasted a token and a database id blind and
 * found out about a schema mismatch only when an application failed to log.
 * The button reads the schema and renders the *same* mapping the write path
 * will use — one line per value JobFill wants to store.
 */

/** Separator produced by `describeMapping`: `slot → "Name" (type)`. */
const ARROW = ' → ';

/**
 * The one slot whose absence makes the database unusable (`report.usable` is
 * `Boolean(mapping.title)`), so its row is an error rather than a suggestion.
 * Typed as `NotionSlot` so a rename in shared/api/notion.ts breaks the build
 * here instead of silently downgrading the warning.
 */
const REQUIRED_SLOT: NotionSlot = 'title';

interface MappingRow {
  line: string;
  slot: string;
  detail: string;
  mapped: boolean;
}

function parseMappingLine(line: string): MappingRow {
  const at = line.indexOf(ARROW);
  const slot = at === -1 ? '' : line.slice(0, at);
  const detail = at === -1 ? line : line.slice(at + ARROW.length);
  return { line, slot, detail, mapped: !detail.startsWith('not mapped') };
}

function describeProperty(p: NotionSchemaReport['available'][number]): string {
  return `${p.name} (${p.type})`;
}

function MappingCard({ report }: { report: NotionSchemaReport }) {
  const rows = describeMapping(report).map(parseMappingLine);
  const mapped = rows.filter((r) => r.mapped).length;

  return (
    <div className="card flex flex-col gap-3">
      <p className="flex items-start gap-2 font-medium text-fg">
        {report.usable ? (
          <IconCheck className="mt-0.5 size-4 text-conf-high" />
        ) : (
          <IconAlert className="mt-0.5 size-4 text-danger" />
        )}
        <span>
          {report.usable
            ? `Connected — ${mapped} of ${rows.length} values will be logged.`
            : 'Connected, but JobFill cannot create pages in this database.'}
        </span>
      </p>

      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <li key={row.line} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {row.mapped ? (
              <IconCheck className="size-4 text-conf-high" />
            ) : (
              <IconAlert
                className={`size-4 ${row.slot === REQUIRED_SLOT ? 'text-danger' : 'text-conf-medium'}`}
              />
            )}
            <code className="code-chip">{row.slot}</code>
            <span className={row.mapped ? 'text-fg' : 'text-fg-muted'}>{row.detail}</span>
          </li>
        ))}
      </ul>

      {report.missing.length > 0 && report.usable && (
        <p className="text-sm text-fg-subtle">
          Unmapped values are skipped rather than failing the write — add the property in Notion,
          then check again.
        </p>
      )}

      <p className="border-t border-line pt-3 text-sm text-fg-subtle">
        {report.available.length > 0
          ? `Properties in this database: ${report.available.map(describeProperty).join(', ')}.`
          : 'This database has no properties at all.'}
      </p>
    </div>
  );
}

type Phase =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'done'; result: NotionCheckResult };

export function NotionCheck({ token, databaseId }: { token: string; databaseId: string }) {
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  // Trimmed here as well as on save: a pasted token usually brings a space with
  // it, and a check that passes must be a check of what gets stored.
  const cleanToken = token.trim();
  const cleanDatabaseId = databaseId.trim();
  const runId = useRef(0);

  // A result describes exactly one pair of credentials. Editing either makes it
  // stale, and a stale "Connected" is worse than no answer at all.
  useEffect(() => {
    runId.current += 1;
    setPhase({ status: 'idle' });
  }, [cleanToken, cleanDatabaseId]);

  const run = useCallback(async (busy: boolean) => {
    if (busy) return;
    const id = ++runId.current;
    setPhase({ status: 'checking' });
    const result = await checkNotionConnection(cleanToken, cleanDatabaseId);
    // The credentials changed while the request was in flight — drop the answer.
    if (runId.current === id) setPhase({ status: 'done', result });
  }, [cleanToken, cleanDatabaseId]);

  const checking = phase.status === 'checking';
  const result = phase.status === 'done' ? phase.result : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* `aria-disabled`, not `disabled`: a control that is disabled mid-press
            drops the keyboard focus to <body>, so the user loses their place
            for the whole request and never sees the focus ring return. */}
        <button
          type="button"
          onClick={() => void run(checking)}
          aria-disabled={checking}
          aria-busy={checking}
          className="btn btn-secondary"
        >
          {checking ? (
            <>
              <Spinner className="size-4" />
              Checking…
            </>
          ) : (
            <>
              <IconBolt className="size-4" />
              Check connection
            </>
          )}
        </button>
        <p className="text-sm text-fg-subtle">
          Reads the database schema and shows which property receives which value. Nothing is
          written to Notion.
        </p>
      </div>

      {/* `ErrorBanner` is a role="alert" of its own, so it stays outside the
          polite region below — nested live regions announce twice. */}
      {result && !result.ok && <ErrorBanner message={result.message} />}

      {/* A reachable database with an unusable schema is not a transport error:
          it comes back `ok` and the card explains it, headline included. */}
      <div aria-live="polite">{result?.ok && <MappingCard report={result.report} />}</div>
    </div>
  );
}
