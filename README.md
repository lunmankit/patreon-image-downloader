# Patreon Image Batch Downloader

Manifest V3 extension (v1.4.1) for Chrome and desktop Firefox. It batch-extracts and downloads high-resolution images from Patreon posts.

On a Patreon page, open the popup and scan. The extension collects post images (preferring original / download URLs), shows a preview, and can filter by minimum width or height. Optional auto-scroll loads more posts on feed pages before the scan. Downloads are saved under `Patreon_Downloads/`.

The popup UI is in Traditional Chinese.

Chrome and desktop Firefox share this folder and the same `background.js`. Each browser has its own manifest:

- **Chrome** loads `manifest.json`. That file registers `background.js` as a service worker (`background.service_worker` only).
- **Firefox 140+** loads `manifest.firefox.json`. That file registers the same `background.js` as an event page (`background.scripts`) and sets the Firefox extension id, `strict_min_version` of 140.0, and `data_collection_permissions`. Firefox 140 is the first desktop release that accepts `data_collection_permissions`, and it already includes the event-page loading behavior Firefox has had since version 121.

Scripts call `chrome.*`, which Firefox implements for these APIs.

## Toolbar icon states

The toolbar icon switches among three states in both browsers (`action.setIcon`). Each state ships at 16, 24, 32, 48, 64, and 128 pixels. The browser selects a size from the display scale, so the icon stays sharp from about 480p at 1x through 4K HiDPI.

- **Idle** (`icons/default16.png` through `default128.png`) — not on a Patreon page.
- **Supported** (`icons/supported16.png` through `supported128.png`) — the active tab is a Patreon page.
- **Complete** (`icons/complete16.png` through `complete128.png`) — a batch download just finished. The icon returns to idle or supported after a few seconds.

`icons/icon128.png` is the same image as the idle 128px icon. `action.default_icon` in both manifests lists those six idle sizes. The store-style `icons` block stays at 16, 48, and 128. `background.js` applies these states from tab changes and from popup messages (`SET_ICON_STATE`, `DOWNLOAD_COMPLETE`).

## Load unpacked in Chrome

Chrome 121 or newer.

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (the one that contains `manifest.json`).

Chrome reads `manifest.json` from that folder. After code changes, open `chrome://extensions` and click **Reload** on this extension.

## Load a temporary add-on in Firefox

Firefox 140 or newer (desktop).

`manifest.firefox.json` is the desktop Firefox manifest. The temporary add-on picker lets you select any manifest file. Select **`manifest.firefox.json`**.

Firefox installs the folder that contains the file you pick and reads `manifest.json` from that folder. Before loading, copy the Firefox manifest over `manifest.json`, then select `manifest.firefox.json` in the picker:

```bash
cp manifest.json /tmp/patreon-manifest.chrome.json
cp manifest.firefox.json manifest.json
```

1. Open `about:debugging`.
2. In the left sidebar, click **This Firefox**.
3. Click **Load Temporary Add-on…**.
4. Select **`manifest.firefox.json`** in this folder.

When you go back to Chrome, restore the Chrome manifest so unpacked load keeps using the service worker:

```bash
cp /tmp/patreon-manifest.chrome.json manifest.json
```

Leave `manifest.json` as the Chrome manifest in git. The copy above is only for the local Firefox session.

Firefox drops temporary add-ons when the browser closes, so load the add-on again after a restart. After code changes, open `about:debugging#/runtime/this-firefox` and click **Reload** next to this extension. Reload reads `manifest.json`, so leave the Firefox copy in place while you are testing in Firefox.

Packaging and signing for addons.mozilla.org is out of scope. `manifest.firefox.json` includes a Firefox extension id, `strict_min_version` of 140.0, and `data_collection_permissions` set to `none` (the auto-load preference stays in the browser, and downloads stay on this device). `gecko_android` is omitted, so this package is desktop Firefox only.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the tab you invoke the extension on. |
| `scripting` | Inject `content.js` into that tab to scan the page. |
| `downloads` | Save the selected images. |
| `storage` | Remember the auto-load preference. |
| `tabs` | Read the active tab URL so the toolbar icon can switch between idle and supported. |
| `https://patreon.com/*`, `https://*.patreon.com/*` | Run on Patreon and request post media from the page. |
