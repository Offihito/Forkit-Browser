import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const adblockerRs = fs.readFileSync(
  path.resolve(import.meta.dirname, '../src-tauri/src/adblocker.rs'),
  'utf8'
);

const match = adblockerRs.match(/pub const TAB_INIT_SCRIPT: &str = r#"([\s\S]*?)"#;/);
assert.ok(match, 'TAB_INIT_SCRIPT should exist in src-tauri/src/adblocker.rs');
const TAB_INIT_SCRIPT = match[1];

function createYouTubeSandbox() {
  const appendedStyles = [];
  const domListeners = {};
  const createdElements = [];

  class MockResponse {
    constructor(body, init = {}) {
      this._body = body;
      this.status = init.status ?? 200;
      this.statusText = init.statusText ?? 'OK';
      this.headers = new Map(Object.entries(init.headers || {}));
      if (!this.headers.has('content-type')) {
        this.headers.set('content-type', 'application/json');
      }
    }
    clone() {
      return new MockResponse(this._body, {
        status: this.status,
        statusText: this.statusText,
        headers: Object.fromEntries(this.headers.entries()),
      });
    }
    async json() {
      return JSON.parse(this._body);
    }
  }

  class MockHeaders {
    constructor(init) {
      this._map = new Map(init ? [...init.entries()] : []);
    }
    get(k) { return this._map.get(k.toLowerCase()) ?? null; }
    delete(k) { this._map.delete(k.toLowerCase()); }
    entries() { return this._map.entries(); }
  }

  class MockXHR {
    open(method, url) { this._opened = { method, url }; }
    send() { this._sent = true; }
    addEventListener() {}
  }

  const sandbox = {
    console,
    Promise,
    JSON,
    Response: MockResponse,
    Headers: MockHeaders,
    XMLHttpRequest: MockXHR,
    setInterval: () => 1,
    location: { hostname: 'www.youtube.com' },
    document: {
      head: {
        appendChild(el) {
          appendedStyles.push(el);
        },
      },
      documentElement: {
        appendChild(el) {
          appendedStyles.push(el);
        },
      },
      createElement(tag) {
        const el = { tagName: tag.toUpperCase(), id: '', textContent: '' };
        createdElements.push(el);
        return el;
      },
      getElementById(id) {
        return appendedStyles.find((s) => s.id === id) || null;
      },
      addEventListener(evt, fn) {
        domListeners[evt] = fn;
      },
      querySelector() {
        return null;
      },
    },
    fetch: async (url) => {
      if (String(url).includes('/youtubei/v1/player')) {
        return new MockResponse(
          JSON.stringify({
            videoDetails: { videoId: 'abc123' },
            adPlacements: [{ adPlacementRenderer: {} }],
            playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
            adSlots: [{ adSlotRenderer: {} }],
          })
        );
      }
      return new MockResponse('{}');
    },
    __TAURI__: {
      core: {
        invoke: async () => {},
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(TAB_INIT_SCRIPT, sandbox);
  return { sandbox, appendedStyles };
}

test('YouTube ytInitialPlayerResponse strips adPlacements and playerAds', () => {
  const { sandbox } = createYouTubeSandbox();
  sandbox.ytInitialPlayerResponse = {
    videoDetails: { title: 'Test Video' },
    adPlacements: [{ id: 1 }, { id: 2 }],
    playerAds: [{ id: 3 }],
    adSlots: [{ id: 4 }],
    adBreakHeartbeatParams: 'secret',
  };

  assert.equal(sandbox.ytInitialPlayerResponse.adPlacements.length, 0);
  assert.equal(sandbox.ytInitialPlayerResponse.playerAds.length, 0);
  assert.equal(sandbox.ytInitialPlayerResponse.adSlots.length, 0);
  assert.equal(sandbox.ytInitialPlayerResponse.adBreakHeartbeatParams, undefined);
  assert.equal(sandbox.ytInitialPlayerResponse.videoDetails.title, 'Test Video');
});

test('fetch blocks YouTube ad endpoints with 204 and strips /youtubei/v1/player ads', async () => {
  const { sandbox } = createYouTubeSandbox();

  const adRes = await sandbox.fetch('https://googleads.g.doubleclick.net/pagead/ads');
  assert.equal(adRes.status, 204);

  const midrollRes = await sandbox.fetch('https://www.youtube.com/get_midroll_info');
  assert.equal(midrollRes.status, 204);

  const playerRes = await sandbox.fetch('https://www.youtube.com/youtubei/v1/player');
  assert.equal(playerRes.status, 200);
  const playerData = await playerRes.json();
  assert.equal(playerData.videoDetails.videoId, 'abc123');
  assert.equal(playerData.adPlacements.length, 0);
  assert.equal(playerData.playerAds.length, 0);
  assert.equal(playerData.adSlots.length, 0);
});

test('XMLHttpRequest blocks googlesyndication ad requests', () => {
  const { sandbox } = createYouTubeSandbox();
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('GET', 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js');
  xhr.send();
  assert.equal(xhr.status, 204);
  assert.equal(xhr.responseText, '');
});

test('Cosmetic CSS hides YouTube ad containers', () => {
  const { appendedStyles } = createYouTubeSandbox();
  assert.ok(appendedStyles.length > 0, 'Style element should be injected');
  const css = appendedStyles[0].textContent;
  assert.ok(css.includes('ytd-ad-slot-renderer'));
  assert.ok(css.includes('#player-ads'));
  assert.ok(css.includes('.ytp-ad-module'));
  assert.ok(css.includes('display: none !important'));
});

test('JSON.parse strips nested adPlacements and adSlots from inline YouTube payloads', () => {
  const { sandbox } = createYouTubeSandbox();
  const parsed = sandbox.JSON.parse(
    JSON.stringify({
      response: {
        playerResponse: {
          videoDetails: { videoId: 'xyz' },
          adPlacements: [{ ad: 1 }],
          playerAds: [{ ad: 2 }],
          adSlots: [{ ad: 3 }],
        },
      },
    })
  );
  assert.equal(parsed.response.playerResponse.videoDetails.videoId, 'xyz');
  assert.equal(parsed.response.playerResponse.adPlacements.length, 0);
  assert.equal(parsed.response.playerResponse.playerAds.length, 0);
  assert.equal(parsed.response.playerResponse.adSlots.length, 0);
});
