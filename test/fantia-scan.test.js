const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { URL, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'fantia.js'), 'utf8'), sandbox);
const FantiaScan = sandbox.FantiaScan;
assert.ok(FantiaScan && typeof FantiaScan.collectFromPost === 'function');

const origin = 'https://fantia.jp';

function urlsOf(collected) {
  return Array.from(collected.images, (image) => String(image.url));
}

const post = {
  title: 'Test Fantia Post',
  thumb: {
    original: 'https://c.fantia.jp/uploads/post/file/1166373/7e7e7fda-720d-462d-ab9b-a4c558ff5780.png',
    micro: 'https://c.fantia.jp/uploads/post/file/1166373/micro_7e7e7fda-720d-462d-ab9b-a4c558ff5780.png'
  },
  post_contents: [
    {
      visible_status: 'visible',
      category: 'photo_gallery',
      title: 'Test Image Gallery',
      post_content_photos: [
        {
          url: {
            original: 'https://cc.fantia.jp/uploads/post_content_photo/file/7325490/5b8138fe-83e3-41d5-b282-33857e65683e.png?sig=a',
            main: 'https://cc.fantia.jp/uploads/post_content_photo/file/7325490/main_5b8138fe-83e3-41d5-b282-33857e65683e.png?sig=a'
          }
        },
        {
          url: {
            original: 'https://cc.fantia.jp/uploads/post_content_photo/file/7325491/870c6d07-a105-4e04-bfd1-42f75bdc1746.png'
          }
        },
        {
          url: {
            original: 'https://cc.fantia.jp/uploads/post_content_photo/file/7325490/5b8138fe-83e3-41d5-b282-33857e65683e.png?sig=other'
          }
        }
      ]
    },
    {
      visible_status: 'visible',
      category: 'blog',
      comment: JSON.stringify({
        ops: [
          {
            insert: {
              fantiaImage: {
                id: '130683',
                url: 'https://cc.fantia.jp/uploads/album_image/file/130683/5d243250-1acb-45b5-80da-5f4904f1ddc4.png?sig=1',
                original_url: '/posts/1166373/album_image?query=aaa'
              }
            }
          },
          {
            insert: {
              fantiaImage: {
                id: '130684',
                url: 'https://cc.fantia.jp/uploads/album_image/file/130684/870c6d07-a105-4e04-bfd1-42f75bdc1746.png',
                original_url: '/posts/1166373/album_image?query=bbb'
              }
            }
          }
        ]
      })
    },
    { visible_status: 'members_only', category: 'blog', title: 'locked blog' },
    {
      visible_status: 'visible',
      category: 'blog',
      comment: JSON.stringify({
        ops: [
          { insert: { image: 'https://www.w3schools.com/images/lamp.jpg' } },
          {
            insert: {
              fantiaImage: {
                id: '130693',
                original_url: '/posts/1166373/album_image?query=ccc'
              }
            }
          },
          {
            insert: {
              fantiaImage: {
                id: '130694',
                original_url: '/posts/1166373/album_image?query=ddd'
              }
            }
          }
        ]
      })
    },
    {
      visible_status: 'visible',
      category: 'file',
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      download_uri: '/posts/1/download/1'
    },
    {
      visible_status: 'visible',
      category: 'file',
      filename: 'art.png',
      content_type: 'image/png',
      download_uri: '/posts/1/download/99'
    },
    { visible_status: 'catchable', category: 'photo_gallery' },
    { visible_status: 'uncatchable', category: 'file', filename: 'secret.jpg' }
  ]
};

