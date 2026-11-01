const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { console: console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'feed-autoload.js'), 'utf8'), sandbox);
const Feed = sandbox.FeedAutoLoad;

function sample(postIds, extra) {
  return Object.assign({
    postIds: postIds,
    postCardCount: postIds.length,
    busy: false,
    hasLoadMore: false
  }, extra || {});
}

// The old Step 0 stop: three loops whose raw a[href*="/posts/"] count
// did not change. That fired while a loader was still on screen.
function oldLinkCountWouldStop(counts) {
  let previous = 0;
  let noChange = 0;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i];
    if (count === previous && count > 0) {
      noChange += 1;
      if (noChange >= 3) return true;
    } else {
      noChange = 0;
      previous = count;
    }
  }
  return false;
}

assert.strictEqual(oldLinkCountWouldStop([40, 40, 40, 40]), true);

let state = Feed.notePosts(Feed.initialState(), ['10', '11', '12'], 3);
for (let i = 0; i < 5; i++) {
  state = Feed.decide(state, sample(['10', '11', '12'], { busy: true, postCardCount: 3 }));
  assert.notStrictEqual(state.action, 'stop', 'loader still visible at sample ' + i);
  assert.strictEqual(state.reason, 'busy');
  assert.strictEqual(state.loading, true);
  assert.strictEqual(state.quietStreak, 0);
}
assert.strictEqual(state.action, 'scroll');

state = Feed.decide(state, sample(['10', '11', '12', '13', '14'], { busy: true, postCardCount: 5 }));
assert.strictEqual(state.reason, 'progress');
assert.strictEqual(state.quietStreak, 0);
assert.ok(state.seenIds.indexOf('14') !== -1);
assert.strictEqual(state.busyPasses, 0);

state = Feed.decide(state, sample(['10', '11', '12', '13', '14'], { postCardCount: 5 }));
assert.strictEqual(state.action, 'scroll');
assert.strictEqual(state.reason, 'quiet');
assert.strictEqual(state.done, false);
state = Feed.decide(state, sample(['10', '11', '12', '13', '14'], { postCardCount: 5 }));
assert.strictEqual(state.action, 'stop');
assert.strictEqual(state.reason, 'end-of-feed');
assert.strictEqual(state.done, true);

// Sidebar / recommendation links must not create progress. The caller passes
// only the filtered id list, so a flat feed id list still reaches end-of-feed
// even if a raw link count elsewhere would have moved.
state = Feed.notePosts(Feed.initialState(), ['1', '2'], 2);
state = Feed.decide(state, sample(['1', '2'], { postCardCount: 2 }));
state = Feed.decide(state, sample(['1', '2'], { postCardCount: 2 }));
assert.strictEqual(state.reason, 'end-of-feed');

// Virtualized window: the visible count stays flat, but a new id is progress.
state = Feed.notePosts(Feed.initialState(), ['1', '2', '3'], 3);
state = Feed.decide(state, sample(['2', '3', '4'], { postCardCount: 3 }));
assert.strictEqual(state.reason, 'progress');
assert.ok(state.seenIds.indexOf('4') !== -1);
assert.notStrictEqual(state.action, 'stop');

// New card shells with no anchor yet still count as more posts.
state = Feed.notePosts(Feed.initialState(), ['1'], 1);
state = Feed.decide(state, sample(['1'], { postCardCount: 4 }));
assert.strictEqual(state.reason, 'progress');
assert.strictEqual(state.maxPostCards, 4);

// "See more posts" / "查看更多文章" keep the feed open. In-post "Show more" does not.
state = Feed.notePosts(Feed.initialState(), ['7'], 1);
state = Feed.decide(state, sample(['7'], { hasLoadMore: true }));
assert.strictEqual(state.action, 'click');
assert.strictEqual(state.reason, 'load-more');
assert.strictEqual(state.done, false);
for (let i = 0; i < 6; i++) {
  state = Feed.decide(state, sample(['7'], { hasLoadMore: true }));
}
assert.strictEqual(state.action, 'stop');
assert.strictEqual(state.reason, 'load-more-stuck');

// A stuck spinner cannot spin forever: busy passes are capped, then quiet passes finish.
state = Feed.notePosts(Feed.initialState(), ['1'], 1);
for (let i = 0; i < Feed.LIMITS.maxBusyPasses + Feed.LIMITS.stablePassesToFinish; i++) {
  state = Feed.decide(state, sample(['1'], { busy: true }));
}
assert.strictEqual(state.action, 'stop');
assert.strictEqual(state.reason, 'busy-gave-up');

// Empty document needs extra quiet passes so a slow first paint is not "done".
state = Feed.initialState();
for (let i = 0; i < Feed.LIMITS.stablePassesWhenEmpty - 1; i++) {
  state = Feed.decide(state, sample([], { postCardCount: 0 }));
  assert.notStrictEqual(state.action, 'stop');
}
state = Feed.decide(state, sample([], { postCardCount: 0 }));
assert.strictEqual(state.reason, 'end-of-feed');

