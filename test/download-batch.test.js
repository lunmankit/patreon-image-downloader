const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { URL, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'download-batch.js'), 'utf8'), sandbox);
const Batch = sandbox.DownloadBatch;

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function item(extra) {
  return Object.assign({
    url: 'https://cdn.example/old.jpg?token-time=1&token-hash=supersecret',
    filename: 'sparkle-01.jpg',
    path: 'Patreon_Downloads/sparkle-01.jpg',
    mediaId: '11',
    postId: '174139933',
    canRefresh: true
  }, extra || {});
}

async function run(items, deps) {
  return Batch.runDownloadBatch(items, Object.assign({
    sleep: async () => {},
    refreshUrl: async () => '',
    discard: async () => {},
    wait: async () => ({ ok: true, mime: 'image/jpeg' })
  }, deps || {}));
}

const redacted = Batch.redactSecrets(
  'https://c10.patreonusercontent.com/a.jpg?token-time=1&token-hash=supersecret&share_token=jwt'
);
assert.ok(redacted.indexOf('supersecret') === -1);
assert.ok(redacted.indexOf('share_token=…') !== -1);
assert.ok(redacted.indexOf('token-hash=…') !== -1);

const forbidden = Batch.classifyDownloadError('Download interrupted: SERVER_FORBIDDEN');
assert.strictEqual(forbidden.code, 'SERVER_FORBIDDEN');
assert.strictEqual(forbidden.retryable, true);
assert.strictEqual(forbidden.refresh, true);
assert.ok(forbidden.label.indexOf('過期') !== -1);

const invalidName = Batch.classifyDownloadError('Invalid filename');
assert.strictEqual(invalidName.code, 'INVALID_FILENAME');
assert.strictEqual(invalidName.retryable, false);
assert.strictEqual(invalidName.refresh, false);
assert.strictEqual(invalidName.label, '檔名無法使用');

const network = Batch.classifyDownloadError('NETWORK_FAILED');
assert.strictEqual(network.retryable, true);
assert.strictEqual(Batch.planRecovery(network, 1, { canRefresh: false }, 3).action, 'retry');
assert.strictEqual(Batch.planRecovery(network, 1, { canRefresh: true }, 3).action, 'refresh');
assert.strictEqual(Batch.planRecovery(invalidName, 1, { canRefresh: true }, 3).action, 'fail');
assert.strictEqual(Batch.planRecovery(network, 3, { canRefresh: true }, 3).action, 'fail');

const seven = [];
for (let i = 0; i < 7; i++) {
  seven.push({ filename: 'f' + i + '.jpg', error: '網路連線失敗', detail: 'NETWORK_FAILED' });
}
const sevenText = Batch.failureSummary(seven);
assert.ok(sevenText.indexOf('下載結束，有 7 個檔案失敗。') === 0);
assert.ok(sevenText.indexOf('f0.jpg：網路連線失敗（NETWORK_FAILED）') !== -1);
assert.ok(sevenText.indexOf('f5.jpg') !== -1);
assert.ok(sevenText.indexOf('f6.jpg') === -1);
assert.ok(sevenText.indexOf('以及其他 1 個檔案。') !== -1);
assert.strictEqual(Batch.resultText([]), '所有圖片已成功下載！');

async function testSuccessAfterRefresh() {
  const urls = [];
  const discarded = [];
  let refreshes = 0;
  const fresh = 'https://www.patreon.com/file?h=174139933&m=11';
  const result = await run([item()], {
    download: async ({ url }) => {
      urls.push(url);
      if (url === fresh) return { ok: true, id: 2 };
      return { ok: false, error: 'Download interrupted: SERVER_FORBIDDEN https://cdn.example/old.jpg?token-hash=supersecret' };
    },
    discard: async (id) => { discarded.push(id); },
    refreshUrl: async (request) => {
      refreshes += 1;
      assert.ok(request.skipUrls.indexOf(request.url) !== -1);
      assert.ok(request.url.indexOf('token-hash=supersecret') !== -1);
      return fresh;
    }
  });
  assert.deepStrictEqual(urls, [
    'https://cdn.example/old.jpg?token-time=1&token-hash=supersecret',
    fresh
  ]);
  assert.strictEqual(refreshes, 1);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.text, '所有圖片已成功下載！');
  assert.ok(result.text.indexOf('失敗') === -1);
  assert.ok(result.text.indexOf('supersecret') === -1);
  assert.ok(result.text.indexOf('token-hash') === -1);
  assert.deepStrictEqual(discarded, []);
}

