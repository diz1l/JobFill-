import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Build straight into the repo root, so the unpacked extension lives at
  // ./chrome-mv3 and can be pointed at from chrome://extensions without
  // digging into a dot-directory.
  outDir: '.',

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
    //
    // `alarms` drives the application-log retry queue. The MV3 worker is evicted
    // after ~30 s idle, so a setTimeout fallback would never fire, and Chrome
    // shows no user-facing warning for this permission.
    //
    // `webNavigation` is deliberately NOT listed: enumerating a tab's frames with
    // `getAllFrames` costs the "Read your browsing history" warning at install, a
    // disproportionate price for an autofiller. Frame aggregation runs the other
    // way round instead — see entrypoints/ui/frames.ts.
    //
    // `scripting` is deliberately NOT listed either: nothing calls it, and an
    // unused permission is a review finding in both stores — in the Firefox MV2
    // build it is not even a real API.
    permissions: ['storage', 'activeTab', 'alarms'],
    host_permissions: [
      'https://api.groq.com/*',
      'https://api.notion.com/*',
      'https://script.google.com/*',
      // Apps Script Web Apps always redirect from script.google.com to this origin
      'https://script.googleusercontent.com/*',
    ],
    // Alternative LLM providers, granted when the user picks one rather than at
    // install: every entry moved up into `host_permissions` is a permission
    // warning paid by everyone, including the majority who only ever use Groq.
    // `chrome.permissions.request()` runs from the click in Settings, which is
    // the user gesture Chrome requires.
    //
    // `https://*/*` is deliberately absent. It would make the `custom` provider
    // work with any self-hosted endpoint, but it is the "read and change all your
    // data on all websites" prompt — too high a price for an escape hatch.
    optional_host_permissions: [
      'https://openrouter.ai/*',
      'https://api.openai.com/*',
      'https://api.together.xyz/*',
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
