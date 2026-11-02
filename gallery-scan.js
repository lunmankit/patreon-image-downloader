// Generic gallery decisions. No chrome.* calls.
// Popup, the gallery content script, the background probe, and node tests
// all load this file.
//
// A gallery item is a thumbnail control, not the thumbnail file. Controls are
// inline window.open(...), links that open a new tab, lightbox / fancybox
// style anchors, anchors whose href is an image file, and image-only anchors
// that point at a viewer page. Full-size URLs already in the DOM count too:
// data-original / data-full / data-org and the largest srcset candidate win
// over a lazy thumb. Inline script blocks are ignored.
//
// Direct image URLs (file extension, or a known image-CDN pattern) are queued.
// Anything that looks like a web page is probed later. The probe may keep a
// single embedded photo; it never keeps the page URL. Videos, archives,
// ads, and other documents are dropped. A tiny thumb is not queued when a
// larger original is present. Missing a strange page is preferred over
// saving HTML.
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
    'data-org', 'data-original', 'data-orig', 'data-origin',
    'data-full', 'data-full-url', 'data-fullurl', 'data-fullsrc', 'data-full-src',
    'data-fullsize', 'data-full-size',
    'data-hires', 'data-hi-res', 'data-highres', 'data-hd',
    'data-zoom-url', 'data-zoom', 'data-zoom-image',
    'data-large', 'data-large-src', 'data-largesrc', 'data-big',
    'data-download-url', 'data-image-url', 'data-img-url', 'data-pswp-src'
  ];
  const LAZY_ATTRS = [
    'data-src', 'data-lazy-src', 'data-lazy', 'data-url',
    'data-image', 'data-bg', 'data-background', 'data-background-image'
  ];
  const LIGHTBOX_ATTRS = [
    'data-lightbox', 'data-fancybox', 'data-fancybox-trigger',
    'data-gallery', 'data-glightbox', 'data-lightbox-group', 'data-pswp-src'
  ];
  const CHROME_SELECTOR = 'header, footer, nav, [role="navigation"], [role="banner"], [role="contentinfo"]';
  const AD_HOSTS = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
    'adservice.google.com', 'adnxs.com', 'advertising.com', 'taboola.com',
    'outbrain.com', 'criteo.com', 'scorecardresearch.com'
  ];
  const MAX_PROBES = 30;
  const GALLERY_MARKER = /(?:^|[\s_-])(gallery|lightbox|photoswipe|fancybox|lightgallery|glightbox|justified|masonry|album|thumbnails|image-grid|photo-grid|post-images)(?:$|[\s_-])/i;

  function decodeEntities(text) {
    return String(text == null ? '' : text)
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#0*39;/g, "'");
  }

  function cleanCssUrl(value) {
    let text = decodeEntities(value).trim();
    if (!text) return '';
    const wrapped = /^url\(\s*(['"]?)([\s\S]*?)\1\s*\)$/i.exec(text);
    if (wrapped) text = wrapped[2].trim();
    return text;
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
    const text = cleanCssUrl(raw);
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

  function hrefLooksLikeImage(href) {
    const text = cleanCssUrl(href).split(/[?#]/)[0];
    if (!text) return false;
    const base = text.split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return false;
    return !!IMAGE_EXT[base.slice(dot + 1).toLowerCase()];
  }

  function looksLikeImageRef(raw) {
    const text = cleanCssUrl(raw);
    if (!text || isPlaceholder(text)) return false;
    if (/^(javascript|mailto|tel|blob|data):/i.test(text) || text === '#' || text.charAt(0) === '#') return false;
    if (hrefLooksLikeImage(text)) return true;
    if (/cloudinary|imgix|googleusercontent|twimg/i.test(text) && /^(https?:)?\/\//i.test(text)) return true;
    return false;
  }

  function isPaginationHref(href) {
    const text = String(href || '');
    return /[?&](?:page|p|paged)=\d+/i.test(text) || /\/page\/\d+\/?(?:[?#]|$)/i.test(text);
  }

  function isPlaceholder(url) {
    const text = String(url || '').trim();
    if (!text) return true;
    if (/^data:/i.test(text)) return true;
    return /blank\.gif|spacer\.gif|1x1|placeholder|transparent\.gif|pixel\.gif|loading\.gif|spinner|lazy\.gif/i.test(text);
  }

  function thumbPenalty(url) {
    const path = String(url || '').toLowerCase();
    let penalty = 0;
    if (/\/mip\/|\/thumbs?\//.test(path) || /\/thumbnails?\//.test(path)) penalty += 5;
    if (/\/(small|tiny|mini|icons?)\//.test(path)) penalty += 5;
    if (/[_-](thumb|thumbnail|small|tiny|mini|mip)s?\b/.test(path)) penalty += 3;
    const baseName = path.split(/[?#]/)[0].split('/').pop() || '';
    const stem = baseName.replace(/\.[a-z0-9]+$/, '');
    if (/^(thumb|thumbnail|small|tiny|mini|mip)s?(\d|[-_].*)?$/.test(stem)) penalty += 5;
    if (/[?&](w|width|h|height|size|resize|fit)=/.test(path)) penalty += 1;
    if (/\/(?:[^/]*\b(?:c_thumb|c_fill|c_scale|c_fit|w_\d+|h_\d+)[^/]*)\//.test(path)) penalty += 2;
    return penalty;
  }

  function widthHint(url) {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return 0; }
    const keys = ['w', 'width', 'maxwidth', 'max-width'];
    for (let i = 0; i < keys.length; i++) {
      const n = parseInt(parsed.searchParams.get(keys[i]) || '', 10);
      if (n > 0) return n;
    }
    const cloud = /(?:^|[,_/])w_(\d{2,5})\b/.exec(parsed.pathname.toLowerCase());
    if (cloud) return parseInt(cloud[1], 10);
    const box = /[_-](\d{2,4})x(\d{2,4})(?=\.)/.exec(parsed.pathname);
    if (box) return Math.max(parseInt(box[1], 10), parseInt(box[2], 10));
    const named = /[_-](\d{2,4})w(?=\.)/i.exec(parsed.pathname);
    if (named) return parseInt(named[1], 10);
    return 0;
  }

  function isLikelyThumb(url) {
    if (thumbPenalty(url) >= 3) return true;
    const hint = widthHint(url);
    return hint > 0 && hint <= 480;
  }

  function entryWidth(entry) {
    if (!entry) return 0;
    if (entry.width > 0) return entry.width;
    return widthHint(entry.url);
  }

  function entryIsWeak(entry) {
    if (!entry) return false;
    if (isLikelyThumb(entry.url)) return true;
    const hint = entryWidth(entry);
    return hint > 0 && hint <= 480;
  }

  function candidateScore(entry) {
    let score = 44;
    if (entry.role === 'original') score = 80;
    else if (entry.role === 'srcset') score = 58;
    else if (entry.role === 'lazy') score = 48;
    const hint = entryWidth(entry);
    if (hint >= 1000) score += 12;
    else if (hint >= 700) score += 6;
    else if (hint > 0 && hint <= 480) score -= 18;
    score -= thumbPenalty(entry.url) * 20;
    return score;
  }

  function pickBestEntry(entries) {
    let best = null;
    let bestScore = -100000;
    const list = entries || [];
    for (let i = 0; i < list.length; i++) {
      const score = candidateScore(list[i]);
      if (score > bestScore) {
        bestScore = score;
        best = list[i];
      }
    }
    return best;
  }

  function pickBest(entries) {
    const best = pickBestEntry(entries);
    return best ? best.url : '';
  }

  function parseSrcset(value) {
    const out = [];
    const parts = String(value || '').split(',');
    for (let i = 0; i < parts.length; i++) {
      const tokens = parts[i].trim().split(/\s+/);
      if (!tokens.length || !tokens[0]) continue;
      let width = 0;
      let density = 0;
      for (let t = 1; t < tokens.length; t++) {
        const token = tokens[t];
        if (/^\d+(?:\.\d+)?w$/i.test(token)) width = parseFloat(token);
        else if (/^\d+(?:\.\d+)?x$/i.test(token)) density = parseFloat(token);
      }
      out.push({ url: tokens[0], width: width, density: density });
    }
    return out;
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

  function pushImageEntry(entries, url, role, width) {
    if (!url || isPlaceholder(url) || classifyUrl(url) !== 'image' || isAdUrl(url) || isUiAsset(url)) return;
    entries.push({ url: url, role: role, width: width || widthHint(url) });
  }

  function resolveOpener(opener, pageUrl) {
    if (!opener || opener.inChrome || !opener.hasThumb) {
      return { status: 'skip', reason: opener && opener.inChrome ? 'chrome' : 'no-thumb' };
    }
    const targets = dedupeUrls(opener.targetUrls, pageUrl);
    const pageTargets = [];
    const entries = [];
    for (let i = 0; i < targets.length; i++) {
      const kind = classifyUrl(targets[i]);
      if (kind === 'image') pushImageEntry(entries, targets[i], 'target', 0);
      else if (kind === 'page') pageTargets.push(targets[i]);
    }
    const selfKey = canonical(pageUrl || '');
    const foreignPages = [];
    for (let i = 0; i < pageTargets.length; i++) {
      if (selfKey && canonical(pageTargets[i]) === selfKey) continue;
      foreignPages.push(pageTargets[i]);
    }
    const originals = dedupeUrls(opener.originalUrls, pageUrl);
    for (let i = 0; i < originals.length; i++) pushImageEntry(entries, originals[i], 'original', 0);
    const lazies = dedupeUrls(opener.lazyUrls, pageUrl);
    for (let i = 0; i < lazies.length; i++) pushImageEntry(entries, lazies[i], 'lazy', 0);
    const srcset = opener.srcset || [];
    for (let i = 0; i < srcset.length; i++) {
      const item = srcset[i] || {};
      const abs = absolutize(item.url, pageUrl);
      const width = item.width > 0 ? item.width : widthHint(abs);
      const role = (width > 0 || item.density > 1) ? 'srcset' : 'lazy';
      pushImageEntry(entries, abs, role, width);
    }
    const best = pickBestEntry(entries);
    const pageToProbe = foreignPages.length === 1 ? foreignPages[0] : '';
    if (best) {
      const weak = entryIsWeak(best);
      if (weak && (opener.dropThumbs || pageToProbe)) {
        if (pageToProbe) return { status: 'probe', url: pageToProbe, reason: 'page' };
        return { status: 'skip', reason: 'thumb' };
      }
      return { status: 'image', url: best.url, reason: 'direct' };
    }
    if (pageToProbe) return { status: 'probe', url: pageToProbe, reason: 'page' };
    if (foreignPages.length > 1) return { status: 'skip', reason: 'ambiguous' };
    return { status: 'skip', reason: 'not-image' };
  }

  function resolveOpeners(openers, pageUrl) {
    const images = [];
    const probes = [];
    let skipped = 0;
    let thumbs = 0;
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
      } else if (decision.reason === 'thumb') {
        thumbs += 1;
      } else {
        skipped += 1;
      }
    }
    return { images: images, probes: probes, skipped: skipped, thumbs: thumbs };
  }

  function attr(tag, name) {
    const re = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
    const match = re.exec(tag);
    if (!match) return '';
    return decodeEntities(match[1] || match[2] || match[3] || '');
  }

  function isTinyBox(width, height) {
    if (width && height && width <= 64 && height <= 64) return true;
    if ((width && width <= 32) || (height && height <= 32)) return true;
    return false;
  }

  function isTinyTag(tag) {
    const width = parseInt(attr(tag, 'width'), 10) || 0;
    const height = parseInt(attr(tag, 'height'), 10) || 0;
    return isTinyBox(width, height);
  }

  function tagListsAttr(tag, names) {
    for (let i = 0; i < names.length; i++) {
      if (attr(tag, names[i])) return true;
    }
    return false;
  }

  function isUiAsset(url) {
    let path = '';
    try { path = decodeURIComponent(new URL(url).pathname).toLowerCase(); } catch (e) { return false; }
    if (/\/(icons?|sprites?|avatars?|emojis?|loading)\//.test(path)) return true;
    const base = path.split('/').pop() || '';
    const stem = base.replace(/\.[a-z0-9]+$/, '');
    return /^(logo|icon|sprite|avatar|favicon|loading|spinner|spacer|pixel|blank|qrcode|captcha|badge|emoji|facebook|instagram|youtube|twitter|share|menu|hamburger|arrow|next|prev|previous)s?(\d|[-_].*)?$/.test(stem);
  }

  function urlsFromImgTag(tag, pageUrl) {
    if (isTinyTag(tag) && !tagListsAttr(tag, ORIGINAL_ATTRS)) return [];
    const entries = [];
    for (let i = 0; i < ORIGINAL_ATTRS.length; i++) {
      const raw = attr(tag, ORIGINAL_ATTRS[i]);
      if (!raw) continue;
      const url = absolutize(raw, pageUrl);
      pushImageEntry(entries, url, 'original', 0);
    }
    for (let i = 0; i < LAZY_ATTRS.length; i++) {
      const raw = attr(tag, LAZY_ATTRS[i]);
      if (!raw) continue;
      const url = absolutize(raw, pageUrl);
      pushImageEntry(entries, url, 'lazy', 0);
    }
    const srcset = parseSrcset(attr(tag, 'srcset')).concat(parseSrcset(attr(tag, 'data-srcset')));
    for (let i = 0; i < srcset.length; i++) {
      const url = absolutize(srcset[i].url, pageUrl);
      const width = srcset[i].width > 0 ? srcset[i].width : 0;
      const role = (width > 0 || srcset[i].density > 1) ? 'srcset' : 'lazy';
      pushImageEntry(entries, url, role, width);
    }
    const src = absolutize(attr(tag, 'src'), pageUrl);
    pushImageEntry(entries, src, 'target', 0);
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
      if (!url || classifyUrl(url) !== 'image' || isAdUrl(url) || isUiAsset(url) || isPlaceholder(url)) continue;
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

  // What a HEAD response is good for. 'accept' is an image content type,
  // 'get' needs a body (HTML viewer, or HEAD is not trustworthy), 'skip'
  // is a document we will not download.
  function interpretHead(status, contentType) {
    const code = status | 0;
    const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (code === 405 || code === 501 || code === 403 || code === 401 || code <= 0) return 'get';
    if (code >= 300 && code < 400) return 'get';
    if (code >= 400) return 'skip';
    if (!mime || mime === 'application/octet-stream') return 'get';
    if (mime.indexOf('image/') === 0) return 'accept';
    if (mime === 'text/html' || mime === 'application/xhtml+xml' || mime === 'text/xml' || mime === 'application/xml' || mime.indexOf('text/') === 0) return 'get';
    return 'skip';
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

  function summaryNotice(skipped, pending, thumbs) {
    const parts = [];
    if (skipped) parts.push('已略過 ' + skipped + ' 個非圖片連結（網頁、廣告或非圖片檔）');
    if (thumbs) parts.push('已略過 ' + thumbs + ' 個只有縮圖、沒有較大原圖的項目');
    if (pending) parts.push('另有 ' + pending + ' 個其他網站的網頁需要授權後才能確認');
    return parts.join('。');
  }

  function elementAttr(el, name) {
    if (!el || typeof el.getAttribute !== 'function') return '';
    const value = el.getAttribute(name);
    return value == null ? '' : String(value);
  }

  function insideChrome(el) {
    if (!el) return false;
    if (typeof el.closest === 'function' && el.closest(CHROME_SELECTOR)) return true;
    let cur = el;
    while (cur) {
      const tag = String(cur.tagName || '').toUpperCase();
      if (tag === 'HEADER' || tag === 'FOOTER' || tag === 'NAV') return true;
      const role = elementAttr(cur, 'role');
      if (role === 'navigation' || role === 'banner' || role === 'contentinfo') return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function hasGalleryMarker(el) {
    const blob = (elementAttr(el, 'class') + ' ' + elementAttr(el, 'id')).toLowerCase();
    return GALLERY_MARKER.test(blob);
  }

  function hasLightboxMarker(el) {
    if (hasGalleryMarker(el)) return true;
    for (let i = 0; i < LIGHTBOX_ATTRS.length; i++) {
      if (elementAttr(el, LIGHTBOX_ATTRS[i])) return true;
    }
    const rel = elementAttr(el, 'rel').toLowerCase();
    return rel.indexOf('lightbox') !== -1 || /(^|\s)gallery(\s|$)/.test(rel);
  }

  function hasNamedAttr(el, names) {
    for (let i = 0; i < names.length; i++) {
      if (elementAttr(el, names[i])) return true;
    }
    return false;
  }

  function isTinyElement(el) {
    const width = parseInt(elementAttr(el, 'width'), 10) || 0;
    const height = parseInt(elementAttr(el, 'height'), 10) || 0;
    return isTinyBox(width, height);
  }

  function queryCount(el, selector) {
    if (!el || typeof el.querySelectorAll !== 'function') return 0;
    return el.querySelectorAll(selector).length;
  }

  function anchorHasImg(el) {
    if (String(el.tagName || '').toUpperCase() === 'IMG') return true;
    return queryCount(el, 'img') > 0;
  }

  function isImageLedAnchor(el) {
    if (queryCount(el, 'img') !== 1) return false;
    if (queryCount(el, 'h1, h2, h3, h4, h5, h6, p, article, li') > 0) return false;
    return true;
  }

  function isOpenerElement(el) {
    return isGalleryControl(el);
  }

  function isGalleryControl(el) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    if (insideChrome(el)) return false;
    const onclick = elementAttr(el, 'onclick');
    if (/window\.open\s*\(/.test(onclick)) return true;
    if (String(el.tagName || '').toUpperCase() !== 'A') return false;
    const href = elementAttr(el, 'href');
    if (href && isPaginationHref(href)) return false;
    const inertHref = !href || href === '#' || /^(javascript|mailto|tel):/i.test(href);
    if (!inertHref) {
      const target = elementAttr(el, 'target').toLowerCase();
      if (target === '_blank' || target === '_new' || target === 'blank') return true;
      if (hrefLooksLikeImage(href)) return true;
      if (isImageLedAnchor(el)) return true;
    }
    if (hasLightboxMarker(el) && anchorHasImg(el)) return true;
    if (inertHref && anchorHasImg(el) && (hasNamedAttr(el, ORIGINAL_ATTRS) || hasNamedAttr(el, LAZY_ATTRS))) return true;
    return false;
  }

  function emptyBag() {
    return { originalUrls: [], lazyUrls: [], srcset: [] };
  }

  function pushSrcsetValue(value, bag) {
    if (!value) return;
    const parsed = parseSrcset(value);
    for (let i = 0; i < parsed.length; i++) {
      if (parsed[i].url) bag.srcset.push(parsed[i]);
    }
  }

  function pushElementUrls(el, bag) {
    if (!el || typeof el.getAttribute !== 'function') return;
    for (let i = 0; i < ORIGINAL_ATTRS.length; i++) {
      const value = cleanCssUrl(elementAttr(el, ORIGINAL_ATTRS[i]));
      if (looksLikeImageRef(value)) bag.originalUrls.push(value);
    }
    for (let i = 0; i < LAZY_ATTRS.length; i++) {
      const value = cleanCssUrl(elementAttr(el, LAZY_ATTRS[i]));
      if (looksLikeImageRef(value)) bag.lazyUrls.push(value);
    }
    pushSrcsetValue(elementAttr(el, 'srcset'), bag);
    pushSrcsetValue(elementAttr(el, 'data-srcset'), bag);
    pushSrcsetValue(elementAttr(el, 'data-lazy-srcset'), bag);
    const parent = el.parentElement;
    if (!parent || String(parent.tagName || '').toUpperCase() !== 'PICTURE') return;
    const kids = parent.children || [];
    for (let i = 0; i < kids.length; i++) {
      if (String(kids[i].tagName || '').toUpperCase() !== 'SOURCE') continue;
      pushSrcsetValue(elementAttr(kids[i], 'srcset'), bag);
      pushSrcsetValue(elementAttr(kids[i], 'data-srcset'), bag);
    }
  }

  function imgsForControl(el, controls) {
    const imgs = [];
    if (String(el.tagName || '').toUpperCase() === 'IMG') imgs.push(el);
    if (typeof el.querySelectorAll === 'function') {
      const inner = el.querySelectorAll('img');
      for (let k = 0; k < inner.length; k++) imgs.push(inner[k]);
    }
    if (!imgs.length && el.parentElement && typeof el.parentElement.querySelectorAll === 'function') {
      const parent = el.parentElement;
      if (!insideChrome(parent)) {
        const parentImgs = parent.querySelectorAll('img');
        let parentOpeners = 0;
        for (let p = 0; p < controls.length; p++) {
          if (parent.contains && parent.contains(controls[p])) parentOpeners += 1;
        }
        if (parentImgs.length > 0 && parentImgs.length <= 4 && parentOpeners <= 2) {
          for (let k = 0; k < parentImgs.length; k++) imgs.push(parentImgs[k]);
        }
      }
    }
    return imgs;
  }

  function pushControlSelfUrls(el, targetUrls, bag) {
    if (String(el.tagName || '').toUpperCase() === 'A') {
      const href = elementAttr(el, 'href');
      if (href && href !== '#') targetUrls.push(href);
    }
    const opened = urlsFromInlineHandler(elementAttr(el, 'onclick'));
    for (let h = 0; h < opened.length; h++) targetUrls.push(opened[h]);
    pushElementUrls(el, bag);
  }

  function listHas(list, node) {
    for (let i = 0; i < list.length; i++) {
      if (list[i] === node) return true;
    }
    return false;
  }

  function openerFromControl(el, controls, dropped) {
    const imgs = imgsForControl(el, controls);
    if (!imgs.length) return null;
    const targetUrls = [];
    const bag = emptyBag();
    const skippedParents = dropped || [];
    let parent = el.parentElement;
    while (parent) {
      if (listHas(skippedParents, parent)) pushControlSelfUrls(parent, targetUrls, bag);
      parent = parent.parentElement;
    }
    pushControlSelfUrls(el, targetUrls, bag);
    for (let m = 0; m < imgs.length; m++) pushElementUrls(imgs[m], bag);
    return {
      hasThumb: true,
      inChrome: false,
      dropThumbs: false,
      targetUrls: targetUrls,
      originalUrls: bag.originalUrls,
      lazyUrls: bag.lazyUrls,
      srcset: bag.srcset
    };
  }

  function repeatedImageChildren(node) {
    const kids = node && node.children ? node.children : [];
    if (kids.length < 4) return 0;
    const counts = {};
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      const childTag = String(child.tagName || '').toUpperCase();
      let qualifies = childTag === 'IMG';
      if (!qualifies && typeof child.querySelectorAll === 'function') {
        const blocked = child.querySelectorAll('h1, h2, h3, h4, h5, h6, p, article, li').length > 0;
        qualifies = !blocked && child.querySelectorAll('img').length === 1;
      }
      if (!qualifies) continue;
      counts[childTag] = (counts[childTag] || 0) + 1;
    }
    let best = 0;
    for (const tag in counts) {
      if (counts[tag] > best) best = counts[tag];
    }
    return best;
  }

  function inGalleryContext(img) {
    let node = img ? img.parentElement : null;
    for (let depth = 0; depth < 4 && node; depth++) {
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'BODY' || tag === 'HTML') break;
      if (hasGalleryMarker(node) || repeatedImageChildren(node) >= 4) return true;
      node = node.parentElement;
    }
    return false;
  }

  function linkedToPage(img) {
    let node = img ? img.parentElement : null;
    for (let depth = 0; depth < 4 && node; depth++) {
      if (String(node.tagName || '').toUpperCase() === 'A') {
        const href = elementAttr(node, 'href');
        if (href && href !== '#' && !hrefLooksLikeImage(href) && !/^(javascript|mailto|tel):/i.test(href)) {
          return true;
        }
      }
      node = node.parentElement;
    }
    return false;
  }

  function imageContainedBy(img, controls) {
    for (let i = 0; i < controls.length; i++) {
      const control = controls[i];
      if (control === img) return true;
      if (control.contains && control.contains(img)) return true;
    }
    return false;
  }

  function openerFromLooseImage(img) {
    if (!img || insideChrome(img)) return null;
    if (isTinyElement(img) && !hasNamedAttr(img, ORIGINAL_ATTRS)) return null;
    const bag = emptyBag();
    pushElementUrls(img, bag);
    let node = img.parentElement;
    for (let depth = 0; depth < 3 && node; depth++) {
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'BODY' || tag === 'HTML') break;
      if (insideChrome(node)) break;
      for (let i = 0; i < ORIGINAL_ATTRS.length; i++) {
        const value = cleanCssUrl(elementAttr(node, ORIGINAL_ATTRS[i]));
        if (looksLikeImageRef(value)) bag.originalUrls.push(value);
      }
      for (let i = 0; i < LAZY_ATTRS.length; i++) {
        const value = cleanCssUrl(elementAttr(node, LAZY_ATTRS[i]));
        if (looksLikeImageRef(value)) bag.lazyUrls.push(value);
      }
      pushSrcsetValue(elementAttr(node, 'data-srcset'), bag);
      node = node.parentElement;
    }
    const upgrade = bag.originalUrls.length || bag.lazyUrls.length || bag.srcset.length;
    const gallery = inGalleryContext(img);
    const src = elementAttr(img, 'src');
    const targetUrls = [];
    if (gallery && src && !isPlaceholder(src)) targetUrls.push(src);
    if (!upgrade && !targetUrls.length) return null;
    return {
      hasThumb: true,
      inChrome: false,
      dropThumbs: true,
      targetUrls: targetUrls,
      originalUrls: bag.originalUrls,
      lazyUrls: bag.lazyUrls,
      srcset: bag.srcset
    };
  }

  function loneContentOpener(imgs, controls) {
    const candidates = [];
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (imageContainedBy(img, controls) || insideChrome(img) || linkedToPage(img)) continue;
      if (isTinyElement(img) && !hasNamedAttr(img, ORIGINAL_ATTRS)) continue;
      const src = elementAttr(img, 'src');
      if (!src || isPlaceholder(src)) continue;
      if (isUiAsset(src) && !hasNamedAttr(img, ORIGINAL_ATTRS)) continue;
      candidates.push(img);
    }
    if (candidates.length !== 1) return null;
    const src = elementAttr(candidates[0], 'src');
    const bag = emptyBag();
    pushElementUrls(candidates[0], bag);
    return {
      hasThumb: true,
      inChrome: false,
      dropThumbs: true,
      targetUrls: [src],
      originalUrls: bag.originalUrls,
      lazyUrls: bag.lazyUrls,
      srcset: bag.srcset
    };
  }

  function collectOpeners(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const nodes = doc.querySelectorAll('a[href], [onclick]');
    const found = [];
    for (let i = 0; i < nodes.length; i++) {
      if (isGalleryControl(nodes[i])) found.push(nodes[i]);
    }
    const controls = [];
    const dropped = [];
    for (let i = 0; i < found.length; i++) {
      const el = found[i];
      let nested = false;
      for (let j = 0; j < found.length; j++) {
        if (i !== j && el.contains && el.contains(found[j])) {
          nested = true;
          break;
        }
      }
      if (nested) dropped.push(el);
      else controls.push(el);
    }
    const openers = [];
    for (let i = 0; i < controls.length; i++) {
      const built = openerFromControl(controls[i], controls, dropped);
      if (built) openers.push(built);
    }
    const imgs = doc.querySelectorAll('img');
    let looseCount = 0;
    for (let i = 0; i < imgs.length; i++) {
      if (imageContainedBy(imgs[i], controls)) continue;
      const built = openerFromLooseImage(imgs[i]);
      if (!built) continue;
      openers.push(built);
      looseCount += 1;
    }
    if (!looseCount) {
      const lone = loneContentOpener(imgs, controls);
      if (lone) openers.push(lone);
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
    parseSrcset: parseSrcset,
    interpretHead: interpretHead,
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
