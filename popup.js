let allExtractedImages = [];
let filteredImages = [];
let timeoutTimer = null;
let downloadFolder = 'Patreon_Downloads';
let downloadBusy = false;
let suggestedCustomName = '';
let folderPrefsReady = false;
let scanNotice = '';
let pendingPageUrls = [];
let currentPageUrl = '';
let currentTabId = 0;
let refreshInjected = null;

function pageKind(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === 'patreon.com' || host.endsWith('.patreon.com')) return 'patreon';
    if (host === 'fantia.jp' || host.endsWith('.fantia.jp')) return 'fantia';
    if (typeof GalleryScan !== 'undefined' && GalleryScan.originMatchPattern(url)) return 'generic';
  } catch (e) {}
  return '';
}

function folderForKind(kind) {
  if (kind === 'fantia') return 'Fantia_Downloads';
  if (kind === 'generic') return 'Gallery_Downloads';
  return 'Patreon_Downloads';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

const scanBtn = document.getElementById('scan-btn');
const downloadBtn = document.getElementById('download-btn');
const sizeFilter = document.getElementById('size-filter');
const sizeVal = document.getElementById('size-val');
const autoLoadCb = document.getElementById('auto-load-cb');
const folderModeSelect = document.getElementById('folder-mode');
const customFolderInput = document.getElementById('custom-folder-name');
const folderNoteEl = document.getElementById('folder-note');
const folderWarningEl = document.getElementById('folder-warning');
const useShortNameBtn = document.getElementById('use-short-name-btn');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const previewContainer = document.getElementById('preview-container');
const probeBtn = document.getElementById('probe-btn');
const autoLoadRow = document.getElementById('auto-load-row');

// Load saved filter and auto-load preferences
const savedSize = localStorage.getItem('patreon_min_size') || '400';
sizeFilter.value = savedSize;
sizeVal.innerText = `${savedSize} px`;

chrome.storage.local.get(['autoLoad', 'folderNameMode', 'customFolderName'], (result) => {
  if (result.autoLoad !== undefined) {
    autoLoadCb.checked = result.autoLoad;
  }
  if (!folderPrefsReady) {
    if (result.folderNameMode === 'off' || result.folderNameMode === 'auto' || result.folderNameMode === 'custom') {
      folderModeSelect.value = result.folderNameMode;
    }
    if (typeof result.customFolderName === 'string') {
      customFolderInput.value = result.customFolderName;
    }
  }
  folderPrefsReady = true;
  updateFolderUi();
});

// Reflect site-supported status on the toolbar icon when popup opens
function applyGalleryResult(saved) {
  if (!saved || saved.pageUrl !== currentPageUrl) return;
  allExtractedImages = Array.isArray(saved.result) ? saved.result : [];
  scanNotice = saved.notice || '';
  pendingPageUrls = Array.isArray(saved.pendingUrls) ? saved.pendingUrls.slice() : [];
  updateProbeButton();
  if (!allExtractedImages.length) {
    statusEl.innerText = scanNotice || '未找到可下載的原圖。';
    filteredImages = [];
    previewContainer.style.display = 'none';
    downloadBtn.style.display = 'none';
    updateFolderUi();
    return;
  }
  applyFilterAndRender();
}

function restoreGenericScan(pageUrl) {
  if (!chrome.storage || !chrome.storage.session) return;
  chrome.storage.session.get(['galleryScan'], (data) => {
    const saved = data && data.galleryScan;
    if (!saved || saved.pageUrl !== pageUrl) return;
    if (!saved.at || Date.now() - saved.at > 10 * 60 * 1000) return;
    if (scanBtn.disabled) return;
    applyGalleryResult(saved);
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  if (!tab) return;
  noteActiveTab(tab);
  currentPageUrl = tab.url || '';
  const kind = pageKind(tab.url);
  if (kind) downloadFolder = folderForKind(kind);
  autoLoadCb.disabled = kind === 'generic';
  if (autoLoadRow) {
    autoLoadRow.classList.toggle('disabled', kind === 'generic');
    autoLoadRow.title = kind === 'generic' ? '一般圖庫只掃瞄目前頁面，不會自動翻頁' : '';
  }
  const supported = kind === 'patreon' || kind === 'fantia';
  updateFolderUi();
  chrome.runtime.sendMessage({
    type: 'SET_ICON_STATE',
    state: supported ? 'supported' : 'default',
    tabId: tab.id
  });
  if (kind === 'generic') restoreGenericScan(tab.url);
});

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes.galleryScan || !changes.galleryScan.newValue) return;
    applyGalleryResult(changes.galleryScan.newValue);
  });
}

