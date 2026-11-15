use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AdBlockStats {
    pub blocked: u64,
    pub allowed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdBlockStatus {
    pub enabled: bool,
    pub stats: AdBlockStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterUpdateResult {
    pub total: usize,
    pub block: usize,
    pub allow: usize,
    pub cosmetic: usize,
}

pub struct AdBlockerState {
    pub inner: Mutex<AdBlocker>,
}

pub struct AdBlocker {
    pub is_enabled: bool,
    pub stats: AdBlockStats,
    pub block_patterns: Vec<String>,
    pub allow_patterns: Vec<String>,
    pub cosmetic_count: usize,
    pub data_dir: PathBuf,
    unsaved_blocks: u64,
}

const YOUTUBE_AD_PATTERNS: &[&str] = &[
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "googleads.g.doubleclick.net",
    "static.doubleclick.net",
    "advertising.youtube.com",
    "ads.google.com",
    "ad.youtube.com",
    "adservice.google.com",
    "r.googleyoutube.com",
    "tracking.google.com",
    "cm.smartadserver.com",
    "tds.gumgum.com",
    "youtube.com/pagead/",
    "google.com/pagead/",
    "youtube.com/api/stats/ads",
    "youtube.com/api/stats/atr",
    "youtube.com/get_midroll_",
    "youtube.com/youtubei/v1/log_event",
    "youtube.com/csi_204",
    "youtubei/v1/player/ad_unit",
    "youtube.com/youtubei/v1/browse?includeadData",
    "/adtag/",
    "/ad_tag/",
    "googleplacementinterstitial",
];

const YOUTUBE_WHITELIST: &[&str] = &[
    "youtube.com/api/timedtext",
    "youtube.com/youtubei/v1/player",
    "youtube.com/s/player/",
    "youtube.com/iframe_api",
    "ytimg.com",
    "ggpht.com",
    "gstatic.com/youtube",
    "youtube.com/youtubei/v1/browse",
    "youtube.com/youtubei/v1/search",
    "youtube.com/youtubei/v1/get_video_details",
    "googlevideo.com/videoplayback",
];

const DEFAULT_AD_DOMAINS: &[&str] = &[
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "google-analytics.com",
    "googletagmanager.com",
    "facebook.com/tr",
    "facebook.net",
    "scorecardresearch.com",
    "adnxs.com",
    "advertising.com",
    "criteo.com",
    "outbrain.com",
    "taboola.com",
    "ads-twitter.com",
    "analytics.twitter.com",
    "ads.yahoo.com",
    "bat.bing.com",
];

impl Drop for AdBlocker {
    fn drop(&mut self) {
        if self.unsaved_blocks > 0 {
            self.save_stats();
        }
    }
}

impl AdBlocker {
    pub fn new(data_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&data_dir);
        let mut blocker = Self {
            is_enabled: true,
            stats: AdBlockStats::default(),
            block_patterns: Vec::new(),
            allow_patterns: Vec::new(),
            cosmetic_count: 0,
            data_dir,
            unsaved_blocks: 0,
        };
        blocker.load_stats();
        blocker.load_filters();
        blocker
    }

    fn record_block_hit(&mut self) {
        self.stats.blocked += 1;
        self.unsaved_blocks += 1;
        if self.unsaved_blocks >= 25 {
            self.unsaved_blocks = 0;
            self.save_stats();
        }
    }

    fn filter_list_path(&self) -> PathBuf {
        self.data_dir.join("adblock-filters.txt")
    }

    fn stats_path(&self) -> PathBuf {
        self.data_dir.join("adblock-stats.json")
    }

    fn whitelist_path(&self) -> PathBuf {
        self.data_dir.join("whitelist.txt")
    }

    fn load_stats(&mut self) {
        if let Ok(content) = fs::read_to_string(self.stats_path()) {
            if let Ok(stats) = serde_json::from_str::<AdBlockStats>(&content) {
                self.stats = stats;
            }
        }
    }

    pub fn save_stats(&self) {
        if let Ok(json) = serde_json::to_string_pretty(&self.stats) {
            let _ = fs::write(self.stats_path(), json);
        }
    }

    fn load_filters(&mut self) {
        if let Ok(content) = fs::read_to_string(self.filter_list_path()) {
            let lines: Vec<String> = content.lines().map(|l| l.trim().to_string()).collect();
            self.parse_filters(&lines);
        }
        if let Ok(wl) = fs::read_to_string(self.whitelist_path()) {
            for domain in wl.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
                self.allow_patterns.push(domain.to_lowercase());
            }
        }
    }

    pub fn parse_filters(&mut self, lines: &[String]) {
        self.block_patterns.clear();
        self.allow_patterns.clear();
        self.cosmetic_count = 0;

        for line in lines {
            let line = line.trim();
            if line.is_empty() || line.starts_with('!') || line.starts_with('[') {
                continue;
            }
            if line.contains("##") || line.contains("#@#") {
                self.cosmetic_count += 1;
                continue;
            }
            if let Some(rest) = line.strip_prefix("@@") {
                let cleaned = Self::simplify_filter(rest);
                if !cleaned.is_empty() {
                    self.allow_patterns.push(cleaned);
                }
            } else {
                let cleaned = Self::simplify_filter(line);
                if !cleaned.is_empty() {
                    self.block_patterns.push(cleaned);
                }
            }
        }
    }

    fn simplify_filter(filter: &str) -> String {
        let mut s = filter.trim();
        if let Some(idx) = s.find('$') {
            s = &s[..idx];
        }
        s = s.trim_start_matches("||").trim_start_matches('|').trim_end_matches('^').trim_end_matches('|');
        s.replace('*', "").to_lowercase()
    }

    pub fn should_block(&mut self, url: &str) -> bool {
        if !self.is_enabled {
            return false;
        }
        let lower: std::borrow::Cow<'_, str> = if url.bytes().any(|b| b.is_ascii_uppercase()) {
            std::borrow::Cow::Owned(url.to_ascii_lowercase())
        } else {
            std::borrow::Cow::Borrowed(url)
        };

        for allow in &self.allow_patterns {
            if !allow.is_empty() && lower.contains(allow) {
                self.stats.allowed += 1;
                return false;
            }
        }

        for pat in YOUTUBE_AD_PATTERNS {
            if lower.contains(pat) {
                self.record_block_hit();
                return true;
            }
        }

        for domain in YOUTUBE_WHITELIST {
            if lower.contains(domain) {
                return false;
            }
        }

        for dom in DEFAULT_AD_DOMAINS {
            if lower.contains(dom) {
                self.record_block_hit();
                return true;
            }
        }

        false
    }

    fn escape_webkit_regex(pattern: &str) -> String {
        let mut out = String::with_capacity(pattern.len() + 8);
        for ch in pattern.chars() {
            match ch {
                '.' | '?' | '+' | '*' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|'
                | '\\' => {
                    out.push('\\');
                    out.push(ch);
                }
                _ => out.push(ch),
            }
        }
        out
    }

    pub fn build_webkit_content_blocker_json(&self) -> String {
        let mut rules: Vec<serde_json::Value> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        let mut push_block = |pat: &str| {
            let trimmed = pat.trim();
            if trimmed.len() < 4 || !seen.insert(trimmed.to_string()) {
                return;
            }
            let escaped = Self::escape_webkit_regex(trimmed);
            rules.push(serde_json::json!({
                "trigger": { "url-filter": escaped },
                "action": { "type": "block" }
            }));
        };

        for pat in YOUTUBE_AD_PATTERNS {
            push_block(pat);
        }
        for dom in DEFAULT_AD_DOMAINS {
            push_block(dom);
        }
        // Include up to 5000 custom/downloaded network patterns so compilation stays fast.
        for pat in self.block_patterns.iter().take(5000) {
            push_block(pat);
        }

        for dom in YOUTUBE_WHITELIST {
            let escaped = Self::escape_webkit_regex(dom);
            rules.push(serde_json::json!({
                "trigger": { "url-filter": escaped },
                "action": { "type": "ignore-previous-rules" }
            }));
        }
        for allow in &self.allow_patterns {
            let trimmed = allow.trim();
            if trimmed.len() >= 3 {
                let escaped = Self::escape_webkit_regex(trimmed);
                rules.push(serde_json::json!({
                    "trigger": { "url-filter": escaped },
                    "action": { "type": "ignore-previous-rules" }
                }));
            }
        }

        serde_json::to_string(&rules).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn add_custom_filter(&mut self, filter: &str) {
        let cleaned = Self::simplify_filter(filter);
        if !cleaned.is_empty() {
            self.block_patterns.push(cleaned);
        }
        let mut lines = fs::read_to_string(self.filter_list_path())
            .unwrap_or_default()
            .lines()
            .map(|l| l.to_string())
            .collect::<Vec<_>>();
        lines.push(filter.to_string());
        let _ = fs::write(self.filter_list_path(), lines.join("\n"));
    }

    pub fn add_to_whitelist(&mut self, domain: &str) {
        self.allow_patterns.push(domain.to_lowercase());
        let mut lines = fs::read_to_string(self.whitelist_path())
            .unwrap_or_default()
            .lines()
            .map(|l| l.to_string())
            .collect::<Vec<_>>();
        lines.push(domain.to_string());
        let _ = fs::write(self.whitelist_path(), lines.join("\n"));
    }
}

