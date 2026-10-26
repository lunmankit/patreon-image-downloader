const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { URL, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'download-path.js'), 'utf8'), sandbox);
const DownloadPath = sandbox.DownloadPath;

const TODAY = '20261026';
const ILLEGAL = /[\\:*?"<>|]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function plan(images, options) {
  const result = DownloadPath.planDownloadPaths(images, Object.assign({ today: TODAY }, options));
  return JSON.parse(JSON.stringify(result));
}

function assertSafe(rel, label) {
  assert.ok(rel.length <= DownloadPath.MAX_RELATIVE_PATH, label + ' length ' + rel.length + ' ' + rel);
  assert.ok(!rel.includes('\\'), label);
  assert.ok(!rel.split('/').some((part) => part === '' || part === '.' || part === '..'), label);
  rel.split('/').forEach((part) => {
    assert.ok(!ILLEGAL.test(part), label + ' ' + part);
    assert.ok(!/[. ]$/.test(part), label + ' trailing ' + part);
    const stem = part.replace(/\..*$/, '');
    assert.ok(!RESERVED.test(part) && !RESERVED.test(stem), label + ' reserved ' + part);
  });
}

const flat = plan([{ filename: 'art.png', postTitle: 'Ignored', postDate: '2026-01-02' }], {
  root: 'Patreon_Downloads',
  mode: 'off'
});
assert.strictEqual(flat.ok, true);
assert.deepStrictEqual(flat.paths, ['Patreon_Downloads/art.png']);
assert.deepStrictEqual(flat.warnings, []);
assert.ok(flat.preview.includes('Patreon_Downloads/'));

const fantiaFlat = plan([{ filename: 'art.png' }], { root: 'Fantia_Downloads', mode: 'off' });
assert.deepStrictEqual(fantiaFlat.paths, ['Fantia_Downloads/art.png']);

const auto = plan([{
  filename: 'photo.jpg',
  postId: '15',
  postTitle: 'Some Post Title',
  postDate: '2026-10-26T15:04:05.000Z'
}], { root: 'Patreon_Downloads', mode: 'auto' });
assert.strictEqual(auto.ok, true);
assert.deepStrictEqual(auto.paths, ['Patreon_Downloads/20261026_Some Post Title/photo.jpg']);
assert.deepStrictEqual(auto.notices, []);
assert.deepStrictEqual(auto.warnings, []);

const fantiaAuto = plan([{
  filename: 'a.png',
  postId: '9',
  postTitle: 'Fantia Title',
  postDate: '2026-10-26T01:02:03+09:00'
}], { root: 'Fantia_Downloads', mode: 'auto' });
assert.deepStrictEqual(fantiaAuto.paths, ['Fantia_Downloads/20261026_Fantia Title/a.png']);

const illegalTitle = plan([{
  filename: 'a.jpg',
  postId: '1',
  postTitle: 'A/B:C*?"<>|.',
  postDate: '20261026'
}], { root: 'Patreon_Downloads', mode: 'auto' });
assert.strictEqual(illegalTitle.paths[0], 'Patreon_Downloads/20261026_A_B_C______/a.jpg');
assertSafe(illegalTitle.paths[0], 'illegal');

const missing = plan([{ filename: 'a.jpg', postId: '', postTitle: '   ', postDate: '' }], {
  root: 'Patreon_Downloads',
  mode: 'auto'
});
assert.strictEqual(missing.paths[0], 'Patreon_Downloads/20261026_untitled/a.jpg');
assert.ok(missing.notices.some((line) => line.includes('今天 20261026')));
assert.ok(missing.notices.some((line) => line.includes('untitled')));

const idFallback = plan([{ filename: 'a.jpg', postId: '99', postTitle: '...', postDate: 'not-a-date' }], {
  root: 'Fantia_Downloads',
  mode: 'auto'
});
assert.strictEqual(idFallback.paths[0], 'Fantia_Downloads/20261026_99/a.jpg');
assert.ok(idFallback.notices.some((line) => line.includes('貼文 ID')));
assert.ok(idFallback.notices.some((line) => line.includes('今天')));

const month = plan([{ filename: 'a.jpg', postId: '3', postTitle: 'August', postDate: '202608' }], {
  root: 'Fantia_Downloads',
  mode: 'auto'
});
assert.strictEqual(month.paths[0], 'Fantia_Downloads/20260801_August/a.jpg');
assert.ok(month.notices.some((line) => line.includes('月份')));