const collected = FantiaScan.collectFromPost(post, origin);
const urls = urlsOf(collected);
assert.strictEqual(collected.lockedCount, 3);
assert.ok(urls.includes(post.thumb.original));
assert.ok(!urls.some((url) => url.includes('/micro_')));
assert.ok(!urls.some((url) => url.includes('/main_')));
assert.ok(urls.includes(post.post_contents[0].post_content_photos[0].url.original));
assert.ok(urls.includes(post.post_contents[0].post_content_photos[1].url.original));
assert.strictEqual(urls.filter((url) => url.includes('/7325490/')).length, 1);
assert.ok(urls.includes('https://cc.fantia.jp/uploads/album_image/file/130683/5d243250-1acb-45b5-80da-5f4904f1ddc4.png?sig=1'));
assert.ok(urls.includes('https://fantia.jp/posts/1166373/album_image?query=ccc'));
assert.ok(urls.includes('https://fantia.jp/posts/1166373/album_image?query=ddd'));
assert.ok(!urls.some((url) => url.includes('w3schools')));
assert.ok(!urls.some((url) => url.includes('clip.mp4') || url.endsWith('/download/1')));
assert.ok(urls.includes('https://fantia.jp/posts/1/download/99'));
assert.strictEqual(collected.images.find((image) => image.url.endsWith('/download/99')).filename, 'art.png');
assert.strictEqual(urls.length, 8);

const blurred = FantiaScan.collectFromPost({
  title: 'Hidden',
  thumb: { original: 'https://c.fantia.jp/uploads/post/file/1/blurred_image.png' },
  post_contents: []
}, origin);
assert.strictEqual(blurred.images.length, 0);

const backnumber = FantiaScan.collectFromPost({
  title: 'August paid',
  thumb: { original: 'https://c.fantia.jp/uploads/post/file/9/abc.jpeg' },
  backnumber_contents: [
    {
      visible_status: 'visible',
      category: 'photo_gallery',
      post_content_photos: [
        { url: { original: 'https://cc.fantia.jp/uploads/post_content_photo/file/1/orig.png' } }
      ]
    },
    { visible_status: 'members_only', category: 'photo_gallery' }
  ]
}, origin);
assert.strictEqual(backnumber.lockedCount, 1);
assert.deepStrictEqual(urlsOf(backnumber), [
  'https://c.fantia.jp/uploads/post/file/9/abc.jpeg',
  'https://cc.fantia.jp/uploads/post_content_photo/file/1/orig.png'
]);

const dom = FantiaScan.collectFromImageUrls([
  'https://cc.fantia.jp/uploads/post_content_photo/file/3/orig.png',
  'https://cc.fantia.jp/uploads/post_content_photo/file/3/thumb_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png',
  '/images/fallback/common/loading-md.jpg',
  'https://fantia.jp/posts/1/post_content_photo/3',
  'https://example.com/photo.jpg'
], 'Album', origin);
assert.deepStrictEqual(urlsOf(dom), [
  'https://cc.fantia.jp/uploads/post_content_photo/file/3/orig.png'
]);

const chromeManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.firefox.json'), 'utf8'));
assert.strictEqual(chromeManifest.background.service_worker, 'background.js');
assert.strictEqual(chromeManifest.background.scripts, undefined);
assert.deepStrictEqual(firefoxManifest.background.scripts, ['background.js']);
assert.strictEqual(firefoxManifest.background.service_worker, undefined);
for (const manifest of [chromeManifest, firefoxManifest]) {
  assert.ok(manifest.host_permissions.includes('https://fantia.jp/*'));
  assert.ok(manifest.host_permissions.includes('https://*.fantia.jp/*'));
  assert.ok(manifest.host_permissions.includes('https://patreon.com/*'));
  assert.ok(manifest.host_permissions.includes('https://*.patreon.com/*'));
  assert.ok(!manifest.host_permissions.some((pattern) => pattern === 'https://*/*' || pattern === '<all_urls>'));
}
assert.strictEqual(
  chromeManifest.browser_specific_settings.gecko.id,
  firefoxManifest.browser_specific_settings.gecko.id
);
const chromeRest = Object.assign({}, chromeManifest);
const firefoxRest = Object.assign({}, firefoxManifest);
delete chromeRest.background;
delete firefoxRest.background;
assert.deepStrictEqual(chromeRest, firefoxRest);

const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
assert.ok(content.includes("pathname.match(/\\/posts\\/.*?-?(\\d+)/)"));
assert.ok(content.includes('scanFantiaPage'));
assert.ok(content.includes("fetch(`/api/posts/${postId}?include=media,attachments,post_file`"));

console.log('fantia scan tests passed');