pub fn init_adblocker(app: &AppHandle) -> AdBlockerState {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./Data"));
    AdBlockerState {
        inner: Mutex::new(AdBlocker::new(data_dir)),
    }
}

#[tauri::command]
pub fn get_adblock_stats(state: State<'_, AdBlockerState>) -> AdBlockStats {
    state.inner.lock().unwrap().stats.clone()
}

#[tauri::command]
pub fn toggle_adblock(app: AppHandle, state: State<'_, AdBlockerState>, enabled: bool) -> bool {
    let mut guard = state.inner.lock().unwrap();
    guard.is_enabled = enabled;
    if guard.unsaved_blocks > 0 {
        guard.unsaved_blocks = 0;
        guard.save_stats();
    }
    let is_en = guard.is_enabled;
    drop(guard);
    #[cfg(target_os = "linux")]
    sync_webkit_adblock_enabled(&app, is_en);
    is_en
}

#[tauri::command]
pub fn reset_adblock_stats(state: State<'_, AdBlockerState>) -> serde_json::Value {
    let mut guard = state.inner.lock().unwrap();
    guard.stats = AdBlockStats::default();
    guard.save_stats();
    serde_json::json!({ "success": true })
}

#[tauri::command]
pub fn add_custom_filter(state: State<'_, AdBlockerState>, filter: String) -> serde_json::Value {
    state.inner.lock().unwrap().add_custom_filter(&filter);
    serde_json::json!({ "success": true })
}

