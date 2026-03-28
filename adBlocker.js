// adBlocker.js - Ad Blocking System with Enhanced YouTube Support
const fs = require('fs');
const path = require('path');
const https = require('https');
const fetch = require('cross-fetch');
const { FiltersEngine, Request } = require('@ghostery/adblocker');

class AdBlocker {
  constructor() {
    this.filters = {
      block: [],
      allow: [],
      cosmetic: []
    };
    this.isEnabled = true;
    this.stats = {
      blocked: 0,
      allowed: 0
    };
    this.filterListPath = path.join(__dirname, 'Data', 'adblock-filters.txt');
    this.statsPath = path.join(__dirname, 'Data', 'adblock-stats.json');
    this.engine = null;
    this.initPromise = this.init();

    this.loadFilters();
    this.loadStats();
  }

  // Filter list URL'leri (popüler reklam engelleme listeleri)
  getDefaultFilterLists() {
    return [
      {
        name: 'EasyList',
        url: 'https://easylist.to/easylist/easylist.txt',
        enabled: true
      },
      {
        name: 'EasyPrivacy',
        url: 'https://easylist.to/easylist/easyprivacy.txt',
        enabled: true
      },
      {
        name: 'AdGuard Base',
        url: 'https://filters.adtidy.org/extension/chromium/filters/2.txt',
        enabled: true
      },
      {
        name: 'Peter Lowe\'s List',
        url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0',
        enabled: true
      }
    ];
  }

  // Filter listelerini indir ve güncelle
  async updateFilterLists() {
    console.log('Updating ad block filter lists...');
    const lists = this.getDefaultFilterLists();
    let allFilters = [];

    for (const list of lists) {
      if (!list.enabled) continue;

      try {
        const filters = await this.downloadFilterList(list.url);
        allFilters = allFilters.concat(filters);
        console.log(`Downloaded ${list.name}: ${filters.length} filters`);
      } catch (err) {
        console.error(`Error downloading ${list.name}:`, err.message);
      }
    }

    // Filtreleri kaydet
    this.parseFilters(allFilters);
    this.saveFilters(allFilters);

    try {
      this.engine = await FiltersEngine.fromPrebuiltAdsAndTracking(fetch);
      console.log('✅ Ghostery adblock engine initialized');
    } catch (err) {
      console.error('Failed to initialize Ghostery engine:', err && err.message ? err.message : err);
      this.engine = null;
    }

    return {
      total: allFilters.length,
      block: this.filters.block.length,
      allow: this.filters.allow.length,
      cosmetic: this.filters.cosmetic.length
    };
  }

  async init() {
    try {
      this.engine = await FiltersEngine.fromPrebuiltAdsAndTracking(fetch);
      console.log('✅ Ghostery adblock engine initialized');
    } catch (err) {
      console.error('Failed to initialize Ghostery engine:', err && err.message ? err.message : err);
      this.engine = null;
    }
  }

  normalizeResourceType(type) {
    if (!type || typeof type !== 'string') return 'other';
    const lower = type.toLowerCase();
    switch (lower) {
      case 'mainframe':
      case 'main_frame':
        return 'main_frame';
      case 'subframe':
      case 'sub_frame':
        return 'sub_frame';
      case 'xmlhttprequest':
      case 'xhr':
        return 'xmlhttprequest';
      case 'stylesheet':
      case 'script':
      case 'image':
      case 'font':
      case 'ping':
      case 'media':
      case 'object':
        return lower;
      default:
        return 'other';
    }
  }

