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
    id: '163709981',
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
assert.strictEqual(imagePost[0].postId, '163709981');
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
    id: '163709981',
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
assert.strictEqual(inlineOnly[0].postId, '163709981');
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

const fullUrl = original;
const keptFull = Media.resolveDimensions({ width: 6720, height: 4480 }, { width: 12, height: 12 }, fullUrl);
assert.strictEqual(keptFull.width, 6720);
assert.strictEqual(keptFull.height, 4480);
const ignoredProbe = Media.resolveDimensions({ width: 0, height: 0 }, { width: 20, height: 20 }, fullUrl);
assert.strictEqual(ignoredProbe.width, 0);
assert.strictEqual(ignoredProbe.height, 0);
const thumbProbe = Media.resolveDimensions({ width: 0, height: 0 }, { width: 120, height: 80 }, tinyThumb);
assert.strictEqual(thumbProbe.width, 120);
assert.strictEqual(thumbProbe.height, 80);

function cdnHash(hash, segment) {
  return 'https://c10.patreonusercontent.com/4/patreon-media/p/post/50/'
    + hash + '/' + segment + '/1.jpg?token-time=1';
}
const hashA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hashB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const thumbA = cdnHash(hashA, 'eyJ3IjoxMDB9');
const betterA = cdnHash(hashA, 'eyJ3Ijo2MjB9');
const fullB = cdnHash(hashB, 'eyJxIjoxMDAsIndlYnAiOjB9');
const thumbOnly = {
  data: {
    id: '50',
    attributes: {
      title: 'Partial gallery',
      published_at: '2026-04-04T00:00:00.000Z',
      content_json_string: JSON.stringify({
        type: 'doc',
        content: [
          { type: 'image', attrs: { media_id: '555', src: betterA, media_width: 3200, media_height: 2000 } },
          { type: 'image', attrs: { media_id: '556', src: fullB, media_width: 4000, media_height: 3000 } }
        ]
      })
    },
    relationships: {
      media: { data: [{ id: '555', type: 'media' }, { id: '556', type: 'media' }, { id: '900', type: 'media' }] }
    }
  },
  included: [
    {
      type: 'media',
      id: '555',
      attributes: {
        mimetype: 'image/jpeg',
        image_urls: { thumbnail: thumbA },
        metadata: { dimensions: { w: 3200, h: 2000 } }
      }
    },
    {
      type: 'media',
      id: '900',
      attributes: { mimetype: 'application/x-mpegURL', media_type: 'video' }
    }
  ]
};
const partial = Media.collectPostImages(thumbOnly);
const byId = {};
partial.forEach((image) => { byId[image.mediaId] = image; });
assert.strictEqual(byId['555'].url, betterA);
assert.strictEqual(byId['556'].url, fullB);
const need = Media.mediaIdsToFetch(thumbOnly, partial);
assert.ok(need.indexOf('555') !== -1);
assert.ok(need.indexOf('556') === -1);
assert.ok(need.indexOf('900') === -1);

const fields = Media.urlsFromImageFields({
  src: tinyThumb,
  srcset: cardThumb + ' 620w, ' + original + ' 2000w',
  dataSrc: 'https://c10.patreonusercontent.com/4/patreon-media/p/post/9/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/eyJ3IjoxMDB9/1.jpg'
});
assert.strictEqual(fields.length, 4);
assert.strictEqual(fields[2], cardThumb);
assert.strictEqual(fields[3], original);

const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
assert.ok(popup.includes('PatreonMedia.passesMinSize'));
const popupHtml = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
assert.ok(popupHtml.includes('patreon-media.js'));

