# Patreon Image Batch Downloader

Chrome extension (Manifest V3, v1.2) that batch-extracts and downloads high-resolution images from Patreon posts.

On a Patreon page, open the popup and scan. The extension collects post images (preferring original / download URLs), shows a preview, and can filter by minimum width or height. Optional auto-scroll loads more posts on feed pages before the scan. Downloads are saved under `Patreon_Downloads/`.

The popup UI is in Traditional Chinese.

## Load unpacked in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (the one that contains `manifest.json`).

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the tab you invoke the extension on. |
| `scripting` | Inject `content.js` into that tab to scan the page. |
| `downloads` | Save the selected images. |
| `storage` | Remember the auto-load preference. |
| `https://patreon.com/*`, `https://*.patreon.com/*` | Run on Patreon and request post media from the page. |
