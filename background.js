// Chrome loads this file as a service worker (manifest.json).
// Firefox loads it as an event page (manifest.firefox.json).
// Both expose the chrome.* namespace below.
const ICON_SETS = {
  default: {
    16: 'icons/default16.png',
    48: 'icons/default48.png',
    128: 'icons/default128.png'
  },
  supported: {
    16: 'icons/supported16.png',
    48: 'icons/supported48.png',
    128: 'icons/supported128.png'
  },
  complete: {
    16: 'icons/complete16.png',
    48: 'icons/complete48.png',
    128: 'icons/complete128.png'
  }
};

let completeResetTimer = null;

function isSupportedUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname;
    return host === 'patreon.com' || host.endsWith('.patreon.com')
      || host === 'fantia.jp' || host.endsWith('.fantia.jp');
  } catch {
    return false;
  }
}

// chrome.action.setIcon({ tabId }) fulfills its promise even when that tab is
// already gone, and Chrome still sets runtime.lastError. try/catch around the
// promise never reads lastError, so the Errors page keeps
// "Unchecked runtime.lastError: No tab with id" with an empty stack
// (Context: Unknown, anonymous function at :0). Read lastError in the callback.
function invokeChrome(fn, args) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (message, value) => {
      if (settled) return;
      settled = true;
      resolve(message ? { ok: false, message } : { ok: true, value });
    };
    try {
      const returned = fn(...args, (value) => {
        const err = chrome.runtime.lastError;
        finish(err && err.message ? err.message : '', value);
      });
      if (returned && typeof returned.then === 'function') {
        returned.then(
          (value) => finish('', value),
          (err) => finish(String(err && err.message || err))
        );
      }
    } catch (e) {
      finish(String(e && e.message || e));
    }
  });
}

function setIconState(state, tabId) {
  const path = ICON_SETS[state] || ICON_SETS.default;
  const details = { path };
  if (typeof tabId === 'number') details.tabId = tabId;
  return invokeChrome(chrome.action.setIcon.bind(chrome.action), [details]).then(() => {});
}

function getTab(tabId) {
  return invokeChrome(chrome.tabs.get.bind(chrome.tabs), [tabId]).then((result) => {
    return result.ok ? result.value : null;
  });
}

function queryActiveTab() {
  return invokeChrome(
    chrome.tabs.query.bind(chrome.tabs),
    [{ active: true, currentWindow: true }]
  ).then((result) => (result.ok && result.value && result.value[0]) || null);
}

async function refreshTabIcon(tabId, url) {
  if (completeResetTimer) return; // keep complete state until it times out
  await setIconState(isSupportedUrl(url) ? 'supported' : 'default', tabId);
}

chrome.runtime.onInstalled.addListener(() => {
  setIconState('default').catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  getTab(tabId).then((tab) => {
    if (!tab) return null;
    return refreshTabIcon(tabId, tab.url);
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    refreshTabIcon(tabId, tab && tab.url).catch(() => {});
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
      completeResetTimer = setTimeout(() => {
        completeResetTimer = null;
        queryActiveTab().then((tab) => {
          if (tab) return refreshTabIcon(tab.id, tab.url);
          return setIconState('default');
        }).catch(() => setIconState('default'));
      }, 5000);
      sendResponse({ ok: true });
    })().catch(() => {});
    return true;
  }

  if (msg.type === 'SET_ICON_STATE' && msg.state) {
    setIconState(msg.state, msg.tabId).catch(() => {});
  }
});
