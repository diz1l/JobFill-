import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  extensionApi: 'chrome',
  modules: ['@wxt-dev/module-react'],

  vite: () => ({
    plugins: [tailwindcss()],
  }),

  manifest: {
    name: 'JobFill',
    short_name: 'JobFill',
    description: 'Autofill job application forms in one click.',
    version: '1.0.0',
    permissions: ['storage', 'activeTab', 'scripting'],
    host_permissions: [
      'https://api.groq.com/*',
      'https://api.notion.com/*',
      'https://script.google.com/*',
    ],
    action: {
      default_popup: 'popup/index.html',
      default_title: 'JobFill',
    },
    options_ui: {
      page: 'options/index.html',
      open_in_tab: true,
    },
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
});
