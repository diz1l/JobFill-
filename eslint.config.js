// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginReact from 'eslint-plugin-react';
import pluginReactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    // Build artifacts, generated code and vendored bundles are never linted.
    ignores: [
      'node_modules/',
      '.wxt/',
      '.output/',
      'dist/',
      'coverage/',
      'testForB/',
      'dev/',
      '#/',
      '**/*.zip',
      // `outDir` is the repo root (so the unpacked extension sits at
      // ./chrome-mv3), which puts built bundles next to the sources. Linting
      // them produced thousands of no-undef/no-unused-expressions errors from
      // minified output — the same failure that once hid the 23 real ones.
      'chrome-mv3/',
      'firefox-mv2/',
      'chrome-mv3-dev/',
      'firefox-mv2-dev/',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Extension source: browser + WebExtension globals.
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        chrome: 'readonly',
        browser: 'readonly',
      },
    },
    plugins: {
      react: pluginReact,
      'react-hooks': pluginReactHooks,
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
    settings: {
      react: { version: 'detect' },
    },
  },
  {
    // Build/tooling scripts run in Node.js and use CommonJS.
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
