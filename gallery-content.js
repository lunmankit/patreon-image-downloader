// Runs in the gallery tab. Finds thumbnail controls and full-size URLs
// already in the DOM, keeps direct image URLs, and asks the background
// worker to probe pages that might be a single photo. Does not call
// window.open and does not create visible tabs. A page whose photo URL
// appears only after a client-side navigation is skipped.
(async () => {
  function send(msg) {
    try {
      const pending = chrome.runtime.sendMessage(msg);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (e) {}
  }

  function report(text) {
    send({ type: 'STATUS_UPDATE', text: text });
  }

  function fetchDimensions(url) {
    return new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve({ width: 0, height: 0 }), 4000);
      img.onload = () => {
        clearTimeout(timer);
        resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve({ width: 0, height: 0 });
      };
      img.src = url;
    });
  }

  async function mapPool(items, limit, worker) {
    let cursor = 0;
    const runners = [];
    const count = Math.min(limit, items.length);
    for (let i = 0; i < count; i++) {
      runners.push((async () => {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          await worker(items[index], index);
        }
      })());
    }
    await Promise.all(runners);
  }

  function probeUrls(urls) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => {
        finish({ ok: false, images: [], skipped: urls.length, pendingUrls: [] });
      }, 14000);
      try {
        chrome.runtime.sendMessage({ type: 'GALLERY_PROBE_PAGES', urls: urls }, (response) => {
          let failed = false;
          try { failed = !!(chrome.runtime.lastError); } catch (e) { failed = true; }
          if (failed || !response || !response.ok) {
            finish({ ok: false, images: [], skipped: urls.length, pendingUrls: [] });
            return;
          }
          finish(response);
        });
      } catch (e) {
        finish({ ok: false, images: [], skipped: urls.length, pendingUrls: [] });
      }
    });
  }

  async function probeInChunks(scan, urls) {
    const images = [];
    const pendingUrls = [];
    let skipped = 0;
    const seen = {};
    const chunkSize = 4;
    for (let i = 0; i < urls.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, urls.length);
      report('正在確認網頁連結 ' + (i + 1) + '-' + end + ' / ' + urls.length + '...');
      const part = await probeUrls(urls.slice(i, i + chunkSize));
      const found = part && part.images ? part.images : [];
      for (let j = 0; j < found.length; j++) {
        const key = scan.canonical(found[j]);
        if (!key || seen[key]) continue;
        seen[key] = true;
        images.push(found[j]);
      }
      skipped += part && part.skipped ? part.skipped : 0;
      const pending = part && part.pendingUrls ? part.pendingUrls : [];
      for (let j = 0; j < pending.length; j++) pendingUrls.push(pending[j]);
    }
    return { images: images, skipped: skipped, pendingUrls: pendingUrls };
  }

  try {
    const scan = globalThis.GalleryScan;
    if (!scan || typeof scan.collectOpeners !== 'function') {
      send({
        type: 'SCAN_COMPLETE',
        result: [],
        skippedCount: 0,
        pendingUrls: [],
        notice: '圖庫掃瞄元件未載入，請重新載入擴充功能後再試。',
        pageUrl: location.href
      });
      return;
    }

    report('正在掃瞄縮圖與原圖...');
    const openers = scan.collectOpeners(document);
    const resolved = scan.resolveOpeners(openers, location.href);
    let probe = { images: [], skipped: 0, pendingUrls: [] };
    if (resolved.probes.length) {
      probe = await probeInChunks(scan, resolved.probes);
    }

    const title = document.title ? String(document.title).trim() : '';
    // Probe results were accepted only after Content-Type or a single-photo
    // extract, so a .php viewer that returns image bytes stays in the list.
    const urls = resolved.images.concat(probe.images || []);
    const seen = {};
    const records = [];
    for (let i = 0; i < urls.length; i++) {
      const key = scan.canonical(urls[i]);
      if (!key || seen[key]) continue;
      seen[key] = true;
      records.push(scan.imageRecord(urls[i], records.length, { postTitle: title }));
    }
    scan.uniqueFilenames(records);

    if (records.length) {
      report('正在讀取圖片尺寸 0 / ' + records.length + '...');
      const batch = 4;
      let sized = 0;
      for (let i = 0; i < records.length; i += batch) {
        const slice = records.slice(i, i + batch);
        await mapPool(slice, batch, async (item) => {
          const dims = await fetchDimensions(item.url);
          item.width = dims.width || 0;
          item.height = dims.height || 0;
        });
        sized += slice.length;
        report('正在讀取圖片尺寸 ' + sized + ' / ' + records.length + '...');
      }
    }

    const skipped = (resolved.skipped || 0) + (probe.skipped || 0);
    const pendingUrls = probe.pendingUrls || [];
    const notice = scan.summaryNotice(skipped, pendingUrls.length, resolved.thumbs || 0);
    const stored = {
      pageUrl: location.href,
      at: Date.now(),
      result: records,
      skippedCount: skipped,
      pendingUrls: pendingUrls,
      notice: notice
    };
    try {
      await new Promise((resolve) => {
        chrome.storage.session.set({ galleryScan: stored }, () => {
          try { void chrome.runtime.lastError; } catch (e) {}
          resolve();
        });
      });
    } catch (e) {}

    send({
      type: 'SCAN_COMPLETE',
      result: records,
      skippedCount: skipped,
      pendingUrls: pendingUrls,
      notice: notice,
      pageUrl: location.href
    });
  } catch (err) {
    console.error('Gallery scan error:', err);
    send({
      type: 'SCAN_COMPLETE',
      result: [],
      skippedCount: 0,
      pendingUrls: [],
      notice: '掃瞄失敗：' + (err && err.message ? err.message : '未知錯誤'),
      pageUrl: location.href
    });
  }
})();
