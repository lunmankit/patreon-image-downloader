// Chrome MV3 runs this file as a service worker. Firefox MV3 runs it as an
// event page (background.scripts). Both expose the chrome.* namespace below.
const ICON_SETS = {
  // Multiple densities so the browser auto-picks for ~480p (1x) through 4K HiDPI (about 2x-3x).
  default: {
    16: 'icons/default16.png',
    24: 'icons/default24.png',
    32: 'icons/default32.png',
    48: 'icons/default48.png',
    64: 'icons/default64.png',
    128: 'icons/default128.png'
  },
  supported: {
    16: 'icons/supported16.png',
    24: 'icons/supported24.png',
    32: 'icons/supported32.png',
    48: 'icons/supported48.png',
    64: 'icons/supported64.png',
    128: 'icons/supported128.png'
  },
  complete: {
    16: 'icons/complete16.png',
    24: 'icons/complete24.png',
    32: 'icons/complete32.png',
    48: 'icons/complete48.png',
    64: 'icons/complete64.png',
    128: 'icons/complete128.png'
  }
};

let completeResetTimer = null;

function isPatreonUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname === 'patreon.com' || u.hostname.endsWith('.patreon.com');
  } catch {
    return false;
  }
}

async function setIconState(state, tabId) {
  const path = ICON_SETS[state] || ICON_SETS.default;
  const details = { path };
  if (typeof tabId === 'number') details.tabId = tabId;
  try {
    await chrome.action.setIcon(details);
  } catch (e) {
    // Tab may have closed; ignore.
  }
}

async function refreshTabIcon(tabId, url) {
  if (completeResetTimer) return; // keep complete state until it times out
  await setIconState(isPatreonUrl(url) ? 'supported' : 'default', tabId);
}

chrome.runtime.onInstalled.addListener(() => {
  setIconState('default');
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await refreshTabIcon(tabId, tab.url);
  } catch (e) {}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    refreshTabIcon(tabId, tab.url);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'DOWNLOAD_COMPLETE') {
    const tabId = sender.tab?.id;
    (async () => {
      if (completeResetTimer) clearTimeout(completeResetTimer);
      await setIconState('complete', tabId);
      // Also set global toolbar icon briefly
      await setIconState('complete');
      completeResetTimer = setTimeout(async () => {
        completeResetTimer = null;
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab) await refreshTabIcon(tab.id, tab.url);
          else await setIconState('default');
        } catch {
          await setIconState('default');
        }
      }, 5000);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'SET_ICON_STATE' && msg.state) {
    setIconState(msg.state, msg.tabId);
  }
});