const shared = plan([
  { filename: 'one.jpg', postId: '11', postTitle: 'Hello', postDate: '2026-10-26' },
  { filename: 'two.jpg', postId: '11', postTitle: 'Hello', postDate: '2026-10-26' },
  { filename: 'three.jpg', postId: '22', postTitle: 'Hello', postDate: '2026-10-26' }
], { root: 'Patreon_Downloads', mode: 'auto' });
assert.strictEqual(shared.paths[0], 'Patreon_Downloads/20261026_Hello_11/one.jpg');
assert.strictEqual(shared.paths[1], 'Patreon_Downloads/20261026_Hello_11/two.jpg');
assert.strictEqual(shared.paths[2], 'Patreon_Downloads/20261026_Hello_22/three.jpg');
assert.strictEqual(shared.folderCount, 2);
assert.ok(shared.preview.includes('將建立 2 個資料夾'));

const longTitle = 'L'.repeat(180);
const longSame = plan([
  { filename: 'a.jpg', postId: '11', postTitle: longTitle, postDate: '2026-10-26' },
  { filename: 'b.jpg', postId: '22', postTitle: longTitle, postDate: '2026-10-26' }
], { root: 'Patreon_Downloads', mode: 'auto' });
assert.strictEqual(longSame.ok, true);
assert.ok(longSame.warnings.some((line) => line.includes('已縮短為')));
assert.ok(longSame.paths[0].endsWith('_11/a.jpg'), longSame.paths[0]);
assert.ok(longSame.paths[1].endsWith('_22/b.jpg'), longSame.paths[1]);
longSame.paths.forEach((rel) => assertSafe(rel, 'long-same'));
assert.notStrictEqual(longSame.paths[0].split('/')[1], longSame.paths[1].split('/')[1]);

const stem = 'A'.repeat(200);
const collapsed = plan([
  { filename: 'a.jpg', postId: '1', postTitle: stem + '1', postDate: '2026-10-26' },
  { filename: 'b.jpg', postId: '2', postTitle: stem + '2', postDate: '2026-10-26' }
], { root: 'Patreon_Downloads', mode: 'auto' });
assert.notStrictEqual(collapsed.paths[0].split('/')[1], collapsed.paths[1].split('/')[1]);
collapsed.paths.forEach((rel) => assertSafe(rel, 'collapsed'));

const exactFolder = 'T'.repeat(168);
const exact = plan([{
  filename: 'a.jpg',
  postId: '1',
  postTitle: exactFolder,
  postDate: '2026-10-26'
}], { root: 'Patreon_Downloads', mode: 'auto' });
// 9 char date prefix + 168 title chars = 177, which is one over the 176 that fit with a.jpg.
assert.strictEqual(exact.ok, true);
assert.strictEqual(exact.paths[0].length, DownloadPath.MAX_RELATIVE_PATH);
assert.ok(exact.warnings.length > 0);

const oneUnder = plan([{
  filename: 'a.jpg',
  postId: '1',
  postTitle: 'T'.repeat(167),
  postDate: '2026-10-26'
}], { root: 'Patreon_Downloads', mode: 'auto' });
assert.deepStrictEqual(oneUnder.warnings, []);
assert.strictEqual(oneUnder.paths[0].length, DownloadPath.MAX_RELATIVE_PATH);

const customOk = plan([{ filename: 'pic.jpg', postId: '1', postTitle: 'ignored' }], {
  root: 'Patreon_Downloads',
  mode: 'custom',
  customName: 'My Folder'
});
assert.strictEqual(customOk.ok, true);
assert.deepStrictEqual(customOk.paths, ['Patreon_Downloads/My Folder/pic.jpg']);

const customEmpty = plan([{ filename: 'pic.jpg' }], {
  root: 'Fantia_Downloads',
  mode: 'custom',
  customName: '   '
});
assert.strictEqual(customEmpty.paths[0], 'Fantia_Downloads/untitled/pic.jpg');
assert.ok(customEmpty.notices.some((line) => line.includes('未輸入')));

const customDots = plan([{ filename: 'pic.jpg' }], {
  root: 'Patreon_Downloads',
  mode: 'custom',
  customName: '...'
});
assert.strictEqual(customDots.paths[0], 'Patreon_Downloads/untitled/pic.jpg');
assert.ok(customDots.notices.some((line) => line.includes('無法使用')));