  // Filter listesini indir
  downloadFilterList(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';

        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const lines = data.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('!') && !line.startsWith('['));
          resolve(lines);
        });
      }).on('error', reject);
    });
  }

  // Filtreleri parse et
  parseFilters(filterLines) {
    this.filters = {
      block: [],
      allow: [],
      cosmetic: []
    };

    for (let line of filterLines) {
      line = line.trim();

      // Boş veya yorum satırlarını atla
      if (!line || line.startsWith('!') || line.startsWith('[')) continue;

      // Cosmetic filters (##, #@#)
      if (line.includes('##') || line.includes('#@#')) {
        this.filters.cosmetic.push(line);
        continue;
      }

      // Exception rules (@@)
      if (line.startsWith('@@')) {
        const pattern = this.convertToRegex(line.substring(2));
        this.filters.allow.push(pattern);
        continue;
      }

      // Block rules
      const pattern = this.convertToRegex(line);
      this.filters.block.push(pattern);
    }

    console.log(`Parsed filters - Block: ${this.filters.block.length}, Allow: ${this.filters.allow.length}, Cosmetic: ${this.filters.cosmetic.length}`);
  }

  // AdBlock formatını regex'e çevir
  convertToRegex(filter) {
    // Basit wildcard dönüşümü
    let pattern = filter
      .replace(/\*/g, '.*')
      .replace(/\^/g, '[^\\w\\d_\\-.%]')
      .replace(/\|{2}/g, '^https?:\\/\\/([^/]+\\.)?')
      .replace(/^\|/g, '^')
      .replace(/\|$/g, '$');

    try {
      return new RegExp(pattern, 'i');
    } catch (e) {
      // Regex hatası varsa basit string matching kullan
      return {
        test: (url) => url.toLowerCase().includes(filter.toLowerCase())
      };
    }
  }

  // URL'nin engellenip engellenmeyeceğini kontrol et
  shouldBlock(url, type = 'other', sourceUrl = '') {
    if (!this.isEnabled) return false;
    const normalizedType = this.normalizeResourceType(type);

    // YouTube için özel kurallar - kritik kaynakları engelleme
    // NOT: googlevideo.com/videoplayback burada intentionally whitelist'te DEĞİL.
    // YouTube reklamları da aynı domain/path kullanır. Sadece network-level
    // block (youtubeAdPatterns) + content-script ile yönetilir.
    const youtubeWhitelist = [
      'youtube.com/api/timedtext',       // Altyazılar
      'youtube.com/youtubei/v1/player',  // Player API (ad olmayan)
      'youtube.com/s/player/',           // Player JS bundle
      'youtube.com/iframe_api',          // Embed API
      'ytimg.com',                       // Thumbnails
      'ggpht.com',                       // Channel avatars
      'gstatic.com/youtube',             // Static assets
      'youtube.com/youtubei/v1/browse',  // Browse API (ana sayfa/kanal)
      'youtube.com/youtubei/v1/search',  // Arama API
      'youtube.com/youtubei/v1/get_video_details', // Video details
      'googlevideo.com/videoplayback'    // Actual video stream
    ];

    // YouTube reklam isteklerini engelle (en yüksek öncelik)
    const youtubeAdPatterns = [
      // --- Ad networks (domain-level — her zaman engelle) ---
      'doubleclick.net',
      'googlesyndication.com',
      'googleadservices.com',
      'googleads.g.doubleclick.net',
      'static.doubleclick.net',
      'advertising.youtube.com',
      'ads.google.com',
      'ad.youtube.com',
      'adservice.google.com',
      'r.googleyoutube.com',
      'tracking.google.com',
      'cm.smartadserver.com',
      'tds.gumgum.com',
      // --- YouTube ad-specific endpoints ---
      'youtube.com/pagead/',
      'google.com/pagead/',
      'youtube.com/api/stats/ads',
      'youtube.com/api/stats/atr',
      'youtube.com/get_midroll_',
      'youtube.com/youtubei/v1/log_event',
      'youtube.com/csi_204',
      // --- Ad serving API endpoints ---
      'youtubei/v1/player/ad_unit',
      'youtube.com/youtubei/v1/browse?includeAdData',
      // --- Ad config ---
      '/adtag/',
      '/ad_tag/',
      'googleplacementinterstitial'
    ];

    // ÖNCE: YouTube ad patterns kontrol (yüksek öncelik — whitelist'ten önce)
    for (const pattern of youtubeAdPatterns) {
      if (url.includes(pattern)) {
        this.stats.blocked++;
        this.saveStats();
        console.log('🎯 YouTube ad blocked:', url.substring(0, 100));
        return true;
      }
    }

    // SONRA: YouTube whitelist kontrol
    for (const domain of youtubeWhitelist) {
      if (url.includes(domain)) {
        return false;
      }
    }

    if (this.engine) {
      try {
        const request = Request.fromRawDetails({ url, type: normalizedType, sourceUrl });
        const result = this.engine.match(request);
        if (result && result.match && result.filter) {
          this.stats.blocked++;
          this.saveStats();
          return true;
        }
      } catch (err) {
        console.error('Ghostery engine match failed:', err && err.message ? err.message : err);
      }
    }

    // Allow listesinde mi kontrol et
    for (const pattern of this.filters.allow) {
      if (pattern.test(url)) {
        this.stats.allowed++;
        return false;
      }
    }

    // Block listesinde mi kontrol et
    for (const pattern of this.filters.block) {
      if (pattern.test(url)) {
        this.stats.blocked++;
        this.saveStats();
        return true;
      }
    }

    // Comprehensive domain-based blocking
    const adDomains = [
      // Google ad ecosystem
      'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
      'google-analytics.com', 'adservice.google.com',
      'pagead2.googlesyndication.com', 'imasdk.googleapis.com',
      'fundingchoicesmessages.google.com',
      'ade.googlesyndication.com', 'adclick.g.doubleclick.net',
      // Major ad exchanges / SSPs / DSPs
      'adnxs.com', 'criteo.com', 'criteo.net',
      'outbrain.com', 'taboola.com', 'taboolacdn.com',
      'amazon-adsystem.com', 'moatads.com', 'adsrvr.org',
      'rubiconproject.com', 'pubmatic.com', 'openx.net',
      'media.net', 'mediavine.com', 'bidswitch.net',
      'adform.net', 'smartadserver.com', 'gumgum.com',
      'teads.tv', 'teads.com',
      'indexexchange.com', 'casalemedia.com',
      'sharethrough.com', 'undertone.com',
      'yieldmo.com', '33across.com', 'triplelift.com',
      'sovrn.com', 'lijit.com', 'sonobi.com',
      'rhythmone.com', 'unrulymedia.com',
      'spotxchange.com', 'spotx.tv',
      'freewheel.com', 'freewheel.tv',
      'liveintent.com', 'connatix.com',
      'nativo.com', 'revcontent.com',
      'content-ad.net', 'dianomi.com',
      'zergnet.com', 'adblade.com',
      // Tracking / analytics / pixels
      'scorecardresearch.com', 'addthis.com', 'sharethis.com',
      'quantserve.com', 'quantcast.com',
      'bluekai.com', 'exelator.com',
      'demdex.net', 'krxd.net', 'rlcdn.com',
      'serving-sys.com', 'sizmek.com',
      'eyeota.net', 'tapad.com', 'lotame.com',
      'adsymptotic.com', 'rfihub.com',
      'intentiq.com', 'id5-sync.com',
      'liveramp.com', 'adsensor.com',
      // Pop-under / aggressive ad networks
      'popads.net', 'popcash.net', 'propellerads.com',
      'exoclick.com', 'clickadu.com', 'hilltopads.net',
      'popunder.net', 'popmyads.com',
      'trafficjunky.com', 'juicyads.com', 'clicksor.com',
      'admaven.com', 'ad-maven.com',
      'trafficfactory.biz', 'plugrush.com',
      'adxpansion.com', 'trafficstars.com',
      'clickaine.com', 'adsterra.com',
      'richpush.com', 'pushground.com',
      'evadav.com', 'galaksion.com',
      // Mobile ad networks
      'adcolony.com', 'inmobi.com', 'mopub.com',
      'applovin.com', 'vungle.com', 'chartboost.com',
      'ironsrc.com', 'fyber.com', 'tapjoy.com',
      // Video ad networks
      'springserve.com', 'videologygroup.com',
      'innovid.com', 'extreme-reach.com',
      // Turkish ad networks
      'plakout.com', 'emedya.com.tr', 'admatic.com.tr',
      'adskeeper.com', 'adskeeper.co.uk', 'mgid.com',
      'reklamstore.com', 'reklamaction.com', 'atemda.com',
      'reklamup.com', 'medyanet.net', 'medyanetads.com',
      'addays.com', 'admingle.com', 'mobilike.com',
      'livad.com', 'setupad.com', 'optad360.com',
      'denakop.com', 'unibots.in',
      // Carbon / BuySellAds
      'carbonads.net', 'carbonads.com', 'buysellads.com',
      'bsa.network',
      // Social media trackers
      'ads-twitter.com', 'analytics.twitter.com',
      'facebook.com/tr', 'facebook.net',
      'tiktokads.com', 'analytics.tiktok.com',
      // Misc ad/tracking
      'advertising.com', 'contextweb.com', 'yldbt.com',
      'mathtag.com', 'mxptint.net',
      'bounceexchange.com', 'bouncex.net',
      'revjet.com', 'narrative.io',
      'zemanta.com', 'adroll.com', 'retargetly.com',
      'steelhouse.com', 'nextroll.com',
      'yandexadexchange.net', 'adfox.ru',
      'ad4mat.com', 'adhese.com', 'adkernel.com',
      'adloox.com', 'admixer.net', 'adnami.io',
      'adsafeprotected.com', 'adthrive.com',
      'betweendigital.com', 'brightcom.com',
      'clickio.com', 'conversantmedia.com',
      'emxdgt.com', 'engagebdr.com',
      'justpremium.com', 'kargo.com', 'marfeel.com',
      'mgid.org', 'mintegral.com', 'mobfox.com',
      'onaudience.com', 'permutive.com',
      'seedtag.com', 'smartclip.net',
      'smaato.net', 'startapp.com',
      'stickyadstv.com', 'verizonmedia.com',
      'vidoomy.com', 'weborama.com',
      'yieldlab.net', 'yieldlove.com'
    ];

    for (const domain of adDomains) {
      if (url.includes(domain)) {
        this.stats.blocked++;
        this.saveStats();
        return true;
      }
    }

    return false;
  }

  // YouTube player için content script - reklamları otomatik atla
  getYouTubeContentScript() {
    return `
      (function() {
        // Daha önce yüklenip yüklenmediğini kontrol et
        if (window.__ytAdBlockerLoaded) return;
        window.__ytAdBlockerLoaded = true;

        console.log('🎬 YouTube Ad Blocker Script Loaded (v2)');

        // ============================================================
        // 1. CSS: Reklam elementlerini derhal gizle
        // ============================================================
        (function injectCSS() {
          if (document.getElementById('__yt_adb_style')) return;
          const style = document.createElement('style');
          style.id = '__yt_adb_style';
          style.textContent = \`
            /* In-stream overlay reklamları */
            .video-ads,
            .ytp-ad-player-overlay,
            .ytp-ad-overlay-container,
            .ytp-ad-text-overlay,
            .ytp-ad-image-overlay,
            .ytp-ad-overlay-close-button,
            .ytp-ad-info-list,
            .ytp-ad-info,
            .ytp-ad-skip-button,
            .ytp-ad-skip-button-modern,
            .ytp-skip-ad-button,
            .ytp-ad-upcoming-ad,
            .ytp-ad-countdown-timer,
            .ytp-ad-player-overlay-top,
            .ytp-ad-player-overlay-bottom,
            .ytp-ad-player-overlay-brand-icon,
            .ytp-ad-player-overlay-ad-badge,
            .ytp-ad-player-overlay-redirect-button,
            .ytp-ad-player-overlay-close-button {
              display: none !important;
              visibility: hidden !important;
              opacity: 0 !important;
              pointer-events: none !important;
            }
            /* Feed reklamları */
            ytd-display-ad-renderer,
            ytd-promoted-sparkles-web-renderer,
            ytd-in-feed-ad-layout-renderer,
            ytd-ad-slot-renderer,
            yt-mealbar-promo-renderer,
            #masthead-ad,
            .ytd-merch-shelf-renderer,
            ytd-statement-banner-renderer,
            ytd-video-masthead-ad-v3-renderer,
            ytd-search-pydata-renderer .ytp-ad-player-overlay {
              display: none !important;
              visibility: hidden !important;
              height: 0 !important;
              min-height: 0 !important;
            }
          \`;
          document.head.appendChild(style);
          console.log('🎨 CSS enjekte edildi');
        })();

        // ============================================================
        // 2. Reklamları tespit & atla
        // ============================================================
        let skipCooldown = 0; // Ardışık skip spamini önle

        // Reklam video elementini bul (ana video değil)

        // Ad state tracking — reklam bitince temizlenecek
        let adState = {
          active: false,
          spamInterval: null,
          originalPlaybackRate: 1
        };

        function cleanupAdState() {
          if (!adState.active) return;
          const video = document.querySelector('video');
          if (video) {
            video.playbackRate = adState.originalPlaybackRate;
            video.muted = adState.originalMuted || false;
          }
          if (adState.spamInterval) {
            clearInterval(adState.spamInterval);
            adState.spamInterval = null;
          }
          adState.active = false;
          console.log('🧹 Ad state cleaned up, main video restored');
        }

        // Element fiilen görünür mü kontrol — CSS display:none gizlenmiş olanları filtre eder
        function isVisible(el) {
          if (!el) return false;
          // offsetParent === null → element veya atası display:none
          // Exception: <body> ve position:fixed elementler her zaman offsetParent=null olabilir
          if (el.offsetParent === null && el.tagName !== 'BODY') {
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
          }
          return true;
        }

        function isAdPlaying() {
          // A: Bilinen reklam class'ları — sadece GÖRÜNÜR olanlar
          const adShowingEl = document.querySelector('.ad-showing');
          if (adShowingEl && isVisible(adShowingEl)) return true;

          // B: Ad overlay elementleri — CSS ile gizlenmiş olanları atla
          const overlaySelectors = [
            '.ytp-ad-player-overlay',
            '.ytp-ad-player-overlay-container',
            '.ytp-ad-text-overlay',
            '.ytp-ad-info',
            '.ytp-ad-player-overlay-brand-icon'
          ];
          for (const sel of overlaySelectors) {
            const el = document.querySelector(sel);
            if (el && isVisible(el)) return true;
          }

          // C: Sponsorlu label — sadece #player scope'unda ve görünür
          const playerEl = document.querySelector('#player, .ytp-player-container');
          if (playerEl) {
            const adLabel = playerEl.querySelector('.ytp-ad-label');
            if (adLabel && isVisible(adLabel)) return true;
          }

          return false;
        }

        function clickSkipButton() {
          const selectors = [
            'button.ytp-ad-skip-button',
            '.ytp-ad-skip-button',
            '.ytp-ad-skip-button-modern',
            '.ytp-skip-ad-button',
            'button[data-testid="skip-button"]',
            '.videoAdUiSkipButton',
            '.ytp-skip-ad-button button',
            'button[aria-label*="skip"], button[aria-label*="Skip"]',
            'button[aria-label*="atlı"], button[aria-label*="Atlı"]'
          ];
          for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && btn.offsetParent !== null) {
              console.log('⏭️  Skip button found:', sel);
              btn.click();
              return true;
            }
          }
          return false;
        }

        function forceSkipAd() {
          if (adState.active) return;

          const video = document.querySelector('video');
          if (!video) return;

          adState.active = true;
          adState.originalPlaybackRate = video.playbackRate || 1;
          adState.originalMuted = video.muted;

          video.muted = true;
          try { video.playbackRate = 16; } catch(e) {}

          // Ad overlay'leri gizle
          document.querySelectorAll(
            '.video-ads, .ytp-ad-player-overlay, .ytp-ad-player-overlay-container, ' +
            '.ytp-ad-text-overlay, .ytp-ad-image-overlay, .ytp-ad-label'
          ).forEach(el => {
            el.style.cssText = 'display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important;';
          });

          // Polling: reklam bitince state'i restore et
          let count = 0;
          adState.spamInterval = setInterval(() => {
            if (!isAdPlaying()) {
              cleanupAdState();
              return;
            }
            count++;
            if (count > 200) { // 10s safety timeout
              cleanupAdState();
            }
          }, 50);

          console.log('⏩ Force skip started (mute + 16x)');
        }

        // Debug: her 3s bir kez video state'ini log
        let debugLogCount = 0;
        function debugLog() {
          const video = document.querySelector('video');
          const adSelectors = [
            '.ad-showing',
            '.ytp-ad-player-overlay',
            '.ytp-ad-player-overlay-container',
            '.ytp-ad-text-overlay',
            '.ytp-ad-label',
            '[class*="ytp-ad-"]'
          ];
          const foundAds = adSelectors.filter(s => document.querySelector(s)).join(', ');
          if (video) {
            console.log(
              '[YT-ADB DEBUG]',
              'dur=' + (video.duration || 0).toFixed(1) + 's',
              'cur=' + (video.currentTime || 0).toFixed(1) + 's',
              'rate=' + video.playbackRate,
              'muted=' + video.muted,
              'paused=' + video.paused,
              'adState.active=' + adState.active,
              'adElements=[' + foundAds + ']'
            );
          }
        }
        setInterval(() => { debugLog(); }, 3000);

        function handleAd() {
          const now = Date.now();
          if (now < skipCooldown) return;

          // Ad yok ama state hala aktif mi? → temizle
          if (!isAdPlaying()) {
            if (adState.active) cleanupAdState();
            return;
          }

          console.log('🚫 Ad detected!');

          if (clickSkipButton()) {
            console.log('✅ Skipped via button');
            cleanupAdState();
            skipCooldown = now + 2000;
            return;
          }

          forceSkipAd();
          skipCooldown = now + 800;
        }


        // ============================================================
        // 3. MutationObserver — DOM değişikliklerinde anında kontrol
        // ============================================================
        (function startObserver() {
          const observer = new MutationObserver((mutations) => {
            // Sadece ilgili mutation'lar için kontrol et
            for (const m of mutations) {
              // Yeni node eklendi mi?
              if (m.addedNodes.length > 0) {
                handleAd();
                return;
              }
              // Class veya style attribute değişti mi?
              if (m.type === 'attributes') {
                const target = m.target;
                if (target && target.className && typeof target.className === 'string') {
                  if (target.className.includes('ad-') || target.className.includes('ytp-ad')) {
                    handleAd();
                    return;
                  }
                }
              }
            }
          });

          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
          });
          console.log('👀 MutationObserver başlatıldı');
        })();

        // ============================================================
        // 4. Ana video length'ini kaydet + Interval
        setInterval(handleAd, 300);

        // ============================================================
        // 5. fetch / XMLHttpRequest intercept — YouTube ad config yanıtlarını engelle
        // Bu, YouTube'un /youtubei/v1/player veya /next endpoint'inden
        // dönen "ad" bilgilerini yakalar.
        // ============================================================
        (function interceptFetch() {
          const originalFetch = window.fetch;
          window.fetch = function(...args) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';

            // Tamamen engel: ad network domains
            if (url.includes('/pagead/') ||
                url.includes('doubleclick') ||
                url.includes('googleadservices') ||
                url.includes('adservice.google')) {
              return Promise.resolve(new Response('{}'));
            }

            // /youtubei/v1/player — response'dan ad payload'ı temizle
            if (url.includes('youtubei/v1/player')) {
              return originalFetch.apply(this, args).then(response => {
                if (!response.ok) return response;
                return response.text().then(text => {
                  try {
                    const data = JSON.parse(text);
                    // Ad payload'ları temizle
                    if (data.streamingData && data.streamingData.adSupportedFormats) {
                      delete data.streamingData.adSupportedFormats;
                    }
                    if (data.videoDetails && data.videoDetails.isAd) {
                      data.videoDetails.isAd = false;
                    }
                    // adRenderer'ları ara ve sil
                    const cleaned = JSON.stringify(data)
                      .replace(/"adRenderer":\{[^}]*\}/g, '')
                      .replace(/"adPods":\[[^\]]*\]/g, '"adPods":[]')
                      .replace(/"adUnit":\{[^}]*\}/g, '');
                    return new Response(cleaned, {
                      status: response.status,
                      headers: { 'Content-Type': 'application/json' }
                    });
                  } catch(e) {
                    // JSON parse fail → orijinal response döndür
                    return new Response(text, {
                      status: response.status,
                      headers: response.headers
                    });
                  }
                });
              });
            }

            return originalFetch.apply(this, args);
          };
        })();

        (function interceptXHR() {
          const originalOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url) {
            if (typeof url === 'string') {
              if (url.includes('/pagead/') ||
                  url.includes('doubleclick') ||
                  url.includes('googleadservices') ||
                  url.includes('adservice.google')) {
                // Bu isteği silent olarak "boş" yap
                this.__blocked = true;
              }
            }
            return originalOpen.apply(this, arguments);
          };

          const originalSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.send = function() {
            if (this.__blocked) {
              console.log('🚫 XHR blocked');
              this.readyState = 4;
              this.status = 200;
              this.responseText = '{}';
              if (typeof this.onload === 'function') this.onload();
              return;
            }
            return originalSend.apply(this, arguments);
          };
        })();

        console.log('✅ YouTube Ad Blocker v2 hazır!');
      })();
    `;
  }

  // Cosmetic filtreleri al (element hiding için)
  getCosmeticFilters(domain) {
    if (!domain) return [];

    return this.filters.cosmetic.filter(filter => {
      // Domain-specific filters
      if (filter.includes(domain)) return true;
      // Generic filters
      if (!filter.includes(',') && filter.startsWith('##')) return true;
      return false;
    });
  }

  // Filtreleri kaydet
  saveFilters(filterLines) {
    try {
      const dataDir = path.dirname(this.filterListPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(this.filterListPath, filterLines.join('\n'), 'utf8');
    } catch (err) {
      console.error('Error saving filters:', err);
    }
  }

  // Filtreleri yükle
  loadFilters() {
    try {
      if (fs.existsSync(this.filterListPath)) {
        const data = fs.readFileSync(this.filterListPath, 'utf8');
        const lines = data.split('\n').filter(line => line.trim());
        this.parseFilters(lines);
        console.log('Ad block filters loaded successfully');
      } else {
        console.log('No filter list found, using basic blocking');
        // Temel filtreleri kullan
        this.parseFilters([
          '||doubleclick.net^',
          '||googlesyndication.com^',
          '||googleadservices.com^',
          '||google-analytics.com^'
        ]);
      }
    } catch (err) {
      console.error('Error loading filters:', err);
    }
  }

  // İstatistikleri kaydet
  saveStats() {
    try {
      const dataDir = path.dirname(this.statsPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(this.statsPath, JSON.stringify(this.stats, null, 2));
    } catch (err) {
      console.error('Error saving stats:', err);
    }
  }

  // İstatistikleri yükle
  loadStats() {
    try {
      if (fs.existsSync(this.statsPath)) {
        const data = fs.readFileSync(this.statsPath, 'utf8');
        this.stats = JSON.parse(data);
      }
    } catch (err) {
      console.error('Error loading stats:', err);
    }
  }

  // İstatistikleri al
  getStats() {
    return { ...this.stats };
  }

  // İstatistikleri sıfırla
  resetStats() {
    this.stats = {
      blocked: 0,
      allowed: 0
    };
    this.saveStats();
  }

  // Reklam engelleyiciyi aç/kapat
  toggle(enabled) {
    this.isEnabled = enabled;
    return this.isEnabled;
  }

  // Özel filtre ekle
  addCustomFilter(filter) {
    const pattern = this.convertToRegex(filter);
    this.filters.block.push(pattern);

    // Dosyaya kaydet
    try {
      const currentFilters = fs.existsSync(this.filterListPath)
        ? fs.readFileSync(this.filterListPath, 'utf8').split('\n')
        : [];
      currentFilters.push(filter);
      fs.writeFileSync(this.filterListPath, currentFilters.join('\n'), 'utf8');
    } catch (err) {
      console.error('Error adding custom filter:', err);
    }
  }

  // Whitelist'e domain ekle
  addToWhitelist(domain) {
    const filter = `@@||${domain}^`;
    const pattern = this.convertToRegex(filter.substring(2));
    this.filters.allow.push(pattern);

    try {
      const whitelistPath = path.join(path.dirname(this.filterListPath), 'whitelist.txt');
      const whitelist = fs.existsSync(whitelistPath)
        ? fs.readFileSync(whitelistPath, 'utf8').split('\n')
        : [];
      whitelist.push(domain);
      fs.writeFileSync(whitelistPath, whitelist.join('\n'), 'utf8');
    } catch (err) {
      console.error('Error adding to whitelist:', err);
    }
  }
}

module.exports = AdBlocker;