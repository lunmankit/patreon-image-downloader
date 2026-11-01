const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { URL, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'gallery-scan.js'), 'utf8'), sandbox);
const Scan = sandbox.GalleryScan;

// Arrays created inside the vm have a different Array prototype.
function same(actual, expected) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected);
}

const page = 'https://www.smlsy.com/video_detail.php?id=405258';
const full = 'https://www.tpzf001.com/userfiles5/202611/20261102_004857_89b36a63337ddebb.jpeg';
const mip = 'https://www.tpzf001.com/userfiles5/202611/mip/20261102_004857_89b36a63337ddebb.jpeg';

assert.strictEqual(Scan.originMatchPattern(page), 'https://www.smlsy.com/*');
assert.strictEqual(Scan.originMatchPattern('http://localhost:8080/gallery'), 'http://localhost:8080/*');
assert.strictEqual(Scan.originMatchPattern('chrome://extensions'), '');
assert.strictEqual(Scan.originMatchPattern('about:blank'), '');
assert.strictEqual(Scan.originMatchPattern('javascript:window.open(1)'), '');

same(
  Scan.urlsFromInlineHandler('window.open("https://www.tpzf001.com/userfiles5/202611/20261102_004857_89b36a63337ddebb.jpeg")'),
  [full]
);
same(
  Scan.urlsFromInlineHandler("window.open('https://cdn.example/a.png', '_blank')"),
  ['https://cdn.example/a.png']
);
same(Scan.urlsFromInlineHandler('window.open(this.dataset.org)'), []);

const opened = Scan.resolveOpener({
  hasThumb: true,
  targetUrls: Scan.urlsFromInlineHandler('window.open("' + full + '")'),
  originalUrls: [full],
  thumbUrls: [mip]
}, page);
assert.strictEqual(opened.status, 'image');
assert.strictEqual(opened.url, full);
assert.ok(opened.url.indexOf('/mip/') === -1);

const mipOnly = Scan.resolveOpener({
  hasThumb: true,
  targetUrls: [mip],
  originalUrls: [full]
}, page);
assert.strictEqual(mipOnly.url, full);

const article = Scan.resolveOpener({
  hasThumb: true,
  targetUrls: ['https://www.smlsy.com/video_detail.php?id=9'],
  originalUrls: [],
  thumbUrls: ['https://www.smlsy.com/images/thumb.jpg']
}, page);
assert.strictEqual(article.status, 'probe');
assert.ok(article.url.indexOf('video_detail.php') !== -1);

assert.strictEqual(Scan.resolveOpener({
  hasThumb: true,
  targetUrls: ['https://www.smlsy.com/clip.mp4']
}, page).status, 'skip');
assert.strictEqual(Scan.resolveOpener({
  hasThumb: true,
  targetUrls: ['https://www.smlsy.com/smloft.apk']
}, page).status, 'skip');
assert.strictEqual(Scan.resolveOpener({
  hasThumb: true,
  targetUrls: ['https://googleads.g.doubleclick.net/pagead/view.jpg']
}, page).status, 'skip');
assert.strictEqual(Scan.resolveOpener({
  hasThumb: false,
  targetUrls: [full]
}, page).status, 'skip');
assert.strictEqual(Scan.classifyUrl('https://images.example/gallery?format=jpg'), 'page');
assert.strictEqual(
  Scan.classifyUrl('https://cdn.example/userfiles/2020/pic?fm=jpeg'),
  'image'
);

const mixed = Scan.resolveOpeners([
  { hasThumb: true, targetUrls: [full], originalUrls: [full] },
  { hasThumb: true, targetUrls: ['https://www.smlsy.com/video_detail.php?id=9'] },
  { hasThumb: true, targetUrls: ['https://www.smlsy.com/smloft.apk'] },
  { hasThumb: true, targetUrls: [full] }
], page);
same(mixed.images, [full]);
assert.strictEqual(mixed.probes.length, 1);
assert.strictEqual(mixed.skipped, 1);