const customReserved = plan([{ filename: 'pic.jpg' }], {
  root: 'Patreon_Downloads',
  mode: 'custom',
  customName: 'CON'
});
assert.strictEqual(customReserved.paths[0], 'Patreon_Downloads/_CON/pic.jpg');
assert.ok(customReserved.notices.some((line) => line.includes('保留字')));

const customTrail = plan([{ filename: 'pic.jpg' }], {
  root: 'Patreon_Downloads',
  mode: 'custom',
  customName: 'Hello. '
});
assert.strictEqual(customTrail.paths[0], 'Patreon_Downloads/Hello/pic.jpg');

const tooLongCustom = 'C'.repeat(177);
const blocked = plan([{ filename: 'a.jpg', postTitle: 'x' }], {
  root: 'Patreon_Downloads',
  mode: 'custom',
  customName: tooLongCustom
});
assert.strictEqual(blocked.ok, false);
assert.deepStrictEqual(blocked.paths, []);
assert.ok(blocked.warnings[0].includes('無法儲存'));
assert.ok(blocked.warnings[0].includes(blocked.suggestedCustomName));
assert.ok(blocked.suggestedCustomName.length < tooLongCustom.length);
const accepted = plan([{ filename: 'a.jpg' }], {
  root: 'Patreon_Downloads',
  mode: 'custom',
  customName: blocked.suggestedCustomName
});
assert.strictEqual(accepted.ok, true);
assert.strictEqual(accepted.paths[0].length <= DownloadPath.MAX_RELATIVE_PATH, true);
assertSafe(accepted.paths[0], 'accepted custom');

const beforeScan = plan([], {
  root: 'Patreon_Downloads',
  mode: 'custom',
  customName: 'C'.repeat(146)
});
assert.strictEqual(beforeScan.ok, false);
assert.ok(beforeScan.warnings[0].includes('無法儲存'));
const beforeScanOk = plan([], {
  root: 'Patreon_Downloads',
  mode: 'custom',
  customName: 'C'.repeat(145)
});
assert.strictEqual(beforeScanOk.ok, true);

const longFile = 'n'.repeat(190) + '.png';
const longFilePlan = plan([{ filename: longFile, postId: '1', postTitle: 'Short', postDate: '2026-10-26' }], {
  root: 'Fantia_Downloads',
  mode: 'auto'
});
assert.strictEqual(longFilePlan.ok, true);
assert.ok(longFilePlan.warnings.some((line) => line.includes('檔名過長')));
longFilePlan.paths.forEach((rel) => assertSafe(rel, 'long-file'));
assert.ok(longFilePlan.paths[0].endsWith('.png'));

const flatLong = plan([{ filename: 'z'.repeat(210) + '.jpg' }], {
  root: 'Patreon_Downloads',
  mode: 'off'
});
assert.strictEqual(flatLong.ok, true);
assertSafe(flatLong.paths[0], 'flat-long');
assert.ok(flatLong.warnings.some((line) => line.includes('檔名過長')));
assert.ok(!flatLong.paths[0].includes('untitled'));

assert.strictEqual(DownloadPath.cleanFilename('CON.jpg'), '_CON.jpg');
assert.strictEqual(DownloadPath.sanitizeFolderName('aux'), '_aux');
assert.strictEqual(DownloadPath.resolveDate('2026-10-26T00:00:00+09:00', TODAY).yyyymmdd, '20261026');
assert.strictEqual(DownloadPath.resolveDate('20261340', TODAY).source, 'today');

const popup = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
assert.ok(popup.includes('個別資料夾：日期_標題'));
assert.ok(popup.includes('個別資料夾：自訂名稱'));
assert.ok(popup.includes('不分子資料夾'));
assert.ok(popup.includes('改用縮短名稱'));
assert.ok(popup.includes('download-path.js'));
const popupJs = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
assert.ok(popupJs.includes('folderNameMode'));
assert.ok(popupJs.includes('customFolderName'));
assert.ok(popupJs.includes('plan.paths[index]'));

const chromeManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.firefox.json'), 'utf8'));
assert.deepStrictEqual(chromeManifest.background, { service_worker: 'background.js' });
assert.deepStrictEqual(firefoxManifest.background, { scripts: ['background.js'] });
assert.strictEqual(chromeManifest.version, firefoxManifest.version);

console.log('download path tests passed');