// Persist size filter setting
sizeFilter.addEventListener('input', () => {
  const minSize = parseInt(sizeFilter.value, 10);
  sizeVal.innerText = `${minSize} px`;
  localStorage.setItem('patreon_min_size', minSize);
  applyFilterAndRender();
});

// Persist auto-load setting
autoLoadCb.addEventListener('change', () => {
  chrome.storage.local.set({ autoLoad: autoLoadCb.checked });
});

function refreshFolderChoice() {
  if (allExtractedImages.length) applyFilterAndRender();
  else updateFolderUi();
}

folderModeSelect.addEventListener('change', () => {
  folderPrefsReady = true;
  chrome.storage.local.set({ folderNameMode: folderModeSelect.value });
  refreshFolderChoice();
});

customFolderInput.addEventListener('input', () => {
  folderPrefsReady = true;
  chrome.storage.local.set({ customFolderName: customFolderInput.value });
  refreshFolderChoice();
});

useShortNameBtn.addEventListener('click', () => {
  if (!suggestedCustomName) return;
  customFolderInput.value = suggestedCustomName;
  chrome.storage.local.set({ customFolderName: suggestedCustomName });
  refreshFolderChoice();
});

function folderOptions() {
  return {
    root: downloadFolder,
    mode: folderModeSelect.value,
    customName: customFolderInput.value,
    today: (typeof DownloadPath !== 'undefined') ? DownloadPath.todayStamp(new Date()) : ''
  };
}

function currentPlan() {
  if (typeof DownloadPath === 'undefined') {
    return {
      ok: true,
      mode: 'off',
      paths: filteredImages.map((img) => downloadFolder + '/' + img.filename),
      folders: filteredImages.map(() => ''),
      preview: '',
      notices: [],
      warnings: ['無法檢查路徑長度，將直接存到下載根目錄。'],
      suggestedCustomName: ''
    };
  }
  return DownloadPath.planDownloadPaths(filteredImages, folderOptions());
}

function updateProbeButton() {
  if (!probeBtn) return;
  if (pendingPageUrls.length) {
    probeBtn.style.display = 'block';
    probeBtn.textContent = '授權並確認其餘 ' + pendingPageUrls.length + ' 個網頁';
  } else {
    probeBtn.style.display = 'none';
  }
}

function updateFolderUi() {
  const mode = folderModeSelect.value;
  customFolderInput.style.display = mode === 'custom' ? 'block' : 'none';
  const plan = currentPlan();
  suggestedCustomName = plan.suggestedCustomName || '';
  const note = [plan.preview].concat(plan.notices || []).filter(Boolean).join('\n');
  folderNoteEl.textContent = note;
  folderWarningEl.textContent = (plan.warnings || []).join('\n');
  folderNoteEl.style.display = note ? 'block' : 'none';
  folderWarningEl.style.display = (plan.warnings || []).length ? 'block' : 'none';
  useShortNameBtn.style.display = suggestedCustomName ? 'block' : 'none';
  const blockDownload = !plan.ok && filteredImages.length > 0;
  if (!downloadBusy) downloadBtn.disabled = blockDownload;
}

// Listen for status progress updates and completion messages from content.js
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;

  if (msg.type === 'STATUS_UPDATE') {
    statusEl.innerText = msg.text;
    resetTimeoutTimer();
  } else if (msg.type === 'SCAN_COMPLETE') {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    scanBtn.disabled = false;

    if (Array.isArray(msg.result)) {
      allExtractedImages = msg.result;

      if (allExtractedImages.length === 0) {
        scanNotice = msg.notice || '';
        pendingPageUrls = Array.isArray(msg.pendingUrls) ? msg.pendingUrls.slice() : [];
        updateProbeButton();
        if (msg.lockedCount) {
          statusEl.innerText = `未找到可下載的圖片。已略過 ${msg.lockedCount} 個尚未解鎖的付費區塊。請先登入 Fantia，且目前的方案必須看得到這些內容。`;
        } else if (msg.notice) {
          statusEl.innerText = msg.notice;
        } else if (pageKind(currentPageUrl) === 'generic') {
          statusEl.innerText = '未找到可下載的原圖。';
        } else {
          statusEl.innerText = "未找到貼文圖片。";
        }
        filteredImages = [];
        previewContainer.style.display = 'none';
        downloadBtn.style.display = 'none';
        updateFolderUi();
        return;
      }

      scanNotice = msg.notice || '';
      pendingPageUrls = Array.isArray(msg.pendingUrls) ? msg.pendingUrls.slice() : [];
      updateProbeButton();
      applyFilterAndRender();
      if (msg.lockedCount) {
        statusEl.innerText += `（已略過 ${msg.lockedCount} 個未解鎖的付費區塊）`;
      }
    } else {
      statusEl.innerText = "掃瞄失敗：解析圖片資料格式錯誤。";
    }
  }
});

