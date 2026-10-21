let allExtractedImages = [];
let filteredImages = [];
let timeoutTimer = null;

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
        statusEl.innerText = "未找到貼文圖片。";
        previewContainer.style.display = 'none';
        downloadBtn.style.display = 'none';
        return;
      }

      applyFilterAndRender();
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

    if (!tab.url || (!tab.url.includes("patreon.com"))) {
      throw new Error("請先開啟 Patreon 頁面再執行掃瞄。");
    }

    await chrome.storage.local.set({ autoLoad: autoLoadCb.checked });

    // Inject content.js script; content.js will send 'SCAN_COMPLETE' message when done
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
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
    item.innerHTML = `
      <img src="${img.url}" />
      <div class="preview-info">
        <span class="preview-filename" title="${img.filename}">${img.filename}</span>
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
      filename: `Patreon_Downloads/${img.filename}`,
      conflictAction: 'uniquify'
    }, () => {
      downloadedCount++;
      statusEl.innerText = `下載進度：${downloadedCount} / ${filteredImages.length}`;
      if (downloadedCount === filteredImages.length) {
        statusEl.innerText = "所有圖片已成功下載！";
        downloadBtn.disabled = false;
      }
    });
  });
});