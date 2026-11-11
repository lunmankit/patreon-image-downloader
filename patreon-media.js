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
    const display = source.display || {};
    const candidates = [
      urls.original,
      source.download_url,
      display.url,
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
    const display = source.display || {};
    const width = Number(dims.w || dims.width || source.width || display.width || 0) || 0;
    const height = Number(dims.h || dims.height || source.height || display.height || 0) || 0;
    return { width: width, height: height };
  }

  // Full-file URLs are probed in batches. Under load the probe sometimes
  // onloads a tiny stand-in. Recording that size makes the minimum-size
  // filter drop a photo on one scan and keep it on the next.
  function resolveDimensions(current, measured, url) {
    const width = Number(current && current.width) || 0;
    const height = Number(current && current.height) || 0;
    if (renditionRank(url) >= 90000) return { width: width, height: height };
    const measuredWidth = Number(measured && measured.width) || 0;
    const measuredHeight = Number(measured && measured.height) || 0;
    if (measuredWidth <= 0 || measuredHeight <= 0) return { width: width, height: height };
    if (width > 0 || height > 0) {
      return {
        width: Math.max(width, measuredWidth),
        height: Math.max(height, measuredHeight)
      };
    }
    return { width: measuredWidth, height: measuredHeight };
  }

  function urlsFromSrcset(value) {
    const found = [];
    const parts = String(value || '').split(',');
    for (let i = 0; i < parts.length; i++) {
      const piece = parts[i].trim().split(/\s+/)[0];
      if (piece) found.push(piece);
    }
    return found;
  }

  function urlsFromImageFields(fields) {
    const src = fields || {};
    const found = [];
    function add(url) {
      if (url) found.push(String(url));
    }
    add(src.currentSrc);
    add(src.src);
    add(src.dataSrc);
    add(src.dataOriginal);
    urlsFromSrcset(src.srcset).forEach(add);
    urlsFromSrcset(src.dataSrcset).forEach(add);
    return found;
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

  // Patreon CDN paths name the post that owns the file:
  // /p/post/<id>/<hash>/...
  function postIdFromMediaUrl(url) {
    const match = String(url || '').match(/\/p\/post\/(\d+)(?:\/|$)/i);
    return match && match[1] ? match[1] : '';
  }

  function isNonPostCdn(url) {
    return /\/p\/(?:campaign|user|creator|comment|reward)\//i.test(String(url || ''));
  }

  function mediaCandidateUrls(attrs) {
    const source = attrs || {};
    const urls = source.image_urls || {};
    const display = source.display || {};
    return [
      urls.original,
      source.download_url,
      display.url,
      urls.default_large,
      urls.default,
      urls.url,
      source.url
    ];
  }

  function referencedMediaIds(json) {
    const ids = {};
    let count = 0;
    eachRelationshipId(json, function (id) {
      if (ids[id]) return;
      ids[id] = true;
      count += 1;
    });
    const attributes = json && json.data && json.data.attributes ? json.data.attributes : {};
    const postFile = attributes.post_file;
    if (postFile && postFile.media_id != null && postFile.media_id !== '') {
      const id = String(postFile.media_id);
      if (!ids[id]) {
        ids[id] = true;
        count += 1;
      }
    }
    return { ids: ids, count: count };
  }

  function mediaOwnedByOtherPost(attrs, postId) {
    const source = attrs || {};
    const ownerType = String(source.owner_type || '').toLowerCase();
    const ownerId = source.owner_id != null && source.owner_id !== '' ? String(source.owner_id) : '';
    return !!(ownerType === 'post' && ownerId && postId && ownerId !== String(postId));
  }

  // `included` on a post payload also carries sideloaded files (other posts,
  // avatars, default includes). Only media this post references, or that
  // names this post, is part of the post. A thumbnail-only include is still
  // referenced, so the later /api/media fetch can upgrade it.
  function includedItemInPost(item, postId, referenced) {
    if (!item) return false;
    const attrs = item.attributes || {};
    const id = item.id != null && item.id !== '' ? String(item.id) : '';
    const box = referenced || { ids: {}, count: 0 };
    const urls = mediaCandidateUrls(attrs);
    let urlOther = false;
    let urlThis = false;
    let nonPost = false;
    for (let i = 0; i < urls.length; i++) {
      if (!urls[i]) continue;
      if (isNonPostCdn(urls[i])) nonPost = true;
      const found = postIdFromMediaUrl(urls[i]);
      if (found && postId && found !== String(postId)) urlOther = true;
      if (found && postId && found === String(postId)) urlThis = true;
    }
    if (nonPost && !(id && box.ids[id])) return false;
    if (mediaOwnedByOtherPost(attrs, postId)) return false;
    if (urlOther && !urlThis && !(id && box.ids[id])) return false;
    if (box.count > 0) {
      if (id && box.ids[id]) return true;
      if (urlThis) return true;
      const ownerType = String(attrs.owner_type || '').toLowerCase();
      const ownerId = attrs.owner_id != null && attrs.owner_id !== '' ? String(attrs.owner_id) : '';
      if (ownerType === 'post' && ownerId && ownerId === String(postId)) return true;
      return false;
    }
    return true;
  }

  // Which post a picture on the page belongs to. '' means skip it.
  // On a post page, only that post. On a feed, only the card's own post,
  // and a CDN url that names a different post does not inherit the card.
  function scopeDomImage(info) {
    const source = info || {};
    const pagePostId = source.pagePostId ? String(source.pagePostId) : '';
    const cardPostId = source.cardPostId ? String(source.cardPostId) : '';
    const urlPostId = postIdFromMediaUrl(source.url);
    if (source.inRecommendation || source.inComment || source.inOtherPost) return '';
    if (urlPostId && cardPostId && urlPostId !== cardPostId) return '';
    if (pagePostId) {
      if (urlPostId && urlPostId !== pagePostId) return '';
      if (cardPostId && cardPostId !== pagePostId) return '';
      if (source.inCurrentPost || cardPostId === pagePostId || urlPostId === pagePostId) return pagePostId;
      return '';
    }
    if (!cardPostId) return '';
    return cardPostId;
  }

  function collectPostImages(json) {
    const data = json && json.data ? json.data : {};
    const attributes = data.attributes || {};
    const postId = data.id != null && data.id !== '' ? String(data.id) : '';
    const postTitle = attributes.title || '';
    const postDate = attributes.published_at || attributes.created_at || '';
    const referenced = referencedMediaIds(json);
    const images = [];

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
    }

    const included = Array.isArray(json && json.included) ? json.included : [];
    for (let i = 0; i < included.length; i++) {
      const item = included[i];
      if (!item || !includedItemInPost(item, postId, referenced)) continue;
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
        const src = attrs.src || attrs.url || '';
        if (!src || !isPostImageUrl(src) && !imageExtension(src)) return;
        if (isSkippableUrl(src)) return;
        if (isNonPostCdn(src)) return;
        const urlPost = postIdFromMediaUrl(src);
        if (urlPost && postId && urlPost !== postId) return;
        // Same file as an included original shares a hash; absorb keeps the
        // larger URL. Skipping here dropped the only copy when `included`
        // had a thumbnail for that id and the src was a better rendition,
        // or when the two URLs did not share a hash.
        const width = Number(attrs.media_width || attrs.width || 0) || 0;
        const height = Number(attrs.media_height || attrs.height || 0) || 0;
        const dims = renditionRank(src) >= 90000 ? { width: width, height: height } : { width: 0, height: 0 };
        push(src, '', dims, mediaId);
      });
    }

    urlsFromHtml(attributes.content).forEach(function (src) {
      if (!isPostImageUrl(src) && !imageExtension(src)) return;
      if (isNonPostCdn(src)) return;
      const urlPost = postIdFromMediaUrl(src);
      if (urlPost && postId && urlPost !== postId) return;
      push(src, '', { width: 0, height: 0 }, '');
    });

    const cover = attributes.image;
    if (cover && typeof cover === 'object') {
      const coverUrl = cover.large_url || cover.url || '';
      const coverPost = postIdFromMediaUrl(coverUrl);
      if (coverUrl && !isSkippableUrl(coverUrl) && !isNonPostCdn(coverUrl) && !(coverPost && postId && coverPost !== postId)) {
        const dims = renditionRank(coverUrl) >= 90000
          ? { width: Number(cover.width) || 0, height: Number(cover.height) || 0 }
          : { width: 0, height: 0 };
        push(coverUrl, '', dims, '');
      }
    }

    const postFile = attributes.post_file;
    if (postFile && postFile.url && isDownloadableImage(postFile, postFile.url)) {
      const filePost = postIdFromMediaUrl(postFile.url);
      if (!isNonPostCdn(postFile.url) && !(filePost && postId && filePost !== postId)) {
        push(
          postFile.url,
          postFile.name,
          fullSizeDimensions(postFile, postFile.url),
          postFile.media_id
        );
      }
    }

    return images;
  }

  function eachRelationshipId(json, visit) {
    const data = json && json.data ? json.data : {};
    const rel = data.relationships || {};
    const names = ['media', 'images', 'attachments', 'attachments_media'];
    for (let n = 0; n < names.length; n++) {
      const relItem = rel[names[n]] || {};
      let list = relItem.data || [];
      if (list && !Array.isArray(list)) list = [list];
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].id != null && list[i].id !== '') visit(String(list[i].id));
      }
    }
    const attributes = data.attributes || {};
    let doc = null;
    if (attributes.content_json_string) {
      try { doc = JSON.parse(attributes.content_json_string); } catch (e) {}
    }
    if (doc) {
      eachContentImage(doc, function (attrs) {
        if (attrs && attrs.media_id != null && attrs.media_id !== '') visit(String(attrs.media_id));
      });
    }
  }

  function nonImageMediaIds(json) {
    const ids = {};
    const included = Array.isArray(json && json.included) ? json.included : [];
    for (let i = 0; i < included.length; i++) {
      const item = included[i];
      if (!item || item.id == null) continue;
      const attrs = item.attributes || {};
      const mime = String(attrs.mimetype || attrs.media_type || '').toLowerCase();
      if (/video|audio|mpegurl/.test(mime)) ids[String(item.id)] = true;
    }
    return ids;
  }

  // Ids that still need /api/media/{id}: not in this payload as a full-size
  // image. A thumbnail-only include used to count as "already collected",
  // so the rest of that post's photos never arrived.
  function mediaIdsToFetch(json, images) {
    const full = {};
    const list = images || [];
    for (let i = 0; i < list.length; i++) {
      const image = list[i];
      if (!image || image.mediaId == null || image.mediaId === '') continue;
      if (renditionRank(image.url) >= 90000) full[String(image.mediaId)] = true;
    }
    const skip = nonImageMediaIds(json);
    const out = [];
    const seen = {};
    eachRelationshipId(json, function (id) {
      if (seen[id] || full[id] || skip[id]) return;
      seen[id] = true;
      out.push(id);
    });
    return out;
  }

  root.PatreonMedia = {
    resizeParams: resizeParams,
    renditionRank: renditionRank,
    dedupeKey: dedupeKey,
    isSkippableUrl: isSkippableUrl,
    isPostImageUrl: isPostImageUrl,
    isDownloadableImage: isDownloadableImage,
    chooseImageUrl: chooseImageUrl,
    postIdFromMediaUrl: postIdFromMediaUrl,
    scopeDomImage: scopeDomImage,
    createSeenImages: createSeenImages,
    rememberImages: rememberImages,
    absorbInto: absorbInto,
    collectPostImages: collectPostImages,
    passesMinSize: passesMinSize,
    resolveDimensions: resolveDimensions,
    urlsFromImageFields: urlsFromImageFields,
    mediaIdsToFetch: mediaIdsToFetch
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