function resetTimeoutTimer() {
  if (timeoutTimer) clearTimeout(timeoutTimer);
  timeoutTimer = setTimeout(() => {
    statusEl.innerText = "掃瞄失敗：回應逾時，請重新整理頁面後再試。";
    scanBtn.disabled = false;
  }, 60000);
}

scanBtn.addEventListener('click', async () => {
  statusEl.innerText = "正在初始化掃瞄...";
  scanBtn.disabled = true;
  resetTimeoutTimer();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      throw new Error("無法存取當前分頁。");
    }

    const kind = pageKind(tab.url);
    if (!kind) {
      throw new Error("請先開啟 Patreon、Fantia，或含縮圖的圖庫頁面再執行掃瞄。");
    }
    downloadFolder = folderForKind(kind);
    noteActiveTab(tab);
    currentPageUrl = tab.url || '';
    scanNotice = '';
    pendingPageUrls = [];
    updateProbeButton();

    await chrome.storage.local.set({ autoLoad: autoLoadCb.checked });

    if (kind === 'generic') {
      const pattern = GalleryScan.originMatchPattern(tab.url);
      const has = await chrome.permissions.contains({ origins: [pattern] });
      if (!has) {
        await chrome.windows.create({
          url: chrome.runtime.getURL('permission.html')
            + '?tabId=' + encodeURIComponent(tab.id)
            + '&pageUrl=' + encodeURIComponent(tab.url),
          type: 'popup',
          width: 440,
          height: 340,
          focused: true
        });
        if (timeoutTimer) clearTimeout(timeoutTimer);
        statusEl.innerText = '請在跳出的視窗按「允許並掃瞄」。完成後再開啟這個面板，即可預覽與下載。';
        scanBtn.disabled = false;
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['gallery-scan.js', 'gallery-content.js']
      });
      return;
    }

    // Inject the scanner; content.js sends 'SCAN_COMPLETE' when done.
    // feed-autoload.js decides when a Patreon feed has actually finished.
    const files = kind === 'fantia' ? ['fantia.js', 'content.js'] : ['feed-autoload.js', 'patreon-media.js', 'content.js'];
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: files
    });
  } catch (err) {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    console.error("Scan error:", err);
    statusEl.innerText = "掃瞄失敗：" + err.message;
    scanBtn.disabled = false;
  }
});

function applyFilterAndRender() {
  if (allExtractedImages.length === 0) return;

  const minSize = parseInt(sizeFilter.value, 10);

  filteredImages = allExtractedImages.filter((img) => {
    if (globalThis.PatreonMedia && typeof PatreonMedia.passesMinSize === 'function') {
      return PatreonMedia.passesMinSize(img, minSize);
    }
    return (img.width === 0 && img.height === 0) || img.width >= minSize || img.height >= minSize;
  });

  statusEl.innerText = `找到 ${allExtractedImages.length} 張，篩選後剩餘 ${filteredImages.length} 張`;
  if (scanNotice) statusEl.innerText += '。' + scanNotice;
  countEl.innerText = filteredImages.length;

  if (filteredImages.length > 0) {
    downloadBtn.style.display = 'block';
  } else {
    downloadBtn.style.display = 'none';
  }

  previewContainer.innerHTML = '';
  previewContainer.style.display = 'block';

  const plan = currentPlan();
  filteredImages.forEach((img, index) => {
    const item = document.createElement('div');
    item.className = 'preview-item';
    const safeUrl = escapeHtml(img.url);
    const safeName = escapeHtml(img.filename);
    const folder = plan.folders && plan.folders[index] ? plan.folders[index] : '';
    const folderLine = folder
      ? `<span class="preview-size">${escapeHtml(downloadFolder + '/' + folder + '/')}</span>`
      : '';
    item.innerHTML = `
      <img src="${safeUrl}" />
      <div class="preview-info">
        <span class="preview-filename" title="${safeName}">${safeName}</span>
        ${folderLine}
        <span class="preview-size">${img.width > 0 ? `${img.width} ×${img.height} px` : '原圖 (未讀取解析度)'}</span>
      </div>
    `;
    previewContainer.appendChild(item);
  });
  updateFolderUi();
}