#[tauri::command]
pub fn add_to_whitelist(state: State<'_, AdBlockerState>, domain: String) -> serde_json::Value {
    state.inner.lock().unwrap().add_to_whitelist(&domain);
    serde_json::json!({ "success": true })
}

#[tauri::command]
pub fn get_adblock_status(state: State<'_, AdBlockerState>) -> AdBlockStatus {
    let guard = state.inner.lock().unwrap();
    AdBlockStatus {
        enabled: guard.is_enabled,
        stats: guard.stats.clone(),
    }
}

#[tauri::command]
pub fn record_ad_blocked(state: State<'_, AdBlockerState>, count: Option<u64>) {
    let mut guard = state.inner.lock().unwrap();
    if guard.is_enabled {
        guard.stats.blocked += count.unwrap_or(1);
        guard.save_stats();
    }
}

#[tauri::command]
pub async fn update_filter_lists(state: State<'_, AdBlockerState>) -> Result<FilterUpdateResult, String> {
    let urls = [
        "https://easylist.to/easylist/easylist.txt",
        "https://easylist.to/easylist/easyprivacy.txt",
        "https://filters.adtidy.org/extension/chromium/filters/2.txt",
        "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0",
    ];

    let client = reqwest::Client::new();
    let mut all_lines = Vec::new();

    for url in &urls {
        if let Ok(resp) = client.get(*url).send().await {
            if let Ok(text) = resp.text().await {
                for line in text.lines() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() && !trimmed.starts_with('!') && !trimmed.starts_with('[') {
                        all_lines.push(trimmed.to_string());
                    }
                }
            }
        }
    }

    let mut guard = state.inner.lock().unwrap();
    let path = guard.filter_list_path();
    let _ = fs::write(path, all_lines.join("\n"));
    guard.parse_filters(&all_lines);

    Ok(FilterUpdateResult {
        total: all_lines.len(),
        block: guard.block_patterns.len(),
        allow: guard.allow_patterns.len(),
        cosmetic: guard.cosmetic_count,
    })
}

