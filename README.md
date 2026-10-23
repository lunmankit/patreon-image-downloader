# Patreon Image Batch Downloader

Manifest V3 extension (v1.4) for Chrome and desktop Firefox. It batch-extracts and downloads high-resolution images from Patreon posts.

On a Patreon page, open the popup and scan. The extension collects post images (preferring original / download URLs), shows a preview, and can filter by minimum width or height. Optional auto-scroll loads more posts on feed pages before the scan. Downloads are saved under `Patreon_Downloads/`.

The popup UI is in Traditional Chinese.

Chrome and Firefox need separate manifests. Chrome Manifest V3 loads `background.service_worker`. `background.scripts` is a Manifest V2 key, and Chrome reports `'background.scripts' requires manifest version of 2 or lower.` when that key is rejected. Firefox desktop release builds start `background.js` as an event page from `background.scripts` and do not support `background.service_worker` ([Firefox bug 1573659](https://bugzilla.mozilla.org/show_bug.cgi?id=1573659)).

`manifest.json` is what Chrome loads. `manifest.firefox.json` is the same manifest with `background.scripts` instead of `background.service_worker`. Firefox's temporary add-on loader reads a file named `manifest.json`, so stage `dist/firefox` before loading there. Both browsers run the same `background.js`. Scripts call `chrome.*`, which Firefox implements for these APIs. Current Chrome leaves `browser_specific_settings` unused.

Firefox 140 is the minimum desktop release because it is the first one that accepts this manifest's `data_collection_permissions` entry. Event pages have been available since Firefox 121.

## Toolbar icon states

The toolbar icon switches among three states in both browsers (`action.setIcon`):

- **Idle** (`icons/default16.png`, `default48.png`, `default128.png`) — not on a Patreon page.
- **Supported** (`icons/supported16.png`, `supported48.png`, `supported128.png`) — the active tab is a Patreon page.
- **Complete** (`icons/complete16.png`, `complete48.png`, `complete128.png`) — a batch download just finished. The icon returns to idle or supported after a few seconds.

`icons/icon128.png` is the same image as the idle 128px icon. `background.js` applies these states from tab changes and from popup messages (`SET_ICON_STATE`, `DOWNLOAD_COMPLETE`).

## Load unpacked in Chrome

Chrome 121 or newer.

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (the one that contains `manifest.json`).

Load this folder (`background.service_worker`). `dist/firefox` is the Firefox package (`background.scripts` only); Chrome does not start a service worker from that folder.

After code changes, open `chrome://extensions` and click **Reload** on this extension.

## Load a temporary add-on in Firefox

Firefox 140 or newer (desktop).

From the repo root, stage a folder whose manifest is named `manifest.json` and uses `background.scripts`:

```bash
python3 scripts/stage-firefox.py
```

The script checks that `manifest.json` and `manifest.firefox.json` match except for `background`, then writes `dist/firefox/` (`dist/` is gitignored).

1. Open `about:debugging`.
2. In the left sidebar, click **This Firefox**.
3. Click **Load Temporary Add-on…**.
4. Select `dist/firefox/manifest.json`.

Firefox drops temporary add-ons when the browser closes, so stage the folder if it is missing and load the add-on again after a restart. After code changes, run `python3 scripts/stage-firefox.py` again, then open `about:debugging#/runtime/this-firefox` and click **Reload** next to this extension. Reload reads the staged folder, so restage before Reload when sources or `manifest.firefox.json` change.

Packaging and signing for addons.mozilla.org is out of scope. `manifest.firefox.json` includes a Firefox extension id, `strict_min_version` of 140.0, and `data_collection_permissions` set to `none` (the auto-load preference stays in the browser, and downloads stay on this device). `gecko_android` is omitted, so this package is desktop Firefox only. Keep that gecko block in `manifest.json` as well so the two files stay aligned; the stage script refuses to run if anything other than `background` drifts.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the tab you invoke the extension on. |
| `scripting` | Inject `content.js` into that tab to scan the page. |
| `downloads` | Save the selected images. |
| `storage` | Remember the auto-load preference. |
| `tabs` | Read the active tab URL so the toolbar icon can switch between idle and supported. |
| `https://patreon.com/*`, `https://*.patreon.com/*` | Run on Patreon and request post media from the page. |