// Max-loop safety still exists.
state = Feed.notePosts(Feed.initialState(), ['1'], 1);
state.loops = Feed.LIMITS.maxLoops;
state = Feed.decide(state, sample(['1', '2'], { busy: true, hasLoadMore: true }));
assert.strictEqual(state.action, 'stop');
assert.strictEqual(state.reason, 'max-loops');

assert.strictEqual(Feed.LIMITS.maxLoops, 100);
assert.ok(Feed.LIMITS.stablePassesToFinish >= 2);
assert.ok(Feed.LIMITS.minObserveMs >= 2500);
assert.ok(Feed.LIMITS.quietMs >= 1000);
assert.ok(Feed.LIMITS.maxSettleMs > Feed.LIMITS.minObserveMs);
assert.ok(Feed.LIMITS.maxBusyPasses >= 4);

assert.strictEqual(Feed.postIdFromHref('/posts/my-title-98765'), '98765');
assert.strictEqual(Feed.postIdFromHref('https://www.patreon.com/posts/98765'), '98765');
assert.strictEqual(Feed.postIdFromHref('/posts/new'), '');
assert.strictEqual(Feed.postIdFromHref(''), '');

assert.strictEqual(Feed.isFeedLoadMoreLabel('See more posts'), true);
assert.strictEqual(Feed.isFeedLoadMoreLabel('Load more'), true);
assert.strictEqual(Feed.isFeedLoadMoreLabel('查看更多文章'), true);
assert.strictEqual(Feed.isFeedLoadMoreLabel('載入更多'), true);
assert.strictEqual(Feed.isFeedLoadMoreLabel('加载更多'), true);
assert.strictEqual(Feed.isFeedLoadMoreLabel('Show more'), false);
assert.strictEqual(Feed.isFeedLoadMoreLabel('See more'), false);
assert.strictEqual(Feed.isFeedLoadMoreLabel('更多'), false);
assert.strictEqual(Feed.isFeedLoadMoreLabel('顯示更多'), false);
assert.strictEqual(Feed.isFeedLoadMoreLabel('Load more comments'), false);
assert.strictEqual(Feed.isFeedLoadMoreLabel('查看更多留言'), false);
assert.strictEqual(Feed.isLoadMoreDataTag('load-more-button'), true);
assert.strictEqual(Feed.isLoadMoreDataTag('post-card'), false);

assert.strictEqual(Feed.isLoadingSignal({
  ariaLabel: 'loading more posts',
  tagName: 'svg'
}), true);
assert.strictEqual(Feed.isLoadingSignal({
  className: 'abc LoadingSpinner xyz',
  tagName: 'div'
}), true);
assert.strictEqual(Feed.isLoadingSignal({
  role: 'progressbar',
  tagName: 'div'
}), true);
assert.strictEqual(Feed.isLoadingSignal({
  text: 'Show more',
  tagName: 'button'
}), false);

assert.strictEqual(Feed.isFeedResource('https://www.patreon.com/api/posts?filter[campaign_id]=99', 'fetch'), true);
assert.strictEqual(Feed.isFeedResource('https://www.patreon.com/api/posts?filter%5Bcampaign_id%5D=99', 'xmlhttprequest'), true);
assert.strictEqual(Feed.isFeedResource('https://www.patreon.com/api/notifications', 'fetch'), false);
assert.strictEqual(Feed.isFeedResource('https://www.patreon.com/api/graphql', 'fetch'), false);
assert.strictEqual(Feed.isFeedResource('https://www.patreon.com/api/posts?filter[campaign_id]=1', 'img'), false);

const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
assert.ok(content.includes('globalThis.FeedAutoLoad'));
assert.ok(content.includes('Feed.decide'));
assert.ok(content.includes('minObserveMs'));
assert.ok(content.includes('quietMs'));
assert.ok(content.includes('maxSettleMs'));
assert.ok(content.includes('isLoadingSignal'));
assert.ok(content.includes('isFeedLoadMoreLabel'));
assert.ok(content.includes('[data-tag="post-card"]'));
assert.ok(content.includes('isUnwantedLink'));
assert.ok(!content.includes('noChangeCount'));
assert.ok(!content.includes("behavior: 'smooth'"));
assert.ok(!content.includes("txt.includes('show more')"));
assert.ok(!content.includes("txt.includes('更多')"));
assert.ok(content.includes('if (!isSinglePostPage && storageData && storageData.autoLoad)'));
assert.ok(content.includes('scanFantiaPage'));
assert.ok(content.includes('fetch(`/api/posts/${postId}?include=media,attachments,post_file`'));

const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
assert.ok(popup.includes("['feed-autoload.js', 'content.js']"));
assert.ok(popup.includes("['fantia.js', 'content.js']"));

const stage = fs.readFileSync(path.join(root, 'scripts/stage-firefox.py'), 'utf8');
assert.ok(stage.includes('feed-autoload.js'));

assert.strictEqual(Feed.foundCount(Feed.notePosts(Feed.initialState(), ['a', 'b'], 2), ['a'], 1), 2);
assert.strictEqual(Feed.foundCount(Feed.initialState(), [], 3), 3);

console.log('feed autoload tests passed');
