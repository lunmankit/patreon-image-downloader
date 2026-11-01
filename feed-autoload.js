// Pure decisions for Patreon feed / creator auto-load.
// Injected before content.js on Patreon. Fantia does not use this.
//
// Patreon serves about 20 posts per page. Stopping after two quiet rounds
// left the scan on that first page. Keep scrolling and clicking until several
// passes in a row add nothing, with no loader and no load-more control.
// A visible loader is "still loading", not the end of the feed.
(function (root) {
  const LIMITS = {
    maxLoops: 160,
    stablePassesToFinish: 8,
    stablePassesWhenEmpty: 6,
    maxBusyPasses: 12,
    maxLoadMoreClicksWithoutGrowth: 24,
    quietMs: 700,
    minObserveMs: 1600,
    maxSettleMs: 5000
  };

  const LOAD_MORE_PHRASES = [
    'load more',
    'load more posts',
    'see more posts',
    'show more posts',
    'view more posts',
    '查看更多文章',
    '查看更多帖子',
    '查看更多貼文',
    '載入更多',
    '加载更多',
    '載入更多貼文',
    '載入更多文章',
    '加载更多帖子',
    '加载更多文章',
    '顯示更多貼文',
    '显示更多帖子',
    '投稿をもっと見る',
    'さらに読み込む',
    '더 많은 포스트 보기',
    '더 보기'
  ];

  function normalizeLabel(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function postIdFromHref(href) {
    if (!href) return '';
    // Ignore query and hash. A year or index in the slug, or a number in
    // ?ref=, is not the post id. Patreon puts the id at the end:
    // /posts/<id> and /<creator>/posts/<slug>-<id>.
    const path = String(href).split(/[?#]/)[0];
    const direct = path.match(/\/posts\/(\d+)(?:\/|$)/);
    if (direct && direct[1]) return direct[1];
    const slugged = path.match(/\/posts\/[^/?#]*-(\d+)(?:\/|$)/);
    return slugged && slugged[1] ? slugged[1] : '';
  }

  // "See more posts" / "Unlock more posts" are the feed's own controls and
  // upsell copy. They are not a recommendation rail. Matching the bare
  // substring "more post" treated those headings as a reason to drop the post.
  function isRecommendationHeading(text) {
    const normalized = normalizeLabel(text);
    if (!normalized) return false;
    if (/see more post|load more post|show more post|view more post|unlock more post|loading more post/.test(normalized)) {
      return false;
    }
    const phrases = [
      'popular post',
      'related post',
      'you might like',
      'recommended',
      'popular product',
      'more posts by',
      'more from this',
      'posts you might'
    ];
    for (let i = 0; i < phrases.length; i++) {
      if (normalized.indexOf(phrases[i]) !== -1) return true;
    }
    return false;
  }

  // Site chrome is the page header, nav, and aside. A post card has its own
  // <header> around the title permalink. That link is the post id, not chrome.
  function isSiteChrome(el) {
    if (!el || typeof el.closest !== 'function') return false;
    const chrome = el.closest('header, nav, aside');
    if (!chrome) return false;
    if (typeof chrome.closest === 'function' && chrome.closest('[data-tag="post-card"]')) return false;
    return true;
  }

  function isFeedLoadMoreLabel(text, inTail) {
    const normalized = normalizeLabel(text);
    if (!normalized || normalized.length > 64) return false;
    if (/comment|reply|留言|評論|评论|回覆|返信|option|選項|選單|菜单/.test(normalized)) return false;
    for (let i = 0; i < LOAD_MORE_PHRASES.length; i++) {
      const phrase = LOAD_MORE_PHRASES[i].toLowerCase();
      if (normalized === phrase) return true;
      if (normalized.indexOf(phrase) !== -1 && normalized.length <= 40) return true;
    }
    // Short labels that only mean "expand this post" when they sit inside a
    // card. In the feed tail they are the pagination control Patreon shows
    // ("Show more" / "查看更多"), which the strict list used to skip.
    if (!inTail) return false;
    if (/^(see more|show more|view more|read more|顯示更多|查看更多|看更多)$/.test(normalized)) return true;
    if (normalized.length <= 24 && (normalized.indexOf('查看更多') !== -1 || normalized.indexOf('顯示更多') !== -1 || normalized.indexOf('看更多') !== -1)) return true;
    return false;
  }

  function isLoadMoreDataTag(tag) {
    return /load-?more|see-more-posts|more-posts/i.test(String(tag || ''));
  }

  function isLoadingSignal(info) {
    const source = info || {};
    const aria = normalizeLabel(source.ariaLabel);
    const text = normalizeLabel(source.text);
    const dataTag = String(source.dataTag || '').toLowerCase();
    const className = String(source.className || '');
    const tag = String(source.tagName || '').toUpperCase();
    const role = String(source.role || '').toLowerCase();
    if (role === 'progressbar') return true;
    if (/loading more posts|loading posts|正在載入|正在加载|載入中|加载中/.test(aria)) return true;
    if (aria === 'loading' && tag === 'SVG') return true;
    if (text === 'loading more posts') return true;
    if (dataTag.includes('loading')) return true;
    if (/LoadingSpinner/.test(className)) return true;
    return false;
  }

  function isFeedResource(name, initiatorType) {
    if (initiatorType && initiatorType !== 'fetch' && initiatorType !== 'xmlhttprequest') return false;
    if (!name) return false;
    return /\/api\/posts\b|\/api\/launcher|\/api\/stream|campaign_id=|filter%5Bcampaign_id%5D|filter\[campaign_id\]/i.test(String(name));
  }

  function initialState() {
    return {
      loops: 0,
      seenIds: [],
      maxPostCards: 0,
      lastPostId: '',
      maxRawLinks: 0,
      quietStreak: 0,
      busyPasses: 0,
      loadMoreClicks: 0,
      action: 'scroll',
      reason: 'start',
      loading: false,
      done: false
    };
  }

  function notePosts(state, postIds, postCardCount, rawPostLinks) {
    const base = state || initialState();
    const seen = new Set(base.seenIds || []);
    const ids = postIds || [];
    let lastPostId = base.lastPostId || '';
    for (let i = 0; i < ids.length; i++) {
      if (!ids[i]) continue;
      const value = String(ids[i]);
      seen.add(value);
      lastPostId = value;
    }
    return {
      loops: base.loops || 0,
      seenIds: Array.from(seen),
      maxPostCards: Math.max(base.maxPostCards || 0, postCardCount || 0),
      lastPostId: lastPostId,
      maxRawLinks: Math.max(base.maxRawLinks || 0, rawPostLinks || 0),
      quietStreak: base.quietStreak || 0,
      busyPasses: base.busyPasses || 0,
      loadMoreClicks: base.loadMoreClicks || 0,
      action: base.action || 'scroll',
      reason: base.reason || 'start',
      loading: !!base.loading,
      done: !!base.done
    };
  }

  function foundCount(state, postIds, postCardCount) {
    const seen = state && state.seenIds ? state.seenIds.length : 0;
    const ids = postIds ? postIds.length : 0;
    const fromIds = Math.max(seen, ids);
    if (fromIds > 0) return fromIds;
    return Math.max(postCardCount || 0, state && state.maxPostCards ? state.maxPostCards : 0);
  }

  function absorb(state, postIds, postCardCount, rawPostLinks) {
    const seen = new Set(state.seenIds || []);
    const ids = [];
    let idGrew = false;
    const list = postIds || [];
    for (let i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      const value = String(list[i]);
      ids.push(value);
      if (!seen.has(value)) {
        seen.add(value);
        idGrew = true;
      }
    }
    const postCards = postCardCount || 0;
    const cardGrew = postCards > (state.maxPostCards || 0);
    const raw = rawPostLinks || 0;
    const rawGrew = raw > (state.maxRawLinks || 0);
    return {
      seenIds: Array.from(seen),
      maxPostCards: Math.max(state.maxPostCards || 0, postCards),
      maxRawLinks: Math.max(state.maxRawLinks || 0, raw),
      lastPostId: ids.length ? ids[ids.length - 1] : (state.lastPostId || ''),
      progress: idGrew || cardGrew || rawGrew
    };
  }

  function decide(state, observation) {
    const current = state || initialState();
    const obs = observation || {};
    if ((current.loops || 0) >= LIMITS.maxLoops) {
      return {
        loops: current.loops || 0,
        seenIds: current.seenIds || [],
        maxPostCards: current.maxPostCards || 0,
        lastPostId: current.lastPostId || '',
        maxRawLinks: current.maxRawLinks || 0,
        quietStreak: current.quietStreak || 0,
        busyPasses: current.busyPasses || 0,
        loadMoreClicks: current.loadMoreClicks || 0,
        action: 'stop',
        reason: 'max-loops',
        loading: false,
        done: true
      };
    }

    const absorbed = absorb(current, obs.postIds, obs.postCardCount, obs.rawPostLinks);
    const progress = absorbed.progress;
    const busy = !!obs.busy;
    const loops = (current.loops || 0) + 1;
    let loadMoreClicks = progress ? 0 : (current.loadMoreClicks || 0);
    const canClick = !!obs.hasLoadMore && loadMoreClicks < LIMITS.maxLoadMoreClicksWithoutGrowth;
    let quietStreak = current.quietStreak || 0;
    let busyPasses = current.busyPasses || 0;
    let action = 'scroll';
    let reason = 'scroll';

    if (progress) {
      quietStreak = 0;
      busyPasses = 0;
      action = canClick ? 'click' : 'scroll';
      reason = canClick ? 'progress-click' : 'progress';
    } else if (busy && busyPasses < LIMITS.maxBusyPasses) {
      busyPasses += 1;
      quietStreak = 0;
      action = 'scroll';
      reason = 'busy';
    } else if (canClick) {
      quietStreak = 0;
      if (busy) busyPasses += 1;
      else busyPasses = 0;
      action = 'click';
      reason = 'load-more';
    } else {
      if (busy) busyPasses += 1;
      else busyPasses = 0;
      quietStreak += 1;
      const need = (absorbed.seenIds.length === 0 && absorbed.maxPostCards === 0)
        ? LIMITS.stablePassesWhenEmpty
        : LIMITS.stablePassesToFinish;
      if (quietStreak >= need) {
        action = 'stop';
        reason = busy ? 'busy-gave-up' : (obs.hasLoadMore ? 'load-more-stuck' : 'end-of-feed');
      } else {
        action = 'scroll';
        reason = 'quiet';
      }
    }

    if (action === 'click') loadMoreClicks += 1;

    return {
      loops: loops,
      seenIds: absorbed.seenIds,
      maxPostCards: absorbed.maxPostCards,
      lastPostId: absorbed.lastPostId,
      maxRawLinks: absorbed.maxRawLinks,
      quietStreak: quietStreak,
      busyPasses: busyPasses,
      loadMoreClicks: loadMoreClicks,
      action: action,
      reason: reason,
      loading: busy && action !== 'stop',
      done: action === 'stop'
    };
  }

  root.FeedAutoLoad = {
    LIMITS: LIMITS,
    postIdFromHref: postIdFromHref,
    isRecommendationHeading: isRecommendationHeading,
    isSiteChrome: isSiteChrome,
    isFeedLoadMoreLabel: isFeedLoadMoreLabel,
    isLoadMoreDataTag: isLoadMoreDataTag,
    isLoadingSignal: isLoadingSignal,
    isFeedResource: isFeedResource,
    initialState: initialState,
    notePosts: notePosts,
    foundCount: foundCount,
    decide: decide
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
