// Chrome loads this file as a service worker (manifest.json).
// Firefox loads it as an event page (manifest.firefox.json).
// Both expose the chrome.* namespace below.
//
// Chrome's service worker has to import the gallery helper itself.
// Firefox lists gallery-scan.js ahead of this file in background.scripts,
// and event pages do not provide importScripts.
if (typeof importScripts === 'function') {
  try { importScripts('gallery-scan.js'); } catch (e) {}
}
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
    return;
  }

  if (msg.type === 'GALLERY_PROBE_PAGES' && Array.isArray(msg.urls)) {
    probeGalleryPages(msg.urls).then(sendResponse).catch(() => {
      sendResponse({ ok: false, images: [], skipped: msg.urls.length, pendingUrls: [] });
    });
    return true;
  }
});

function containsOrigin(pattern) {
  if (!chrome.permissions || !pattern) return Promise.resolve(false);
  return invokeChrome(chrome.permissions.contains.bind(chrome.permissions), [{ origins: [pattern] }])
    .then((result) => !!(result.ok && result.value));
}

async function probeGalleryPages(urls) {
  const scan = globalThis.GalleryScan;
  if (!scan || typeof scan.decideProbe !== 'function') {
    return { ok: false, images: [], skipped: (urls || []).length, pendingUrls: [] };
  }
  const requested = [];
  const seen = {};
  let skipped = 0;
  (urls || []).forEach((url) => {
    const key = scan.canonical(url);
    if (!key || seen[key]) return;
    seen[key] = true;
    if (!scan.originMatchPattern(url)) {
      skipped += 1;
      return;
    }
    requested.push(url);
  });
  const limit = scan.MAX_PROBES || 30;
  const batch = requested.slice(0, limit);
  const images = [];
  const pendingUrls = [];
  skipped += requested.length - batch.length;
  const imageSeen = {};

  async function probeOne(url) {
    const pattern = scan.originMatchPattern(url);
    const allowed = await containsOrigin(pattern);
    if (!allowed) {
      pendingUrls.push(url);
      return;
    }
    let signal;
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        signal = AbortSignal.timeout(12000);
      }
    } catch (e) {}
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'include',
      signal: signal,
      headers: { 'Accept': 'image/avif,image/webp,image/*,text/html;q=0.8,*/*;q=0.1' }
    });
    const contentType = res.headers.get('content-type') || '';
    const mime = contentType.split(';')[0].trim().toLowerCase();
    let html = '';
    if (mime.indexOf('image/') !== 0) {
      const text = await res.text();
      html = text.length > 800000 ? text.slice(0, 800000) : text;
    } else if (res.body && typeof res.body.cancel === 'function') {
      try { res.body.cancel(); } catch (e) {}
    }
    if (!res.ok && mime.indexOf('image/') !== 0) {
      skipped += 1;
      return;
    }
    const decision = scan.decideProbe({
      url: url,
      finalUrl: res.url || url,
      contentType: contentType,
      html: html
    });
    if (decision.status === 'image' && decision.url && !imageSeen[scan.canonical(decision.url)]) {
      imageSeen[scan.canonical(decision.url)] = true;
      images.push(decision.url);
    } else {
      skipped += 1;
    }
  }

  let cursor = 0;
  const runners = [];
  const pool = Math.min(3, batch.length);
  for (let i = 0; i < pool; i++) {
    runners.push((async () => {
      while (cursor < batch.length) {
        const index = cursor;
        cursor += 1;
        try {
          await probeOne(batch[index]);
        } catch (e) {
          skipped += 1;
        }
      }
    })());
  }
  await Promise.all(runners);
  return { ok: true, images: images, skipped: skipped, pendingUrls: pendingUrls };
}
