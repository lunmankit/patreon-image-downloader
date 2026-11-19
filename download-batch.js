// Shared batch download decisions for the popup. No DOM and no chrome.* calls.
// Patreon, Fantia, and generic galleries all use this. Patreon can also ask
// for a fresh media URL; the caller decides whether refresh is possible.
//
// chrome.downloads.download's callback fires when a download is queued or
// refused, not when the file is saved. Interruptions (NETWORK_FAILED,
// SERVER_FORBIDDEN, an expired signed URL, and similar) have to be observed
// separately. The status text keeps the raw reason code so a later failure
// is diagnosable, and it never includes the media URL.
//
// A path Chrome or Firefox rejects (INVALID_FILENAME) is not a dead end:
// the relative path is sanitized per segment first, and one failure is
// tried again under a different safe path. The media URL is not refreshed
// for that error, and the same bad path is not repeated.
(function (root) {
  const MAX_ATTEMPTS = 3;
  const DEFAULT_CONCURRENCY = 3;
  const FAILURE_PREVIEW_LIMIT = 6;
  const SUCCESS_TEXT = '所有圖片已成功下載！';

  const INTERRUPT_CODES = [
    'FILE_SECURITY_CHECK_FAILED',
    'SERVER_CROSS_ORIGIN_REDIRECT',
    'NETWORK_INVALID_REQUEST',
    'FILE_NAME_TOO_LONG',
    'NETWORK_DISCONNECTED',
    'FILE_VIRUS_INFECTED',
    'FILE_ACCESS_DENIED',
    'SERVER_UNAUTHORIZED',
    'SERVER_CERT_PROBLEM',
    'SERVER_BAD_CONTENT',
    'SERVER_FORBIDDEN',
    'NETWORK_TIMEOUT',
    'SERVER_NO_RANGE',
    'FILE_TOO_LARGE',
    'FILE_TOO_SHORT',
    'NETWORK_FAILED',
    'SERVER_FAILED',
    'USER_SHUTDOWN',
    'USER_CANCELED',
    'FILE_BLOCKED',
    'FILE_NO_SPACE',
    'FILE_FAILED',
    'CRASH'
  ];

  const LABELS = {
    INVALID_FILENAME: '檔名無法使用',
    FILE_NAME_TOO_LONG: '檔名過長',
    FILE_FAILED: '無法寫入檔案',
    FILE_ACCESS_DENIED: '沒有權限寫入檔案',
    FILE_NO_SPACE: '磁碟空間不足',
    FILE_TOO_LARGE: '檔案過大',
    FILE_TOO_SHORT: '檔案內容不完整',
    FILE_VIRUS_INFECTED: '檔案被安全性檢查阻擋',
    FILE_BLOCKED: '檔案被瀏覽器阻擋',
    FILE_SECURITY_CHECK_FAILED: '安全性檢查失敗',
    NETWORK_FAILED: '網路連線失敗',
    NETWORK_TIMEOUT: '網路逾時',
    NETWORK_DISCONNECTED: '網路已中斷',
    NETWORK_INVALID_REQUEST: '下載網址無效',
    SERVER_FAILED: '伺服器錯誤',
    SERVER_NO_RANGE: '伺服器不支援續傳',
    SERVER_BAD_CONTENT: '伺服器回應的不是圖片',
    SERVER_UNAUTHORIZED: '沒有權限，可能需要重新登入',
    SERVER_FORBIDDEN: '伺服器拒絕存取，連結可能已過期',
    SERVER_CERT_PROBLEM: '憑證錯誤',
    SERVER_CROSS_ORIGIN_REDIRECT: '下載重新導向失敗',
    USER_CANCELED: '下載已取消',
    USER_SHUTDOWN: '瀏覽器關閉，下載中斷',
    CRASH: '下載程序當掉',
    INTERRUPTED: '下載中斷'
  };

  const PERMANENT = {
    INVALID_FILENAME: true,
    FILE_NAME_TOO_LONG: true,
    FILE_FAILED: true,
    FILE_ACCESS_DENIED: true,
    FILE_NO_SPACE: true,
    FILE_TOO_LARGE: true,
    FILE_VIRUS_INFECTED: true,
    FILE_BLOCKED: true,
    FILE_SECURITY_CHECK_FAILED: true,
    USER_CANCELED: true,
    USER_SHUTDOWN: true
  };

  const REFRESHABLE = {
    SERVER_FORBIDDEN: true,
    SERVER_UNAUTHORIZED: true,
    SERVER_FAILED: true,
    SERVER_BAD_CONTENT: true,
    SERVER_NO_RANGE: true,
    SERVER_CERT_PROBLEM: true,
    SERVER_CROSS_ORIGIN_REDIRECT: true,
    NETWORK_FAILED: true,
    NETWORK_TIMEOUT: true,
    NETWORK_DISCONNECTED: true,
    NETWORK_INVALID_REQUEST: true,
    FILE_TOO_SHORT: true,
    CRASH: true,
    INTERRUPTED: true
  };

  function redactSecrets(text) {
    return String(text == null ? '' : text)
      .replace(/([?#&](?:token-hash|token-time|token|expires|signature|sig|jwt|access_token|share_token|auth)=)[^&#\s]*/gi, '$1…')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '…');
  }

  function classifyDownloadError(message) {
    const raw = String(message == null ? '' : message);
    const upper = raw.toUpperCase();
    let code = '';
    for (let i = 0; i < INTERRUPT_CODES.length; i++) {
      if (upper.indexOf(INTERRUPT_CODES[i]) !== -1) {
        code = INTERRUPT_CODES[i];
        break;
      }
    }
    if (!code && /INVALID\s+FILENAME|非法檔名|ILLEGAL CHARACTERS/.test(upper)) code = 'INVALID_FILENAME';
    if (!code && /INVALID\s+URL/.test(upper)) code = 'NETWORK_INVALID_REQUEST';
    if (!code && /\b403\b|FORBIDDEN/.test(upper)) code = 'SERVER_FORBIDDEN';
    if (!code && /\b401\b|UNAUTHORIZED/.test(upper)) code = 'SERVER_UNAUTHORIZED';
    if (!code && /TIMEOUT|逾時/.test(upper)) code = 'NETWORK_TIMEOUT';
    if (!code && upper.indexOf('INTERRUPTED') !== -1) code = 'INTERRUPTED';
    if (!code) {
      return {
        code: '',
        label: '下載失敗',
        retryable: true,
        refresh: true,
        raw: raw
      };
    }
    return {
      code: code,
      label: LABELS[code] || '下載失敗',
      retryable: !PERMANENT[code],
      refresh: !!REFRESHABLE[code],
      raw: raw
    };
  }

  function planRecovery(info, nextAttempt, item, maxAttempts) {
    const limit = maxAttempts || MAX_ATTEMPTS;
    if (!info || !info.retryable || nextAttempt >= limit) {
      return { action: 'fail', waitMs: 0 };
    }
    const canRefresh = !!(item && item.canRefresh);
    if (canRefresh && info.refresh) {
      return { action: 'refresh', waitMs: 400 * nextAttempt };
    }
    return { action: 'retry', waitMs: 350 * nextAttempt };
  }

  function isHttpUrl(url) {
    try {
      const parsed = new URL(String(url || ''));
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch (e) {
      return false;
    }
  }

  function isNonImageBody(mime) {
    const value = String(mime || '').split(';')[0].trim().toLowerCase();
    if (!value) return false;
    if (value.indexOf('image/') === 0) return false;
    if (value === 'application/octet-stream' || value === 'binary/octet-stream') return false;
    return value === 'text/html'
      || value === 'application/xhtml+xml'
      || value === 'text/plain'
      || value === 'application/json';
  }

  function displayName(item) {
    const name = item && item.filename ? String(item.filename) : '';
    if (name) return name;
    const pathName = item && item.path ? String(item.path).split('/').pop() : '';
    return pathName || '未命名檔案';
  }

  function publicDetail(info) {
    if (!info) return '';
    if (info.code) return info.code;
    const raw = redactSecrets(info.raw || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    return raw.length > 80 ? raw.slice(0, 77) + '...' : raw;
  }

  function failureLine(fail) {
    const name = redactSecrets(fail && fail.filename ? fail.filename : '未命名檔案');
    const label = redactSecrets(fail && fail.error ? fail.error : '下載失敗');
    const detail = redactSecrets(fail && fail.detail ? fail.detail : '');
    if (detail && detail !== label) return name + '：' + label + '（' + detail + '）';
    return name + '：' + label;
  }

  function failureSummary(failures) {
    const list = Array.isArray(failures) ? failures : [];
    if (!list.length) return '';
    const lines = ['下載結束，有 ' + list.length + ' 個檔案失敗。'];
    const shown = list.slice(0, FAILURE_PREVIEW_LIMIT);
    for (let i = 0; i < shown.length; i++) lines.push(failureLine(shown[i]));
    if (list.length > shown.length) {
      lines.push('以及其他 ' + (list.length - shown.length) + ' 個檔案。');
    }
    return lines.join('\n');
  }

  function progressText(settled, total, retrying) {
    const base = '下載進度：' + settled + ' / ' + total;
    return retrying ? base + '（正在重試）' : base;
  }

  function resultText(failed) {
    if (!failed || !failed.length) return SUCCESS_TEXT;
    return failureSummary(failed);
  }

  function sanitizeDownloadPath(value) {
    const api = root.DownloadPath;
    if (api && typeof api.sanitizeRelativePath === 'function') return api.sanitizeRelativePath(value);
    const text = String(value == null ? '' : value).replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '').replace(/^\/+/, '');
    const parts = text.split('/').filter(function (part) {
      return part && part !== '.' && part !== '..';
    });
    return parts.join('/') || 'image.jpg';
  }

  function alternateSafePath(item, current) {
    const api = root.DownloadPath;
    const leafRaw = (item && item.filename) || String(current || '').split('/').pop() || 'image.jpg';
    const leaf = api && typeof api.cleanFilename === 'function' ? api.cleanFilename(leafRaw) : String(leafRaw || 'image.jpg');
    const first = String(current || '').split('/')[0] || 'Downloads';
    const rootName = api && typeof api.sanitizeFolderName === 'function' ? api.sanitizeFolderName(first) : first;
    const postRaw = item && item.postId ? String(item.postId) : '';
    const postSeg = postRaw && api && typeof api.sanitizeFolderName === 'function'
      ? api.sanitizeFolderName(postRaw)
      : postRaw;
    let next = postSeg && postSeg !== 'untitled'
      ? rootName + '/' + postSeg + '/' + leaf
      : rootName + '/' + leaf;
    next = sanitizeDownloadPath(next);
    if (next === current) {
      const dot = leaf.lastIndexOf('.');
      const alt = dot > 0 ? leaf.slice(0, dot) + '_' + leaf.slice(dot) : leaf + '_';
      next = sanitizeDownloadPath(rootName + '/' + alt);
    }
    return next;
  }

  async function runOne(item, options) {
    const opts = options || {};
    const maxAttempts = Math.max(1, Number(opts.maxAttempts) || MAX_ATTEMPTS);
    let url = String(item && item.url || '');
    let saveAs = sanitizeDownloadPath((item && (item.path || item.filename)) || '');
    let filenameRetried = false;
    const tried = [];
    let lastInfo = classifyDownloadError('下載沒有開始');

    function adoptSafeFilename() {
      if (filenameRetried || !lastInfo || lastInfo.code !== 'INVALID_FILENAME') return false;
      filenameRetried = true;
      const next = alternateSafePath(item, saveAs);
      if (!next || next === saveAs) return false;
      saveAs = next;
      if (typeof opts.noteRetry === 'function') opts.noteRetry();
      return true;
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (!isHttpUrl(url)) {
        lastInfo = classifyDownloadError('Invalid URL');
      } else {
        let started = null;
        try {
          started = await opts.download({
            url: url,
            filename: saveAs
          });
        } catch (e) {
          started = { ok: false, error: (e && e.message) || String(e) };
        }
        if (tried.indexOf(url) === -1) tried.push(url);
        if (!started || !started.ok) {
          lastInfo = classifyDownloadError((started && started.error) || '下載沒有開始');
          if (adoptSafeFilename()) {
            attempt -= 1;
            continue;
          }
        } else {
          let finished = null;
          try {
            finished = await opts.wait(started.id);
          } catch (e) {
            finished = { ok: false, error: (e && e.message) || String(e) };
          }
          const badBody = !!(finished && finished.ok && isNonImageBody(finished.mime));
          if (finished && finished.ok && !badBody) {
            return { ok: true, filename: displayName(item) };
          }
          lastInfo = classifyDownloadError(
            badBody ? 'SERVER_BAD_CONTENT' : ((finished && finished.error) || 'interrupted')
          );
          if (!badBody && adoptSafeFilename()) {
            if (started.id && typeof opts.discard === 'function') {
              try { await opts.discard(started.id); } catch (e) {}
            }
            attempt -= 1;
            continue;
          }
          const recoveryNow = planRecovery(lastInfo, attempt + 1, item, maxAttempts);
          const giveUp = recoveryNow.action === 'fail';
          if (started.id && typeof opts.discard === 'function' && (!giveUp || badBody)) {
            try { await opts.discard(started.id); } catch (e) {}
          }
          if (giveUp) break;
          if (typeof opts.noteRetry === 'function') opts.noteRetry();
          if (recoveryNow.waitMs && typeof opts.sleep === 'function') await opts.sleep(recoveryNow.waitMs);
          if (recoveryNow.action === 'refresh' && typeof opts.refreshUrl === 'function') {
            await applyRefresh(opts, item, tried, function (next) { url = next; });
          }
          continue;
        }
      }

      const recovery = planRecovery(lastInfo, attempt + 1, item, maxAttempts);
      if (recovery.action === 'fail') break;
      if (typeof opts.noteRetry === 'function') opts.noteRetry();
      if (recovery.waitMs && typeof opts.sleep === 'function') await opts.sleep(recovery.waitMs);
      if (recovery.action === 'refresh' && typeof opts.refreshUrl === 'function') {
        await applyRefresh(opts, item, tried, function (next) { url = next; });
      }
    }

    return {
      ok: false,
      filename: displayName(item),
      error: lastInfo.label,
      detail: publicDetail(lastInfo)
    };
  }

  async function applyRefresh(opts, item, tried, assign) {
    let fresh = '';
    try {
      fresh = await opts.refreshUrl(Object.assign({}, item, {
        url: tried.length ? tried[tried.length - 1] : (item && item.url) || '',
        skipUrls: tried.slice()
      }));
    } catch (e) {
      fresh = '';
    }
    if (typeof fresh === 'string' && fresh && tried.indexOf(fresh) === -1 && isHttpUrl(fresh)) {
      assign(fresh);
    }
  }

  async function runDownloadBatch(items, deps) {
    const options = deps || {};
    const list = Array.isArray(items) ? items : [];
    const concurrency = Math.max(1, Number(options.concurrency) || DEFAULT_CONCURRENCY);
    const failed = [];
    let settled = 0;

    function emit(retrying) {
      if (typeof options.onProgress !== 'function') return;
      options.onProgress({
        settled: settled,
        total: list.length,
        failed: failed.length,
        retrying: !!retrying,
        text: progressText(settled, list.length, !!retrying)
      });
    }

    if (!list.length) {
      return { ok: true, failed: [], succeeded: 0, text: SUCCESS_TEXT };
    }

    emit(false);
    let cursor = 0;
    const workerOptions = Object.assign({}, options, {
      noteRetry: function () { emit(true); }
    });

    async function worker() {
      while (cursor < list.length) {
        const item = list[cursor];
        cursor += 1;
        const outcome = await runOne(item, workerOptions);
        settled += 1;
        if (!outcome.ok) {
          failed.push({
            filename: outcome.filename,
            error: outcome.error,
            detail: outcome.detail
          });
        }
        emit(false);
      }
    }

    const workers = [];
    const pool = Math.min(concurrency, list.length);
    for (let i = 0; i < pool; i++) workers.push(worker());
    await Promise.all(workers);

    return {
      ok: failed.length === 0,
      failed: failed,
      succeeded: list.length - failed.length,
      text: resultText(failed)
    };
  }

  root.DownloadBatch = {
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    DEFAULT_CONCURRENCY: DEFAULT_CONCURRENCY,
    SUCCESS_TEXT: SUCCESS_TEXT,
    redactSecrets: redactSecrets,
    classifyDownloadError: classifyDownloadError,
    planRecovery: planRecovery,
    failureSummary: failureSummary,
    progressText: progressText,
    resultText: resultText,
    isNonImageBody: isNonImageBody,
    runDownloadBatch: runDownloadBatch
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
