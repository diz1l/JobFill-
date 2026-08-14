import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  vite: () => ({
    plugins: [tailwindcss()],
  }),

  manifest: {
    // `name`/`description` are resolved from public/_locales/<locale>/messages.json
    name: '__MSG_extName__',
    short_name: 'JobFill',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    // `version` intentionally omitted — WXT takes it from package.json (single source of truth)
    // `alarms` drives the application-log retry queue (FR-6.3). The MV3 worker is
    // evicted after ~30 s idle, so a setTimeout fallback would never fire.
    // Chrome shows no user-facing warning for this permission.
    //
    // `webNavigation` is deliberately NOT listed (NFR-2). P0-5 used it to
    // enumerate a tab's frames with `getAllFrames`, which costs the user-facing
    // "Read your browsing history" warning at install — a disproportionate price
    // for an autofiller. Frame aggregation now runs the other way round: one
    // broadcast `tabs.sendMessage` (no permission at all), and every frame that
    // has something to say answers over `chrome.runtime.sendMessage`, which
    // hands us its `sender.frameId`. See entrypoints/ui/frames.ts.
    // `scripting` is deliberately NOT listed either: nothing calls chrome.scripting,
    // and an unused permission is a review finding in both stores — in the Firefox
    // MV2 build it is not even a real API. Re-add it together with the activeTab +
    // executeScript migration sketched at the bottom of entrypoints/content.ts.
    permissions: ['storage', 'activeTab', 'alarms'],
    host_permissions: [
      'https://api.groq.com/*',
      'https://api.notion.com/*',
      'https://script.google.com/*',
      // Apps Script Web Apps always redirect from script.google.com to this origin
      'https://script.googleusercontent.com/*',
    ],
    // Firefox requires an explicit add-on id, otherwise storage.sync is not persisted
    browser_specific_settings: {
      gecko: {
        id: 'jobfill@diz1l.dev',
        strict_min_version: '109.0',
      },
    },
    action: {
      default_popup: 'popup/index.html',
      default_title: 'JobFill',
    },
    options_ui: {
      page: 'options/index.html',
      open_in_tab: true,
    },
    commands: {
      'fill-form': {
        suggested_key: {
          default: 'Alt+Shift+F',
        },
        description: 'Fill the current form with the active profile',
      },
    },
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
});