const onePhoto = '<html><body><img src="https://cdn.example/userfiles/full.jpeg" width="1600" height="900"></body></html>';
const viewerPage = 'https://www.smlsy.com/view.php?id=1';
assert.strictEqual(Scan.extractSinglePhoto(onePhoto, viewerPage), 'https://cdn.example/userfiles/full.jpeg');
const oneDecision = Scan.decideProbe({
  url: viewerPage,
  finalUrl: viewerPage,
  contentType: 'text/html; charset=UTF-8',
  html: onePhoto
});
assert.strictEqual(oneDecision.status, 'image');
assert.strictEqual(oneDecision.url, 'https://cdn.example/userfiles/full.jpeg');
assert.notStrictEqual(oneDecision.url, viewerPage);

const withLogo = '<html><body><header><img src="https://cdn.example/logo.png"></header><img src="https://cdn.example/userfiles/full.jpeg"></body></html>';
assert.strictEqual(Scan.extractSinglePhoto(withLogo, viewerPage), 'https://cdn.example/userfiles/full.jpeg');

const many = '<html><body><img src="https://cdn.example/a.jpeg"><img src="https://cdn.example/b.jpeg"><img src="https://cdn.example/c.jpeg"></body></html>';
assert.strictEqual(Scan.extractSinglePhoto(many, viewerPage), '');
const manyDecision = Scan.decideProbe({
  url: viewerPage,
  finalUrl: viewerPage,
  contentType: 'text/html',
  html: many
});
assert.strictEqual(manyDecision.status, 'skip');
assert.ok(!manyDecision.url || manyDecision.url !== viewerPage);

const articleHtml = '<html><head><meta property="og:image" content="https://cdn.example/og.jpeg"></head><body><article><img src="https://cdn.example/a.jpeg"><img src="https://cdn.example/b.jpeg"></article></body></html>';
assert.strictEqual(Scan.extractSinglePhoto(articleHtml, viewerPage), '');

const ogOnly = '<html><head><meta property="og:image" content="https://cdn.example/only.jpeg"></head><body></body></html>';
assert.strictEqual(Scan.extractSinglePhoto(ogOnly, viewerPage), 'https://cdn.example/only.jpeg');

const bytes = Scan.decideProbe({
  url: 'https://cdn.example/download.php?id=4',
  finalUrl: 'https://cdn.example/files/4.png',
  contentType: 'image/png',
  html: ''
});
assert.strictEqual(bytes.status, 'image');
assert.strictEqual(bytes.url, 'https://cdn.example/files/4.png');

const extensionless = Scan.decideProbe({
  url: 'https://cdn.example/userfiles/raw',
  finalUrl: 'https://cdn.example/userfiles/raw',
  contentType: 'image/jpeg',
  html: ''
});
assert.strictEqual(extensionless.status, 'image');
assert.strictEqual(extensionless.url, 'https://cdn.example/userfiles/raw');

const pdf = Scan.decideProbe({
  url: 'https://cdn.example/file',
  finalUrl: 'https://cdn.example/file',
  contentType: 'application/pdf',
  html: ''
});
assert.strictEqual(pdf.status, 'skip');

assert.strictEqual(Scan.filenameFor(full, 0), '20261102_004857_89b36a63337ddebb.jpeg');
assert.strictEqual(Scan.filenameFor('https://cdn.example/download.php?id=4', 2), 'image_003.jpg');
const dupes = [
  Scan.imageRecord(full, 0, {}),
  Scan.imageRecord(full + '?x=1', 1, {})
];
Scan.uniqueFilenames(dupes);
assert.notStrictEqual(dupes[0].filename, dupes[1].filename);

