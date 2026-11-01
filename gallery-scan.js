// Generic gallery decisions. No chrome.* calls.
// Popup, the gallery content script, the background probe, and node tests
// all load this file.
//
// A thumbnail counts only when a control on the page opens another URL in a
// new tab (an <a target="_blank"> or an inline window.open("...")). The URL
// that opens is what we resolve. The thumbnail file itself is not the download.
// Inline script blocks are ignored, so a site-wide window.open helper is not
// treated as a gallery.
//
// Direct image URLs (file extension, or a known image-CDN pattern) are queued.
// Anything that looks like a web page is probed later. The probe may keep a
// single embedded photo; it never keeps the page URL. Videos, archives,
// ads, and other documents are dropped. Missing a strange page is preferred
// over saving HTML.
(function (root) {
  const IMAGE_EXT = {
    avif: 1, bmp: 1, gif: 1, heic: 1, heif: 1, jfif: 1, jpe: 1, jpeg: 1, jpg: 1,
    png: 1, tif: 1, tiff: 1, webp: 1
  };
  const PAGE_EXT = {
    asp: 1, aspx: 1, cgi: 1, htm: 1, html: 1, jsp: 1, jspx: 1, php: 1, shtml: 1, xhtml: 1
  };
  const SKIP_EXT = {
    apk: 1, avi: 1, bin: 1, css: 1, csv: 1, dmg: 1, doc: 1, docx: 1, eot: 1, exe: 1,
    ico: 1, js: 1, json: 1, m3u8: 1, m4a: 1, m4v: 1, mkv: 1, mov: 1, mp3: 1, mp4: 1,
    mpeg: 1, mpg: 1, ogg: 1, pdf: 1, ppt: 1, pptx: 1, rar: 1, svg: 1, torrent: 1,
    ts: 1, txt: 1, wasm: 1, wav: 1, webm: 1, woff: 1, woff2: 1, xls: 1, xlsx: 1,
    xml: 1, zip: 1, '7z': 1
  };
  const ORIGINAL_ATTRS = [
    'data-org', 'data-original', 'data-full', 'data-full-url', 'data-fullsrc',
    'data-hires', 'data-zoom-url'
  ];
  const CHROME_SELECTOR = 'header, footer, nav, [role="navigation"], [role="banner"], [role="contentinfo"]';
  const AD_HOSTS = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
    'adservice.google.com', 'adnxs.com', 'advertising.com', 'taboola.com',
    'outbrain.com', 'criteo.com', 'scorecardresearch.com'
  ];
  const MAX_PROBES = 30;

  function decodeEntities(text) {
    return String(text == null ? '' : text)
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#0*39;/g, "'");
  }

  function originMatchPattern(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      if (!parsed.hostname) return '';
      return parsed.origin + '/*';
    } catch (e) {
      return '';
    }
  }

  function isSameOrigin(a, b) {
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch (e) {
      return false;
    }
  }

  function canonical(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.href;
    } catch (e) {
      return String(url || '');
    }
  }

  function absolutize(raw, pageUrl) {
    const text = decodeEntities(raw).trim();
    if (!text || text === '#' || text.charAt(0) === '#') return '';
    if (/^(javascript|mailto|tel|blob|data):/i.test(text)) return '';
    try {
      const parsed = new URL(text, pageUrl || undefined);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.href;
    } catch (e) {
      return '';
    }
  }

  function pathExtension(parsed) {
    const base = (parsed.pathname || '').split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '';
    return base.slice(dot + 1).toLowerCase();
  }

  function hostIs(hostname, suffix) {
    return hostname === suffix || hostname.endsWith('.' + suffix);
  }

  function isAdUrl(url) {
    let hostname = '';
    try { hostname = new URL(url).hostname.toLowerCase(); } catch (e) { return false; }
    for (let i = 0; i < AD_HOSTS.length; i++) {
      if (hostIs(hostname, AD_HOSTS[i])) return true;
    }
    return false;
  }

  // Narrow on purpose. A format query on a normal HTML host is still a page
  // and has to be probed. Only hosts and paths that serve image files get a
  // pass when they have no file extension.
  function looksLikeImageCdn(parsed) {
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host.indexOf('cloudinary') !== -1 || host.indexOf('imgix') !== -1) return true;
    if (host.indexOf('googleusercontent') !== -1 || host.indexOf('twimg') !== -1) return true;
    return /\/(userfiles|uploads)\//.test(path);
  }

  function hasImageFormatQuery(parsed) {
    const keys = ['format', 'fm', 'ext'];
    for (let i = 0; i < keys.length; i++) {
      const value = (parsed.searchParams.get(keys[i]) || '').toLowerCase().replace(/^\./, '');
      if (IMAGE_EXT[value]) return true;
    }
    return false;
  }

  // 'image' can be downloaded as a file. 'page' might embed one photo and must
  // be fetched before we trust it. 'skip' is never downloaded.
  function classifyUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return 'skip'; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'skip';
    if (isAdUrl(url)) return 'skip';
    const ext = pathExtension(parsed);
    if (IMAGE_EXT[ext]) return 'image';
    if (PAGE_EXT[ext]) return 'page';
    if (SKIP_EXT[ext]) return 'skip';
    if (ext) return 'skip';
    if (hasImageFormatQuery(parsed) && looksLikeImageCdn(parsed)) return 'image';
    return 'page';
  }

  function thumbPenalty(url) {
    const path = String(url || '').toLowerCase();
    let penalty = 0;
    if (/\/mip\/|\/thumbs?\//.test(path) || /\/thumbnails?\//.test(path)) penalty += 5;
    if (/\/(small|tiny|mini|icons?)\//.test(path)) penalty += 5;
    if (/[_-](thumb|small|tiny|mini|mip)\b/.test(path)) penalty += 3;
    if (/[?&](w|width|h|height|size|resize)=/.test(path)) penalty += 1;
    return penalty;
  }

  function pickBest(entries) {
    let best = null;
    let bestScore = -100000;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      let score = entry.role === 'original' ? 50 : 40;
      score -= thumbPenalty(entry.url) * 20;
      if (score > bestScore) {
        bestScore = score;
        best = entry.url;
      }
    }
    return best || '';
  }

  function urlsFromInlineHandler(code) {
    const text = String(code || '');
    const urls = [];
    const re = /window\.open\s*\(\s*(['"`])([\s\S]*?)\1/g;
    let match;
    while ((match = re.exec(text))) {
      if (match[2]) urls.push(match[2]);
    }
    return urls;
  }

  function dedupeUrls(list, pageUrl) {
    const out = [];
    const seen = {};
    const source = list || [];
    for (let i = 0; i < source.length; i++) {
      const abs = absolutize(source[i], pageUrl);
      if (!abs) continue;
      const key = canonical(abs);
      if (seen[key]) continue;
      seen[key] = true;
      out.push(abs);
    }
    return out;
  }

  function resolveOpener(opener, pageUrl) {
    if (!opener || opener.inChrome || !opener.hasThumb) {
      return { status: 'skip', reason: opener && opener.inChrome ? 'chrome' : 'no-thumb' };
    }
    const targets = dedupeUrls(opener.targetUrls, pageUrl);
    const originals = dedupeUrls(opener.originalUrls, pageUrl);
    const imageTargets = [];
    const pageTargets = [];
    for (let i = 0; i < targets.length; i++) {
      const kind = classifyUrl(targets[i]);
      if (kind === 'image') imageTargets.push(targets[i]);
      else if (kind === 'page') pageTargets.push(targets[i]);
    }
    const originalImages = [];
    for (let i = 0; i < originals.length; i++) {
      if (classifyUrl(originals[i]) === 'image') originalImages.push(originals[i]);
    }
    if (imageTargets.length || originalImages.length) {
      const entries = [];
      for (let i = 0; i < imageTargets.length; i++) entries.push({ url: imageTargets[i], role: 'target' });
      for (let i = 0; i < originalImages.length; i++) entries.push({ url: originalImages[i], role: 'original' });
      return { status: 'image', url: pickBest(entries), reason: 'direct' };
    }
    if (pageTargets.length === 1) {
      return { status: 'probe', url: pageTargets[0], reason: 'page' };
    }
    return { status: 'skip', reason: pageTargets.length > 1 ? 'ambiguous' : 'not-image' };
  }

  function resolveOpeners(openers, pageUrl) {
    const images = [];
    const probes = [];
    let skipped = 0;
    const seen = {};
    const list = openers || [];
    for (let i = 0; i < list.length; i++) {
      const decision = resolveOpener(list[i], pageUrl);
      if (decision.status === 'image' || decision.status === 'probe') {
        const key = canonical(decision.url);
        if (!key || seen[key]) continue;
        seen[key] = true;
        if (decision.status === 'image') images.push(decision.url);
        else probes.push(decision.url);
      } else {
        skipped += 1;
      }
    }
    return { images: images, probes: probes, skipped: skipped };
  }

  function attr(tag, name) {
    const re = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
    const match = re.exec(tag);
    if (!match) return '';
    return decodeEntities(match[1] || match[2] || match[3] || '');
  }

  function isTinyTag(tag) {
    const width = parseInt(attr(tag, 'width'), 10) || 0;
    const height = parseInt(attr(tag, 'height'), 10) || 0;
    if (width && height && width <= 64 && height <= 64) return true;
    if ((width && width <= 32) || (height && height <= 32)) return true;
    return false;
  }

  function isUiAsset(url) {
    let path = '';
    try { path = decodeURIComponent(new URL(url).pathname).toLowerCase(); } catch (e) { return false; }
    if (/\/(icons?|sprites?|avatars?|emojis?|loading)\//.test(path)) return true;
    const base = path.split('/').pop() || '';
    const stem = base.replace(/\.[a-z0-9]+$/, '');
    return /^(logo|icon|sprite|avatar|favicon|loading|spinner|spacer|pixel|blank|qrcode|captcha|badge|emoji)s?(\d|[-_].*)?$/.test(stem);
  }

  function urlsFromImgTag(tag, pageUrl) {
    if (isTinyTag(tag)) return [];
    const names = ORIGINAL_ATTRS.concat(['data-lazy-src', 'data-src', 'src']);
    const entries = [];
    for (let i = 0; i < names.length; i++) {
      const raw = attr(tag, names[i]);
      if (!raw) continue;
      const url = absolutize(raw, pageUrl);
      if (!url || classifyUrl(url) !== 'image' || isAdUrl(url) || isUiAsset(url)) continue;
      const original = ORIGINAL_ATTRS.indexOf(names[i]) !== -1;
      entries.push({ url: url, role: original ? 'original' : 'target' });
    }
    const best = pickBest(entries);
    return best ? [best] : [];
  }

  function stripChrome(html) {
    return String(html || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
      .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '');
  }

  function metaImageUrls(html, pageUrl) {
    const urls = [];
    const seen = {};
    const re = /<meta\b[^>]*>/gi;
    let match;
    while ((match = re.exec(html))) {
      const tag = match[0];
      const key = (attr(tag, 'property') || attr(tag, 'name')).toLowerCase();
      if (key !== 'og:image' && key !== 'twitter:image') continue;
      const url = absolutize(attr(tag, 'content'), pageUrl);
      if (!url || classifyUrl(url) !== 'image' || isAdUrl(url) || isUiAsset(url)) continue;
      const id = canonical(url);
      if (seen[id]) continue;
      seen[id] = true;
      urls.push(url);
    }
    return urls;
  }

  // One clearly embedded photo, or nothing. A list, article, or empty page
  // returns '' so the caller does not download the HTML document.
  function extractSinglePhoto(html, pageUrl) {
    const source = stripChrome(html);
    const found = [];
    const seen = {};
    const re = /<img\b[^>]*>/gi;
    let match;
    while ((match = re.exec(source))) {
      const urls = urlsFromImgTag(match[0], pageUrl);
      for (let i = 0; i < urls.length; i++) {
        const key = canonical(urls[i]);
        if (seen[key]) continue;
        seen[key] = true;
        found.push(urls[i]);
      }
    }
    if (found.length === 1) return found[0];
    if (found.length === 0) {
      const meta = metaImageUrls(source, pageUrl);
      if (meta.length === 1) return meta[0];
    }
    return '';
  }

  function decideProbe(info) {
    const details = info || {};
    const requested = details.url || '';
    const finalUrl = details.finalUrl || requested;
    const mime = String(details.contentType || '').split(';')[0].trim().toLowerCase();
    if (mime.indexOf('image/') === 0 && mime !== 'image/svg+xml' && mime !== 'image/x-icon' && mime !== 'image/vnd.microsoft.icon') {
      if (!finalUrl || isAdUrl(finalUrl) || classifyUrl(finalUrl) === 'skip') {
        return { status: 'skip', reason: 'not-image' };
      }
      return { status: 'image', url: finalUrl, reason: 'content-type' };
    }
    const htmlLike = mime === 'text/html' || mime === 'application/xhtml+xml' || mime === 'application/xml' || mime === 'text/xml';
    const emptyMime = !mime;
    if (htmlLike || (emptyMime && /^\s*</.test(String(details.html || '')))) {
      const photo = extractSinglePhoto(details.html || '', finalUrl || requested);
      if (photo && photo !== canonical(finalUrl) && classifyUrl(photo) === 'image') {
        return { status: 'image', url: photo, reason: 'single-photo' };
      }
      return { status: 'skip', reason: 'html-page' };
    }
    if (emptyMime && classifyUrl(finalUrl) === 'image' && !isAdUrl(finalUrl)) {
      return { status: 'image', url: finalUrl, reason: 'final-url' };
    }
    return { status: 'skip', reason: 'not-image' };
  }

  function filenameFor(url, index) {
    let name = '';
    try {
      const base = new URL(url).pathname.split('/').pop() || '';
      try { name = decodeURIComponent(base); } catch (e) { name = base; }
    } catch (e2) {}
    name = String(name).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    const extMatch = name.match(/\.([A-Za-z0-9]{1,8})$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';
    const ordinal = String((index | 0) + 1).padStart(3, '0');
    if (!name || !IMAGE_EXT[ext] || name.length > 80 || /^\./.test(name)) {
      return 'image_' + ordinal + '.jpg';
    }
    return name;
  }

  function imageRecord(url, index, meta) {
    const info = meta || {};
    return {
      url: url,
      filename: filenameFor(url, index),
      width: 0,
      height: 0,
      postId: info.postId ? String(info.postId) : '',
      postTitle: info.postTitle ? String(info.postTitle) : '',
      postDate: info.postDate ? String(info.postDate) : ''
    };
  }

  function uniqueFilenames(records) {
    const used = {};
    const list = records || [];
    for (let i = 0; i < list.length; i++) {
      let name = list[i].filename || filenameFor(list[i].url, i);
      if (!used[name]) {
        used[name] = true;
        list[i].filename = name;
        continue;
      }
      const match = name.match(/^(.*?)(\.[A-Za-z0-9]{1,8})?$/);
      const base = match && match[1] ? match[1] : 'image';
      const ext = match && match[2] ? match[2] : '';
      let n = 2;
      while (used[base + '_' + n + ext]) n += 1;
      name = base + '_' + n + ext;
      used[name] = true;
      list[i].filename = name;
    }
    return list;
  }

  function summaryNotice(skipped, pending) {
    const parts = [];
    if (skipped) parts.push('已略過 ' + skipped + ' 個非圖片連結（網頁、廣告或非圖片檔）');
    if (pending) parts.push('另有 ' + pending + ' 個其他網站的網頁需要授權後才能確認');
    return parts.join('。');
  }

  function isOpenerElement(el) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    const onclick = el.getAttribute('onclick') || '';
    if (/window\.open\s*\(/.test(onclick)) return true;
    if (String(el.tagName || '').toUpperCase() !== 'A') return false;
    const href = el.getAttribute('href') || '';
    if (!href) return false;
    const target = String(el.getAttribute('target') || '').toLowerCase();
    return target === '_blank' || target === '_new' || target === 'blank';
  }

  function pushOriginals(img, into) {
    if (!img || typeof img.getAttribute !== 'function') return;
    for (let i = 0; i < ORIGINAL_ATTRS.length; i++) {
      const value = img.getAttribute(ORIGINAL_ATTRS[i]);
      if (value) into.push(value);
    }
  }

  function collectOpeners(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const nodes = doc.querySelectorAll('a[href], [onclick]');
    const found = [];
    for (let i = 0; i < nodes.length; i++) {
      if (isOpenerElement(nodes[i])) found.push(nodes[i]);
    }
    const openers = [];
    for (let i = 0; i < found.length; i++) {
      const el = found[i];
      let nested = false;
      for (let j = 0; j < found.length; j++) {
        if (i !== j && el.contains && el.contains(found[j])) {
          nested = true;
          break;
        }
      }
      if (nested) continue;
      if (el.closest && el.closest(CHROME_SELECTOR)) continue;
      const imgs = [];
      if (String(el.tagName || '').toUpperCase() === 'IMG') imgs.push(el);
      if (typeof el.querySelectorAll === 'function') {
        const inner = el.querySelectorAll('img');
        for (let k = 0; k < inner.length; k++) imgs.push(inner[k]);
      }
      if (!imgs.length && el.parentElement && typeof el.parentElement.querySelectorAll === 'function') {
        const parent = el.parentElement;
        if (!(parent.closest && parent.closest(CHROME_SELECTOR))) {
          const parentImgs = parent.querySelectorAll('img');
          let parentOpeners = 0;
          for (let p = 0; p < found.length; p++) {
            if (parent.contains && parent.contains(found[p])) parentOpeners += 1;
          }
          if (parentImgs.length > 0 && parentImgs.length <= 4 && parentOpeners <= 2) {
            for (let k = 0; k < parentImgs.length; k++) imgs.push(parentImgs[k]);
          }
        }
      }
      if (!imgs.length) continue;
      const targetUrls = [];
      if (String(el.tagName || '').toUpperCase() === 'A') {
        const href = el.getAttribute('href') || '';
        if (href) targetUrls.push(href);
      }
      const opened = urlsFromInlineHandler(el.getAttribute('onclick') || '');
      for (let h = 0; h < opened.length; h++) targetUrls.push(opened[h]);
      const originalUrls = [];
      for (let m = 0; m < imgs.length; m++) pushOriginals(imgs[m], originalUrls);
      openers.push({
        hasThumb: true,
        inChrome: false,
        targetUrls: targetUrls,
        originalUrls: originalUrls
      });
    }
    return openers;
  }

  root.GalleryScan = {
    MAX_PROBES: MAX_PROBES,
    originMatchPattern: originMatchPattern,
    isSameOrigin: isSameOrigin,
    canonical: canonical,
    absolutize: absolutize,
    classifyUrl: classifyUrl,
    isAdUrl: isAdUrl,
    urlsFromInlineHandler: urlsFromInlineHandler,
    resolveOpener: resolveOpener,
    resolveOpeners: resolveOpeners,
    extractSinglePhoto: extractSinglePhoto,
    decideProbe: decideProbe,
    filenameFor: filenameFor,
    imageRecord: imageRecord,
    uniqueFilenames: uniqueFilenames,
    summaryNotice: summaryNotice,
    collectOpeners: collectOpeners,
    isOpenerElement: isOpenerElement
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
