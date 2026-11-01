const params = new URLSearchParams(location.search);
const pageUrl = params.get('pageUrl') || '';
const tabId = parseInt(params.get('tabId') || '', 10);
const mode = params.get('mode') || 'scan';
const explainEl = document.getElementById('explain');
const allowBtn = document.getElementById('allow');
const statusEl = document.getElementById('status');
let finished = false;

function hostLabel(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function uniquePatterns(urls) {
  const patterns = [];
  const seen = {};
  (urls || []).forEach((url) => {
    const pattern = GalleryScan.originMatchPattern(url);
    if (!pattern || seen[pattern]) return;
    seen[pattern] = true;
    patterns.push(pattern);
  });
  return patterns.slice(0, 10);
}

function sessionGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.get(keys, (data) => resolve(data || {}));
    } catch (e) {
      resolve({});
    }
  });
}

function sessionSet(value) {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.set(value, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

if (mode === 'probe') {
  allowBtn.textContent = '允許並確認';
  explainEl.textContent = '有些縮圖會開到其他網站的網頁。允許後只會留下確認是單張原圖的網址，網頁本身不會下載。';
} else {
  const host = hostLabel(pageUrl);
  explainEl.textContent = host
    ? '第一次掃瞄「' + host + '」時，需要你允許擴充功能讀取這個網站，才能找出縮圖對應的原圖。只會下載確認是圖片的網址，網頁、廣告和非圖片檔會略過。安裝時不會取得所有網站的權限。'
    : '第一次掃瞄這個網站時，需要你允許擴充功能讀取該網址，才能找出縮圖對應的原圖。安裝時不會取得所有網站的權限。';
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || finished || mode === 'probe') return;
  if (msg.type === 'STATUS_UPDATE' && msg.text) {
    statusEl.textContent = msg.text;
  } else if (msg.type === 'SCAN_COMPLETE') {
    finished = true;
    allowBtn.disabled = true;
    const count = Array.isArray(msg.result) ? msg.result.length : 0;
    const extra = msg.notice ? '\n' + msg.notice : '';
    statusEl.textContent = '掃瞄完成，找到 ' + count + ' 張原圖。請重新開啟工具列的下載面板，即可預覽與下載。' + extra;
  }
});

async function startScan() {
  if (!pageUrl || !tabId) {
    statusEl.textContent = '找不到要掃瞄的分頁，請回到原頁面再試一次。';
    return;
  }
  const pattern = GalleryScan.originMatchPattern(pageUrl);
  if (!pattern) {
    statusEl.textContent = '此頁面無法取得網站權限。';
    return;
  }
  allowBtn.disabled = true;
  statusEl.textContent = '正在向此網站要求權限...';
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch (err) {
    allowBtn.disabled = false;
    statusEl.textContent = '無法要求權限：' + (err && err.message ? err.message : '未知錯誤');
    return;
  }
  if (!granted) {
    allowBtn.disabled = false;
    statusEl.textContent = '未允許權限，已取消掃瞄。';
    return;
  }
  statusEl.textContent = '已允許，正在掃瞄縮圖...';
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['gallery-scan.js', 'gallery-content.js']
    });
  } catch (err) {
    statusEl.textContent = '掃瞄失敗：' + (err && err.message ? err.message : '未知錯誤');
    allowBtn.disabled = false;
  }
}

async function confirmOtherPages() {
  allowBtn.disabled = true;
  statusEl.textContent = '正在向這些網站要求權限...';
  const stored = await sessionGet(['galleryProbeRequest', 'galleryScan']);
  const request = stored.galleryProbeRequest || {};
  const urls = Array.isArray(request.urls) ? request.urls : [];
  const patterns = uniquePatterns(urls);
  if (!patterns.length) {
    statusEl.textContent = '沒有需要確認的網頁連結。';
    allowBtn.disabled = false;
    return;
  }
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: patterns });
  } catch (err) {
    allowBtn.disabled = false;
    statusEl.textContent = '無法要求權限：' + (err && err.message ? err.message : '未知錯誤');
    return;
  }
  if (!granted) {
    allowBtn.disabled = false;
    statusEl.textContent = '未允許權限，已略過這些網頁連結。';
    return;
  }
  statusEl.textContent = '正在確認這些網頁是不是單張原圖...';
  let response = null;
  try {
    response = await chrome.runtime.sendMessage({ type: 'GALLERY_PROBE_PAGES', urls: urls });
  } catch (err) {
    response = null;
  }
  if (!response || !response.ok) {
    allowBtn.disabled = false;
    statusEl.textContent = '無法確認這些網頁連結。';
    return;
  }
  const previous = stored.galleryScan || {};
  const records = Array.isArray(request.result)
    ? request.result.slice()
    : (Array.isArray(previous.result) ? previous.result.slice() : []);
  const have = {};
  records.forEach((img) => { if (img && img.url) have[img.url] = true; });
  (response.images || []).forEach((url) => {
    if (!url || have[url]) return;
    have[url] = true;
    records.push(GalleryScan.imageRecord(url, records.length, {
      postTitle: records[0] ? records[0].postTitle : ''
    }));
  });
  GalleryScan.uniqueFilenames(records);
  const pendingUrls = response.pendingUrls || [];
  const notice = GalleryScan.summaryNotice(response.skipped || 0, pendingUrls.length);
  await sessionSet({
    galleryScan: {
      pageUrl: request.pageUrl || previous.pageUrl || pageUrl,
      at: Date.now(),
      result: records,
      skippedCount: response.skipped || 0,
      pendingUrls: pendingUrls,
      notice: notice
    }
  });
  finished = true;
  allowBtn.disabled = true;
  statusEl.textContent = '確認完成，目前共 ' + records.length + ' 張原圖。請重新開啟下載面板後下載。' + (notice ? '\n' + notice : '');
}

allowBtn.addEventListener('click', () => {
  if (mode === 'probe') confirmOtherPages();
  else startScan();
});

setTimeout(() => {
  if (finished || !allowBtn.disabled) return;
  statusEl.textContent = '花費太久。請重新開啟下載面板再試一次。';
  allowBtn.disabled = false;
}, 90000);
