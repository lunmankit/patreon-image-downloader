(async () => {
  try {
    const result = [];

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

    function imageRecord(url, filename, meta) {
      const info = meta || {};
      return {
        url: url,
        filename: filename,
        width: 0,
        height: 0,
        postId: info.postId ? String(info.postId) : '',
        postTitle: info.postTitle ? String(info.postTitle) : '',
        postDate: info.postDate ? String(info.postDate) : ''
      };
    }

    // Helper to identify and filter out recommended/popular/sidebar post links.
    // A header, footer, or "see more posts" line inside a post card is part of
    // that post. Dropping it used to throw away the permalink once the card
    // unmounted, so the post still counted as found and its photos never downloaded.
    function isUnwantedLink(a) {
      if (!a || !a.closest) return false;

      const marker = a.closest('footer, aside, [data-tag="sidebar"], [data-tag="post-recommendations"], [data-tag="related-posts"], [data-tag="popular-posts"], [data-tag="more-posts"]');
      if (marker && !marker.closest('[data-tag="post-card"]')) return true;

      const card = a.closest('[data-tag="post-card"]');
      const sectionBlock = a.closest('section, div[data-tag], div[class*="Container"], div[class*="Grid"]');
      if (!sectionBlock) return false;
      if (card && (sectionBlock === card || (typeof card.contains === 'function' && card.contains(sectionBlock)))) {
        return false;
      }

      const headings = sectionBlock.querySelectorAll('h1, h2, h3, h4, h5');
      for (const h of headings) {
        const txt = h.innerText || h.textContent || '';
        if (globalThis.FeedAutoLoad && typeof FeedAutoLoad.isRecommendationHeading === 'function') {
          if (FeedAutoLoad.isRecommendationHeading(txt)) return true;
        } else {
          const lower = txt.toLowerCase();
          if (
            lower.includes('popular post') ||
            lower.includes('related post') ||
            lower.includes('you might like') ||
            lower.includes('recommended') ||
            lower.includes('popular products')
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

      function absorb(collected, postId) {
        if (!collected) return;
        lockedCount += collected.lockedCount || 0;
        (collected.images || []).forEach((image) => {
          const key = scan.dedupeKey(image.url, location.origin);
          if (!key || seen.has(key)) return;
          seen.add(key);
          if (postId && image && !image.postId) image.postId = String(postId);
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
        if (json && json.post) absorb(scan.collectFromPost(json.post, location.origin), postId);
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
          if (json && json.post) absorb(scan.collectFromPost(json.post, location.origin), postId);
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
    const singlePostId = (globalThis.FeedAutoLoad && typeof FeedAutoLoad.postIdFromHref === 'function')
      ? FeedAutoLoad.postIdFromHref(pathname)
      : '';
    const isSinglePostPage = !!singlePostId;

    // -------------------------------------------------------------
    // Step 0: Auto-Load ALL Posts (Feed / creator pages only)
    // -------------------------------------------------------------
    // Patreon returns about 20 posts per page. Keep stepping the window to
    // the bottom and clicking the tail control until several passes add no
    // posts. One jump plus two quiet rounds stopped on the first page.
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function classText(el) {
      if (!el) return '';
      if (typeof el.className === 'string') return el.className;
      if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
      return el.getAttribute('class') || '';
    }

    function isPageChrome(el) {
      if (globalThis.FeedAutoLoad && typeof FeedAutoLoad.isSiteChrome === 'function') {
        return FeedAutoLoad.isSiteChrome(el);
      }
      return !!(el && el.closest && el.closest('header, nav, aside'));
    }

    function isIgnoredRegion(el) {
      if (!el || !el.closest) return false;
      if (isPageChrome(el)) return true;
      return isUnwantedLink(el);
    }

    function followsElement(anchor, el) {
      if (!anchor || !el || !anchor.compareDocumentPosition) return true;
      return (anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }

    function isVisible(el) {
      if (!el || el.isConnected === false) return false;
      if (el.hidden) return false;
      let style = null;
      try {
        style = window.getComputedStyle(el);
      } catch (e) {}
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 8 && rect.height >= 8;
    }

    function feedPostCards() {
      return Array.from(document.querySelectorAll('[data-tag="post-card"]')).filter((el) => {
        return !isIgnoredRegion(el);
      });
    }

    function collectFeedPostIds() {
      const Feed = globalThis.FeedAutoLoad;
      const ids = [];
      const seen = new Set();
      function add(id) {
        if (!id) return;
        const value = String(id);
        if (!value || seen.has(value)) return;
        seen.add(value);
        ids.push(value);
      }
      feedPostCards().forEach((card) => {
        add(card.getAttribute('data-post-id'));
        const links = card.querySelectorAll('a[href*="/posts/"]');
        for (let i = 0; i < links.length; i++) {
          if (isIgnoredRegion(links[i])) continue;
          add(Feed.postIdFromHref(links[i].getAttribute('href')));
        }
      });
      document.querySelectorAll('a[href*="/posts/"]').forEach((anchor) => {
        if (isIgnoredRegion(anchor)) return;
        if (anchor.closest('[data-tag="post-card"]')) return;
        add(Feed.postIdFromHref(anchor.getAttribute('href')));
      });
      document.querySelectorAll('[data-post-id]').forEach((el) => {
        if (isIgnoredRegion(el)) return;
        add(el.getAttribute('data-post-id'));
      });
      return ids;
    }

    function activatableControl(el) {
      if (!el || !el.closest) return null;
      const target = el.closest('button, [role="button"], a');
      if (!target || isPageChrome(target)) return null;
      if (target.closest('[data-tag="post-card"]')) return null;
      if (target.disabled || target.getAttribute('aria-disabled') === 'true') return null;
      if (String(target.tagName).toUpperCase() === 'A') {
        const href = (target.getAttribute('href') || '').trim();
        if (href && href !== '#' && href.toLowerCase().indexOf('javascript:') !== 0) return null;
      }
      if (!isVisible(target)) return null;
      return target;
    }

    function countRawPostLinks() {
      const Feed = globalThis.FeedAutoLoad;
      let count = 0;
      const anchors = document.querySelectorAll('a[href*="/posts/"]');
      for (let i = 0; i < anchors.length; i++) {
        if (isPageChrome(anchors[i])) continue;
        if (Feed.postIdFromHref(anchors[i].getAttribute('href'))) count += 1;
      }
      return count;
    }

    function scanFeedTail() {
      const Feed = globalThis.FeedAutoLoad;
      const cards = feedPostCards();
      const firstCard = cards.length ? cards[0] : null;
      const selector = [
        'button',
        '[role="button"]',
        'a',
        'svg',
        '[role="progressbar"]',
        '[data-tag*="loading"]',
        '[data-tag*="Loading"]',
        '[class*="LoadingSpinner"]'
      ].join(', ');
      const candidates = document.querySelectorAll(selector);
      let busy = false;
      let hasStrongLoadMore = false;
      const loadMoreEls = [];
      const seenControls = new Set();
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (el.closest('[data-tag="post-card"]')) continue;
        if (isPageChrome(el)) continue;
        if (firstCard && !followsElement(firstCard, el)) continue;
        if (!isVisible(el)) continue;
        const info = {
          ariaLabel: el.getAttribute('aria-label') || '',
          text: el.innerText || el.textContent || '',
          dataTag: el.getAttribute('data-tag') || '',
          className: classText(el),
          tagName: el.tagName || '',
          role: el.getAttribute('role') || ''
        };
        if (Feed.isLoadingSignal(info)) busy = true;
        const clickable = activatableControl(el);
        if (!clickable || seenControls.has(clickable)) continue;
        if (firstCard && !followsElement(firstCard, clickable)) continue;
        const label = (clickable.getAttribute('aria-label') || '') + ' ' + (clickable.innerText || clickable.textContent || '');
        const dataTag = (clickable.getAttribute('data-tag') || '') + ' ' + info.dataTag;
        const tailLabel = Feed.isFeedLoadMoreLabel(label, true) || Feed.isLoadMoreDataTag(dataTag);
        if (!tailLabel) continue;
        seenControls.add(clickable);
        loadMoreEls.push(clickable);
        if (Feed.isFeedLoadMoreLabel(label, false) || Feed.isLoadMoreDataTag(dataTag)) {
          hasStrongLoadMore = true;
        }
      }
      return {
        busy: busy,
        hasLoadMore: hasStrongLoadMore,
        loadMoreEl: loadMoreEls.length ? loadMoreEls[loadMoreEls.length - 1] : null,
        loadMoreEls: loadMoreEls,
        postCardCount: cards.length,
        rawPostLinks: countRawPostLinks()
      };
    }

    function clickTailLoadMore() {
      const tail = scanFeedTail();
      const els = tail.loadMoreEls || [];
      for (let i = 0; i < els.length; i++) {
        try { els[i].click(); } catch (e) {}
      }
      return tail;
    }

    function feedMutationMatters(record) {
      const targetNode = record.target;
      const target = targetNode && targetNode.nodeType === 1
        ? targetNode
        : targetNode && targetNode.parentElement;
      if (!target || !target.closest) return true;
      if (isIgnoredRegion(target)) return false;
      if (target.closest('[data-tag="post-card"]')) return false;
      const added = record.addedNodes ? record.addedNodes.length : 0;
      const removed = record.removedNodes ? record.removedNodes.length : 0;
      return added + removed > 0;
    }

    function pageScrollHeight() {
      const bodyHeight = document.body ? document.body.scrollHeight : 0;
      const rootHeight = document.documentElement ? document.documentElement.scrollHeight : 0;
      const scrolling = document.scrollingElement ? document.scrollingElement.scrollHeight : 0;
      return Math.max(bodyHeight, rootHeight, scrolling, 0);
    }

    function scrollWindowTo(top) {
      const scrollingElement = document.scrollingElement || document.documentElement;
      try { scrollingElement.scrollTop = top; } catch (e) {}
      if (document.body && document.body !== scrollingElement) {
        try { document.body.scrollTop = top; } catch (e) {}
      }
      try { window.scrollTo(0, top); } catch (e) {}
      try { window.dispatchEvent(new Event('scroll')); } catch (e) {}
    }

    function findScrollableContainers() {
      const nodes = [];
      const root = document.body;
      if (!root || !root.querySelectorAll) return nodes;
      const all = root.querySelectorAll('main, section, div');
      for (let i = 0; i < all.length && nodes.length < 6; i++) {
        const el = all[i];
        if (el.scrollHeight < el.clientHeight + 160) continue;
        let overflowY = '';
        try { overflowY = window.getComputedStyle(el).overflowY; } catch (e) { continue; }
        if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') continue;
        nodes.push(el);
      }
      return nodes;
    }

    function scrollContainersBy(nodes, distance) {
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        try {
          const max = Math.max(0, el.scrollHeight - el.clientHeight);
          el.scrollTop = Math.min(max, el.scrollTop + distance);
        } catch (e) {}
      }
    }

    function pinContainers(nodes) {
      for (let i = 0; i < nodes.length; i++) {
        try { nodes[i].scrollTop = nodes[i].scrollHeight; } catch (e) {}
      }
    }

    async function scrollFeedToEnd() {
      const view = window.innerHeight || 800;
      const step = Math.max(320, Math.floor(view * 0.85));
      const scrollers = findScrollableContainers();
      const cards = feedPostCards();
      const anchor = cards.length ? cards[cards.length - 1] : document.querySelector('main');
      if (anchor && anchor.scrollIntoView) {
        try {
          anchor.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'instant' });
        } catch (e) {}
      }
      // Already at the bottom: step back up so the next-page sentinel can enter again.
      const maxTop = Math.max(0, pageScrollHeight() - view);
      const here = window.scrollY || 0;
      if (maxTop - here < 80) {
        scrollWindowTo(Math.max(0, maxTop - Math.min(view, 1000)));
        scrollContainersBy(scrollers, -Math.min(view, 1000));
        await sleep(140);
      }
      for (let i = 0; i < 36; i++) {
        const top = window.scrollY || 0;
        const dest = Math.max(0, pageScrollHeight() - view);
        if (top >= dest - 8) break;
        scrollWindowTo(Math.min(dest, top + step));
        scrollContainersBy(scrollers, step);
        await sleep(90);
      }
      scrollWindowTo(pageScrollHeight());
      pinContainers(scrollers);
      await sleep(80);
      scrollWindowTo(pageScrollHeight());
      pinContainers(scrollers);
    }

    function watchFeedResources() {
      const net = {
        stamp: 0,
        at: 0,
        disconnect() {}
      };
      if (typeof PerformanceObserver !== 'function' || !globalThis.FeedAutoLoad) return net;
      try {
        const observer = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!globalThis.FeedAutoLoad.isFeedResource(entry.name, entry.initiatorType)) continue;
            net.stamp += 1;
            net.at = Date.now();
          }
        });
        observer.observe({ type: 'resource', buffered: false });
        net.disconnect = function () {
          try { observer.disconnect(); } catch (e) {}
        };
      } catch (e) {}
      return net;
    }

    async function waitForFeedSettle(net, announce) {
      const Feed = globalThis.FeedAutoLoad;
      const limits = Feed.LIMITS;
      const baselineIds = new Set(collectFeedPostIds());
      const baselineCards = feedPostCards().length;
      const baselineRaw = countRawPostLinks();
      let lastActivity = Date.now();
      let lastPin = Date.now();
      let resourceStamp = net.stamp;
      const started = Date.now();
      const observer = new MutationObserver((records) => {
        for (let i = 0; i < records.length; i++) {
          if (feedMutationMatters(records[i])) {
            lastActivity = Date.now();
            return;
          }
        }
      });
      const root = document.body || document.documentElement;
      if (root) observer.observe(root, { childList: true, subtree: true });

      let latest = scanFeedTail();
      try {
        for (;;) {
          await sleep(200);
          if (net.stamp !== resourceStamp) {
            resourceStamp = net.stamp;
            lastActivity = Date.now();
          }
          latest = scanFeedTail();
          const ids = collectFeedPostIds();
          const rawNow = countRawPostLinks();
          let grewDuringWait = latest.postCardCount > baselineCards || rawNow > baselineRaw;
          if (!grewDuringWait) {
            for (let i = 0; i < ids.length; i++) {
              if (!baselineIds.has(ids[i])) {
                grewDuringWait = true;
                break;
              }
            }
          }
          const elapsed = Date.now() - started;
          const quietFor = Date.now() - lastActivity;
          if (Date.now() - lastPin >= 700) {
            lastPin = Date.now();
            scrollWindowTo(pageScrollHeight());
            if (latest.loadMoreEl) {
              try { latest.loadMoreEl.click(); } catch (e) {}
            }
          }
          if (latest.busy) announce(true);
          if (elapsed >= limits.maxSettleMs) break;
          if (latest.busy) continue;
          if (quietFor < limits.quietMs) continue;
          if (grewDuringWait) break;
          if (elapsed >= limits.minObserveMs) break;
        }
      } finally {
        observer.disconnect();
      }

      const quietFor = Date.now() - lastActivity;
      return {
        postIds: collectFeedPostIds(),
        postCardCount: latest.postCardCount,
        rawPostLinks: countRawPostLinks(),
        hasLoadMore: latest.hasLoadMore,
        busy: !!(latest.busy || quietFor < limits.quietMs)
      };
    }

    let seenCardImages = (globalThis.PatreonMedia && typeof PatreonMedia.createSeenImages === 'function')
      ? PatreonMedia.createSeenImages()
      : null;

    function cardPostId(card) {
      if (!card) return '';
      const direct = card.getAttribute('data-post-id');
      if (direct) return String(direct);
      if (!globalThis.FeedAutoLoad) return '';
      const links = card.querySelectorAll('a[href*="/posts/"]');
      for (let i = 0; i < links.length; i++) {
        if (isIgnoredRegion(links[i])) continue;
        const id = FeedAutoLoad.postIdFromHref(links[i].getAttribute('href'));
        if (id) return id;
      }
      return '';
    }

    function rememberVisiblePostImages() {
      if (!seenCardImages || !globalThis.PatreonMedia) return;
      feedPostCards().forEach((card) => {
        const urls = [];
        const images = card.querySelectorAll('img');
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          const found = globalThis.PatreonMedia
            ? PatreonMedia.urlsFromImageFields({
              currentSrc: img.currentSrc,
              src: img.getAttribute('src') || '',
              dataSrc: img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '',
              dataOriginal: img.getAttribute('data-original') || '',
              srcset: img.getAttribute('srcset') || '',
              dataSrcset: img.getAttribute('data-srcset') || ''
            })
            : [];
          for (let u = 0; u < found.length; u++) urls.push(found[u]);
        }
        seenCardImages = PatreonMedia.rememberImages(seenCardImages, cardPostId(card), urls);
      });
    }

    async function autoLoadAllPosts() {
      const Feed = globalThis.FeedAutoLoad;
      const limits = Feed.LIMITS;
      const net = watchFeedResources();
      rememberVisiblePostImages();
      let state = Feed.notePosts(
        Feed.initialState(),
        collectFeedPostIds(),
        feedPostCards().length,
        countRawPostLinks()
      );
      let lastReportAt = 0;
      let lastReportText = '';

      function announce(extraBusy) {
        const ids = collectFeedPostIds();
        const cards = feedPostCards().length;
        const count = Feed.foundCount(state, ids, cards);
        const busy = !!(extraBusy || state.loading);
        const text = busy
          ? `正在自動展開貼文 (已找到 ${count} 篇，貼文仍在載入)...`
          : `正在自動展開貼文 (已找到 ${count} 篇)...`;
        const now = Date.now();
        if (text === lastReportText && now - lastReportAt < 2000) return;
        lastReportText = text;
        lastReportAt = now;
        reportStatus(text);
      }

      try {
        while (!state.done && state.loops < limits.maxLoops) {
          rememberVisiblePostImages();
          announce(false);
          await scrollFeedToEnd();
          clickTailLoadMore();
          const observation = await waitForFeedSettle(net, announce);
          state = Feed.decide(state, observation);
          rememberVisiblePostImages();
        }
      } finally {
        rememberVisiblePostImages();
        net.disconnect();
      }

      const count = Feed.foundCount(state, collectFeedPostIds(), feedPostCards().length);
      if (!state.done) {
        reportStatus(`貼文展開已達上限 (已找到 ${count} 篇)，繼續獲取目前貼文...`);
      } else {
        reportStatus(`貼文已全部展開 (共 ${count} 篇)`);
      }
      return state.seenIds || [];
    }

    let rememberedFeedIds = [];
    const storageData = await new Promise(resolve => chrome.storage.local.get(['autoLoad'], resolve));
    if (!isSinglePostPage && storageData && storageData.autoLoad) {
      if (!globalThis.FeedAutoLoad) {
        reportStatus('自動展開元件未載入，改為掃瞄目前畫面上的貼文。');
      } else {
        try {
          rememberedFeedIds = await autoLoadAllPosts() || [];
        } catch (e) {
          console.warn('Auto-load failed:', e);
          reportStatus('自動展開中斷，改為掃瞄目前畫面上的貼文...');
        }
      }
    }

    // -------------------------------------------------------------
    // Step 1: Detect Post IDs (Filtered mode)
    // -------------------------------------------------------------
    reportStatus("正在掃瞄頁面貼文 ID...");
    const postIds = new Set();

    if (isSinglePostPage) {
      // Single post page: Only process the main post ID, ignore bottom recommendation grids
      postIds.add(singlePostId);
    } else {
      // Feed page: Process main stream post IDs and skip recommended ads.
      // Card title links live in the card's own header; isIgnoredRegion keeps those.
      const postLinks = document.querySelectorAll('a[href*="/posts/"]');
      postLinks.forEach(a => {
        if (isIgnoredRegion(a)) return;
        const id = globalThis.FeedAutoLoad
          ? FeedAutoLoad.postIdFromHref(a.getAttribute('href') || '')
          : '';
        if (id) postIds.add(id);
      });

      document.querySelectorAll('[data-post-id]').forEach(el => {
        if (isIgnoredRegion(el)) return;
        const id = el.getAttribute('data-post-id');
        if (id) postIds.add(id);
      });

      // Ids seen while paging, including ones a virtualized list has since unmounted.
      rememberedFeedIds.forEach((id) => {
        if (id) postIds.add(String(id));
      });
    }

    function pushCollected(item) {
      if (!item || !item.url || !globalThis.PatreonMedia) return;
      const filename = extractFilename(
        item.url,
        item.name || '',
        item.postTitle || '',
        result.length + 1
      );
      PatreonMedia.absorbInto(result, {
        url: item.url,
        filename: filename,
        width: item.width || 0,
        height: item.height || 0,
        postId: item.postId ? String(item.postId) : '',
        postTitle: item.postTitle ? String(item.postTitle) : '',
        postDate: item.postDate ? String(item.postDate) : ''
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

    async function fetchJsonRetry(url, label) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const apiRes = await fetch(url, {
            headers: { 'Accept': 'application/vnd.api+json' }
          });
          if (apiRes.status === 429 || apiRes.status === 408 || apiRes.status >= 500) {
            await sleep(400 * (attempt + 1));
            continue;
          }
          if (!apiRes.ok) return null;
          const json = await apiRes.json();
          if (json && json.errors && !json.data) {
            await sleep(400 * (attempt + 1));
            continue;
          }
          return json;
        } catch (e) {
          if (attempt === 3) console.warn(`Failed to fetch ${label}:`, e);
          await sleep(400 * (attempt + 1));
        }
      }
      return null;
    }

    function fetchPostJson(postId) {
      return fetchJsonRetry(
        `/api/posts/${postId}?include=media,images,attachments,attachments_media,post_file`,
        'post ' + postId
      );
    }

    function fetchMediaJson(mediaId) {
      return fetchJsonRetry('/api/media/' + mediaId, 'media ' + mediaId);
    }

    // -------------------------------------------------------------
    // Step 2: Fetch Patreon API for ALL detected Post IDs
    // -------------------------------------------------------------
    if (postIds.size > 0) {
      if (!globalThis.PatreonMedia) {
        reportStatus('媒體解析元件未載入，請重新載入擴充功能後再試。');
      } else {
        reportStatus(`正在獲取 ${postIds.size} 篇貼文的高解析度媒體資料...`);
        const postIdArray = Array.from(postIds);
        let incompletePosts = 0;
        await mapPool(postIdArray, 3, async (postId) => {
          const json = await fetchPostJson(postId);
          if (!json) {
            incompletePosts += 1;
            return;
          }
          if (!json.data) json.data = {};
          if (!json.data.id) json.data.id = postId;
          const attributes = json.data.attributes || {};
          const found = PatreonMedia.collectPostImages(json);
          const missing = PatreonMedia.mediaIdsToFetch(json, found);
          for (let m = 0; m < missing.length; m++) {
            const mediaJson = await fetchMediaJson(missing[m]);
            const resource = mediaJson && (mediaJson.data || mediaJson);
            if (!resource || !resource.attributes) continue;
            const extra = PatreonMedia.collectPostImages({
              data: {
                id: postId,
                attributes: {
                  title: attributes.title || '',
                  published_at: attributes.published_at || attributes.created_at || ''
                }
              },
              included: [resource]
            });
            for (let e = 0; e < extra.length; e++) PatreonMedia.absorbInto(found, extra[e]);
          }
          for (let i = 0; i < found.length; i++) pushCollected(found[i]);
        });
        if (incompletePosts > 0) {
          reportStatus(`有 ${incompletePosts} 篇貼文暫時無法取得完整圖片，已先保留目前找得到的照片。`);
        }
      }
    }

    // -------------------------------------------------------------
    // Step 3: Photos remembered from cards that have since unmounted,
    // plus whatever is still on screen. A resized card image does not
    // replace the original the API already kept.
    // -------------------------------------------------------------
    if (globalThis.PatreonMedia) {
      const seenCount = seenCardImages && seenCardImages.items ? seenCardImages.items.length : 0;
      if (result.length === 0) {
        reportStatus('正在備用掃瞄頁面 DOM 圖片...');
      } else if (seenCount > 0) {
        reportStatus('正在補上已展開貼文裡的圖片...');
      }
      if (seenCardImages && seenCardImages.items) {
        for (let i = 0; i < seenCardImages.items.length; i++) {
          const seen = seenCardImages.items[i];
          pushCollected({ url: seen.url, postId: seen.postId });
        }
      }
      const imgElements = document.querySelectorAll('img');
      imgElements.forEach((img) => {
        if (isUnwantedLink(img)) return;
        const card = img.closest('[data-tag="post-card"]');
        const postId = card ? cardPostId(card) : '';
        if (isSinglePostPage && postId && postId !== singlePostId) return;
        const urls = PatreonMedia.urlsFromImageFields({
          currentSrc: img.currentSrc,
          src: img.getAttribute('src') || '',
          dataSrc: img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '',
          dataOriginal: img.getAttribute('data-original') || '',
          srcset: img.getAttribute('srcset') || '',
          dataSrcset: img.getAttribute('data-srcset') || ''
        });
        for (let u = 0; u < urls.length; u++) {
          if (!PatreonMedia.isPostImageUrl(urls[u])) continue;
          pushCollected({ url: urls[u], postId: postId });
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
            let dims = await fetchDimensions(item.url);
            if (!(dims.width > 0 && dims.height > 0)) dims = await fetchDimensions(item.url);
            const resolved = PatreonMedia.resolveDimensions(item, dims, item.url);
            item.width = resolved.width;
            item.height = resolved.height;
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