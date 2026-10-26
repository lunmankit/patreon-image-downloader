# Patreon & Fantia Image Batch Downloader

Manifest V3 extension (v1.7) for Chrome and desktop Firefox. It batch-extracts and downloads high-resolution images from Patreon posts and from Fantia posts the current browser session can already see.

On a supported page, open the popup and scan. The extension collects images (preferring original / download URLs), shows a preview, and can filter by minimum width or height. Optional auto-load scrolls Patreon feeds, and on Fantia it follows listing pagination, before the scan. Patreon downloads are saved under `Patreon_Downloads/`. Fantia downloads are saved under `Fantia_Downloads/`.

## Per-post folders

The popup field **下載資料夾** chooses where the batch goes. The choice and the last custom name are stored in extension storage.

- **不分子資料夾** — files stay directly in `Patreon_Downloads/` or `Fantia_Downloads/` (the default).
- **個別資料夾：日期_標題** — one folder per post, `Patreon_Downloads/20261026_Some Post Title/file.jpg` (Fantia uses `Fantia_Downloads/`). The date and title come from the post. A missing date uses today. A missing title uses the post id, or `untitled`. A month-only value uses that month's first day. The popup says when a fallback was used. Two posts that would share a name get the post id appended.
- **個別資料夾：自訂名稱** — one folder name you type, under the same root, for the whole batch.

Windows still limits the full path to about 260 characters (`MAX_PATH`), and `chrome.downloads` does not opt into long paths. This extension treats a relative path longer than **200 characters** as too long to save, leaving about 59 characters for the drive and the Downloads directory. The check runs while you edit a custom name and again when a date-plus-title folder is computed. Before a scan it estimates with a typical filename; after a scan it uses the real filenames.

Auto mode shortens an over-long title and shows the shortened folder before download. A custom name that does not fit is not shortened silently: the popup warns **資料夾路徑超過 200 字元，無法儲存**, download stays disabled, and **改用縮短名稱** fills in a name that fits. Filenames that are still too long after the folder fits are shortened, with a separate warning, on both Patreon and Fantia.

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

The script checks that `manifest.json` and `manifest.firefox.json` match except for `background`, then writes `dist/firefox/` (`dist/` is gitignored), including `fantia.js` and `download-path.js`.

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
| `storage` | Remember auto-load, the folder naming mode, and the last custom folder name. |
| `tabs` | Read the active tab URL so the toolbar icon can switch between idle and supported. |
| `https://patreon.com/*`, `https://*.patreon.com/*` | Run on Patreon and request post media from the page. |
| `https://fantia.jp/*`, `https://*.fantia.jp/*` | Run on Fantia, including `www`, and download images from `c.fantia.jp` and `cc.fantia.jp`. No other hosts are added. |

Scanning stays on demand, the same as Patreon. The extension does not register a content script that runs on every page load.