pub const TAB_INIT_SCRIPT: &str = r#"
(function() {
  if (window.__forkitTabInit) return;
  window.__forkitTabInit = true;

  // Real YouTube Ad Blocker (Network + Player API + Initial Data + Cosmetic)
  if (location.hostname.includes('youtube.com') || location.hostname.includes('youtu.be')) {
    if (!window.__ytAdBlockerLoaded) {
      window.__ytAdBlockerLoaded = true;

      var AD_URL_PATTERNS = [
        'doubleclick.net',
        'googlesyndication.com',
        'googleadservices.com',
        'adservice.google.',
        '/pagead/',
        '/api/stats/ads',
        '/api/stats/atr',
        '/get_midroll_',
        '/ptracking',
        '/youtubei/v1/player/ad_unit',
        'googleplacementinterstitial'
      ];

      function isAdUrl(url) {
        if (!url || typeof url !== 'string') return false;
        var lower = url.toLowerCase();
        for (var i = 0; i < AD_URL_PATTERNS.length; i++) {
          if (lower.indexOf(AD_URL_PATTERNS[i]) !== -1) return true;
        }
        return false;
      }

      function notifyBlocked(n) {
        try {
          if (window.__TAURI__ && window.__TAURI__.core) {
            window.__TAURI__.core.invoke('record_ad_blocked', { count: n || 1 }).catch(function() {});
          }
        } catch (_) {}
      }

      var AD_KEYS = [
        'adPlacements',
        'playerAds',
        'adSlots',
        'adBreakHeartbeatParams',
        'instreamAdBreak',
        'linearAdSequenceRenderer'
      ];

      function deepStripAds(obj, depth) {
        if (!obj || typeof obj !== 'object' || (depth || 0) > 8) return obj;
        var removed = 0;
        if (Array.isArray(obj)) {
          for (var i = 0; i < obj.length; i++) {
            if (obj[i] && typeof obj[i] === 'object') {
              deepStripAds(obj[i], (depth || 0) + 1);
            }
          }
          return obj;
        }
        for (var k = 0; k < AD_KEYS.length; k++) {
          var key = AD_KEYS[k];
          if (key in obj) {
            if (Array.isArray(obj[key])) {
              removed += obj[key].length;
              obj[key] = [];
            } else {
              removed += 1;
              delete obj[key];
            }
          }
        }
        var keys = Object.keys(obj);
        for (var j = 0; j < keys.length; j++) {
          var child = obj[keys[j]];
          if (child && typeof child === 'object') {
            deepStripAds(child, (depth || 0) + 1);
          }
        }
        if (removed > 0 && !depth) notifyBlocked(removed);
        return obj;
      }

      function stripAdFields(obj) {
        return deepStripAds(obj, 0);
      }

      // 0. Hook JSON.parse for inline/cached YouTube player configs
      var origJsonParse = JSON.parse;
      JSON.parse = function(text) {
        var res = origJsonParse.apply(this, arguments);
        if (typeof text === 'string' && (
            text.indexOf('adPlacements') !== -1 ||
            text.indexOf('playerAds') !== -1 ||
            text.indexOf('adSlots') !== -1)) {
          deepStripAds(res, 0);
        }
        return res;
      };

      // 1. Trap SSR ytInitialPlayerResponse & ytInitialData before player reads them
      ['ytInitialPlayerResponse', 'ytInitialData'].forEach(function(prop) {
        var currentVal = window[prop];
        if (currentVal) stripAdFields(currentVal);
        try {
          Object.defineProperty(window, prop, {
            configurable: true,
            enumerable: true,
            get: function() { return currentVal; },
            set: function(val) {
              currentVal = stripAdFields(val);
            }
          });
        } catch (_) {}
      });

      // 2. Intercept window.fetch: block ad requests & strip ad data from /youtubei/v1/ responses
      var origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function(input, init) {
          var reqUrl = typeof input === 'string' ? input : (input && input.url ? input.url : '');
          if (isAdUrl(reqUrl)) {
            notifyBlocked(1);
            return Promise.resolve(new Response('', { status: 204, statusText: 'No Content' }));
          }
          var p = origFetch.apply(this, arguments);
          if (reqUrl.indexOf('/youtubei/v1/player') !== -1 ||
              reqUrl.indexOf('/youtubei/v1/next') !== -1 ||
              reqUrl.indexOf('/youtubei/v1/browse') !== -1) {
            return p.then(function(res) {
              try {
                var ct = res.headers.get('content-type') || '';
                if (ct.indexOf('application/json') === -1) return res;
                return res.clone().json().then(function(data) {
                  stripAdFields(data);
                  var headers = new Headers(res.headers);
                  headers.delete('content-length');
                  return new Response(JSON.stringify(data), {
                    status: res.status,
                    statusText: res.statusText,
                    headers: headers
                  });
                }).catch(function() { return res; });
              } catch (_) {
                return res;
              }
            });
          }
          return p;
        };
      }

      // 3. Intercept XMLHttpRequest: block ad URLs & strip /youtubei/v1/ JSON
      var origXhrOpen = XMLHttpRequest.prototype.open;
      var origXhrSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__forkitUrl = typeof url === 'string' ? url : '';
        this.__forkitBlocked = isAdUrl(this.__forkitUrl);
        return origXhrOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        if (this.__forkitBlocked) {
          notifyBlocked(1);
          try {
            Object.defineProperty(this, 'status', { get: function() { return 204; } });
            Object.defineProperty(this, 'readyState', { get: function() { return 4; } });
            Object.defineProperty(this, 'responseText', { get: function() { return ''; } });
          } catch (_) {}
          return;
        }
        if (this.__forkitUrl && (
            this.__forkitUrl.indexOf('/youtubei/v1/player') !== -1 ||
            this.__forkitUrl.indexOf('/youtubei/v1/next') !== -1)) {
          var xhr = this;
          this.addEventListener('readystatechange', function() {
            if (xhr.readyState === 4 && xhr.status === 200) {
              try {
                var parsed = JSON.parse(xhr.responseText);
                stripAdFields(parsed);
                var cleanText = JSON.stringify(parsed);
                Object.defineProperty(xhr, 'responseText', { get: function() { return cleanText; } });
                Object.defineProperty(xhr, 'response', {
                  get: function() {
                    return xhr.responseType === 'json' ? parsed : cleanText;
                  }
                });
              } catch (_) {}
            }
          });
        }
        return origXhrSend.apply(this, arguments);
      };

      // 4. Cosmetic CSS: hide all YouTube ad banners, feed ads, companion ads
      var injectStyle = function() {
        if (document.getElementById('forkit-yt-adblock-style')) return;
        var style = document.createElement('style');
        style.id = 'forkit-yt-adblock-style';
        style.textContent = `
          ytd-ad-slot-renderer,
          ytd-banner-promo-renderer,
          ytd-statement-banner-renderer,
          ytd-in-feed-ad-layout-renderer,
          ytd-display-ad-renderer,
          ytd-promoted-sparkles-web-renderer,
          ytd-promoted-video-renderer,
          ytd-companion-slot-renderer,
          ytd-action-companion-ad-renderer,
          ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
          #masthead-ad,
          #player-ads,
          .ytp-ad-module,
          .ytp-ad-overlay-container,
          .ytp-ad-text-overlay { display: none !important; }
        `;
        (document.head || document.documentElement).appendChild(style);
      };
      injectStyle();
      document.addEventListener('DOMContentLoaded', injectStyle);

      // 5. Fallback safety net if a server-stitched ad ever appears
      setInterval(function() {
        var adShowing = document.querySelector('.ad-showing, .ad-interrupting');
        if (adShowing) {
          var video = document.querySelector('video.html5-main-video');
          if (video) {
            video.muted = true;
            if (isFinite(video.duration) && video.duration > 0) {
              video.currentTime = video.duration;
            }
          }
          var skipBtn = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
          if (skipBtn) skipBtn.click();
        }
      }, 300);
    }
  }
})();
"#;

