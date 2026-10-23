(async () => {
  try {
    const result = [];
    const imagesSet = new Set();

    // Helper to send real-time progress/completion updates to popup safely
    function sendMessageSafely(msg) {
      try {
        const p = chrome.runtime.sendMessage(msg);
        if (p && typeof p.catch === 'function') {
          p.catch(() => {});
        }
      } catch (e) {}
    }

    function reportStatus(text) {
      sendMessageSafely({ type: 'STATUS_UPDATE', text: text });
    }

    // Helper function to safely sanitize OS filenames
    function sanitizeFilename(name) {
      if (!name) return '';
      return name.replace(/[\\/:\*\?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    }

    // Helper function to dynamically load real image dimensions
    function fetchDimensions(url) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({ width: 0, height: 0 });
        img.src = url;
      });
    }

    // Helper to extract original filename with CDN hash filter
    function extractFilename(url, attrName, postTitle, index) {
      let name = attrName;

      if (!name && url) {
        try {
          const urlPath = url.split('?')[0];
          const urlFileName = decodeURIComponent(urlPath.split('/').pop());
          const baseName = urlFileName.split('.')[0].toLowerCase();
          
          const isGeneric = !urlFileName || 
                            ['original', 'default', 'media', 'post'].includes(baseName) ||
                            /^\d+$/.test(baseName);

          if (!isGeneric) {
            name = urlFileName;
          }
        } catch (e) {}
      }

      if (name) {
        return sanitizeFilename(name);
      }

      const extMatch = url ? url.match(/\.(jpg|jpeg|png|webp|gif|svg)/i) : null;
      const ext = extMatch ? extMatch[0].toLowerCase() : '.jpg';
      const prefix = postTitle ? sanitizeFilename(postTitle) : 'Patreon_Media';
      return `${prefix}_${String(index).padStart(3, '0')}${ext}`;
    }

    // Helper to identify and filter out recommended/popular/sidebar post links
    function isUnwantedLink(a) {
      if (!a) return false;

      // 1. Direct ancestor tag checks for sidebar, footer, or recommendations
      if (a.closest('footer, aside, [data-tag="sidebar"], [data-tag="post-recommendations"], [data-tag="related-posts"], [data-tag="popular-posts"], [data-tag="more-posts"]')) {
        return true;
      }

      // 2. Check section headings for recommendation titles
      const sectionBlock = a.closest('section, div[data-tag], div[class*="Container"], div[class*="Grid"]');
      if (sectionBlock) {
        const headings = sectionBlock.querySelectorAll('h1, h2, h3, h4, h5');
        for (const h of headings) {
          const txt = (h.innerText || h.textContent || '').toLowerCase();
          if (
            txt.includes('popular post') || 
            txt.includes('related post') || 
            txt.includes('more post') || 
            txt.includes('you might like') || 
            txt.includes('recommended') ||
            txt.includes('popular products')
          ) {
            return true;
          }
        }
      }
      return false;
    }

    function isFantiaHost() {
      const host = location.hostname;
      return host === 'fantia.jp' || host.endsWith('.fantia.jp');
    }

    // Fantia: posts, photo-gallery / album images, and paid blocks the
    // current session can already see. Locked blocks are counted and skipped.
    async function scanFantiaPage() {
      const scan = globalThis.FantiaScan;
      if (!scan || typeof scan.collectFromPost !== 'function') {
        sendMessageSafely({
          type: 'SCAN_COMPLETE',
          result: [],
          lockedCount: 0,
          notice: 'Fantia 掃瞄元件未載入，請重新載入擴充功能後再試。'
        });
        return;
      }

      const result = [];
      const seen = new Set();
      let lockedCount = 0;
      let authFailed = false;
      const pathname = location.pathname;

      function absorb(collected) {
        if (!collected) return;
        lockedCount += collected.lockedCount || 0;
        (collected.images || []).forEach((image) => {
          const key = scan.dedupeKey(image.url, location.origin);
          if (!key || seen.has(key)) return;
          seen.add(key);
          result.push(image);
        });
      }

      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      const csrf = csrfMeta ? csrfMeta.getAttribute('content') : '';

      async function fetchJson(apiPath) {
        const res = await fetch(apiPath, {
          credentials: 'same-origin',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            ...(csrf ? { 'X-CSRF-Token': csrf } : {})
          }
        });
        if (res.status === 401 || res.status === 403) {
          authFailed = true;
          return null;
        }
        if (!res.ok) return null;
        return res.json();
      }

      function collectPostIds(doc) {
        const ids = new Set();
        const scope = doc.querySelector('#page') || doc.body;
        scope.querySelectorAll('a[href*="/posts/"]').forEach((anchor) => {
          if (anchor.closest('header, footer, aside, #breadcrumb')) return;
          const match = (anchor.getAttribute('href') || '').match(/\/posts\/(\d+)/);
          if (match) ids.add(match[1]);
        });
        return ids;
      }

      function nextPageHref(doc) {
        const anchor = doc.querySelector('a[rel="next"]');
        return anchor ? anchor.getAttribute('href') : '';
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

      function isRecognizedFantiaPath(path) {
        return /^\/posts\/\d+(?:\/|$)/.test(path)
          || /^\/fanclubs\/\d+\/backnumbers\/?$/.test(path)
          || /^\/fanclubs\/\d+\/?$/.test(path)
          || /^\/fanclubs\/\d+\/posts\/?$/.test(path);
      }

      async function scanSinglePost(postId) {
        reportStatus('正在獲取 Fantia 貼文圖片...');
        const json = await fetchJson('/api/v1/posts/' + postId);
        if (json && json.post) absorb(scan.collectFromPost(json.post, location.origin));
      }

      async function scanBacknumbers() {
        const params = new URLSearchParams(location.search);
        const rootEl = document.querySelector('#backnumbers-content');
        const planId = (params.get('plan') || (rootEl && rootEl.getAttribute('data-plan-id')) || '').trim();
        const month = (params.get('month') || (rootEl && rootEl.getAttribute('data-month')) || '').trim();
        const pageRaw = params.get('page') || (rootEl && rootEl.getAttribute('data-page')) || '1';
        if (!/^\d+$/.test(planId) || !/^\d{6}$/.test(month)) return;

        const storageData = await new Promise((resolve) => chrome.storage.local.get(['autoLoad'], resolve));
        const autoLoad = !!(storageData && storageData.autoLoad);
        let page = autoLoad ? 1 : Math.max(1, parseInt(pageRaw, 10) || 1);
        let guard = 0;

        while (guard < 40) {
          reportStatus(`正在讀取 Fantia 付費月份內容（第 ${page} 頁）...`);
          const json = await fetchJson(
            `/api/v1/fanclub/backnumbers/monthly_contents/plan/${planId}/month/${month}?page=${page}`
          );
          const backnumber = json && json.backnumber;
          if (!backnumber) break;
          absorb(scan.collectFromPost(backnumber, location.origin));
          guard += 1;
          if (!autoLoad || !backnumber.exist_next) break;
          page += 1;
        }
      }

      async function scanListing() {
        const storageData = await new Promise((resolve) => chrome.storage.local.get(['autoLoad'], resolve));
        const autoLoad = !!(storageData && storageData.autoLoad);
        reportStatus(autoLoad ? '正在展開 Fantia 貼文列表...' : '正在掃瞄這個 Fantia 頁面上的貼文...');

        const ids = collectPostIds(document);
        if (autoLoad) {
          let nextHref = nextPageHref(document);
          const seenPages = new Set([location.pathname + location.search]);
          let pageCount = 0;
          while (nextHref && pageCount < 20 && ids.size < 200) {
            let nextUrl;
            try {
              nextUrl = new URL(nextHref, location.origin);
            } catch (e) {
              break;
            }
            if (nextUrl.hostname !== location.hostname) break;
            const key = nextUrl.pathname + nextUrl.search;
            if (seenPages.has(key)) break;
            seenPages.add(key);
            pageCount += 1;
            reportStatus(`正在載入 Fantia 貼文列表（第 ${pageCount + 1} 頁，已找到 ${ids.size} 篇）...`);
            const res = await fetch(nextUrl.pathname + nextUrl.search, { credentials: 'same-origin' });
            if (!res.ok) break;
            const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
            const before = ids.size;
            collectPostIds(doc).forEach((id) => {
              if (ids.size < 200) ids.add(id);
            });
            if (ids.size === before) break;
            nextHref = nextPageHref(doc);
          }
        }

        const postIds = Array.from(ids);
        if (postIds.length === 0) return;
        reportStatus(`正在獲取 ${postIds.length} 篇 Fantia 貼文的圖片...`);
        let done = 0;
        await mapPool(postIds, 4, async (postId) => {
          const json = await fetchJson('/api/v1/posts/' + postId);
          if (json && json.post) absorb(scan.collectFromPost(json.post, location.origin));
          done += 1;
          if (done === postIds.length || done % 2 === 0) {
            reportStatus(`正在獲取 Fantia 貼文圖片（${done}/${postIds.length}）...`);
          }
        });
      }

      function collectDomImageUrls() {
        const urls = [];
        const scope = document.querySelector('main') || document.querySelector('#page') || document.body;
        scope.querySelectorAll('img, a[href]').forEach((el) => {
          if (el.closest('header, footer, aside, #header, #footer, #breadcrumb')) return;
          if (el.tagName === 'IMG' && /avatar|icon|logo|circle/i.test(el.className || '')) return;
          const raw = el.tagName === 'IMG'
            ? (el.currentSrc || el.getAttribute('data-src') || el.getAttribute('src') || '')
            : (el.getAttribute('href') || '');
          if (raw) urls.push(raw);
        });
        return urls;
      }

      const singlePost = pathname.match(/^\/posts\/(\d+)(?:\/|$)/);
      if (singlePost) {
        await scanSinglePost(singlePost[1]);
      } else if (/^\/fanclubs\/\d+\/backnumbers\/?$/.test(pathname)) {
        await scanBacknumbers();
      } else {
        await scanListing();
      }

      if (result.length === 0 && lockedCount === 0 && !authFailed && isRecognizedFantiaPath(pathname)) {
        reportStatus('正在備用掃瞄頁面上的 Fantia 圖片...');
        absorb(scan.collectFromImageUrls(collectDomImageUrls(), 'Fantia', location.origin));
      }

      if (result.length > 0) {
        reportStatus(`正在校正 ${result.length} 張圖片的真實尺寸...`);
        const batchSize = 5;
        for (let i = 0; i < result.length; i += batchSize) {
          const batch = result.slice(i, i + batchSize);
          reportStatus(`正在校正圖片尺寸 (${Math.min(i + batchSize, result.length)}/${result.length})...`);
          await Promise.all(batch.map(async (item) => {
            const dims = await fetchDimensions(item.url);
            if (dims.width > 0 && dims.height > 0) {
              item.width = dims.width;
              item.height = dims.height;
            }
          }));
        }
      }

      let notice = '';
      if (result.length === 0 && lockedCount === 0) {
        if (authFailed) {
          notice = '請先登入 Fantia。付費內容只會下載你已經可以觀看的圖片。';
        } else if (!isRecognizedFantiaPath(pathname)) {
          notice = '請開啟 Fantia 貼文、投稿列表（相簿）或已解鎖的付費內容頁面。';
        }
      }

      sendMessageSafely({
        type: 'SCAN_COMPLETE',
        result: result,
        lockedCount: lockedCount,
        notice: notice
      });
    }

    if (isFantiaHost()) {
      await scanFantiaPage();
      return;
    }

    // Check page mode: Single Post vs Feed
    const pathname = window.location.pathname;
    const singlePostMatch = pathname.match(/\/posts\/.*?-?(\d+)/) || pathname.match(/\/posts\/(\d+)/);
    const isSinglePostPage = !!(singlePostMatch && singlePostMatch[1]);

    // -------------------------------------------------------------
    // Step 0: Auto-Load ALL Posts (Feed pages only)
    // -------------------------------------------------------------
    async function autoLoadAllPosts() {
      let previousPostCount = 0;
      let noChangeCount = 0;
      const maxRetries = 3;
      const maxLoops = 100;

      for (let i = 0; i < maxLoops; i++) {
        const currentCount = document.querySelectorAll('a[href*="/posts/"]').length;
        reportStatus(`正在自動展開貼文 (已找到約 ${currentCount} 篇貼文)...`);

        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        await new Promise(r => setTimeout(r, 800));

        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'));
        const loadMoreBtn = buttons.find(b => {
          const txt = (b.innerText || b.textContent || '').toLowerCase();
          return (txt.includes('load more') || txt.includes('show more') || txt.includes('view more') || txt.includes('載入更多') || txt.includes('更多'))
                 && b.offsetParent !== null;
        });

        if (loadMoreBtn) {
          loadMoreBtn.click();
          await new Promise(r => setTimeout(r, 1200));
        }

        const updatedPostCount = document.querySelectorAll('a[href*="/posts/"]').length;
        if (updatedPostCount === previousPostCount && updatedPostCount > 0) {
          noChangeCount++;
          if (noChangeCount >= maxRetries) {
            reportStatus(`貼文已全部展開 (共 ${updatedPostCount} 篇)`);
            break;
          }
        } else {
          noChangeCount = 0;
          previousPostCount = updatedPostCount;
        }
      }
    }

    const storageData = await new Promise(resolve => chrome.storage.local.get(['autoLoad'], resolve));
    if (!isSinglePostPage && storageData && storageData.autoLoad) {
      await autoLoadAllPosts();
    }

    // -------------------------------------------------------------
    // Step 1: Detect Post IDs (Filtered mode)
    // -------------------------------------------------------------
    reportStatus("正在掃瞄頁面貼文 ID...");
    const postIds = new Set();

    if (isSinglePostPage) {
      // Single post page: Only process the main post ID, ignore bottom recommendation grids
      postIds.add(singlePostMatch[1]);
    } else {
      // Feed page: Process main stream post IDs and skip recommended ads
      const postLinks = document.querySelectorAll('a[href*="/posts/"]');
      postLinks.forEach(a => {
        if (isUnwantedLink(a)) return;
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/posts\/.*?-?(\d+)/) || href.match(/\/posts\/(\d+)/);
        if (match && match[1]) {
          postIds.add(match[1]);
        }
      });

      document.querySelectorAll('[data-post-id]').forEach(el => {
        if (isUnwantedLink(el)) return;
        const id = el.getAttribute('data-post-id');
        if (id) postIds.add(id);
      });
    }

    // -------------------------------------------------------------
    // Step 2: Fetch Patreon API for ALL detected Post IDs
    // -------------------------------------------------------------
    if (postIds.size > 0) {
      reportStatus(`正在獲取 ${postIds.size} 篇貼文的高解析度媒體資料...`);
      const postIdArray = Array.from(postIds);

      await Promise.all(postIdArray.map(async (postId) => {
        try {
          const apiRes = await fetch(`/api/posts/${postId}?include=media,attachments,post_file`, {
            headers: { 'Accept': 'application/vnd.api+json' }
          });

          if (!apiRes.ok) return;
          const json = await apiRes.json();

          const postTitle = json.data?.attributes?.title || '';
          let mediaIndex = 1;

          if (Array.isArray(json.included)) {
            json.included.forEach((item) => {
              if (item.type === 'media') {
                const attrs = item.attributes || {};
                const fullResUrl = attrs.download_url || attrs.image_urls?.original || attrs.image_urls?.default || attrs.url;

                if (fullResUrl) {
                  const urlBasePath = fullResUrl.split('?')[0];
                  if (!imagesSet.has(urlBasePath)) {
                    imagesSet.add(urlBasePath);

                    const originalName = attrs.file_name || attrs.name;
                    const filename = extractFilename(fullResUrl, originalName, postTitle, mediaIndex);

                    result.push({
                      url: fullResUrl,
                      filename: filename,
                      width: 0,
                      height: 0
                    });
                    mediaIndex++;
                  }
                }
              } else if (item.type === 'attachment') {
                const attrs = item.attributes || {};
                if (attrs.url) {
                  const urlBasePath = attrs.url.split('?')[0];
                  if (!imagesSet.has(urlBasePath)) {
                    imagesSet.add(urlBasePath);
                    const originalName = attrs.file_name || attrs.name;
                    const filename = extractFilename(attrs.url, originalName, postTitle, mediaIndex);

                    result.push({
                      url: attrs.url,
                      filename: filename,
                      width: 0,
                      height: 0
                    });
                    mediaIndex++;
                  }
                }
              }
            });
          }

          const postFile = json.data?.attributes?.post_file;
          if (postFile && postFile.url) {
            const urlBasePath = postFile.url.split('?')[0];
            if (!imagesSet.has(urlBasePath)) {
              imagesSet.add(urlBasePath);
              const filename = extractFilename(postFile.url, postFile.name, postTitle, mediaIndex);
              result.push({
                url: postFile.url,
                filename: filename,
                width: 0,
                height: 0
              });
              mediaIndex++;
            }
          }
        } catch (e) {
          console.warn(`Failed to fetch API for post ${postId}:`, e);
        }
      }));
    }

    // -------------------------------------------------------------
    // Step 3: Fallback DOM Scan
    // -------------------------------------------------------------
    if (result.length === 0) {
      reportStatus("正在備用掃瞄頁面 DOM 圖片...");
      let index = 1;
      const imgElements = document.querySelectorAll('img');
      imgElements.forEach((img) => {
        if (isUnwantedLink(img)) return;
        let src = img.currentSrc || img.src;
        if (src && (src.includes('patreonusercontent.com') || src.includes('pbs.twimg.com'))) {
          const urlBasePath = src.split('?')[0];
          if (!imagesSet.has(urlBasePath)) {
            imagesSet.add(urlBasePath);
            const filename = extractFilename(src, null, 'Patreon_Image', index);
            result.push({
              url: src,
              filename: filename,
              width: 0,
              height: 0
            });
            index++;
          }
        }
      });
    }

    // -------------------------------------------------------------
    // Step 4: Batched Real Dimension Calibration
    // -------------------------------------------------------------
    if (result.length > 0) {
      reportStatus(`正在校正 ${result.length} 張圖片的真實尺寸...`);
      const batchSize = 5;
      for (let i = 0; i < result.length; i += batchSize) {
        const batch = result.slice(i, i + batchSize);
        reportStatus(`正在校正圖片尺寸 (${Math.min(i + batchSize, result.length)}/${result.length})...`);
        await Promise.all(
          batch.map(async (item) => {
            const dims = await fetchDimensions(item.url);
            if (dims.width > 0 && dims.height > 0) {
              item.width = dims.width;
              item.height = dims.height;
            }
          })
        );
      }
    }

    // Send SCAN_COMPLETE message with extracted image array
    sendMessageSafely({ type: 'SCAN_COMPLETE', result: result });
  } catch (err) {
    console.error("Content script error:", err);
    sendMessageSafely({ type: 'SCAN_COMPLETE', result: [] });
  }
})();