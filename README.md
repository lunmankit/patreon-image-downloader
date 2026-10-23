# Patreon Image Batch Downloader

Manifest V3 extension (v1.6) for Chrome and desktop Firefox. It batch-extracts and downloads high-resolution images from Patreon posts.

On a Patreon page, open the popup and scan. The extension collects post images (preferring original / download URLs), shows a preview, and can filter by minimum width or height. Optional auto-scroll loads more posts on feed pages before the scan. Downloads are saved under `Patreon_Downloads/`.

The popup UI is in Traditional Chinese.

Chrome loads this folder. `background.js` runs as a service worker (`background.service_worker` in `manifest.json`). Current Chrome reports `'background.scripts' requires manifest version of 2 or lower` when that key is present in Manifest V3, so `manifest.json` does not include it. Firefox does not run background service workers. It still runs `background.js` as an event page, but only from a staged copy: `tools/stage-firefox.py` writes `dist/firefox/` with `background.scripts` and no `service_worker`. Firefox temporary install always reads `manifest.json` from the selected add-on's directory, so the staged folder is a separate directory rather than a second file next to the Chrome manifest. Firefox 140 is the first desktop release that accepts `data_collection_permissions`, and it already includes the event-page behavior Firefox has had since version 121. Scripts call `chrome.*`, which Firefox implements for these APIs. Chrome leaves `browser_specific_settings` unused.

## Toolbar icon states

The toolbar icon switches among three states in both browsers (`action.setIcon`):

- **Idle** (`icons/default16.png`, `default48.png`, `default128.png`) — not on a Patreon page (red download badge).
- **Supported** (`icons/supported16.png`, `supported48.png`, `supported128.png`) — the active tab is a Patreon page (green check + red download badges).
- **Complete** (`icons/complete16.png`, `complete48.png`, `complete128.png`) — a batch download just finished (green check badge). The icon returns to idle or supported after a few seconds.

Status badges are drawn large with thick glyphs so they stay readable at the 16px toolbar size.

`icons/icon128.png` is the same image as the idle 128px icon. `background.js` applies these states from tab changes and from popup messages (`SET_ICON_STATE`, `DOWNLOAD_COMPLETE`).

## Load unpacked in Chrome

Chrome 121 or newer.

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (the one that contains `manifest.json`).

After code changes, open `chrome://extensions` and click **Reload** on this extension.

## Load a temporary add-on in Firefox

Firefox 140 or newer (desktop).

1. From this folder, run `python3 tools/stage-firefox.py` (on Windows, `py -3 tools/stage-firefox.py`).
2. Open `about:debugging`.
3. In the left sidebar, click **This Firefox**.
4. Click **Load Temporary Add-on…**.
5. Select `dist/firefox/manifest.json`.

Firefox drops temporary add-ons when the browser closes, so load the add-on again after a restart. After code changes, run `python3 tools/stage-firefox.py` again, then open `about:debugging#/runtime/this-firefox` and click **Reload** next to this extension.

Packaging and signing for addons.mozilla.org is out of scope. The manifest already includes a Firefox extension id, `strict_min_version` of 140.0, and `data_collection_permissions` set to `none` (the auto-load preference stays in the browser, and downloads stay on this device). `gecko_android` is omitted, so this package is desktop Firefox only.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the tab you invoke the extension on. |
| `scripting` | Inject `content.js` into that tab to scan the page. |
| `downloads` | Save the selected images. |
| `storage` | Remember the auto-load preference. |
| `tabs` | Read the active tab URL so the toolbar icon can switch between idle and supported. |
| `https://patreon.com/*`, `https://*.patreon.com/*` | Run on Patreon and request post media from the page. |
