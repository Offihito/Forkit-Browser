// Forkit Browser — Ad Blocker Content Script
// Safe approach: CSS cosmetic filtering + MutationObserver + ad element cleanup
// NO prototype interception (fetch/XHR/createElement) to avoid breaking pages
(function () {
  if (window.__forkitADB) return;
  window.__forkitADB = true;

  var blockedCount = 0;

  function reportBlocked(n) {
    blockedCount += (n || 1);
    // Host page listens for these via consolemessage event
    console.log('__FORKIT_ADBLOCK__:' + blockedCount);
  }

  // ═══ 0. Site detection — avoid false positives on known sites ═══
  var hostname = '';
  try { hostname = window.location.hostname.toLowerCase(); } catch (e) { }
  var isYouTube = hostname.indexOf('youtube.com') !== -1 || hostname.indexOf('youtu.be') !== -1;
  var isGoogle = hostname.indexOf('google.') !== -1;

  // ═══ 1. CSS — hide known ad selectors IMMEDIATELY ═══
  // Use precise selectors to avoid corrupting legitimate page elements.
  // Avoid broad substring selectors like [class*="ad-"] which match words
  // like "upload", "thread", "loading", etc.
  var CSS = '' +
    // Google Adsense
    'ins.adsbygoogle,' +
    '[id^="google_ads_iframe"],' +
    '[data-ad-slot],[data-ad-client],[data-adunit],' +
    // Ad iframes (match by domain in src)
    'iframe[src*="doubleclick.net"],' +
    'iframe[src*="googlesyndication.com"],' +
    'iframe[src*="googleadservices.com"],' +
    'iframe[src*="adnxs.com"],' +
    'iframe[src*="amazon-adsystem.com"],' +
    'iframe[src*="taboola.com"],' +
    'iframe[src*="outbrain.com"],' +
    'iframe[src*="criteo.com"],' +
    'iframe[src*="plakout.com"],' +
    'iframe[src*="mgid.com"],' +
    'iframe[src*="adskeeper.com"],' +
    'iframe[src*="adform.net"],' +
    'iframe[src*="reklamstore.com"],' +
    'iframe[src*="media.net"],' +
    'iframe[src*="popads.net"],' +
    'iframe[src*="propellerads.com"],' +
    'iframe[src*="exoclick.com"],' +
    'iframe[src*="smartadserver.com"],' +
    'iframe[src*="imasdk.googleapis.com"],' +
    'iframe[src*="admatic.com.tr"],' +
    'iframe[src*="emedya.com.tr"],' +
    'iframe[src*="pubmatic.com"],' +
    'iframe[src*="openx.net"],' +
    'iframe[src*="rubiconproject.com"],' +
    'iframe[src*="adsrvr.org"],' +
    'iframe[src*="bidswitch.net"],' +
    'iframe[src*="mediavine.com"],' +
    'iframe[src*="carbonads.net"],' +
    'iframe[src*="buysellads.com"],' +
    'iframe[src*="revive-adserver"],' +
    'iframe[src*="serving-sys.com"],' +
    'iframe[src*="sizmek.com"],' +
    'iframe[src*="admaven.com"],' +
    'iframe[src*="revcontent.com"],' +
    'iframe[src*="yieldmo.com"],' +
    'iframe[src*="33across.com"],' +
    'iframe[src*="sharethrough.com"],' +
    'iframe[src*="undertone.com"],' +
    'iframe[src*="adcolony.com"],' +
    'iframe[src*="inmobi.com"],' +
    'iframe[src*="mopub.com"],' +
    // Exact class matches for ad containers (not substring!)
    '.ad-banner,.ad-wrapper,.ad-unit,.ad-frame,' +
    '.ad-overlay,.ad-popup,.ad-modal,.ad-sticky,' +
    '.adBox,.adBlock,.adContent,.ad_box,' +
    '.ad-container,.ad-slot,.ad-placement,' +
    '.ad-leaderboard,.ad-skyscraper,.ad-rectangle,' +
    '.ad-top,.ad-bottom,.ad-left,.ad-right,' +
    '.ad-inline,.ad-interstitial,.ad-native,' +
    '.ad-skin,.ad-floating,.ad-fixed,' +
    // Exact ID matches for ad positions
    '#ad-header,#ad-footer,#ad-sidebar,#ad-overlay,' +
    '#masthead-ad,#ad-top,#ad-bottom,' +
    '#ad-leaderboard,#ad-banner,#ad-wrapper,' +
    '#sidebar-ad,#content-ad,#footer-ad,' +
    // 3rd party ad widgets (exact class/id)
    '.taboola,.taboola-widget,#taboola-below-article,' +
    '[id^="taboola-"],' +
    '.OUTBRAIN,.outbrain-widget,#outbrain_widget,' +
    '[id^="outbrain"],' +
    '.mgid-widget,[id^="mgid"],' +
    '.adskeeper-widget,[id^="adskeeper"],' +
    '.carbonads,#carbonads,.carbon-ads,' +
    // RevContent, Revcontent
    '.rc-widget,.revcontent,' +
    // Native ad containers
    '.native-ad,.sponsored-content,.promoted-content,' +
    '.paid-content,.advertorial,' +
    // Ad-specific renderer elements (YouTube)
    'ytd-display-ad-renderer,' +
    'ytd-promoted-sparkles-web-renderer,' +
    'ytd-in-feed-ad-layout-renderer,' +
    'ytd-ad-slot-renderer,' +
    'yt-mealbar-promo-renderer,' +
    'ytd-statement-banner-renderer,' +
    'ytd-video-masthead-ad-v3-renderer,' +
    // Interstitials (exact class)
    '.interstitial-ad,.interstitial-wrapper,' +
    // Push notification popups
    '.onesignal-slidedown-container,' +
    '[id^="onesignal"],' +
    // Turkish ad networks (exact class/id)
    '.reklam-alani,.reklam-banner,[id^="reklam-"],' +
    '.reklam,[id*="reklam"],' +
    '.admatic-widget,[id^="admatic"],' +
    // Common ad wrapper patterns
    '[id^="div-gpt-ad"],' +
    '[id^="ad_"],' +
    '[class^="ad_"],' +
    '.dfp-ad,.gpt-ad,' +
    // AdSense link units
    '.adsbygoogle[data-ad-format="link"],' +
    // Sticky/floating ads
    '.sticky-ad,.floating-ad,.adhesion-ad,' +
    // Video pre-roll ad wrappers
    '.ima-ad-container,.videoAdUi,' +
    // Consent/cookie walls often wrapping ads
    '.ad-wall,.adwall';


  var HIDE_STYLE = '{display:none!important;visibility:hidden!important;' +
    'height:0!important;min-height:0!important;max-height:0!important;' +
    'width:0!important;overflow:hidden!important;opacity:0!important;' +
    'pointer-events:none!important;position:absolute!important;z-index:-1!important}';

  function injectCSS() {
    if (document.getElementById('__fk_adb')) return;
    var s = document.createElement('style');
    s.id = '__fk_adb';
    s.textContent = CSS + HIDE_STYLE;
    (document.head || document.documentElement).appendChild(s);
  }
  injectCSS();
  document.addEventListener('DOMContentLoaded', injectCSS);

  // ═══ 2. Ad domain check (for iframe src, link href, window.open) ═══
  var AD_DOMAINS = [
    // ── Google ad ecosystem ──
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
    'adservice.google.com', 'pagead2.googlesyndication.com',
    'tpc.googlesyndication.com', 'ad.doubleclick.net',
    'static.doubleclick.net', 'ads.google.com',
    'imasdk.googleapis.com', 'fundingchoicesmessages.google.com',
    'ade.googlesyndication.com', 'adclick.g.doubleclick.net',
    // ── Major ad exchanges / SSPs / DSPs ──
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
    // ── Tracking / analytics / pixels ──
    'scorecardresearch.com', 'addthis.com', 'sharethis.com',
    'quantserve.com', 'quantcast.com',
    'bluekai.com', 'exelator.com',
    'demdex.net', 'krxd.net', 'rlcdn.com',
    'serving-sys.com', 'sizmek.com',
    'eyeota.net', 'tapad.com', 'lotame.com',
    'adsymptotic.com', 'rfihub.com',
    'intentiq.com', 'id5-sync.com',
    'liveramp.com', 'adsensor.com',
    // ── Pop-under / aggressive ad networks ──
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
    'pushame.com', 'notifyadme.com',
    'pushengage.com', 'pushwoosh.com',
    'subscribers.com', 'pushcrew.com',
    // ── Mobile ad networks ──
    'adcolony.com', 'inmobi.com', 'mopub.com',
    'applovin.com', 'unity3d.com/ads', 'unityads.unity3d.com',
    'vungle.com', 'chartboost.com', 'ironsrc.com',
    'fyber.com', 'tapjoy.com',
    // ── Video ad networks ──
    'springserve.com', 'videologygroup.com',
    'innovid.com', 'extreme-reach.com',
    'videoheroes.tv', 'cedato.com',
    // ── Turkish ad networks ──
    'plakout.com', 'emedya.com.tr', 'admatic.com.tr',
    'adskeeper.com', 'adskeeper.co.uk', 'mgid.com',
    'reklamstore.com', 'reklamaction.com', 'atemda.com',
    'reklamup.com', 'medyanet.net', 'medyanetads.com',
    'addays.com', 'admingle.com', 'mobilike.com',
    'livad.com', 'setupad.com', 'optad360.com',
    'denakop.com', 'unibots.in',
    // ── Carbon / BuySellAds ──
    'carbonads.net', 'carbonads.com', 'buysellads.com',
    'bsa.network', 'cdn.carbonads.com',
    // ── Social media trackers ──
    'ads-twitter.com', 'analytics.twitter.com',
    'facebook.com/tr', 'facebook.net/signals',
    'connect.facebook.net/signals',
    'tiktokads.com', 'analytics.tiktok.com',
    // ── Misc ad/tracking ──
    'cm.smartadserver.com', 'tds.gumgum.com',
    'ads.yahoo.com', 'advertising.com',
    'contextweb.com', 'yldbt.com',
    'mathtag.com', 'mxptint.net',
    'bounceexchange.com', 'bouncex.net',
    'revjet.com', 'narrative.io',
    'liadm.com', 'ib-ibi.com',
    'zemanta.com', 'adroll.com', 'retargetly.com',
    'steelhouse.com', 'nextroll.com',
    'yandexadexchange.net', 'adfox.ru',
    'begun.ru', 'adblogin.com',
    'ad4mat.com', 'ad4mat.de',
    'adhese.com', 'adkernel.com',
    'adloox.com', 'admixer.net',
    'adnami.io', 'adnium.com',
    'adsafeprotected.com', 'adthrive.com',
    'adventori.com', 'anura.io',
    'betweendigital.com', 'brightcom.com',
    'clickio.com', 'conversantmedia.com',
    'emxdgt.com', 'engagebdr.com',
    'genieesspv.jp', 'justpremium.com',
    'kargo.com', 'marfeel.com',
    'mgid.org', 'mintegral.com',
    'mobfox.com', 'my6sense.com',
    'onaudience.com', 'opera-api.com',
    'permutive.com', 'playground.xyz',
    'seedtag.com', 'smartclip.net',
    'smaato.net', 'startapp.com',
    'stickyadstv.com', 'verizonmedia.com',
    'vidoomy.com', 'weborama.com',
    'yieldlab.net', 'yieldlove.com'
  ];

  function isAdDomain(url) {
    if (!url) return false;
    var lower = url.toLowerCase();
    for (var i = 0; i < AD_DOMAINS.length; i++) {
      if (lower.indexOf(AD_DOMAINS[i]) !== -1) return true;
    }
    return false;
  }

  // ═══ 3. Element hiding logic (CSS-only, no DOM removal) ═══
  // Using CSS hiding instead of .remove() to prevent layout corruption.
  // Removed elements can break page structure; hidden elements are invisible
  // but don't break layout dependencies.
  function hideElement(el) {
    try {
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('height', '0', 'important');
      el.style.setProperty('min-height', '0', 'important');
      el.style.setProperty('max-height', '0', 'important');
      el.style.setProperty('overflow', 'hidden', 'important');
      el.style.setProperty('opacity', '0', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
    } catch (e) { }
  }

  // Only remove ad iframes (safe — they're isolated by domain)
  function removeAdIframe(el) {
    try { el.remove(); } catch (e) { }
  }

  function isAdElement(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      var tag = (el.tagName || '').toLowerCase();

      // Check iframes with ad sources
      if (tag === 'iframe') {
        var src = (el.src || el.getAttribute('src') || '');
        if (src && isAdDomain(src)) return true;
      }

      // Check class/id — use exact word boundary matching
      var cls = (typeof el.className === 'string') ? el.className : '';
      var id = (el.id || '');

      // Exact class patterns (case-insensitive word match)
      var exactPatterns = ['adsbygoogle', 'taboola', 'outbrain', 'mgid',
        'adskeeper', 'plakout', 'carbonads', 'revcontent',
        'admatic', 'reklam', 'native-ad', 'sponsored',
        'promoted-content', 'paid-content', 'advertorial',
        'dfp-ad', 'gpt-ad', 'div-gpt-ad'];

      for (var i = 0; i < exactPatterns.length; i++) {
        var p = exactPatterns[i];
        if (cls.toLowerCase().indexOf(p) !== -1 || id.toLowerCase().indexOf(p) !== -1) return true;
      }

      // Data attributes (these are always ad-specific)
      if (el.hasAttribute('data-ad-slot') ||
        el.hasAttribute('data-ad-client') || el.hasAttribute('data-adunit')) return true;

      // ins.adsbygoogle
      if (tag === 'ins' && cls.toLowerCase().indexOf('adsbygoogle') !== -1) return true;

    } catch (e) { }
    return false;
  }

  // ═══ 4. Overlay/interstitial ad detection ═══
  // Targets first-party overlay ads that network blocking can't catch
  // (ads served from the page's own domain, embedded in HTML).
  var _checkedOverlays = new WeakSet();

  function isOverlayAd(el) {
    try {
      if (!el || el.nodeType !== 1) return false;
      if (_checkedOverlays.has(el)) return false;

      // Skip YouTube
      if (isYouTube) return false;

      var tag = (el.tagName || '').toLowerCase();
      if (tag === 'header' || tag === 'nav' || tag === 'footer' || tag === 'video') return false;

      // Skip cookie/consent/GDPR elements
      var elId = (el.id || '').toLowerCase();
      var elCls = (typeof el.className === 'string') ? el.className.toLowerCase() : '';
      if (elId.indexOf('cookie') !== -1 || elId.indexOf('consent') !== -1 ||
        elId.indexOf('gdpr') !== -1 || elCls.indexOf('cookie') !== -1 ||
        elCls.indexOf('consent') !== -1 || elCls.indexOf('gdpr') !== -1) return false;

      var style = window.getComputedStyle(el);
      if (!style) return false;

      var pos = style.position;
      if (pos !== 'fixed' && pos !== 'absolute') return false;
      if (style.display === 'none' || style.visibility === 'hidden') return false;

      var zIndex = parseInt(style.zIndex) || 0;
      if (zIndex < 50) return false; // Only high z-index overlays

      var w = el.offsetWidth || 0;
      var h = el.offsetHeight || 0;
      if (w < 250 || h < 200) return false; // Must be large

      // Check for ad iframes inside
      var iframes = el.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        if (isAdDomain(iframes[i].src)) return true;
      }

      // Check for ad-domain links inside
      var links = el.querySelectorAll('a[href]');
      var adLinkCount = 0;
      for (var k = 0; k < links.length; k++) {
        if (isAdDomain(links[k].href)) adLinkCount++;
      }
      if (adLinkCount > 0) return true;

      // Check for known ad element inside
      if (isAdElement(el)) return true;

      // Check for close button + large image (classic overlay ad pattern)
      var hasCloseBtn = false;
      var closeCandidates = el.querySelectorAll('button, span, div, a, i');
      for (var b = 0; b < closeCandidates.length; b++) {
        var cand = closeCandidates[b];
        var btnText = (cand.textContent || '').trim();
        var btnW = cand.offsetWidth || 0;
        var btnH = cand.offsetHeight || 0;
        if (btnW > 0 && btnW <= 50 && btnH > 0 && btnH <= 50) {
          if (btnText === '×' || btnText === '✕' || btnText === 'X' || btnText === 'x' ||
            btnText === '✖' || btnText === '✗' || btnText === 'Close' || btnText === 'CLOSE' ||
            btnText === 'Kapat' || btnText === 'KAPAT') {
            hasCloseBtn = true;
            break;
          }
        }
      }
      // Also check for close selectors
      if (!hasCloseBtn) {
        try {
          if (el.querySelector('[class*="close"], [id*="close"], [class*="kapat"], [onclick*="close"], [onclick*="hide"]')) {
            hasCloseBtn = true;
          }
        } catch (e) { }
      }

      if (hasCloseBtn) {
        // Has close button + large image = very likely ad overlay
        var imgs = el.querySelectorAll('img');
        for (var im = 0; im < imgs.length; im++) {
          var imgW = imgs[im].offsetWidth || 0;
          var imgH = imgs[im].offsetHeight || 0;
          if (imgW > 200 && imgH > 150) return true; // Large promotional image
        }
        // Has close button + external links = likely ad
        var extLinks = 0;
        for (var el2 = 0; el2 < links.length; el2++) {
          try {
            var lh = new URL(links[el2].href).hostname;
            if (lh && lh !== window.location.hostname) extLinks++;
          } catch (e) { }
        }
        if (extLinks > 0) return true;
      }

    } catch (e) { }
    return false;
  }

  function scanOverlays() {
    if (isYouTube) return;
    var removed = 0;

    try {
      if (!document.body) return;

      // Scan ALL elements in the DOM, not just body children
      var allEls = document.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        if (el.nodeType !== 1 || _checkedOverlays.has(el)) continue;

        // Quick pre-filter: skip if not positioned
        var style;
        try { style = window.getComputedStyle(el); } catch (e) { continue; }
        if (!style) continue;
        var pos = style.position;
        if (pos !== 'fixed' && pos !== 'absolute') continue;

        var zIndex = parseInt(style.zIndex) || 0;
        if (zIndex < 50) continue;

        if (isOverlayAd(el)) {
          hideElement(el);
          _checkedOverlays.add(el);
          removed++;

          // Walk up to parent and hide sibling backdrops
          var parent = el.parentElement;
          if (parent) {
            var siblings = parent.children;
            for (var si = 0; si < siblings.length; si++) {
              var sib = siblings[si];
              if (sib === el || sib.nodeType !== 1 || _checkedOverlays.has(sib)) continue;
              var sibStyle;
              try { sibStyle = window.getComputedStyle(sib); } catch (e) { continue; }
              if (!sibStyle || sibStyle.display === 'none') continue;
              var sibPos = sibStyle.position;
              if (sibPos !== 'fixed' && sibPos !== 'absolute') continue;
              var sibW = sib.offsetWidth || 0;
              var sibH = sib.offsetHeight || 0;
              if (sibW >= window.innerWidth * 0.7 && sibH >= window.innerHeight * 0.7) {
                var sibBg = sibStyle.backgroundColor || '';
                var sibOp = parseFloat(sibStyle.opacity);
                if (sibBg.indexOf('rgba') !== -1 || (sibOp > 0 && sibOp < 0.95)) {
                  hideElement(sib);
                  _checkedOverlays.add(sib);
                  removed++;
                }
              }
            }
          }
        }
      }

      // Also specifically scan for common overlay ad wrapper patterns
      var overlaySelectors = [
        'div[style*="position: fixed"][style*="z-index"]',
        'div[style*="position:fixed"][style*="z-index"]',
        'div[class*="overlay"][style*="position"]',
        'div[class*="modal"][style*="position"]',
        'div[class*="popup"][style*="position"]',
        'div[class*="interstitial"]',
        'div[id*="overlay"][style*="position"]',
        'div[id*="modal"][style*="position"]',
        'div[id*="popup"][style*="position"]'
      ];

      for (var s = 0; s < overlaySelectors.length; s++) {
        try {
          var matches = document.querySelectorAll(overlaySelectors[s]);
          for (var m = 0; m < matches.length; m++) {
            var mel = matches[m];
            if (_checkedOverlays.has(mel)) continue;
            if (isOverlayAd(mel)) {
              hideElement(mel);
              _checkedOverlays.add(mel);
              removed++;
            }
          }
        } catch (e) { }
      }
    } catch (e) { }

    if (removed > 0) {
      reportBlocked(removed);
      try {
        var bodyStyle = window.getComputedStyle(document.body);
        if (bodyStyle && (bodyStyle.overflow === 'hidden' || bodyStyle.overflowY === 'hidden')) {
          document.body.style.setProperty('overflow', 'auto', 'important');
          document.documentElement.style.setProperty('overflow', 'auto', 'important');
        }
      } catch (e) { }
    }
  }



  function cleanup() {
    if (isYouTube) return;

    var removed = 0;

    // Remove ad iframes (safe: identifiable by domain)
    try {
      var allIframes = document.querySelectorAll('iframe');
      for (var fi = 0; fi < allIframes.length; fi++) {
        if (isAdDomain(allIframes[fi].src)) {
          removeAdIframe(allIframes[fi]);
          removed++;
        }
      }
    } catch (e) { }

    // Hide known ad elements by selector (CSS hide, not remove)
    try {
      var adEls = document.querySelectorAll(
        'ins.adsbygoogle, [id^="google_ads_iframe"], ' +
        '[data-ad-client], [data-adunit], [data-ad-slot], ' +
        '.taboola, [id^="taboola"], [id^="taboola-"], ' +
        '.OUTBRAIN, [id^="outbrain"], ' +
        '[class*="mgid"], [id^="mgid"], ' +
        '.adskeeper-widget, [class*="plakout"], ' +
        '.carbonads, #carbonads, ' +
        '.revcontent, [id^="rc-widget"], ' +
        '[id^="div-gpt-ad"], ' +
        '.admatic-widget, [id^="admatic"], ' +
        '[id*="reklam"], .reklam, ' +
        '.native-ad, .sponsored-content, .promoted-content, ' +
        '.dfp-ad, .gpt-ad, ' +
        '.ad-placement, .ad-container, .ad-wrapper, ' +
        '.sticky-ad, .floating-ad, .adhesion-ad, ' +
        '[data-ad-manager], [data-google-query-id]'
      );
      for (var ai = 0; ai < adEls.length; ai++) {
        hideElement(adEls[ai]);
        removed++;
      }
    } catch (e) { }

    // Also hide elements identified by isAdElement
    try {
      var allDivs = document.querySelectorAll('div, aside, section');
      for (var di = 0; di < allDivs.length; di++) {
        if (isAdElement(allDivs[di])) {
          hideElement(allDivs[di]);
          removed++;
        }
      }
    } catch (e) { }

    if (removed > 0) reportBlocked(removed);
  }

  // ═══ 5. MutationObserver — catch dynamically added ads ═══
  function startObserver() {
    if (!document.body) return;
    var observer = new MutationObserver(function (mutations) {
      var needsCleanup = false;
      for (var i = 0; i < mutations.length; i++) {
        var nodes = mutations[i].addedNodes;
        if (!nodes) continue;
        for (var j = 0; j < nodes.length; j++) {
          var node = nodes[j];
          if (node.nodeType !== 1) continue;

          // Check the node itself for known ad patterns
          if (isAdElement(node)) {
            hideElement(node);
            reportBlocked(1);
            continue;
          }

          // Any new div/section/aside could contain ads — schedule cleanup
          if (node.tagName === 'DIV' || node.tagName === 'ASIDE' ||
            node.tagName === 'SECTION' || node.tagName === 'ARTICLE') {
            needsCleanup = true;
          }

          // Check iframe children
          if (node.querySelectorAll) {
            try {
              var childIframes = node.querySelectorAll('iframe');
              for (var ci = 0; ci < childIframes.length; ci++) {
                if (isAdDomain(childIframes[ci].src)) {
                  removeAdIframe(childIframes[ci]);
                  reportBlocked(1);
                }
              }
            } catch (e) { }
          }
        }
      }
      if (needsCleanup) {
        setTimeout(cleanup, 150);
        setTimeout(scanOverlays, 300);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver);

  // ═══ 6. Scheduled sweeps ═══
  function runScheduledCleanup() {
    cleanup();
    setTimeout(function () { cleanup(); scanOverlays(); }, 300);
    setTimeout(function () { cleanup(); scanOverlays(); }, 800);
    setTimeout(function () { cleanup(); scanOverlays(); }, 1500);
    setTimeout(function () { cleanup(); scanOverlays(); }, 3000);
    setTimeout(function () { cleanup(); scanOverlays(); }, 5000);

    // Ongoing: ad cleanup every 8s, overlay scan every 5s
    setInterval(cleanup, 8000);
    setInterval(scanOverlays, 5000);
  }

  if (document.readyState !== 'loading') {
    runScheduledCleanup();
  } else {
    document.addEventListener('DOMContentLoaded', runScheduledCleanup);
  }

  console.log('__FORKIT_ADBLOCK__:0');
  console.log('[Forkit AdBlock] Content script active on', hostname);
})();
