const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { URL, console, Buffer };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'patreon-media.js'), 'utf8'), sandbox);
const Media = sandbox.PatreonMedia;

const HASH = 'f3ce039176cc4694aaa48f782c17bf0d';
function cdn(segment) {
  return 'https://c10.patreonusercontent.com/4/patreon-media/p/post/163709981/'
    + HASH + '/' + segment + '/1.jpg?token-time=1&token-hash=abc';
}
const original = cdn('eyJxIjoxMDAsIndlYnAiOjB9');
const download = cdn('eyJhIjoxLCJwIjoxfQ==');
const cardThumb = cdn('eyJ3Ijo2MjB9');
const tinyThumb = cdn('eyJ3IjoxMDB9');

assert.ok(Media.renditionRank(original) > Media.renditionRank(download));
assert.ok(Media.renditionRank(download) > Media.renditionRank(cardThumb));
assert.ok(Media.renditionRank(cardThumb) > Media.renditionRank(tinyThumb));
assert.strictEqual(Media.dedupeKey(original), Media.dedupeKey(tinyThumb));
assert.notStrictEqual(
  Media.dedupeKey('https://www.patreon.com/file?h=10&i=1'),
  Media.dedupeKey('https://www.patreon.com/file?h=10&i=2')
);

const list = [];
Media.absorbInto(list, { url: tinyThumb, filename: 'thumb.jpg', width: 100, height: 80, postId: '163709981' });
Media.absorbInto(list, { url: original, filename: 'full.jpg', width: 6720, height: 4480, postId: '163709981' });
assert.strictEqual(list.length, 1);
assert.strictEqual(list[0].url, original);
assert.strictEqual(list[0].width, 6720);

Media.absorbInto(list, { url: 'https://www.patreon.com/file?h=10&i=1', filename: 'a.jpg', postId: '10' });
Media.absorbInto(list, { url: 'https://www.patreon.com/file?h=10&i=2', filename: 'b.jpg', postId: '10' });
assert.strictEqual(list.length, 3);

const imagePost = Media.collectPostImages({
  data: {
    id: '167604834',
    attributes: {
      title: 'Art card',
      published_at: '2026-01-02T00:00:00.000Z',
      post_type: 'image_file',
      image: {
        url: cardThumb,
        large_url: cdn('eyJ3IjoxMDgwfQ=='),
        width: 3840,
        height: 2160
      },
      post_file: {
        url: download,
        name: 'card.png',
        width: 3840,
        height: 2160
      }
    }
  },
  included: [{
    type: 'media',
    id: '725534910',
    attributes: {
      mimetype: 'image/png',
      file_name: 'card.png',
      download_url: download,
      image_urls: {
        original: original,
        default: cardThumb,
        thumbnail: tinyThumb
      },
      metadata: { dimensions: { w: 3840, h: 2160 } },
      state: 'ready'
    }
  }]
});
assert.strictEqual(imagePost.length, 1);
assert.strictEqual(imagePost[0].url, original);
assert.strictEqual(imagePost[0].postId, '167604834');
assert.strictEqual(imagePost[0].width, 3840);
assert.strictEqual(imagePost[0].height, 2160);
assert.strictEqual(imagePost[0].name, 'card.png');
assert.ok(Media.passesMinSize(imagePost[0], 400));
assert.ok(Media.passesMinSize(imagePost[0], 2000));

const videoPost = Media.collectPostImages({
  data: {
    id: '152669616',
    attributes: {
      title: 'My Thoughts on AI',
      published_at: '2026-02-02T00:00:00.000Z',
      post_type: 'video_external_file',
      image: {
        url: 'https://image.mux.com/PLAY/thumbnail.jpg?token=abc',
        large_url: 'https://image.mux.com/PLAY/thumbnail.jpg?token=abc',
        width: 1920,
        height: 1080
      },
      post_file: {
        url: 'https://stream.mux.com/PLAY.m3u8?token=abc',
        duration: 100
      },
      content_json_string: JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }]
      })
    }
  },
  included: [{
    type: 'media',
    id: '1',
    attributes: {
      mimetype: 'application/x-mpegURL',
      media_type: 'video',
      download_url: 'https://stream.mux.com/PLAY.m3u8?token=abc'
    }
  }]
});
assert.strictEqual(videoPost.length, 1);
assert.ok(videoPost[0].url.indexOf('image.mux.com') !== -1);
assert.ok(videoPost.every((image) => image.url.indexOf('.m3u8') === -1));

const inlineOnly = Media.collectPostImages({
  data: {
    id: '99',
    attributes: {
      title: 'Inline',
      published_at: '2026-03-03T00:00:00.000Z',
      content_json_string: JSON.stringify({
        type: 'doc',
        content: [{
          type: 'image',
          attrs: {
            media_id: '555',
            src: original,
            media_width: 4000,
            media_height: 3000
          }
        }]
      })
    }
  },
  included: []
});
assert.strictEqual(inlineOnly.length, 1);
assert.strictEqual(inlineOnly[0].url, original);
assert.strictEqual(inlineOnly[0].postId, '99');
assert.strictEqual(inlineOnly[0].width, 4000);
assert.strictEqual(inlineOnly[0].height, 3000);
assert.ok(Media.passesMinSize(inlineOnly[0], 400));

const seen = Media.rememberImages(Media.createSeenImages(), '99', [
  tinyThumb,
  'https://c10.patreonusercontent.com/4/patreon-media/p/campaign/1/avatar/eyJ3IjoxMDB9/1.png'
]);
assert.strictEqual(seen.items.length, 1);
assert.strictEqual(seen.items[0].url, tinyThumb);
const merged = [];
inlineOnly.forEach((image) => Media.absorbInto(merged, image));
Media.absorbInto(merged, { url: seen.items[0].url, postId: '99', width: 100, height: 100 });
assert.strictEqual(merged.length, 1);
assert.strictEqual(merged[0].url, original);

assert.strictEqual(Media.passesMinSize({ width: 0, height: 0 }, 400), true);
assert.strictEqual(Media.passesMinSize({ width: 620, height: 338 }, 400), true);
assert.strictEqual(Media.passesMinSize({ width: 300, height: 200 }, 400), false);
assert.strictEqual(Media.passesMinSize({ width: 100, height: 100 }, 400), false);
assert.strictEqual(Media.passesMinSize({ width: 360, height: 800 }, 400), true);

const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
assert.ok(popup.includes('PatreonMedia.passesMinSize'));
const popupHtml = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
assert.ok(popupHtml.includes('patreon-media.js'));

console.log('patreon media tests passed');