async function testFourFailuresReportDetail() {
  const names = ['sparkle-01.jpg', 'sparkle-02.jpg', 'sparkle-03.jpg', 'sparkle-04.jpg'];
  let downloads = 0;
  const result = await run(names.map((name, index) => item({
    filename: name,
    path: 'Patreon_Downloads/' + name,
    url: 'https://cdn.example/' + index + '.jpg?token-hash=supersecret',
    mediaId: String(11 + index)
  })), {
    concurrency: 1,
    download: async () => {
      downloads += 1;
      return { ok: false, error: 'SERVER_FORBIDDEN ?token-hash=supersecret' };
    },
    refreshUrl: async () => ''
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failed.length, 4);
  assert.strictEqual(downloads, 12);
  assert.ok(result.text.indexOf('下載結束，有 4 個檔案失敗。') === 0);
  names.forEach((name) => {
    assert.ok(result.text.indexOf(name + '：伺服器拒絕存取，連結可能已過期（SERVER_FORBIDDEN）') !== -1);
  });
  assert.ok(result.text.indexOf('supersecret') === -1);
  assert.ok(result.text.indexOf('https://') === -1);
}

async function testFantiaRetriesWithoutRefresh() {
  let downloads = 0;
  let refreshes = 0;
  const result = await run([item({
    url: 'https://c.fantia.jp/uploads/a.png',
    filename: 'a.png',
    path: 'Fantia_Downloads/a.png',
    canRefresh: false,
    mediaId: '',
    postId: '9'
  })], {
    download: async () => {
      downloads += 1;
      if (downloads === 1) return { ok: false, error: 'NETWORK_FAILED' };
      return { ok: true, id: 4 };
    },
    refreshUrl: async () => {
      refreshes += 1;
      return 'https://c.fantia.jp/should-not-be-used.png';
    }
  });
  assert.strictEqual(downloads, 2);
  assert.strictEqual(refreshes, 0);
  assert.strictEqual(result.text, '所有圖片已成功下載！');
}

async function testInvalidFilenameIsNotRetried() {
  let downloads = 0;
  let refreshes = 0;
  const result = await run([item({ filename: 'bad.jpg' })], {
    download: async () => {
      downloads += 1;
      return { ok: false, error: 'Invalid filename' };
    },
    refreshUrl: async () => {
      refreshes += 1;
      return 'https://cdn.example/other.jpg';
    }
  });
  assert.strictEqual(downloads, 1);
  assert.strictEqual(refreshes, 0);
  assert.ok(result.text.indexOf('bad.jpg：檔名無法使用（INVALID_FILENAME）') !== -1);
}

async function testHtmlBodyIsRetried() {
  let waits = 0;
  const discarded = [];
  const urls = [];
  const result = await run([item({ canRefresh: false, filename: 'page.jpg' })], {
    download: async ({ url }) => {
      urls.push(url);
      return { ok: true, id: urls.length };
    },
    wait: async () => {
      waits += 1;
      if (waits === 1) return { ok: true, mime: 'text/html; charset=utf-8' };
      return { ok: true, mime: 'image/jpeg' };
    },
    discard: async (id) => { discarded.push(id); }
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(waits, 2);
  assert.deepStrictEqual(discarded, [1]);
  assert.strictEqual(urls.length, 2);
}

async function testConcurrency() {
  let active = 0;
  let max = 0;
  const pending = [];
  const items = [];
  for (let n = 1; n <= 5; n++) {
    items.push(item({
      url: 'https://cdn.example/g' + n + '.jpg',
      filename: 'g' + n + '.jpg',
      path: 'Gallery_Downloads/g' + n + '.jpg',
      canRefresh: false,
      mediaId: '',
      postId: ''
    }));
  }
  const resultPromise = run(items, {
    concurrency: 2,
    download: () => {
      active += 1;
      if (active > max) max = active;
      return new Promise((resolve) => {
        pending.push(() => {
          active -= 1;
          resolve({ ok: true, id: pending.length });
        });
      });
    },
    refreshUrl: async () => {
      throw new Error('gallery download should not refresh');
    }
  });
  for (let guard = 0; guard < 20; guard++) {
    await flush();
    if (!pending.length) continue;
    const wave = pending.splice(0, pending.length);
    assert.ok(wave.length <= 2, 'wave ' + wave.length);
    wave.forEach((release) => release());
  }
  const result = await resultPromise;
  assert.strictEqual(result.succeeded, 5);
  assert.strictEqual(result.text, '所有圖片已成功下載！');
  assert.strictEqual(max, 2);
}

async function testProgressStaysQuietOnSuccess() {
  const texts = [];
  const result = await run([
    item({ filename: 'a.jpg', url: 'https://cdn.example/a.jpg', canRefresh: false }),
    item({ filename: 'b.jpg', url: 'https://cdn.example/b.jpg', canRefresh: false })
  ], {
    concurrency: 1,
    download: async () => ({ ok: true, id: 1 }),
    onProgress: (progress) => texts.push(progress.text)
  });
  assert.ok(texts.indexOf('下載進度：0 / 2') !== -1);
  assert.ok(texts.indexOf('下載進度：2 / 2') !== -1);
  assert.ok(texts.every((text) => text.indexOf('失敗') === -1));
  assert.strictEqual(result.text, '所有圖片已成功下載！');
}

const popupJs = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const stage = fs.readFileSync(path.join(root, 'scripts/stage-firefox.py'), 'utf8');
assert.ok(popupHtml.includes('download-batch.js'));
assert.ok(popupJs.includes('batch.runDownloadBatch(items'));
assert.ok(popupJs.includes("typeof batch.runDownloadBatch !== 'function'"));
assert.ok(popupJs.includes('chrome.downloads.onChanged'));
assert.ok(popupJs.includes('pageRefreshDownloadUrls'));
assert.ok(popupJs.includes('plan.paths[index]'));
assert.ok(!popupJs.includes('failedCount'));
assert.ok(stage.includes('download-batch.js'));
assert.ok(Batch.isNonImageBody('text/html; charset=utf-8'));
assert.ok(!Batch.isNonImageBody('image/jpeg'));
assert.ok(!Batch.isNonImageBody(''));

testSuccessAfterRefresh()
  .then(testFourFailuresReportDetail)
  .then(testFantiaRetriesWithoutRefresh)
  .then(testInvalidFilenameIsNotRetried)
  .then(testHtmlBodyIsRetried)
  .then(testConcurrency)
  .then(testProgressStaysQuietOnSuccess)
  .then(() => {
    console.log('download batch tests passed');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
