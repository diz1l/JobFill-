import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['shared/**'],
      exclude: ['shared/**/*.test.ts'],
      reporter: ['text', 'html', 'json', 'json-summary'],
      /**
       * Thresholds are per-directory ratchets, not one global number.
       *
       * - Every directory has unit tests, so each gets a percentage gate at (or
       *   just below) its measured figures — any regression fails CI. The
       *   original target was 90% lines / 80% branches; all groups overtook it,
       *   so their gates are the real figures instead of the target.
       * - The global entry additionally uses NEGATIVE thresholds, which Vitest
       *   reads as "max allowed uncovered lines/statements/functions/branches".
       *   Percentages alone would let untested code grow as long as tested code
       *   grew alongside it; an absolute count does not. Lower it whenever tests
       *   land — that is the ratchet.
       *
       * Note: global thresholds apply to every included file, glob-matched ones
       * included, so the budget below is repo-wide.
       */
      thresholds: {
        // Repo-wide budget of untested code.
        // Measured 2026-08-15, after the schema v2 profile migration landed:
        //   2 lines, 9 statements, 0 functions, 25 branches uncovered.
        //
        // There is deliberately no headroom left. What remains uncovered is
        // enumerated below and is *unreachable by construction*, so any increase
        // is new untested code and should fail:
        //   - storage/validate.ts — the two guards *inside* the now-live
        //     schema-migration loop: a version with no `MIGRATIONS` entry, and a
        //     migration that fails to raise the version. Both are about a
        //     mistake in this repo's own table rather than about anything a user
        //     can hand us, and `SYNC_SCHEMA_VERSION` 2 with a complete table
        //     reaches neither. The loop itself is covered by "schema v1 → v2" in
        //     tests/storage.test.ts. (2 lines / 3 stmts / 3 br)
        //   - api/groq.ts 125–126 — `toGroqError`'s `err instanceof GroqApiError`
        //     short-circuit and its `endpoint?.label ?? …`. The function is
        //     module-private, is called from exactly two catch blocks that can
        //     only produce `HttpError`/`TypeError`, and is always passed an
        //     endpoint. (1 line / 1 stmt / 2 br)
        //   - api/notion.ts 129 — `pickProperty`'s "loose name" step. Provably
        //     dead: its predicate is `spec.types.includes(p.type) && aliases
        //     match`, and any property satisfying it would already have been
        //     returned by the preceding per-type loop. (1 line / 1 stmt / 1 br)
        //   - api/notion.ts 286 else / api/sheets.ts 79 else — the
        //     `err instanceof HttpError` fall-through in two translators that
        //     are only ever called from a catch around `httpJson` /
        //     `httpRequest`, which throw nothing else. (2 br)
        //   - api/provider.ts 197 — `if (!url.hostname)` in `validateBaseUrl`.
        //     WHATWG URL parsing rejects an `https:` URL with no host outright,
        //     so the check can never see one. (1 br)
        //   - extractors (3 br), field-matcher/fingerprint.ts (4 stmts / 11 br),
        //     filler/inlineButton.ts + missingData.ts (2 br) — pre-existing, and
        //     documented against their own gates below.
        lines: -2,
        statements: -9,
        branches: -25,
        // Zero uncovered functions. Expressed as a percentage rather than as
        // `-0`, because Vitest tests `threshold >= 0` to decide which of the two
        // meanings applies and `-0 >= 0` is true — `-0` would silently become a
        // 0% gate, i.e. no gate at all.
        functions: 100,

        // Measured: 100% lines / 99.51% stmts / 100% funcs / 98.18% branches.
        // The gap is the five unreachable spots listed above (groq 125–126,
        // notion 132 + 290, sheets 82, provider 208).
        'shared/api/**': {
          lines: 100,
          statements: 99,
          functions: 100,
          branches: 98,
        },

        // Measured: 99.42% lines / 99.27% stmts / 100% funcs / 98.58% branches.
        // The migration loop is live and tested now, so the gate went up with
        // it; what is left is the two guards named above. local.ts, sync.ts and
        // retryQueue.ts are at 100% lines and functions.
        'shared/storage/**': {
          lines: 99,
          statements: 99,
          functions: 100,
          branches: 98,
        },

        // Measured: 100% across the board. `types.ts` and `messages.ts` are
        // plain data plus two string builders, so there is nothing here that
        // justifies a single uncovered branch.
        'shared/*.ts': {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },

        // Measured: 100% lines / 98.31% stmts / 100% funcs / 94.66% branches
        'shared/field-matcher/**': {
          lines: 99,
          statements: 97,
          functions: 100,
          branches: 93,
        },

        // Measured: 100% lines / 100% stmts / 100% funcs / 95.08% branches
        'shared/extractors/**': {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 95,
        },

        // Measured: 100% lines / 100% stmts / 100% funcs / 99.54% branches.
        // The one uncovered branch is unreachable by construction:
        //   inlineButton.ts `if (toast === el)` — the timers guarantee it holds.
        'shared/filler/**': {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 98,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@@': new URL('.', import.meta.url).pathname,
    },
  },
});