#[cfg(target_os = "linux")]
mod webkit_content_blocker {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::ffi::CString;
    use webkit2gtk::glib::object::ObjectExt as GlibObjectExt;
    use webkit2gtk::glib::translate::ToGlibPtr;
    use webkit2gtk::{ffi, gio, glib, WebViewExt};

    const FILTER_ID: &str = "forkit-adblock";

    struct FilterPtr(*mut ffi::WebKitUserContentFilter);

    impl Drop for FilterPtr {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { ffi::webkit_user_content_filter_unref(self.0) };
            }
        }
    }

    thread_local! {
        static COMPILED_FILTER: RefCell<Option<FilterPtr>> = const { RefCell::new(None) };
        static LIVE_UCMS: RefCell<Vec<glib::WeakRef<webkit2gtk::UserContentManager>>> = const { RefCell::new(Vec::new()) };
        static INIT_STARTED: Cell<bool> = const { Cell::new(false) };
        static ADBLOCK_ENABLED: Cell<bool> = const { Cell::new(true) };
    }

    struct CallbackData {
        store: *mut ffi::WebKitUserContentFilterStore,
        json_bytes: Option<Vec<u8>>,
        hash_path: PathBuf,
        hash_str: String,
    }

    fn fnv1a_64(data: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for &b in data {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    }

    fn apply_filter_to_all_live(filter: *mut ffi::WebKitUserContentFilter) {
        LIVE_UCMS.with(|cell| {
            let mut list = cell.borrow_mut();
            list.retain(|weak| {
                if let Some(ucm) = weak.upgrade() {
                    let ucm_ptr: *mut ffi::WebKitUserContentManager = ucm.to_glib_none().0;
                    unsafe {
                        ffi::webkit_user_content_manager_add_filter(ucm_ptr, filter);
                    }
                    true
                } else {
                    false
                }
            });
        });
    }

    fn finish_with_filter(filter: *mut ffi::WebKitUserContentFilter) {
        if filter.is_null() {
            return;
        }
        let enabled = ADBLOCK_ENABLED.with(|c| c.get());
        if enabled {
            apply_filter_to_all_live(filter);
        }
        COMPILED_FILTER.with(|cell| {
            *cell.borrow_mut() = Some(FilterPtr(filter));
        });
    }

    unsafe extern "C" fn on_save_ready(
        _source: *mut glib::gobject_ffi::GObject,
        res: *mut gio::ffi::GAsyncResult,
        user_data: glib::ffi::gpointer,
    ) {
        let data = Box::from_raw(user_data as *mut CallbackData);
        let mut err: *mut glib::ffi::GError = std::ptr::null_mut();
        let filter = ffi::webkit_user_content_filter_store_save_finish(data.store, res, &mut err);
        if !err.is_null() {
            glib::ffi::g_error_free(err);
        } else if !filter.is_null() {
            let _ = fs::write(&data.hash_path, &data.hash_str);
            finish_with_filter(filter);
        }
        glib::gobject_ffi::g_object_unref(data.store as *mut glib::gobject_ffi::GObject);
    }

    unsafe extern "C" fn on_load_ready(
        _source: *mut glib::gobject_ffi::GObject,
        res: *mut gio::ffi::GAsyncResult,
        user_data: glib::ffi::gpointer,
    ) {
        let mut data = Box::from_raw(user_data as *mut CallbackData);
        let mut err: *mut glib::ffi::GError = std::ptr::null_mut();
        let filter = ffi::webkit_user_content_filter_store_load_finish(data.store, res, &mut err);
        if !err.is_null() {
            glib::ffi::g_error_free(err);
        }
        if !filter.is_null() {
            finish_with_filter(filter);
            glib::gobject_ffi::g_object_unref(data.store as *mut glib::gobject_ffi::GObject);
            return;
        }
        // Fallback to compiling and saving JSON if cached binary filter wasn't found.
        if let Some(bytes_vec) = data.json_bytes.take() {
            let gbytes = glib::Bytes::from_owned(bytes_vec);
            let c_id = CString::new(FILTER_ID).unwrap();
            let store = data.store;
            let raw_ctx = Box::into_raw(data) as glib::ffi::gpointer;
            ffi::webkit_user_content_filter_store_save(
                store,
                c_id.as_ptr(),
                gbytes.to_glib_none().0,
                std::ptr::null_mut(),
                Some(on_save_ready),
                raw_ctx,
            );
        } else {
            glib::gobject_ffi::g_object_unref(data.store as *mut glib::gobject_ffi::GObject);
        }
    }

    pub fn init(app: &AppHandle) {
        let already = INIT_STARTED.with(|c| {
            let prev = c.get();
            c.set(true);
            prev
        });
        if already {
            return;
        }

        let Some(ad_state) = app.try_state::<AdBlockerState>() else {
            return;
        };
        let (enabled, data_dir, json) = {
            let guard = ad_state.inner.lock().unwrap();
            (
                guard.is_enabled,
                guard.data_dir.clone(),
                guard.build_webkit_content_blocker_json(),
            )
        };
        ADBLOCK_ENABLED.with(|c| c.set(enabled));

        let store_dir = data_dir.join("webkit-filters");
        let _ = fs::create_dir_all(&store_dir);
        let hash_path = store_dir.join("forkit-adblock.hash");
        let hash_str = format!("{:016x}", fnv1a_64(json.as_bytes()));
        let cached_hash = fs::read_to_string(&hash_path).unwrap_or_default();

        let Ok(c_store_dir) = CString::new(store_dir.to_string_lossy().as_bytes()) else {
            return;
        };
        let c_id = CString::new(FILTER_ID).unwrap();

        unsafe {
            let store = ffi::webkit_user_content_filter_store_new(c_store_dir.as_ptr());
            if store.is_null() {
                return;
            }
            if cached_hash.trim() == hash_str {
                let ctx = Box::new(CallbackData {
                    store,
                    json_bytes: Some(json.into_bytes()),
                    hash_path,
                    hash_str,
                });
                ffi::webkit_user_content_filter_store_load(
                    store,
                    c_id.as_ptr(),
                    std::ptr::null_mut(),
                    Some(on_load_ready),
                    Box::into_raw(ctx) as glib::ffi::gpointer,
                );
            } else {
                let gbytes = glib::Bytes::from_owned(json.into_bytes());
                let ctx = Box::new(CallbackData {
                    store,
                    json_bytes: None,
                    hash_path,
                    hash_str,
                });
                ffi::webkit_user_content_filter_store_save(
                    store,
                    c_id.as_ptr(),
                    gbytes.to_glib_none().0,
                    std::ptr::null_mut(),
                    Some(on_save_ready),
                    Box::into_raw(ctx) as glib::ffi::gpointer,
                );
            }
        }
    }

    pub fn attach_to_webview(app: &AppHandle, wk: &webkit2gtk::WebView) {
        let Some(ucm) = wk.user_content_manager() else {
            return;
        };
        LIVE_UCMS.with(|cell| {
            let mut list = cell.borrow_mut();
            list.retain(|w| w.upgrade().is_some());
            list.push(ucm.downgrade());
        });

        let enabled = ADBLOCK_ENABLED.with(|c| c.get());
        if enabled {
            COMPILED_FILTER.with(|cell| {
                if let Some(ref f) = *cell.borrow() {
                    let ucm_ptr: *mut ffi::WebKitUserContentManager = ucm.to_glib_none().0;
                    unsafe {
                        ffi::webkit_user_content_manager_add_filter(ucm_ptr, f.0);
                    }
                }
            });
        }
        init(app);
    }

    pub fn sync_enabled(app: &AppHandle, enabled: bool) {
        let _ = app.run_on_main_thread(move || {
            ADBLOCK_ENABLED.with(|c| c.set(enabled));
            let c_id = CString::new(FILTER_ID).unwrap();
            COMPILED_FILTER.with(|filter_cell| {
                let filter_opt = filter_cell.borrow();
                LIVE_UCMS.with(|ucms_cell| {
                    let mut list = ucms_cell.borrow_mut();
                    list.retain(|weak| {
                        if let Some(ucm) = weak.upgrade() {
                            let ucm_ptr: *mut ffi::WebKitUserContentManager = ucm.to_glib_none().0;
                            unsafe {
                                if enabled {
                                    if let Some(ref f) = *filter_opt {
                                        ffi::webkit_user_content_manager_add_filter(ucm_ptr, f.0);
                                    }
                                } else {
                                    ffi::webkit_user_content_manager_remove_filter_by_id(
                                        ucm_ptr,
                                        c_id.as_ptr(),
                                    );
                                }
                            }
                            true
                        } else {
                            false
                        }
                    });
                });
            });
        });
    }
}

