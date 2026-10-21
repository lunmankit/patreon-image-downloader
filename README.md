# patreon-image-downloader

Chrome extension that batch-extracts and downloads high-resolution images from Patreon posts.

## Toolbar icon states

The toolbar icon switches among three states:

- **Idle** (`icons/default16.png`, `default48.png`, `default128.png`) — not on a Patreon page.
- **Supported** (`icons/supported16.png`, `supported48.png`, `supported128.png`) — the active tab is a Patreon page.
- **Complete** (`icons/complete16.png`, `complete48.png`, `complete128.png`) — a batch download just finished. The icon returns to idle or supported after a few seconds.

`icons/icon128.png` is the same image as the idle 128px icon. `background.js` applies these states from tab changes and from popup messages (`SET_ICON_STATE`, `DOWNLOAD_COMPLETE`).
