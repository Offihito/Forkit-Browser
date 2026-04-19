(() => {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const http = require("http");
  const https = require("https");
  const { URL, pathToFileURL, fileURLToPath } = require("url");

  function getFilesDir() {
    // Most reliable: this file lives in Files/
    try {
      if (typeof __dirname === "string") {
        const candidate = __dirname;
        if (fs.existsSync(path.join(candidate, "newtab.html"))) return candidate;
      }
    } catch (e) {
      /* ignore */
    }

    try {
      if (typeof nw !== "undefined" && nw.App && typeof nw.App.getAppPath === "function") {
        return path.join(nw.App.getAppPath(), "Files");
      }
    } catch (e) {
      /* ignore */
    }
    // Fallback: running from project root (dev mode)
    try {
      const cwdFiles = path.join(process.cwd(), "Files");
      if (fs.existsSync(cwdFiles)) return cwdFiles;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  /**
   * Resolves app Files/*.html (and other files) to a file:// URL for NW webviews.
   * Returns null if the input is remote or not an existing file under Files/.
   */
  function resolveLocalAppPageUrl(input) {
    if (!input || typeof input !== "string") return null;
    const trimmed = input.trim();
    if (/^https?:\/\//i.test(trimmed)) return null;
    if (/^file:\/\//i.test(trimmed)) return trimmed;
    const filesDir = getFilesDir();
    if (!filesDir) return null;
    const rel = trimmed.replace(/^\.\//, "").replace(/^Files[/\\]/, "");
    if (!rel || rel.includes("..")) return null;
    const candidate = path.join(filesDir, rel);
    const resolvedFiles = path.resolve(filesDir);
    const resolvedCandidate = path.resolve(candidate);
    if (!resolvedCandidate.startsWith(resolvedFiles + path.sep) && resolvedCandidate !== resolvedFiles) {
      return null;
    }
    if (!fs.existsSync(resolvedCandidate) || !fs.statSync(resolvedCandidate).isFile()) {
      return null;
    }
    return pathToFileURL(resolvedCandidate).href;
  }

  /**
   * Maps file:// URLs under Files/ to short paths (e.g. newtab.html) for the address bar and history.
   */
  function fileUrlToDisplayPath(href) {
    if (!href || typeof href !== "string") return href;
    if (!/^file:\/\//i.test(href)) return href;
    const filesDir = getFilesDir();
    if (!filesDir) return href;
    try {
      const filePath = fileURLToPath(href);
      const rel = path.relative(filesDir, filePath);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        return rel.split(path.sep).join("/");
      }
    } catch (e) {
      /* ignore */
    }
    return href;
  }

  const adBlockerPath = path.join(process.cwd(), "adBlocker.js");
  const AdBlocker = require(adBlockerPath);
  const adBlocker = new AdBlocker();

  // ── Ad Blocker: content-script loading + injection ──────────────────
  // Read the ad block content script from file
  let adBlockScriptCode = "";
  try {
    const filesDir = getFilesDir() || path.join(process.cwd(), "Files");
    const adBlockScriptPath = path.join(filesDir, "adblock-content.js");
    adBlockScriptCode = fs.readFileSync(adBlockScriptPath, "utf8");
    console.log("✅ Ad block script loaded (" + adBlockScriptCode.length + " chars)");
  } catch (err) {
    console.error("❌ Failed to load adblock-content.js:", err.message);
  }

  // ── Context Menu: script loading ──────────────────
  let contextMenuScriptCode = "";
  try {
    const filesDir = getFilesDir() || path.join(process.cwd(), "Files");
    const scriptPath = path.join(filesDir, "contextmenu-content.js");
    contextMenuScriptCode = fs.readFileSync(scriptPath, "utf8");
  } catch (err) { }

  // Track total blocked count (reported by content scripts via consolemessage)
  let totalBlocked = 0;

  /**
   * Sets up ad blocking on a <webview> element.
   * Uses addContentScripts for document_start injection (if available),
   * plus executeScript fallback with retries and verification.
   */
  function setupWebviewAdBlocking(webviewEl, tabId) {
    if (!webviewEl || webviewEl.tagName === "IFRAME") return;

    // Remember tabId for context menu events
    webviewEl.__forkitTabId = tabId;

    // --- Listen for messages from the content script to track blocked count ---
    webviewEl.addEventListener("consolemessage", (e) => {
      if (e.message && e.message.startsWith("__FORKIT_ADBLOCK__:")) {
        try {
          const count = parseInt(e.message.split(":")[1]) || 0;
          if (count > 0) {
            totalBlocked = Math.max(totalBlocked, count);
            // Update the adBlocker stats so the UI can read them
            if (adBlocker.stats) {
              adBlocker.stats.blocked = totalBlocked;
            }
          }
        } catch (err) { }
      } else if (e.message && e.message.startsWith("__FORKIT_CM__:")) {
        try {
          const jsonStr = e.message.substring("__FORKIT_CM__:".length);
          const params = JSON.parse(jsonStr);
          window.windowAPI.showContextMenu(params, webviewEl.__forkitTabId);
        } catch (err) { }
      }
    });

    // --- addContentScripts: inject at document_start via inline code ---
    // Using inline code instead of file path because file paths are resolved
    // relative to the webview's URL (remote site), not the app package.
    try {
      if (typeof webviewEl.addContentScripts === "function" && adBlockScriptCode) {
        webviewEl.addContentScripts([{
          name: "forkitAdBlock",
          matches: ["http://*/*", "https://*/*"],
          exclude_matches: ["*://*.roblox.com/*", "*://*.discord.com/*", "*://*.discordapp.com/*", "*://*.cloudflare.com/*", "*://*.rbxcdn.com/*"],
          js: { code: adBlockScriptCode },
          run_at: "document_start",
          all_frames: true
        }]);
        console.log("✅ addContentScripts registered (document_start, inline code)");
      }
    } catch (err) {
      console.warn("⚠️ addContentScripts failed:", err.message);
    }

    // --- Force inject via executeScript with verification ---
    const forceInject = () => {
      if (!adBlocker.isEnabled) return;
      if (!adBlockScriptCode) return;
      if (webviewEl.isDestroyed?.() || !webviewEl.isConnected) return;

      // Try all available injection methods
      const tryInject = (code) => {
        // Method 1: NW.js webview executeScript
        if (typeof webviewEl.executeScript === "function") {
          try {
            webviewEl.executeScript({ code }, () => {
              if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) {
                // Fallback to executeJavaScript
                if (typeof webviewEl.executeJavaScript === "function") {
                  webviewEl.executeJavaScript(code).catch(() => { });
                }
              }
            });
            return;
          } catch (e) {
            // Fall through to next method
          }
        }
        // Method 2: Electron-style executeJavaScript
        if (typeof webviewEl.executeJavaScript === "function") {
          webviewEl.executeJavaScript(code).catch(() => { });
        }
      };

      // First: check if the script is already running
      const verifyCode = `
        (function() {
          try { return !!window.__forkitADB; } catch(e) { return false; }
        })()
      `;

      const doVerifyAndInject = () => {
        if (typeof webviewEl.executeScript === "function") {
          try {
            webviewEl.executeScript({ code: verifyCode }, (results) => {
              const isInjected = Array.isArray(results) ? results[0] : results;
              if (!isInjected) {
                console.log("🔄 Content script not found, injecting...");
                tryInject(adBlockScriptCode);
              }
            });
          } catch (e) { }
        } else {
          tryInject(adBlockScriptCode);
        }

        // Also inject context menu tracker
        if (contextMenuScriptCode) {
          if (typeof webviewEl.executeScript === "function") {
            webviewEl.executeScript({ code: contextMenuScriptCode }, () => { });
          } else if (typeof webviewEl.executeJavaScript === "function") {
            webviewEl.executeJavaScript(contextMenuScriptCode).catch(() => { });
          }
        }
      };

      doVerifyAndInject();
    };

    const injectAll = () => {
      if (!webviewEl.isConnected) return;
      
      const url = webviewEl.src || "";
      
      // CRITICAL: Cloudflare Turnstile anti-tamper detects executeScript and addContentScripts
      // and forcefully aborts the browser connection (window.stop() -> ERR_ABORTED).
      // We must completely bypass injection on these sensitive auth/challenge domains.
      if (
        url.includes('roblox.com') || 
        url.includes('discord.com') || 
        url.includes('discordapp.com') || 
        url.includes('cloudflare.com')
      ) {
        return;
      }

      forceInject();

      // YouTube-specific injection
      if (url.includes("youtube.com") || url.includes("youtu.be")) {
        const ytScript = adBlocker.getYouTubeContentScript();
        if (ytScript) {
          if (typeof webviewEl.executeScript === "function") {
            try {
              webviewEl.executeScript({ code: ytScript }, () => { });
            } catch (e) { }
          } else if (typeof webviewEl.executeJavaScript === "function") {
            webviewEl.executeJavaScript(ytScript).catch(() => { });
          }
        }
      }
    };

    // Attach to ALL webview lifecycle events
    webviewEl.addEventListener("loadstop", injectAll);
    webviewEl.addEventListener("contentload", injectAll);
    webviewEl.addEventListener("loadcommit", (e) => {
      if (e.isTopLevel) injectAll();
    });

    // NW.js: Handle permission requests (download, etc.)
    webviewEl.addEventListener("permissionrequest", (e) => {
      console.log("🔐 Permission request:", e.permission);
      if (e.permission === "download") {
        e.request.allow();
      }
    });

    // Delayed retries — but only if not already injected (prevent 6× duplication)
    // This was causing 6+ MutationObservers on same element = memory leak
    if (!webviewEl.__adblockInited) {
      webviewEl.__adblockInited = true;
      setTimeout(injectAll, 300);
      setTimeout(injectAll, 800);
      setTimeout(injectAll, 1500);
    }
  }

  const nwWin = nw.Window.get();
  const clipboard = nw.Clipboard.get();

  const listeners = {
    downloadProgress: [],
    downloadComplete: [],
    downloadError: [],
    contextMenuCommand: [],
    startDownloadFromWebview: []
  };

  const emit = (eventName, data) => {
    listeners[eventName].forEach((cb) => {
      try {
        cb(data);
      } catch (err) {
        console.error(`windowAPI listener failed for ${eventName}:`, err);
      }
    });
  };

  function saveToDownloads(downloadUrl, fileName) {
    let parsedUrl;
    try {
      parsedUrl = new URL(downloadUrl);
    } catch (err) {
      emit("downloadError", { fileName, error: "Invalid URL" });
      return;
    }

    const protocol = parsedUrl.protocol === "https:" ? https : http;
    const downloadsDir = path.join(os.homedir(), "Downloads");
    const outputPath = path.join(downloadsDir, fileName || "download");

    fs.mkdirSync(downloadsDir, { recursive: true });
    const output = fs.createWriteStream(outputPath);

    protocol.get(downloadUrl, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        emit("downloadError", {
          fileName,
          error: `HTTP ${response.statusCode}`
        });
        return;
      }

      const totalSize = parseInt(response.headers["content-length"] || "0", 10);
      let downloaded = 0;

      response.on("data", (chunk) => {
        downloaded += chunk.length;
        const progress = totalSize ? Math.round((downloaded / totalSize) * 100) : 0;
        emit("downloadProgress", { fileName, progress, downloaded, totalSize });
      });

      response.pipe(output);
      output.on("finish", () => {
        output.close();
        emit("downloadComplete", { fileName, filePath: outputPath });
      });
    }).on("error", (err) => {
      emit("downloadError", { fileName, error: err.message });
      try {
        fs.unlinkSync(outputPath);
      } catch (unlinkErr) {
        // ignore cleanup errors
      }
    });
  }

  // ── Custom HTML Context Menu ───────────────────────────────────────────
  // NW.js nw.Menu popup click callbacks are unreliable on Linux/GTK.
  // This builds a styled HTML overlay instead, using standard DOM events.

  let _ctxOverlay = null; // backdrop
  let _ctxMenu = null;    // the menu div

  function _injectCtxStyles() {
    if (document.getElementById("__forkit-ctx-styles")) return;
    const style = document.createElement("style");
    style.id = "__forkit-ctx-styles";
    style.textContent = `
      .__fk-ctx-overlay {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        z-index: 99999; background: transparent;
      }
      .__fk-ctx-menu {
        position: fixed; z-index: 100000;
        min-width: 220px; max-width: 340px;
        background: var(--surface, #1e1e1e);
        border: 1px solid var(--outline, #303134);
        border-radius: 8px;
        padding: 4px 0;
        box-shadow: 0 8px 24px rgba(0,0,0,0.35);
        font-family: 'Google Sans', 'Segoe UI', system-ui, sans-serif;
        font-size: 13px;
        color: var(--on-surface, #e8eaed);
        user-select: none;
        animation: __fkCtxFade 0.12s ease;
      }
      @keyframes __fkCtxFade {
        from { opacity: 0; transform: scale(0.96); }
        to   { opacity: 1; transform: scale(1); }
      }
      .__fk-ctx-item {
        padding: 7px 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 10px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: background 0.1s;
        border-radius: 0;
      }
      .__fk-ctx-item:hover {
        background: var(--primary-container, rgba(138,180,248,0.15));
      }
      .__fk-ctx-item.disabled {
        opacity: 0.4;
        pointer-events: none;
      }
      .__fk-ctx-sep {
        height: 1px;
        margin: 4px 12px;
        background: var(--outline, #303134);
      }
    `;
    document.head.appendChild(style);
  }

  function _closeCtxMenu() {
    if (_ctxOverlay && _ctxOverlay.parentNode) _ctxOverlay.remove();
    if (_ctxMenu && _ctxMenu.parentNode) _ctxMenu.remove();
    _ctxOverlay = null;
    _ctxMenu = null;
  }

  function _addCtxItem(menu, label, action, tabId, payload, enabled) {
    const div = document.createElement("div");
    div.className = "__fk-ctx-item" + (enabled === false ? " disabled" : "");
    div.textContent = label;
    div.addEventListener("click", function (e) {
      e.stopPropagation();
      _closeCtxMenu();
      emit("contextMenuCommand", { action, tabId, ...payload });
    });
    menu.appendChild(div);
  }

  function _addCtxSep(menu) {
    const sep = document.createElement("div");
    sep.className = "__fk-ctx-sep";
    menu.appendChild(sep);
  }

  window.windowAPI = {
    resolveLocalAppPageUrl: (u) => resolveLocalAppPageUrl(u),
    fileUrlToDisplayPath: (u) => fileUrlToDisplayPath(u),
    minimize: () => nwWin.minimize(),
    maximize: () => {
      if (nwWin.isMaximized) nwWin.restore();
      else nwWin.maximize();
    },
    close: () => nwWin.close(),
    closeApp: () => nw.App.quit(),
    showDevTools: () => nwWin.showDevTools(),
    ping: () => console.log("NW bridge ready"),

    downloadItem: (url, fileName) => {
      if (typeof url === "string") saveToDownloads(url, fileName);
    },
    onDownloadProgress: (cb) => typeof cb === "function" && listeners.downloadProgress.push(cb),
    onDownloadComplete: (cb) => typeof cb === "function" && listeners.downloadComplete.push(cb),
    onDownloadError: (cb) => typeof cb === "function" && listeners.downloadError.push(cb),
    onStartDownloadFromWebview: (cb) => typeof cb === "function" && listeners.startDownloadFromWebview.push(cb),

    showContextMenu: (params, tabId) => {
      _injectCtxStyles();
      _closeCtxMenu(); // close previous

      const text = params?.selectionText || "";
      const link = params?.linkURL || "";
      const imageUrl = params?.srcURL || "";

      // Build the menu div
      const menu = document.createElement("div");
      menu.className = "__fk-ctx-menu";

      if (text) {
        _addCtxItem(menu, "Copy", "copy-selection", tabId, { text });
        _addCtxItem(menu, `Search Google for "${text.substring(0, 30)}…"`, "create-tab", tabId, {
          url: `https://www.google.com/search?q=${encodeURIComponent(text)}`
        });
        _addCtxSep(menu);
      }

      if (link) {
        _addCtxItem(menu, "Open link in new tab", "create-tab", tabId, { url: link });
        _addCtxItem(menu, "Copy link address", "copy-link", tabId, { url: link });
        _addCtxSep(menu);
      }

      if (imageUrl) {
        _addCtxItem(menu, "Open image in new tab", "create-tab", tabId, { url: imageUrl });
        _addCtxItem(menu, "Copy image address", "copy-image-link", tabId, { url: imageUrl });
        _addCtxItem(menu, "Save image as…", "download-image", tabId, {
          url: imageUrl,
          fileName: imageUrl.split("/").pop().split("?")[0] || "image.png"
        });
        _addCtxSep(menu);
      }

      if (params?.isEditable) {
        _addCtxItem(menu, "Paste", "paste", tabId, {});
        _addCtxItem(menu, "Cut", "cut", tabId, {});
        _addCtxSep(menu);
      }

      _addCtxItem(menu, "Back", "back", tabId, {}, Boolean(params?.canGoBack));
      _addCtxItem(menu, "Forward", "forward", tabId, {}, Boolean(params?.canGoForward));
      _addCtxItem(menu, "Refresh", "reload", tabId, {});
      _addCtxSep(menu);
      _addCtxItem(menu, "Save page as…", "download-page", tabId, {});
      _addCtxItem(menu, "Print…", "print", tabId, {});
      _addCtxSep(menu);
      _addCtxItem(menu, "View source", "view-source", tabId, {});
      _addCtxItem(menu, "Inspect (DevTools)", "inspect", tabId, {});

      // Transparent overlay to catch clicks outside the menu
      const overlay = document.createElement("div");
      overlay.className = "__fk-ctx-overlay";
      overlay.addEventListener("click", _closeCtxMenu);
      overlay.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        _closeCtxMenu();
      });

      document.body.appendChild(overlay);
      document.body.appendChild(menu);
      _ctxOverlay = overlay;
      _ctxMenu = menu;

      // Position: convert screen coords to window-relative
      let x = Math.round(params?.x || 0);
      let y = Math.round(params?.y || 0);
      try {
        x -= window.screenX || window.screenLeft || 0;
        y -= window.screenY || window.screenTop || 0;
      } catch (e) { /* use raw */ }

      // Clamp to viewport so menu doesn't go off-screen
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = menu.getBoundingClientRect();
      if (x + rect.width > vw) x = vw - rect.width - 4;
      if (y + rect.height > vh) y = vh - rect.height - 4;
      if (x < 0) x = 4;
      if (y < 0) y = 4;

      menu.style.left = x + "px";
      menu.style.top = y + "px";

      // Close on Escape key
      const onKey = (e) => {
        if (e.key === "Escape") { _closeCtxMenu(); document.removeEventListener("keydown", onKey); }
      };
      document.addEventListener("keydown", onKey);
    },
    onContextMenuCommand: (cb) => typeof cb === "function" && listeners.contextMenuCommand.push(cb),

    adBlock: {
      getStats: async () => adBlocker.getStats(),
      toggle: async (enabled) => adBlocker.toggle(enabled),
      updateFilterLists: async () => adBlocker.updateFilterLists(),
      addCustomFilter: async (filter) => {
        adBlocker.addCustomFilter(filter);
        return { success: true };
      },
      addToWhitelist: async (domain) => {
        adBlocker.addToWhitelist(domain);
        return { success: true };
      },
      resetStats: async () => {
        adBlocker.resetStats();
        return { success: true };
      },
      getStatus: async () => ({
        enabled: adBlocker.isEnabled,
        stats: adBlocker.getStats()
      }),
      /** Check if a URL belongs to an ad domain */
      isAdUrl: (url) => adBlocker.isEnabled && adBlocker.shouldBlock(url, 'sub_frame'),
      /** Wire up network-level blocking + YouTube injection on a <webview> */
      setupWebview: (webviewEl, tabId) => setupWebviewAdBlocking(webviewEl, tabId)
    }
  };

  listeners.contextMenuCommand.push((data) => {
    if (data.action === "copy-selection" && data.text) clipboard.set(data.text, "text");
    if (data.action === "copy-link" && data.url) clipboard.set(data.url, "text");
    if (data.action === "copy-image-link" && data.url) clipboard.set(data.url, "text");
  });
})();
