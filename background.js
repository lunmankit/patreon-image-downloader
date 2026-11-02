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

  function fetchTimed(url, method, ms) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => {
      if (controller) {
        try { controller.abort(); } catch (e) {}
      }
    }, ms);
    return fetch(url, {
      method: method,
      redirect: 'follow',
      credentials: 'include',
      signal: controller ? controller.signal : undefined,
      headers: { 'Accept': 'image/avif,image/webp,image/*,text/html;q=0.8,*/*;q=0.1' }
    }).finally(() => clearTimeout(timer));
  }

  async function readLimited(res, max) {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (total < max) {
          const step = await reader.read();
          if (step.done) break;
          const buf = step.value;
          chunks.push(buf);
          total += buf && buf.byteLength ? buf.byteLength : 0;
        }
      } finally {
        try { await reader.cancel(); } catch (e) {}
      }
      const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;
      let text = '';
      for (let i = 0; i < chunks.length; i++) {
        text += decoder ? decoder.decode(chunks[i], { stream: true }) : String(chunks[i] || '');
        if (text.length >= max) return text.slice(0, max);
      }
      return text;
    }
    const text = await res.text();
    return text.length > max ? text.slice(0, max) : text;
  }

  function remember(decision) {
    if (decision && decision.status === 'image' && decision.url && !imageSeen[scan.canonical(decision.url)]) {
      imageSeen[scan.canonical(decision.url)] = true;
      images.push(decision.url);
      return;
    }
    skipped += 1;
  }

  async function probeOne(url) {
    const pattern = scan.originMatchPattern(url);
    const allowed = await containsOrigin(pattern);
    if (!allowed) {
      pendingUrls.push(url);
      return;
    }
    let headStatus = 0;
    let headType = '';
    let headFinal = url;
    try {
      const head = await fetchTimed(url, 'HEAD', 3000);
      headStatus = head.status;
      headType = head.headers.get('content-type') || '';
      headFinal = head.url || url;
      if (head.body && typeof head.body.cancel === 'function') {
        try { head.body.cancel(); } catch (e) {}
      }
    } catch (e) {
      headStatus = 0;
    }
    const step = typeof scan.interpretHead === 'function'
      ? scan.interpretHead(headStatus, headType)
      : 'get';
    if (step === 'accept') {
      remember(scan.decideProbe({
        url: url,
        finalUrl: headFinal,
        contentType: headType,
        html: ''
      }));
      return;
    }
    if (step === 'skip') {
      skipped += 1;
      return;
    }
    let res;
    try {
      res = await fetchTimed(url, 'GET', 6000);
    } catch (e) {
      skipped += 1;
      return;
    }
    const contentType = res.headers.get('content-type') || '';
    const mime = contentType.split(';')[0].trim().toLowerCase();
    const htmlLike = !mime || mime === 'text/html' || mime === 'application/xhtml+xml' || mime === 'text/xml' || mime === 'application/xml' || mime.indexOf('text/') === 0;
    let html = '';
    if (mime.indexOf('image/') === 0) {
      if (res.body && typeof res.body.cancel === 'function') {
        try { res.body.cancel(); } catch (e) {}
      }
    } else if (!res.ok || !htmlLike) {
      skipped += 1;
      if (res.body && typeof res.body.cancel === 'function') {
        try { res.body.cancel(); } catch (e) {}
      }
      return;
    } else {
      const length = parseInt(res.headers.get('content-length') || '', 10);
      if (length > 2000000) {
        skipped += 1;
        if (res.body && typeof res.body.cancel === 'function') {
          try { res.body.cancel(); } catch (e) {}
        }
        return;
      }
      html = await readLimited(res, 800000);
    }
    remember(scan.decideProbe({
      url: url,
      finalUrl: res.url || url,
      contentType: contentType,
      html: html
    }));
  }

  let cursor = 0;
  const runners = [];
  const pool = Math.min(4, batch.length);
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