function el(tag, attrs, children) {
  const node = {
    tagName: String(tag).toUpperCase(),
    attrs: attrs || {},
    children: children || [],
    parentElement: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    }
  };
  node.children.forEach((child) => { child.parentElement = node; });
  node.contains = function (other) {
    let cur = other;
    while (cur) {
      if (cur === node) return true;
      cur = cur.parentElement;
    }
    return false;
  };
  node.closest = function (selector) {
    let cur = node;
    while (cur) {
      if (matches(cur, selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  };
  node.querySelectorAll = function (selector) {
    const out = [];
    walk(node, (candidate) => {
      if (candidate !== node && matches(candidate, selector)) out.push(candidate);
    });
    return out;
  };
  return node;
}

function walk(node, visit) {
  (node.children || []).forEach((child) => {
    visit(child);
    walk(child, visit);
  });
}

function matches(node, selector) {
  return String(selector).split(',').some((part) => matchesOne(node, part.trim()));
}

function matchesOne(node, selector) {
  if (selector === 'img') return node.tagName === 'IMG';
  if (selector === 'header' || selector === 'footer' || selector === 'nav') {
    return node.tagName === selector.toUpperCase();
  }
  if (selector === 'a[href]') return node.tagName === 'A' && !!node.getAttribute('href');
  if (selector === '[onclick]') return !!node.getAttribute('onclick');
  const role = /^\[role="([^"]+)"\]$/.exec(selector);
  if (role) return node.getAttribute('role') === role[1];
  return false;
}

const doc = el('div', {}, [
  el('header', {}, [
    el('a', { href: './', target: '_blank' }, [
      el('img', { src: 'https://www.smlsy.com/images/logo/fox.png' })
    ])
  ]),
  el('div', { onclick: 'window.open("' + full + '")' }, [
    el('div', {}, [
      el('img', { src: mip, 'data-org': full })
    ])
  ]),
  el('a', { href: 'https://www.smlsy.com/video_detail.php?id=9', target: '_blank' }, [
    el('img', { src: 'https://www.smlsy.com/images/thumb.jpg' })
  ]),
  el('a', { href: 'https://www.smlsy.com/smloft.apk', target: '_blank' }, [
    el('img', { src: 'https://www.smlsy.com/images/web/hot.png' })
  ]),
  el('a', { href: './?id=405258&lang=en', target: '_blank' }),
  el('div', {}, [
    el('img', { src: 'https://cdn.example/tile-thumb.jpg' }),
    el('a', { href: 'https://cdn.example/photos/full.png', target: '_blank' })
  ])
]);

const found = Scan.resolveOpeners(Scan.collectOpeners(doc), page);
same(found.images, [full, 'https://cdn.example/photos/full.png']);
same(found.probes, ['https://www.smlsy.com/video_detail.php?id=9']);
assert.strictEqual(found.skipped, 1);
found.images.forEach((url) => {
  assert.strictEqual(Scan.classifyUrl(url), 'image');
  assert.ok(url.indexOf('/mip/') === -1);
  assert.ok(!/\.(php|html|apk)(\?|$)/.test(url));
});

const chromeManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.firefox.json'), 'utf8'));
assert.strictEqual(chromeManifest.version, '1.9');
assert.strictEqual(firefoxManifest.version, '1.9');
assert.deepStrictEqual(chromeManifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
assert.deepStrictEqual(firefoxManifest.optional_host_permissions, chromeManifest.optional_host_permissions);
assert.deepStrictEqual(firefoxManifest.background.scripts, ['gallery-scan.js', 'background.js']);
assert.ok(!chromeManifest.host_permissions.includes('<all_urls>'));
assert.ok(!chromeManifest.host_permissions.includes('https://*/*'));

const popup = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
assert.ok(popup.includes('gallery-scan.js'));
assert.ok(popup.includes('Gallery_Downloads'));
assert.ok(popup.includes('網頁、廣告與非圖片檔不會下載'));
assert.ok(popupJs.includes("['gallery-scan.js', 'gallery-content.js']"));
assert.ok(popupJs.includes("['feed-autoload.js', 'patreon-media.js', 'content.js']"));
assert.ok(popupJs.includes("['fantia.js', 'content.js']"));
assert.ok(popupJs.includes('permissions.contains'));
assert.ok(popupJs.includes('permission.html'));

const stage = fs.readFileSync(path.join(root, 'scripts/stage-firefox.py'), 'utf8');
assert.ok(stage.includes('gallery-scan.js'));
assert.ok(stage.includes('gallery-content.js'));
assert.ok(stage.includes('permission.html'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
assert.ok(readme.includes('v1.9'));
assert.ok(!readme.includes('v1.8'));

console.log('gallery-scan.test.js ok');