#[cfg(target_os = "linux")]
pub fn init_webkit_content_blocker(app: &AppHandle) {
    webkit_content_blocker::init(app);
}

#[cfg(target_os = "linux")]
pub fn attach_adblock_to_webkit(app: &AppHandle, wk: &webkit2gtk::WebView) {
    webkit_content_blocker::attach_to_webview(app, wk);
}

#[cfg(target_os = "linux")]
pub fn sync_webkit_adblock_enabled(app: &AppHandle, enabled: bool) {
    webkit_content_blocker::sync_enabled(app, enabled);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_blocker() -> AdBlocker {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("forkit_adblock_test_{}", nanos));
        AdBlocker::new(dir)
    }

    #[test]
    fn blocks_youtube_and_common_ad_urls() {
        let mut blocker = temp_blocker();
        assert!(blocker.should_block("https://googleads.g.doubleclick.net/pagead/ads"));
        assert!(blocker.should_block("https://www.youtube.com/pagead/interaction/"));
        assert!(blocker.should_block("https://www.youtube.com/api/stats/ads?ns=yt"));
        assert!(blocker.should_block("https://www.youtube.com/get_midroll_info"));
        assert!(blocker.should_block("https://www.youtube.com/youtubei/v1/player/ad_unit"));
        assert!(blocker.should_block("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"));
        assert_eq!(blocker.stats.blocked, 6);
    }

    #[test]
    fn allows_youtube_core_video_and_assets() {
        let mut blocker = temp_blocker();
        assert!(!blocker.should_block("https://www.youtube.com/youtubei/v1/player"));
        assert!(!blocker.should_block("https://rr1---sn-abc.googlevideo.com/videoplayback?expire=123"));
        assert!(!blocker.should_block("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"));
        assert!(!blocker.should_block("https://www.youtube.com/api/timedtext?lang=tr"));
    }

    #[test]
    fn respects_toggle_and_whitelist() {
        let mut blocker = temp_blocker();
        blocker.add_to_whitelist("doubleclick.net");
        assert!(!blocker.should_block("https://doubleclick.net/test"));

        blocker.is_enabled = false;
        assert!(!blocker.should_block("https://www.youtube.com/pagead/ads"));
    }
}
