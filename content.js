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