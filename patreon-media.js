// Pure Patreon post-media decisions. Injected before content.js on Patreon.
// Fantia does not use this.
//
// Feed auto-load keeps post ids while Patreon unmounts cards. The fetch that
// follows has to turn each post payload into the original photo, and a resized
// card image must not win the dedupe over that original or collapse every
// /file? download into one path.
(function (root) {
  function decodeBase64(value) {
    try {
      if (typeof atob === 'function') return atob(value);
    } catch (e) {}
    try {
      if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64').toString('utf8');
    } catch (e2) {}
    return '';
  }

  function resizeParams(url) {
    const path = String(url || '').split('?')[0];
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      let part = parts[i];
      try { part = decodeURIComponent(part); } catch (e) {}
      if (part.indexOf('eyJ') !== 0) continue;
      const mod = part.length % 4;
      const padded = mod === 0 ? part : part + '===='.slice(mod);
      const decoded = decodeBase64(padded);
      if (!decoded) continue;
      try {
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (e2) {}
    }
    return null;
  }

  function renditionRank(url) {
    const params = resizeParams(url);
    if (!params) return 5000;
    const hasBox = params.w != null || params.h != null;
    if (!hasBox && (params.q != null || params.webp != null)) return 100000;
    if (!hasBox && params.a != null && params.p != null) return 90000;
    if (hasBox) return Math.max(Number(params.w) || 0, Number(params.h) || 0);
    return 4000;
  }

  function fileHash(url) {
    const path = String(url || '').split('?')[0];
    const parts = path.split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^[a-f0-9]{32}$/i.test(parts[i])) return parts[i].toLowerCase();
    }
    return '';
  }

  function dedupeKey(url) {
    const value = String(url || '');
    if (!value) return '';
    let parsed = null;
    try {
      parsed = new URL(value, 'https://www.patreon.com');
    } catch (e) {}
    if (parsed && /\/file$/.test(parsed.pathname)) {
      return parsed.origin + parsed.pathname + '?' + parsed.searchParams.toString();
    }
    const hash = fileHash(value);
    if (hash) return 'hash:' + hash;
    return value.split('?')[0];
  }

  function isSkippableUrl(url) {
    const path = String(url || '').split('?')[0].toLowerCase();
    if (!path) return true;
    if (path.indexOf('stream.mux.com') !== -1) return true;
    return /\.(m3u8|mp4|mp3|m4a|wav|zip|rar|7z|pdf)$/.test(path);
  }

  function isPostImageUrl(url) {
    const value = String(url || '');
    if (!value || isSkippableUrl(value)) return false;
    if (/\/p\/post\//i.test(value)) return true;
    if (/patreon\.com\/file\?/i.test(value)) return true;
    if (/image\.mux\.com/i.test(value)) return true;
    if (/pbs\.twimg\.com/i.test(value)) return true;
    return false;
  }

  function imageExtension(url) {
    return /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg)(?:$|\?)/i.test(String(url || ''));
  }

  function isDownloadableImage(attrs, url) {
    if (!url || isSkippableUrl(url)) return false;
    const source = attrs || {};
    const mime = String(source.mimetype || source.media_type || '').toLowerCase();
    if (/video|audio|mpegurl|zip|pdf/.test(mime)) return false;
    if (mime.indexOf('image/') === 0 || mime === 'image') return true;
    if (source.image_urls) return true;
    if (imageExtension(url)) return true;
    if (/\/file(?:\?|$)/i.test(url)) return true;
    return false;
  }

  function chooseImageUrl(attrs) {
    const source = attrs || {};
    const urls = source.image_urls || {};
    const candidates = [
      urls.original,
      source.download_url,
      urls.default_large,
      urls.default,
      urls.url,
      source.url
    ];
    let best = '';
    let bestRank = -1;
    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i];
      if (!url || isSkippableUrl(url)) continue;
      const rank = renditionRank(url);
      if (rank > bestRank) {
        best = url;
        bestRank = rank;
      }
    }
    return best;
  }

  function fullSizeDimensions(attrs, url) {
    if (renditionRank(url) < 90000) return { width: 0, height: 0 };
    const source = attrs || {};
    const meta = source.metadata || {};
    const dims = meta.dimensions || {};
    const width = Number(dims.w || dims.width || source.width || 0) || 0;
    const height = Number(dims.h || dims.height || source.height || 0) || 0;
    return { width: width, height: height };
  }

  function passesMinSize(img, minSize) {
    const image = img || {};
    const min = Number(minSize) || 0;
    const width = Number(image.width) || 0;
    const height = Number(image.height) || 0;
    if (width === 0 && height === 0) return true;
    return width >= min || height >= min;
  }

  function createSeenImages() {
    return { items: [], keys: {} };
  }

  function rememberImages(store, postId, urls) {
    const box = store || createSeenImages();
    const id = postId ? String(postId) : '';
    const list = urls || [];
    for (let i = 0; i < list.length; i++) {
      const url = list[i];
      if (!isPostImageUrl(url)) continue;
      const key = id + '|' + url;
      if (box.keys[key]) continue;
      box.keys[key] = true;
      box.items.push({ postId: id, url: String(url) });
    }
    return box;
  }

  function absorbInto(list, record) {
    if (!list || !record || !record.url) return list;
    const key = dedupeKey(record.url);
    if (!key) return list;
    for (let i = 0; i < list.length; i++) {
      if (dedupeKey(list[i].url) !== key) continue;
      if (renditionRank(record.url) > renditionRank(list[i].url)) {
        if (!record.filename && list[i].filename) record.filename = list[i].filename;
        if (!record.postId && list[i].postId) record.postId = list[i].postId;
        if (!record.postTitle && list[i].postTitle) record.postTitle = list[i].postTitle;
        if (!record.postDate && list[i].postDate) record.postDate = list[i].postDate;
        list[i] = record;
      }
      return list;
    }
    list.push(record);
    return list;
  }

  function eachContentImage(doc, visit) {
    const stack = [doc];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) stack.push(node[i]);
        continue;
      }
      if (typeof node !== 'object') continue;
      if (node.type === 'image' && node.attrs) visit(node.attrs);
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        const value = node[keys[i]];
        if (value && typeof value === 'object') stack.push(value);
      }
    }
  }

  function urlsFromHtml(html) {
    const found = [];
    const tags = String(html || '').match(/<img\b[^>]*>/gi) || [];
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      const match = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || tag.match(/\bdata-src\s*=\s*["']([^"']+)["']/i);
      if (match && match[1]) found.push(match[1]);
    }
    return found;
  }

  function collectPostImages(json) {
    const data = json && json.data ? json.data : {};
    const attributes = data.attributes || {};
    const postId = data.id != null && data.id !== '' ? String(data.id) : '';
    const postTitle = attributes.title || '';
    const postDate = attributes.published_at || attributes.created_at || '';
    const images = [];
    const seenMediaIds = {};

    function push(url, name, dims, mediaId) {
      if (!url || isSkippableUrl(url)) return;
      if (!isPostImageUrl(url) && !imageExtension(url) && !/\/file(?:\?|$)/i.test(url)) return;
      const size = dims || { width: 0, height: 0 };
      absorbInto(images, {
        url: url,
        name: name || '',
        width: size.width || 0,
        height: size.height || 0,
        postId: postId,
        postTitle: postTitle,
        postDate: postDate,
        mediaId: mediaId ? String(mediaId) : ''
      });
      if (mediaId) seenMediaIds[String(mediaId)] = true;
    }

    const included = Array.isArray(json && json.included) ? json.included : [];
    for (let i = 0; i < included.length; i++) {
      const item = included[i];
      if (!item) continue;
      const attrs = item.attributes || {};
      if (item.type === 'media') {
        const url = chooseImageUrl(attrs);
        if (!isDownloadableImage(attrs, url)) continue;
        push(url, attrs.file_name || attrs.name, fullSizeDimensions(attrs, url), item.id);
      } else if (item.type === 'attachment') {
        const url = attrs.url || attrs.download_url || '';
        if (!isDownloadableImage(attrs, url)) continue;
        push(url, attrs.name || attrs.file_name, fullSizeDimensions(attrs, url), item.id);
      }
    }

    let doc = null;
    if (attributes.content_json_string) {
      try { doc = JSON.parse(attributes.content_json_string); } catch (e) {}
    }
    if (doc) {
      eachContentImage(doc, function (attrs) {
        const mediaId = attrs.media_id ? String(attrs.media_id) : '';
        if (mediaId && seenMediaIds[mediaId]) return;
        const src = attrs.src || attrs.url || '';
        if (!src || !isPostImageUrl(src) && !imageExtension(src)) return;
        if (isSkippableUrl(src)) return;
        const width = Number(attrs.media_width || attrs.width || 0) || 0;
        const height = Number(attrs.media_height || attrs.height || 0) || 0;
        const dims = renditionRank(src) >= 90000 ? { width: width, height: height } : { width: 0, height: 0 };
        push(src, '', dims, mediaId);
      });
    }

    urlsFromHtml(attributes.content).forEach(function (src) {
      if (!isPostImageUrl(src) && !imageExtension(src)) return;
      push(src, '', { width: 0, height: 0 }, '');
    });

    const cover = attributes.image;
    if (cover && typeof cover === 'object') {
      const coverUrl = cover.large_url || cover.url || '';
      if (coverUrl && !isSkippableUrl(coverUrl)) {
        const dims = renditionRank(coverUrl) >= 90000
          ? { width: Number(cover.width) || 0, height: Number(cover.height) || 0 }
          : { width: 0, height: 0 };
        push(coverUrl, '', dims, '');
      }
    }

    const postFile = attributes.post_file;
    if (postFile && postFile.url && isDownloadableImage(postFile, postFile.url)) {
      push(
        postFile.url,
        postFile.name,
        fullSizeDimensions(postFile, postFile.url),
        postFile.media_id
      );
    }

    return images;
  }

  root.PatreonMedia = {
    resizeParams: resizeParams,
    renditionRank: renditionRank,
    dedupeKey: dedupeKey,
    isSkippableUrl: isSkippableUrl,
    isPostImageUrl: isPostImageUrl,
    isDownloadableImage: isDownloadableImage,
    chooseImageUrl: chooseImageUrl,
    createSeenImages: createSeenImages,
    rememberImages: rememberImages,
    absorbInto: absorbInto,
    collectPostImages: collectPostImages,
    passesMinSize: passesMinSize
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
