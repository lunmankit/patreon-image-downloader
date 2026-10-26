// Pure path planning for popup downloads. No DOM and no chrome.* calls.
// Popup and node tests both load this file.
//
// Windows MAX_PATH is 260 characters, counting the drive, directories, the
// file name, and a terminating NUL. chrome.downloads (and the Firefox
// downloads API) take a path relative to the user's Downloads directory and
// do not apply the \\?\ long-path prefix. A typical Downloads prefix is
// about 20–60 characters (C:\Users\<name>\Downloads\).
//
// MAX_RELATIVE_PATH is 200 characters for the relative path this extension
// passes as `filename`, for example:
//   Patreon_Downloads/<folder>/<file>
//   Fantia_Downloads/<folder>/<file>
// 200 + a 59-character prefix + NUL stays within 260. Longer relative paths
// are treated as unsafe to save.
//
// A custom folder is too long when it does not leave room for the filename
// (the whole name, or the first PRESERVE_FILENAME_CHARS of it, whichever is
// shorter). Auto mode shortens the folder instead of refusing the download.
// Before a scan, the check uses TYPICAL_FILENAME as a stand-in.
(function (root) {
  const MAX_RELATIVE_PATH = 200;
  const PRESERVE_FILENAME_CHARS = 80;
  const TYPICAL_FILENAME = 'typical-download-image-name-0001.jpg';
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  function todayStamp(date) {
    const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + m + day;
  }

  function cleanSegment(name) {
    let text = String(name == null ? '' : name);
    text = text.replace(/[\u0000-\u001f]/g, '');
    text = text.replace(/[\\/:*?"<>|]/g, '_');
    text = text.replace(/\s+/g, ' ').trim();
    text = text.replace(/^[. ]+/, '').replace(/[. ]+$/, '');
    return text;
  }

  function guardReserved(segment) {
    const stem = String(segment).replace(/\..*$/, '');
    if (RESERVED.test(segment) || RESERVED.test(stem)) return '_' + segment;
    return segment;
  }

  function sanitizeFolderName(name) {
    const cleaned = cleanSegment(name);
    if (!cleaned) return 'untitled';
    return guardReserved(cleaned);
  }

  function truncateSegment(name, maxLen) {
    const limit = Math.max(1, maxLen | 0);
    let text = cleanSegment(name);
    if (!text) text = 'untitled';
    if (text.length > limit) {
      text = text.slice(0, limit).replace(/[. ]+$/g, '');
    }
    if (!text) text = 'untitled'.slice(0, limit);
    text = guardReserved(text);
    if (text.length > limit) {
      text = text.slice(0, limit).replace(/[. ]+$/g, '') || 'u';
    }
    return text || 'u';
  }

  function truncateKeepingSuffix(name, suffix, maxLen) {
    const extra = suffix || '';
    const limit = Math.max(1, maxLen | 0);
    if (!extra) return truncateSegment(name, limit);
    const head = cleanSegment(name) || 'untitled';
    if ((head + extra).length <= limit) return sanitizeFolderName(head + extra);
    const room = limit - extra.length;
    if (room < 1) return truncateSegment(extra, limit);
    const shortened = truncateSegment(head, room).replace(/[. ]+$/g, '');
    let combined = (shortened || 'u') + extra;
    if (combined.length > limit) combined = combined.slice(0, limit).replace(/[. ]+$/g, '');
    return combined || 'u';
  }

  function cleanFilename(filename) {
    let name = String(filename == null ? '' : filename);
    name = name.replace(/[\u0000-\u001f]/g, '');
    name = name.replace(/[\\/:*?"<>|]/g, '_');
    name = name.replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
    if (!name) name = 'image.jpg';
    const match = name.match(/^(.*?)(\.[A-Za-z0-9]{1,8})$/);
    let base = match ? match[1].replace(/[. ]+$/g, '') : name;
    const ext = match ? match[2] : '';
    if (!base) base = 'image';
    if (RESERVED.test(base)) base = '_' + base;
    return base + ext;
  }

  function fitFilename(filename, maxLen) {
    const cleaned = cleanFilename(filename);
    const limit = Math.max(1, maxLen | 0);
    if (cleaned.length <= limit) return cleaned;
    const match = cleaned.match(/^(.*?)(\.[A-Za-z0-9]{1,8})$/);
    const ext = match ? match[2] : '';
    let base = match ? match[1] : cleaned;
    const room = limit - ext.length;
    if (room < 1) return truncateSegment(cleaned, limit);
    base = base.slice(0, room).replace(/[. ]+$/g, '');
    if (!base) base = 'f';
    if (RESERVED.test(base)) {
      base = ('_' + base).slice(0, Math.max(1, room)).replace(/[. ]+$/g, '') || 'f';
    }
    let out = base + ext;
    if (out.length > limit) out = out.slice(0, limit).replace(/[. ]+$/g, '');
    return out || 'f';
  }

  function resolveDate(raw, today) {
    const value = String(raw == null ? '' : raw).trim();
    let match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match && validMonthDay(match[2], match[3])) {
      return { yyyymmdd: match[1] + match[2] + match[3], source: 'post' };
    }
    match = value.match(/^(\d{4})(\d{2})(\d{2})(?:\D|$)/);
    if (match && validMonthDay(match[2], match[3])) {
      return { yyyymmdd: match[1] + match[2] + match[3], source: 'post' };
    }
    match = value.match(/^(\d{4})(\d{2})$/);
    if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) {
      return { yyyymmdd: match[1] + match[2] + '01', source: 'month' };
    }
    return { yyyymmdd: today, source: 'today' };
  }

  function validMonthDay(month, day) {
    const m = Number(month);
    const d = Number(day);
    return m >= 1 && m <= 12 && d >= 1 && d <= 31;
  }

  function resolveTitle(title, postId) {
    const fromTitle = cleanSegment(title);
    if (fromTitle) return { text: fromTitle, source: 'title' };
    const fromId = cleanSegment(postId);
    if (fromId) return { text: fromId, source: 'id' };
    return { text: 'untitled', source: 'untitled' };
  }

  function joinPath(root, folder, filename) {
    if (!folder) return root + '/' + filename;
    return root + '/' + folder + '/' + filename;
  }

  function blankPlan(mode, root, preview) {
    return {
      ok: true,
      mode: mode,
      paths: [],
      folders: [],
      preview: preview,
      notices: [],
      warnings: [],
      suggestedCustomName: '',
      folderCount: 0,
      limit: MAX_RELATIVE_PATH
    };
  }

  function planDownloadPaths(images, options) {
    const opts = options || {};
    const root = sanitizeFolderName(opts.root || 'Downloads');
    const mode = opts.mode === 'auto' || opts.mode === 'custom' ? opts.mode : 'off';
    const today = /^\d{8}$/.test(String(opts.today || '')) ? String(opts.today) : todayStamp(new Date());
    const list = (Array.isArray(images) ? images : []).map((image) => ({
      filename: cleanFilename(image && image.filename),
      postId: image && image.postId != null && image.postId !== '' ? String(image.postId) : '',
      postTitle: image && image.postTitle != null ? String(image.postTitle) : '',
      postDate: image && image.postDate != null ? String(image.postDate) : ''
    }));

    if (mode === 'off') {
      return planFlat(root, list);
    }

    const notices = [];
    const groups = mode === 'custom'
      ? [customGroup(list, opts.customName, notices)]
      : autoGroups(list, today, notices);

    const budget = MAX_RELATIVE_PATH - root.length - 2;
    let ok = true;
    let suggestedCustomName = '';
    let folderTruncatedExample = '';
    let fileTruncated = false;

    groups.forEach((group) => {
      const filenames = group.items.map((item) => item.image.filename);
      const longest = filenames.length
        ? filenames.reduce((max, name) => Math.max(max, name.length), 0)
        : TYPICAL_FILENAME.length;
      const blameFileLen = Math.min(longest, PRESERVE_FILENAME_CHARS);
      const maxFolder = Math.max(1, budget - blameFileLen);
      group.maxFolderLen = maxFolder;
      const desired = group.suffix ? group.folder + group.suffix : group.folder;
      let folder = sanitizeFolderName(desired);
      group.truncated = false;
      if (folder.length > maxFolder) {
        folder = truncateKeepingSuffix(group.folder, group.suffix, maxFolder);
        group.truncated = true;
        if (mode === 'custom') {
          ok = false;
          suggestedCustomName = folder;
        } else if (!folderTruncatedExample) {
          folderTruncatedExample = folder;
        }
      }
      group.finalFolder = folder;
      const room = Math.max(1, budget - folder.length);
      group.fitted = filenames.map((name) => {
        if (name.length <= room) return name;
        fileTruncated = true;
        return fitFilename(name, room);
      });
    });

    if (mode === 'auto') {
      disambiguateFolders(groups);
      fileTruncated = false;
      groups.forEach((group) => {
        const room = Math.max(1, budget - group.finalFolder.length);
        group.fitted = group.items.map((item) => {
          const name = item.image.filename;
          if (name.length <= room) return name;
          fileTruncated = true;
          return fitFilename(name, room);
        });
      });
    }

    const paths = new Array(list.length);
    const folders = new Array(list.length);
    if (ok) {
      groups.forEach((group) => {
        group.items.forEach((item, itemIndex) => {
          let filename = group.fitted[itemIndex];
          const folder = group.finalFolder;
          let rel = joinPath(root, folder, filename);
          if (rel.length > MAX_RELATIVE_PATH) {
            const room = MAX_RELATIVE_PATH - root.length - 2 - folder.length;
            filename = fitFilename(filename, Math.max(1, room));
            rel = joinPath(root, folder, filename);
            fileTruncated = true;
          }
          paths[item.index] = rel;
          folders[item.index] = folder;
        });
      });
    }

    if (mode === 'auto' && folderTruncatedExample) {
      const shortened = groups.find((group) => group.truncated);
      if (shortened && shortened.finalFolder) folderTruncatedExample = shortened.finalFolder;
    }

    const warnings = [];
    if (mode === 'custom' && !ok) {
      warnings.push(
        '資料夾路徑超過 ' + MAX_RELATIVE_PATH +
        ' 字元，無法儲存。請縮短名稱，或改用：「' + suggestedCustomName + '」。'
      );
    } else if (folderTruncatedExample) {
      warnings.push(
        '路徑超過 ' + MAX_RELATIVE_PATH +
        ' 字元，無法原樣儲存。資料夾已縮短為：「' + folderTruncatedExample + '」。'
      );
    }
    if (fileTruncated && (ok || mode === 'auto')) {
      warnings.push('部分檔名過長，已縮短檔名以便儲存。');
    }

    const finalNames = [];
    const seenFolders = new Set();
    groups.forEach((group) => {
      const name = ok ? group.finalFolder : suggestedCustomName;
      if (!name || seenFolders.has(name)) return;
      seenFolders.add(name);
      finalNames.push(name);
    });

    return {
      ok: ok,
      mode: mode,
      paths: ok ? paths : [],
      folders: ok ? folders : [],
      preview: buildPreview(mode, root, today, list.length, finalNames, !ok),
      notices: notices,
      warnings: warnings,
      suggestedCustomName: suggestedCustomName,
      folderCount: list.length ? finalNames.length : 0,
      limit: MAX_RELATIVE_PATH
    };
  }

  function planFlat(root, list) {
    const maxFile = MAX_RELATIVE_PATH - root.length - 1;
    const paths = new Array(list.length);
    const folders = new Array(list.length);
    let fileTruncated = false;
    list.forEach((image, index) => {
      let filename = image.filename;
      if ((root + '/' + filename).length > MAX_RELATIVE_PATH) {
        filename = fitFilename(filename, maxFile);
        fileTruncated = true;
      }
      paths[index] = root + '/' + filename;
      folders[index] = '';
    });
    const warnings = fileTruncated ? ['部分檔名過長，已縮短檔名以便儲存。'] : [];
    return {
      ok: true,
      mode: 'off',
      paths: paths,
      folders: folders,
      preview: '不分子資料夾，圖片直接存在 ' + root + '/。',
      notices: [],
      warnings: warnings,
      suggestedCustomName: '',
      folderCount: 0,
      limit: MAX_RELATIVE_PATH
    };
  }

  function customGroup(list, customName, notices) {
    const typed = String(customName == null ? '' : customName);
    const cleaned = cleanSegment(typed);
    let folder = cleaned ? guardReserved(cleaned) : 'untitled';
    if (!typed.trim()) {
      notices.push('未輸入資料夾名稱，已改用 untitled。');
    } else if (!cleaned) {
      notices.push('資料夾名稱無法使用，已改用 untitled。');
    } else if (folder !== cleaned) {
      notices.push('資料夾名稱是 Windows 保留字，已改為 ' + folder + '。');
    }
    return {
      folder: folder,
      suffix: '',
      items: list.map((image, index) => ({ image: image, index: index }))
    };
  }

  function autoGroups(list, today, notices) {
    const order = [];
    const map = new Map();
    list.forEach((image, index) => {
      const key = image.postId
        ? 'id:' + image.postId
        : 'meta:' + image.postDate + '\n' + image.postTitle;
      if (!map.has(key)) {
        const date = resolveDate(image.postDate, today);
        const title = resolveTitle(image.postTitle, image.postId);
        const group = {
          folder: sanitizeFolderName(date.yyyymmdd + '_' + title.text),
          postId: image.postId,
          suffix: '',
          items: [],
          dateSource: date.source,
          titleSource: title.source
        };
        map.set(key, group);
        order.push(group);
      }
      map.get(key).items.push({ image: image, index: index });
    });

    const counts = new Map();
    order.forEach((group) => {
      counts.set(group.folder, (counts.get(group.folder) || 0) + 1);
    });
    const used = new Set();
    order.forEach((group, index) => {
      let suffix = '';
      if ((counts.get(group.folder) || 0) > 1) {
        const idPart = cleanSegment(group.postId);
        suffix = '_' + (idPart || String(index + 1));
      }
      let candidate = sanitizeFolderName(group.folder + suffix);
      let n = 2;
      while (used.has(candidate)) {
        const idPart = cleanSegment(group.postId);
        suffix = '_' + (idPart || String(index + 1)) + '_' + n;
        candidate = sanitizeFolderName(group.folder + suffix);
        n += 1;
      }
      group.suffix = suffix;
      used.add(candidate);
    });

    const single = order.length <= 1;
    if (order.some((group) => group.dateSource === 'today')) {
      notices.push(single
        ? '此貼文沒有日期，已改用今天 ' + today + '。'
        : '有貼文沒有日期，已改用今天 ' + today + '。');
    }
    if (order.some((group) => group.dateSource === 'month')) {
      notices.push(single
        ? '此內容只提供月份，日期使用該月 1 日。'
        : '有內容只提供月份，日期使用該月 1 日。');
    }
    if (order.some((group) => group.titleSource === 'id')) {
      notices.push(single
        ? '此貼文沒有標題，已改用貼文 ID。'
        : '有貼文沒有標題，已改用貼文 ID。');
    }
    if (order.some((group) => group.titleSource === 'untitled')) {
      notices.push(single
        ? '此貼文沒有標題，已改用 untitled。'
        : '有貼文沒有標題，已改用 untitled。');
    }
    return order;
  }

  function disambiguateFolders(groups) {
    const seen = new Set();
    groups.forEach((group) => {
      let name = group.finalFolder;
      let n = 2;
      while (seen.has(name)) {
        name = truncateKeepingSuffix(group.folder, (group.suffix || '') + '_' + n, group.maxFolderLen);
        n += 1;
        if (n > 100) break;
      }
      seen.add(name);
      group.finalFolder = name;
    });
  }

  function buildPreview(mode, root, today, imageCount, finalNames, blocked) {
    if (mode === 'auto' && imageCount === 0) {
      return '掃瞄後依每篇貼文命名，例如 ' + root + '/' + today +
        '_貼文標題/。路徑超過 ' + MAX_RELATIVE_PATH + ' 字元時會縮短並在這裡提示。';
    }
    const shown = finalNames[0] || 'untitled';
    if (blocked) {
      return '無法儲存。縮短後預覽：' + root + '/' + shown + '/';
    }
    if (mode === 'auto' && finalNames.length > 1) {
      return '將建立 ' + finalNames.length + ' 個資料夾。預覽：' + root + '/' + shown + '/';
    }
    return '預覽：' + root + '/' + shown + '/';
  }

  root.DownloadPath = {
    MAX_RELATIVE_PATH: MAX_RELATIVE_PATH,
    PRESERVE_FILENAME_CHARS: PRESERVE_FILENAME_CHARS,
    TYPICAL_FILENAME: TYPICAL_FILENAME,
    todayStamp: todayStamp,
    cleanSegment: cleanSegment,
    sanitizeFolderName: sanitizeFolderName,
    truncateSegment: truncateSegment,
    cleanFilename: cleanFilename,
    fitFilename: fitFilename,
    resolveDate: resolveDate,
    resolveTitle: resolveTitle,
    planDownloadPaths: planDownloadPaths,
    blankPlan: blankPlan
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
