let allExtractedImages = [];
let filteredImages = [];
let timeoutTimer = null;
let downloadFolder = 'Patreon_Downloads';

function pageKind(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === 'patreon.com' || host.endsWith('.patreon.com')) return 'patreon';
    if (host === 'fantia.jp' || host.endsWith('.fantia.jp')) return 'fantia';
  } catch (e) {}
  return '';
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
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const previewContainer = document.getElementById('preview-container');

// Load saved filter and auto-load preferences
const savedSize = localStorage.getItem('patreon_min_size') || '400';
sizeFilter.value = savedSize;
sizeVal.innerText = `${savedSize} px`;

chrome.storage.local.get(['autoLoad'], (result) => {
  if (result.autoLoad !== undefined) {
    autoLoadCb.checked = result.autoLoad;
  }
});

// Reflect site-supported status on the toolbar icon when popup opens
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  if (!tab) return;
  const supported = pageKind(tab.url) !== '';
  chrome.runtime.sendMessage({
    type: 'SET_ICON_STATE',
    state: supported ? 'supported' : 'default',
    tabId: tab.id
  });
});

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
        if (msg.lockedCount) {
          statusEl.innerText = `未找到可下載的圖片。已略過 ${msg.lockedCount} 個尚未解鎖的付費區塊。請先登入 Fantia，且目前的方案必須看得到這些內容。`;
        } else if (msg.notice) {
          statusEl.innerText = msg.notice;
        } else {
          statusEl.innerText = "未找到貼文圖片。";
        }
        previewContainer.style.display = 'none';
        downloadBtn.style.display = 'none';
        return;
      }

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
      throw new Error("請先開啟 Patreon 或 Fantia 頁面再執行掃瞄。");
    }
    downloadFolder = kind === 'fantia' ? 'Fantia_Downloads' : 'Patreon_Downloads';

    await chrome.storage.local.set({ autoLoad: autoLoadCb.checked });

    // Inject the scanner; content.js sends 'SCAN_COMPLETE' when done.
    // Patreon keeps the original single-file injection.
    const files = kind === 'fantia' ? ['fantia.js', 'content.js'] : ['content.js'];
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

  filteredImages = allExtractedImages.filter(img => 
    (img.width === 0 && img.height === 0) || img.width >= minSize || img.height >= minSize
  );

  statusEl.innerText = `找到 ${allExtractedImages.length} 張，篩選後剩餘 ${filteredImages.length} 張`;
  countEl.innerText = filteredImages.length;

  if (filteredImages.length > 0) {
    downloadBtn.style.display = 'block';
  } else {
    downloadBtn.style.display = 'none';
  }

  previewContainer.innerHTML = '';
  previewContainer.style.display = 'block';

  filteredImages.forEach((img) => {
    const item = document.createElement('div');
    item.className = 'preview-item';
    const safeUrl = escapeHtml(img.url);
    const safeName = escapeHtml(img.filename);
    item.innerHTML = `
      <img src="${safeUrl}" />
      <div class="preview-info">
        <span class="preview-filename" title="${safeName}">${safeName}</span>
        <span class="preview-size">${img.width > 0 ? `${img.width} ×${img.height} px` : '原圖 (未讀取解析度)'}</span>
      </div>
    `;
    previewContainer.appendChild(item);
  });
}

downloadBtn.addEventListener('click', () => {
  if (filteredImages.length === 0) return;

  downloadBtn.disabled = true;
  let downloadedCount = 0;

  filteredImages.forEach((img) => {
    chrome.downloads.download({
      url: img.url,
      filename: `${downloadFolder}/${img.filename}`,
      conflictAction: 'uniquify'
    }, () => {
      downloadedCount++;
      statusEl.innerText = `下載進度：${downloadedCount} / ${filteredImages.length}`;
      if (downloadedCount === filteredImages.length) {
        statusEl.innerText = "所有圖片已成功下載！";
        downloadBtn.disabled = false;
        try {
          chrome.runtime.sendMessage({ type: 'DOWNLOAD_COMPLETE' });
        } catch (e) {}
      }
    });
  });
});