// Pure Fantia post parsing. Injected before content.js on fantia.jp.
// Downloads only images Fantia already marks visible for this browser session.
// Locked paid blocks (members_only, catchable, uncatchable) are counted and skipped.
(function (root) {
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
  const DERIVATIVE = /\/(?:thumb_webp|medium_webp|main_webp|thumb|medium|large|main|micro|ogp)_[0-9a-f-]{8,}\.(?:jpe?g|png|gif|webp|avif|bmp)$/i;

  function sanitizeFilename(name) {
    if (!name) return '';
    return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  }

  function absUrl(url, origin) {
    if (!url || typeof url !== 'string') return '';
    if (url.startsWith('data:') || url.startsWith('blob:')) return '';
    try {
      return new URL(url, origin || 'https://fantia.jp').href;
    } catch (e) {
      return '';
    }
  }

  function isFantiaHost(hostname) {
    return hostname === 'fantia.jp' || hostname.endsWith('.fantia.jp');
  }

  function isDerivativePath(pathname) {
    return DERIVATIVE.test(pathname || '');
  }

  function isDownloadableImage(url, origin, trustExtensionless) {
    const full = absUrl(url, origin);
    if (!full) return false;
    let parsed;
    try {
      parsed = new URL(full);
    } catch (e) {
      return false;
    }
    if (parsed.protocol !== 'https:' || !isFantiaHost(parsed.hostname)) return false;
    const path = parsed.pathname.toLowerCase();
    if (path.includes('/images/fallback/') || path.includes('/assets/') || path.includes('blurred')) {
      return false;
    }
    if (IMAGE_EXT.test(path)) return !isDerivativePath(parsed.pathname);
    // Blog originals redirect from /posts/:id/album_image?query=... to the file.
    if (path.includes('/album_image')) return true;
    // Extensionless attachment URLs are only accepted when the post API
    // already said the file is an image. /post_content_photo/:id is an HTML viewer.
    if (trustExtensionless && !path.includes('/post_content_photo/')) return true;
    return false;
  }

  function dedupeKey(url, origin) {
    const full = absUrl(url, origin);
    if (!full) return '';
    const parsed = new URL(full);
    if (parsed.pathname.toLowerCase().includes('/album_image') && !IMAGE_EXT.test(parsed.pathname)) {
      return parsed.pathname + parsed.search;
    }
    return parsed.pathname;
  }

  function extOf(url) {
    const match = String(url || '').split('?')[0].match(IMAGE_EXT);
    return match ? match[0].toLowerCase() : '.jpg';
  }

  function clipName(name) {
    const cleaned = sanitizeFilename(name);
    return cleaned.length > 80 ? cleaned.slice(0, 80).trim() : cleaned;
  }

  function fantiaPostId(post) {
    if (!post || post.id == null || post.id === '') return '';
    return String(post.id);
  }

  function fantiaPostDate(post) {
    if (!post || typeof post !== 'object') return '';
    const keys = ['posted_at', 'published_at', 'created_at', 'converted_at'];
    for (let i = 0; i < keys.length; i++) {
      if (post[keys[i]]) return String(post[keys[i]]);
    }
    if (post.month) return String(post.month);
    return '';
  }

  function fileNameFor(url, title, index, explicitName) {
    if (explicitName && IMAGE_EXT.test(explicitName)) return sanitizeFilename(explicitName);
    const prefix = clipName(title) || 'Fantia';
    const explicit = clipName(explicitName);
    if (explicit) return explicit + extOf(url);
    return prefix + '_' + String(index).padStart(3, '0') + extOf(url);
  }

  function parseOps(comment) {
    if (!comment || typeof comment !== 'string') return [];
    try {
      const parsed = JSON.parse(comment);
      return parsed && Array.isArray(parsed.ops) ? parsed.ops : [];
    } catch (e) {
      return [];
    }
  }

  function isImageAttachment(content) {
    const type = String(content.content_type || '');
    if (type.indexOf('image/') === 0) return true;
    if (IMAGE_EXT.test(String(content.filename || ''))) return true;
    return IMAGE_EXT.test(String(content.download_uri || '').split('?')[0]);
  }

  function collectFromPost(post, origin) {
    const images = [];
    const seen = new Set();
    let lockedCount = 0;
    let index = 1;

    function add(url, title, explicitName, trustExtensionless) {
      const full = absUrl(url, origin);
      if (!isDownloadableImage(full, origin, trustExtensionless)) return;
      const key = dedupeKey(full, origin);
      if (!key || seen.has(key)) return;
      seen.add(key);
      images.push({
        url: full,
        filename: fileNameFor(full, title, index, explicitName),
        width: 0,
        height: 0,
        postId: fantiaPostId(post),
        postTitle: post && post.title ? String(post.title) : '',
        postDate: fantiaPostDate(post)
      });
      index += 1;
    }

    if (!post || typeof post !== 'object') {
      return { images: images, lockedCount: lockedCount };
    }

    const title = post.title || '';
    if (post.thumb && post.thumb.original) add(post.thumb.original, title);

    const contents = Array.isArray(post.post_contents)
      ? post.post_contents
      : (Array.isArray(post.backnumber_contents) ? post.backnumber_contents : []);

    contents.forEach((content) => {
      if (!content || typeof content !== 'object') return;
      // visible: the logged-in user can already see it (including paid plans they joined).
      // Anything else is still locked. Do not guess original URLs for those blocks.
      if ((content.visible_status || 'visible') !== 'visible') {
        lockedCount += 1;
        return;
      }

      const contentTitle = title || content.title || '';
      const photos = Array.isArray(content.post_content_photos) ? content.post_content_photos : [];
      photos.forEach((photo) => {
        const original = photo && photo.url && photo.url.original;
        if (original) add(original, contentTitle);
      });

      if (content.download_uri && isImageAttachment(content)) {
        add(content.download_uri, contentTitle, content.filename, true);
      }

      if (content.category === 'blog' || content.category === 'text') {
        parseOps(content.comment).forEach((op) => {
          const insert = op && op.insert;
          if (!insert || typeof insert !== 'object' || !insert.fantiaImage) return;
          const image = insert.fantiaImage;
          const direct = image.url && /^https:\/\//i.test(image.url) ? image.url : '';
          add(direct || image.original_url, contentTitle);
        });
      }
    });

    return { images: images, lockedCount: lockedCount };
  }

  function collectFromImageUrls(urls, title, origin) {
    const images = [];
    const seen = new Set();
    let index = 1;
    (urls || []).forEach((url) => {
      const full = absUrl(url, origin);
      if (!isDownloadableImage(full, origin, false)) return;
      const key = dedupeKey(full, origin);
      if (!key || seen.has(key)) return;
      seen.add(key);
      images.push({
        url: full,
        filename: fileNameFor(full, title, index),
        width: 0,
        height: 0,
        postId: '',
        postTitle: '',
        postDate: ''
      });
      index += 1;
    });
    return { images: images, lockedCount: 0 };
  }

  root.FantiaScan = {
    collectFromPost: collectFromPost,
    collectFromImageUrls: collectFromImageUrls,
    dedupeKey: dedupeKey,
    isDownloadableImage: isDownloadableImage
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
