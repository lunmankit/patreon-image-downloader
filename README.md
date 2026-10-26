# Patreon & Fantia Image Batch Downloader

Manifest V3 extension (v1.6) for Chrome and desktop Firefox. It batch-extracts and downloads high-resolution images from Patreon posts and from Fantia posts the current browser session can already see.

On a supported page, open the popup and scan. The extension collects images (preferring original / download URLs), shows a preview, and can filter by minimum width or height. Optional auto-load scrolls Patreon feeds, and on Fantia it follows listing pagination, before the scan. Patreon downloads are saved under `Patreon_Downloads/`. Fantia downloads are saved under `Fantia_Downloads/`.

The popup UI is in Traditional Chinese.

Chrome and Firefox need separate manifests. Chrome Manifest V3 loads `background.service_worker`. `background.scripts` is a Manifest V2 key, and Chrome reports `'background.scripts' requires manifest version of 2 or lower.` when that key is rejected. Firefox desktop release builds start `background.js` as an event page from `background.scripts` and do not support `background.service_worker` ([Firefox bug 1573659](https://bugzilla.mozilla.org/show_bug.cgi?id=1573659)).

`manifest.json` is what Chrome loads. `manifest.firefox.json` is the same manifest with `background.scripts` instead of `background.service_worker`. Firefox's temporary add-on loader reads a file named `manifest.json`, so stage `dist/firefox` before loading there. Both browsers run the same `background.js`. Scripts call `chrome.*`, which Firefox implements for these APIs. Current Chrome leaves `browser_specific_settings` unused.

Firefox 140 is the minimum desktop release because it is the first one that accepts this manifest's `data_collection_permissions` entry. Event pages have been available since Firefox 121.

## Fantia

Fantia support uses the same popup flow as Patreon: scan the open page, preview the images, then batch-download them. The scanner reads Fantia's post JSON (`/api/v1/posts/<id>`, with the page CSRF token) and keeps original image URLs only. It does not collect credentials and it does not bypass paywalls.

Pages that scan:

1. **貼文 / individual posts** — `https://fantia.jp/posts/<id>` (and `www.fantia.jp`). Opening the original-image viewer under that post (`/posts/<id>/post_content_photo/<photoId>`) still scans the parent post.
2. **相簿 / albums and gallery-style pages** — a post's 画像ギャラリー (`photo_gallery`) plus blog images stored as album images (`album_image`, including `/posts/<id>/album_image`). Fanclub post grids at `https://fantia.jp/fanclubs/<id>` and `https://fantia.jp/fanclubs/<id>/posts` are scanned as galleries: each post card on the page is fetched. With auto-load checked, the scanner follows `rel="next"` pagination (up to 20 pages / 200 posts).
3. **付費內容 / paid content you can already view** — members-only blocks inside a post, and backnumber month pages at `https://fantia.jp/fanclubs/<id>/backnumbers`. Fantia returns `visible_status: "visible"` only when this login can see the block, including a paid plan you have already joined. Those images are included. Blocks still marked locked (`members_only`, `catchable`, `uncatchable`) are skipped and counted in the popup. You must already be logged in to Fantia in this browser. If you are not entitled to a post, the extension will not try to reconstruct its files.

Public posts work without a paid plan. Image files are the originals Fantia gives that session (`url.original`, blog `fantiaImage` files, and image attachments). Video, audio, and zip attachments are left out. Derivative thumbnails (`thumb_`, `micro_`, and similar) are not substituted for originals.

## Toolbar icon states

The toolbar icon switches among three states in both browsers (`action.setIcon`):

- **Idle** (`icons/default16.png`, `default48.png`, `default128.png`) — not on a Patreon or Fantia page (red download badge).
- **Supported** (`icons/supported16.png`, `supported48.png`, `supported128.png`) — the active tab is a Patreon or Fantia page (green check + red download badges).
- **Complete** (`icons/complete16.png`, `complete48.png`, `complete128.png`) — a batch download just finished (green check badge). The icon returns to idle or supported after a few seconds.

Status badges are drawn large with thick glyphs so they stay readable at the 16px toolbar size.

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

The script checks that `manifest.json` and `manifest.firefox.json` match except for `background`, then writes `dist/firefox/` (`dist/` is gitignored), including `fantia.js`.

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
| `scripting` | Inject `content.js` (and `fantia.js` on Fantia) into that tab to scan the page. |
| `downloads` | Save the selected images. |
| `storage` | Remember the auto-load preference. |
| `tabs` | Read the active tab URL so the toolbar icon can switch between idle and supported. |
| `https://patreon.com/*`, `https://*.patreon.com/*` | Run on Patreon and request post media from the page. |
| `https://fantia.jp/*`, `https://*.fantia.jp/*` | Run on Fantia, including `www`, and download images from `c.fantia.jp` and `cc.fantia.jp`. No other hosts are added. |

Scanning stays on demand, the same as Patreon. The extension does not register a content script that runs on every page load.
