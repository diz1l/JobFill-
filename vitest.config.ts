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
       * - Directories that have unit tests get percentage gates set at (or just
       *   below) their measured numbers, so any regression fails CI. The
       *   original target for every group was 90% lines / 80% branches; the
       *   three groups below have overtaken it, so their gates are the real
       *   figures instead of the target.
       * - The rest (shared/api, shared/storage, shared/types.ts,
       *   shared/messages.ts) is only partially tested, so a percentage gate
       *   there would either be meaningless or would freeze the current state.
       *   The global entry therefore uses NEGATIVE thresholds, which Vitest
       *   reads as "max allowed uncovered lines/statements/functions/branches".
       *   That keeps the amount of untested code from growing and must be
       *   lowered whenever tests land.
       *
       * Note: in Vitest the global thresholds apply to every included file,
       * glob-matched ones included, so the budget below is repo-wide.
       */
      thresholds: {
        // Repo-wide budget of untested code.
        // Measured 2026-08-14 after `shared/filler` was covered:
        //   98 lines, 140 statements, 40 functions, 150 branches uncovered
        //   (was 377 / 474 / 88 / 352 before).
        // What is left sits almost entirely in shared/storage and shared/api;
        // lower these every time tests land there — that is the ratchet.
        lines: -105,
        statements: -148,
        functions: -44,
        branches: -158,

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
        // One uncovered branch is left, and it is unreachable by construction:
        //   inlineButton.ts `if (toast === el)` — the timers guarantee it holds
        // `index.ts`'s `map[fieldType] ?? ''` was listed here as unreachable too,
        // on the grounds that every FieldType is a key of the map. FR-5.3 made it
        // reachable: `classifyUnresolvedFields` passes it a field type that came
        // back from the model, which is not necessarily one of those keys. It is
        // covered by "ignores a field type that does not exist at all"
        // (tests/filler.test.ts) — the fallback is what stops a hallucinated
        // type from writing anything.
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
