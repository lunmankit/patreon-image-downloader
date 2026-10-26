const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundPath = path.join(__dirname, '..', 'background.js');

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  for (let i = 0; i < 8; i++) await flush();
}

function loadBackground(options) {
  const tabs = new Map(options.tabs || []);
  const missing = new Set(options.missing || []);
  const calls = [];
  const unchecked = [];
  const timers = [];
  const listeners = {
    onInstalled: [],
    onActivated: [],
    onUpdated: [],
    onMessage: []
  };
  let pendingError = '';
  let checked = false;
  let activeTabId = options.activeTabId;

  function deliver(callback, errorMessage, value, missingResolves) {
    pendingError = errorMessage || '';
    checked = false;
    if (typeof callback !== 'function') {
      if (pendingError) unchecked.push(pendingError);
      const err = pendingError;
      pendingError = '';
      if (err && missingResolves) return Promise.resolve(value);
      if (err) return Promise.reject(new Error(err));
      return Promise.resolve(value);
    }
    callback(value);
    if (pendingError && !checked) unchecked.push(pendingError);
    pendingError = '';
    return undefined;
  }

  const chrome = {
    runtime: {
      onInstalled: { addListener(fn) { listeners.onInstalled.push(fn); } },
      onMessage: { addListener(fn) { listeners.onMessage.push(fn); } }
    },
    tabs: {
      onActivated: { addListener(fn) { listeners.onActivated.push(fn); } },
      onUpdated: { addListener(fn) { listeners.onUpdated.push(fn); } },
      get(tabId, callback) {
        if (missing.has(tabId) || !tabs.has(tabId)) {
          return deliver(callback, 'No tab with id: ' + tabId + '.', undefined, false);
        }
        return deliver(callback, '', tabs.get(tabId), false);
      },
      query(queryInfo, callback) {
        const tab = tabs.get(activeTabId);
        const list = queryInfo.active && tab ? [tab] : [];
        return deliver(callback, '', list, false);
      }
    },
    action: {
      setIcon(details, callback) {
        calls.push(JSON.parse(JSON.stringify(details)));
        if (typeof details.tabId === 'number' && (missing.has(details.tabId) || !tabs.has(details.tabId))) {
          return deliver(callback, 'No tab with id: ' + details.tabId + '.', undefined, true);
        }
        return deliver(callback, '', undefined, false);
      }
    }
  };
  Object.defineProperty(chrome.runtime, 'lastError', {
    configurable: true,
    get() {
      checked = true;
      return pendingError ? { message: pendingError } : undefined;
    }
  });

  const sandbox = {
    URL,
    Promise,
    console,
    chrome,
    setTimeout(fn) {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(backgroundPath, 'utf8'), sandbox, { filename: backgroundPath });
  return { calls, unchecked, timers, listeners, tabs };
}

(async () => {
  const supported = {
    16: 'icons/supported16.png',
    48: 'icons/supported48.png',
    128: 'icons/supported128.png'
  };
  const idle = {
    16: 'icons/default16.png',
    48: 'icons/default48.png',
    128: 'icons/default128.png'
  };
  const complete = {
    16: 'icons/complete16.png',
    48: 'icons/complete48.png',
    128: 'icons/complete128.png'
  };

  {
    const env = loadBackground({ missing: [13724252] });
    env.listeners.onActivated[0]({ tabId: 13724252 });
    env.listeners.onUpdated[0](13724252, { status: 'complete', url: 'https://www.patreon.com/posts/1' }, { url: 'https://www.patreon.com/posts/1' });
    env.listeners.onUpdated[0](13724252, { url: 'https://fantia.jp/posts/9' }, { url: 'https://fantia.jp/posts/9' });
    env.listeners.onMessage[0]({ type: 'SET_ICON_STATE', state: 'supported', tabId: 13724252 }, {}, () => {});
    await settle();
    assert.deepStrictEqual(env.unchecked, [], 'missing tab must not leave lastError unchecked');
    assert.ok(env.calls.every((call) => call.tabId === 13724252));
  }

  {
    const tab = { id: 7, url: 'https://example.com/', active: true };
    const env = loadBackground({ tabs: [[7, tab]], activeTabId: 7 });
    env.listeners.onUpdated[0](7, { status: 'complete' }, tab);
    await settle();
    assert.deepStrictEqual(env.unchecked, []);
    assert.deepStrictEqual(env.calls, [{ path: idle, tabId: 7 }]);
  }

  {
    const tab = { id: 8, url: 'https://www.patreon.com/cw/example', active: true };
    const env = loadBackground({ tabs: [[8, tab]], activeTabId: 8 });
    env.listeners.onActivated[0]({ tabId: 8 });
    await settle();
    assert.deepStrictEqual(env.unchecked, []);
    assert.deepStrictEqual(env.calls, [{ path: supported, tabId: 8 }]);
  }

  {
    const tab = { id: 9, url: 'https://fantia.jp/fanclubs/1/posts', active: true };
    const env = loadBackground({ tabs: [[9, tab]], activeTabId: 9 });
    env.listeners.onUpdated[0](9, { url: tab.url }, tab);
    await settle();
    assert.deepStrictEqual(env.unchecked, []);
    assert.deepStrictEqual(env.calls, [{ path: supported, tabId: 9 }]);
  }

  {
    const tab = { id: 3, url: 'https://www.patreon.com/posts/9', active: true };
    const env = loadBackground({ tabs: [[3, tab]], activeTabId: 3 });
    let response = null;
    const keep = env.listeners.onMessage[0](
      { type: 'DOWNLOAD_COMPLETE' },
      { tab: { id: 3 } },
      (value) => { response = value; }
    );
    assert.strictEqual(keep, true);
    await settle();
    assert.strictEqual(response && response.ok, true);
    assert.deepStrictEqual(env.calls, [
      { path: complete, tabId: 3 },
      { path: complete }
    ]);
    env.calls.length = 0;
    env.listeners.onUpdated[0](3, { status: 'complete' }, tab);
    await settle();
    assert.deepStrictEqual(env.calls, [], 'complete icon stays until the timer fires');
    env.timers[0]();
    await settle();
    assert.deepStrictEqual(env.unchecked, []);
    assert.deepStrictEqual(env.calls, [{ path: supported, tabId: 3 }]);
  }

  console.log('icon-state.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