probeBtn.addEventListener('click', async () => {
  if (!pendingPageUrls.length || !currentPageUrl) return;
  probeBtn.disabled = true;
  try {
    await chrome.storage.session.set({
      galleryProbeRequest: {
        pageUrl: currentPageUrl,
        urls: pendingPageUrls.slice(),
        result: allExtractedImages.slice()
      }
    });
    await chrome.windows.create({
      url: chrome.runtime.getURL('permission.html')
        + '?mode=probe&tabId=' + encodeURIComponent('')
        + '&pageUrl=' + encodeURIComponent(currentPageUrl),
      type: 'popup',
      width: 440,
      height: 340,
      focused: true
    });
    statusEl.innerText = '請在跳出的視窗允許這些網站。確認完成後，這個面板會更新可下載的原圖。';
  } catch (err) {
    statusEl.innerText = '無法開啟授權視窗：' + err.message;
  }
  probeBtn.disabled = false;
});

function noteActiveTab(tab) {
  const nextId = tab && tab.id ? tab.id : 0;
  if (nextId !== currentTabId) refreshInjected = null;
  currentTabId = nextId;
}

// Runs in the Patreon tab, after patreon-media.js is injected. Numeric post
// and media ids are the only values turned into API paths. Signed query
// parameters stay on the download URL and are not written into the popup.
function pageRefreshDownloadUrls(requests) {
  const media = globalThis.PatreonMedia;
  if (!media || typeof media.refreshDownloadUrls !== 'function') {
    return Promise.resolve((requests || []).map(() => ''));
  }
  const rootCache = globalThis.__patreonUrlRefreshCache || (globalThis.__patreonUrlRefreshCache = {});
  function fetchJson(path) {
    if (Object.prototype.hasOwnProperty.call(rootCache, path) && rootCache[path]) {
      return Promise.resolve(rootCache[path]);
    }
    return fetch(path, {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/vnd.api+json' }
    }).then((res) => {
      if (!res.ok) return null;
      return res.json();
    }).then((json) => {
      if (json) rootCache[path] = json;
      return json || null;
    }).catch(() => null);
  }
  return media.refreshDownloadUrls(requests, fetchJson);
}