function postCdn(postId, hash, segment, file) {
  return 'https://c10.patreonusercontent.com/4/patreon-media/p/post/' + postId + '/'
    + hash + '/' + segment + '/' + (file || '1.jpg') + '?token-time=1';
}
const openPost = '701';
const neighborPost = '702';
const openOriginal = postCdn(openPost, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'eyJxIjoxMDAsIndlYnAiOjB9');
const neighborOriginal = postCdn(neighborPost, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'eyJxIjoxMDAsIndlYnAiOjB9');
const neighborThumb = postCdn(neighborPost, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'eyJ3Ijo2MjB9');
const looseFile = 'https://www.patreon.com/file?h=701&i=9';
const scopedPost = Media.collectPostImages({
  data: {
    id: openPost,
    attributes: {
      title: 'Wanna play hide & seek in our Satin Catsuit ??',
      published_at: '2026-11-11T12:00:00.000Z',
      content_json_string: JSON.stringify({
        type: 'doc',
        content: [
          { type: 'image', attrs: { media_id: '11', src: openOriginal, media_width: 1200, media_height: 1800 } },
          { type: 'image', attrs: { media_id: '22', src: neighborOriginal, media_width: 1200, media_height: 1800 } }
        ]
      }),
      content: '<p>note</p><img src="' + neighborThumb + '"><img src="https://c10.patreonusercontent.com/4/patreon-media/p/user/5/cccccccccccccccccccccccccccccccc/eyJ3IjoxMDB9/1.jpg">',
      image: {
        url: postCdn(neighborPost, 'dddddddddddddddddddddddddddddddd', 'eyJ3Ijo2MjB9'),
        large_url: postCdn(neighborPost, 'dddddddddddddddddddddddddddddddd', 'eyJ3IjoxMDgwfQ==')
      }
    },
    relationships: {
      media: { data: [{ id: '11', type: 'media' }] },
      images: { data: [{ id: '11', type: 'media' }] }
    }
  },
  included: [
    {
      type: 'media',
      id: '11',
      attributes: {
        mimetype: 'image/jpeg',
        file_name: 'catsuit-01.jpg',
        owner_type: 'post',
        owner_id: openPost,
        image_urls: { original: openOriginal }
      }
    },
    {
      type: 'media',
      id: '22',
      attributes: {
        mimetype: 'image/jpeg',
        file_name: 'Chun & Mirin Patreon-Set 2-03.jpg',
        owner_type: 'post',
        owner_id: neighborPost,
        image_urls: { original: neighborOriginal, default: neighborThumb }
      }
    },
    {
      type: 'media',
      id: '33',
      attributes: {
        mimetype: 'image/jpeg',
        file_name: 'Chun & Mirin Patreon-Set 2-04.jpg',
        owner_type: 'post',
        owner_id: neighborPost,
        download_url: looseFile
      }
    },
    {
      type: 'media',
      id: '44',
      attributes: {
        mimetype: 'image/jpeg',
        file_name: 'avatar.jpg',
        owner_type: 'user',
        owner_id: '5',
        image_urls: {
          original: 'https://c10.patreonusercontent.com/4/patreon-media/p/user/5/cccccccccccccccccccccccccccccccc/eyJ3IjoxMDB9/1.jpg'
        }
      }
    },
    {
      type: 'media',
      id: '55',
      attributes: {
        mimetype: 'image/jpeg',
        file_name: 'Chun & Mirin Patreon-Set 2-05.jpg',
        download_url: 'https://www.patreon.com/file?h=55&i=5'
      }
    }
  ]
});
assert.strictEqual(scopedPost.length, 1);
assert.strictEqual(scopedPost[0].name, 'catsuit-01.jpg');
assert.strictEqual(scopedPost[0].postId, openPost);
assert.strictEqual(scopedPost[0].postTitle, 'Wanna play hide & seek in our Satin Catsuit ??');
assert.ok(scopedPost.every((image) => image.name.indexOf('Chun & Mirin') === -1));
assert.ok(scopedPost.every((image) => image.url.indexOf('/p/post/' + neighborPost + '/') === -1));

const neighborOnly = Media.collectPostImages({
  data: {
    id: neighborPost,
    attributes: {
      title: 'Chun & Mirin Set 2',
      published_at: '2026-11-10T00:00:00.000Z'
    },
    relationships: {
      images: { data: [{ id: '22', type: 'media' }] }
    }
  },
  included: [
    {
      type: 'media',
      id: '22',
      attributes: {
        mimetype: 'image/jpeg',
        file_name: 'Chun & Mirin Patreon-Set 2-03.jpg',
        owner_type: 'post',
        owner_id: neighborPost,
        image_urls: { original: neighborOriginal }
      }
    }
  ]
});
assert.strictEqual(neighborOnly.length, 1);
assert.strictEqual(neighborOnly[0].postId, neighborPost);
assert.strictEqual(neighborOnly[0].postTitle, 'Chun & Mirin Set 2');
assert.notStrictEqual(neighborOnly[0].postId, scopedPost[0].postId);

const cardThumbUrl = postCdn(openPost, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'eyJ3Ijo2MjB9');
const otherCardThumb = neighborThumb;
assert.strictEqual(Media.scopeDomImage({
  pagePostId: openPost,
  cardPostId: openPost,
  url: openOriginal,
  inCurrentPost: true
}), openPost);
assert.strictEqual(Media.scopeDomImage({
  pagePostId: openPost,
  cardPostId: neighborPost,
  url: otherCardThumb,
  inOtherPost: true
}), '');
assert.strictEqual(Media.scopeDomImage({
  pagePostId: openPost,
  cardPostId: '',
  url: otherCardThumb
}), '');
assert.strictEqual(Media.scopeDomImage({
  pagePostId: openPost,
  cardPostId: '',
  url: cardThumbUrl
}), openPost);
assert.strictEqual(Media.scopeDomImage({
  pagePostId: openPost,
  cardPostId: openPost,
  url: 'https://www.patreon.com/file?h=1&i=2',
  inComment: true
}), '');
assert.strictEqual(Media.scopeDomImage({
  pagePostId: openPost,
  cardPostId: '',
  url: 'https://pbs.twimg.com/media/loose.jpg',
  inRecommendation: true
}), '');
assert.strictEqual(Media.scopeDomImage({
  pagePostId: openPost,
  cardPostId: '',
  url: 'https://www.patreon.com/file?h=9&i=9'
}), '');
assert.strictEqual(Media.scopeDomImage({
  pagePostId: '',
  cardPostId: openPost,
  url: openOriginal
}), openPost);
assert.strictEqual(Media.scopeDomImage({
  pagePostId: '',
  cardPostId: neighborPost,
  url: neighborOriginal
}), neighborPost);
assert.strictEqual(Media.scopeDomImage({
  pagePostId: '',
  cardPostId: openPost,
  url: neighborOriginal
}), '');
assert.strictEqual(Media.scopeDomImage({
  pagePostId: '',
  cardPostId: '',
  url: neighborThumb
}), '');

const contentJs = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
assert.ok(contentJs.includes('PatreonMedia.scopeDomImage'));
assert.ok(contentJs.includes('json-api-use-default-includes=false'));
assert.ok(contentJs.includes('findCurrentPostRoot'));
assert.ok(contentJs.includes('if (!isSinglePostPage && storageData && storageData.autoLoad)'));

console.log('patreon media tests passed');