function startChromeDownload(request) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const returned = chrome.downloads.download({
        url: request.url,
        filename: request.filename,
        conflictAction: 'uniquify'
      }, (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err) finish({ ok: false, error: err.message || String(err) });
        else if (downloadId == null) finish({ ok: false, error: '下載沒有開始' });
        else finish({ ok: true, id: downloadId });
      });
      // Chrome calls the callback and may also return a promise. Firefox can
      // settle the promise when the callback does not run. The first result wins.
      if (returned && typeof returned.then === 'function') {
        returned.then((downloadId) => {
          if (downloadId == null) finish({ ok: false, error: '下載沒有開始' });
          else finish({ ok: true, id: downloadId });
        }, (err) => {
          finish({ ok: false, error: (err && err.message) || String(err) });
        });
      }
    } catch (e) {
      finish({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

function waitForChromeDownload(id) {
  return new Promise((resolve) => {
    if (id == null) {
      resolve({ ok: false, error: '下載沒有開始' });
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { chrome.downloads.onChanged.removeListener(onChanged); } catch (e) {}
      resolve(result);
    };
    const lookUp = (fallbackError) => {
      try {
        chrome.downloads.search({ id: id }, (items) => {
          void chrome.runtime.lastError;
          const item = items && items[0];
          if (!item) {
            if (fallbackError) finish({ ok: false, error: fallbackError });
            return;
          }
          if (item.state === 'complete') finish({ ok: true, mime: item.mime || '' });
          else if (item.state === 'interrupted') finish({ ok: false, error: item.error || fallbackError || 'interrupted' });
          else if (fallbackError) finish({ ok: false, error: fallbackError });
        });
      } catch (e) {
        if (fallbackError) finish({ ok: false, error: fallbackError });
      }
    };
    const onChanged = (delta) => {
      if (!delta || delta.id !== id) return;
      const state = delta.state && delta.state.current;
      if (delta.error && delta.error.current && state !== 'complete') {
        finish({ ok: false, error: String(delta.error.current) });
        return;
      }
      if (state === 'complete' || state === 'interrupted') lookUp(state === 'interrupted' ? 'interrupted' : '');
    };
    try { chrome.downloads.onChanged.addListener(onChanged); } catch (e) {}
    timer = setTimeout(() => lookUp('NETWORK_TIMEOUT'), 120000);
    lookUp('');
  });
}

function discardChromeDownload(id) {
  return new Promise((resolve) => {
    if (id == null || !chrome.downloads) {
      resolve();
      return;
    }
    try {
      chrome.downloads.cancel(id, () => {
        void chrome.runtime.lastError;
        try {
          chrome.downloads.erase({ id: id }, () => {
            void chrome.runtime.lastError;
            resolve();
          });
        } catch (e) {
          resolve();
        }
      });
    } catch (e) {
      resolve();
    }
  });
}

async function refreshPatreonItem(item) {
  if (!item || !item.canRefresh || !currentTabId) return '';
  if (pageKind(currentPageUrl) !== 'patreon') return '';
  try {
    if (!refreshInjected) {
      const tabId = currentTabId;
      refreshInjected = chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['patreon-media.js']
      }).catch((err) => {
        if (currentTabId === tabId) refreshInjected = null;
        throw err;
      });
    }
    await refreshInjected;
    const injected = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      func: pageRefreshDownloadUrls,
      args: [[{
        mediaId: item.mediaId || '',
        postId: item.postId || '',
        url: item.url || '',
        skipUrls: Array.isArray(item.skipUrls) ? item.skipUrls.slice(0, 8) : []
      }]]
    });
    const row = injected && injected[0] && injected[0].result;
    const fresh = Array.isArray(row) ? row[0] : '';
    return typeof fresh === 'string' ? fresh : '';
  } catch (e) {
    return '';
  }
}

downloadBtn.addEventListener('click', () => {
  if (filteredImages.length === 0 || downloadBusy) return;

  const plan = currentPlan();
  updateFolderUi();
  if (!plan.ok || !plan.paths || plan.paths.length !== filteredImages.length) {
    statusEl.innerText = '資料夾路徑過長，無法儲存。請縮短名稱後再下載。';
    return;
  }

  const batch = globalThis.DownloadBatch;
  if (!batch || typeof batch.runDownloadBatch !== 'function') {
    statusEl.innerText = '下載元件未載入，請重新載入擴充功能後再試。';
    return;
  }

  const kind = pageKind(currentPageUrl);
  const items = filteredImages.map((img, index) => ({
    url: img.url,
    filename: img.filename,
    path: plan.paths[index],
    mediaId: img.mediaId ? String(img.mediaId) : '',
    postId: img.postId ? String(img.postId) : '',
    canRefresh: kind === 'patreon' && !!(img.mediaId || img.postId)
  }));

  downloadBusy = true;
  downloadBtn.disabled = true;
  statusEl.innerText = `下載進度：0 / ${items.length}`;
  batch.runDownloadBatch(items, {
    concurrency: batch.DEFAULT_CONCURRENCY,
    download: startChromeDownload,
    wait: waitForChromeDownload,
    discard: discardChromeDownload,
    refreshUrl: refreshPatreonItem,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress: (progress) => {
      if (progress && progress.text) statusEl.innerText = progress.text;
    }
  }).then((result) => {
    downloadBusy = false;
    statusEl.innerText = result && result.text ? result.text : '所有圖片已成功下載！';
    updateFolderUi();
    try {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_COMPLETE' });
    } catch (e) {}
  }).catch((err) => {
    downloadBusy = false;
    const message = err && err.message ? err.message : '未知錯誤';
    statusEl.innerText = '下載失敗：' + message;
    updateFolderUi();
  });
});