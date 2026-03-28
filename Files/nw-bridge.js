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

  // Track total blocked count (reported by content scripts via consolemessage)
  let totalBlocked = 0;

  /**
   * Sets up ad blocking on a <webview> element.
   * Uses addContentScripts for document_start injection (if available),
   * plus executeScript fallback with retries and verification.
   */
  function setupWebviewAdBlocking(webviewEl) {
    if (!webviewEl || webviewEl.tagName === "IFRAME") return;

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
            return;
          } catch (e) { }
        }
        // If verification isn't possible, just inject (the script's own guard prevents double-run)
        tryInject(adBlockScriptCode);
      };

      doVerifyAndInject();
    };

    const injectAll = () => {
      if (!webviewEl.isConnected) return;
      forceInject();

      // YouTube-specific injection
      const url = webviewEl.src || "";
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

    // Delayed retries — aggressive schedule to ensure injection succeeds
    setTimeout(injectAll, 300);
    setTimeout(injectAll, 800);
    setTimeout(injectAll, 1500);
    setTimeout(injectAll, 3000);
    setTimeout(injectAll, 5000);
    setTimeout(injectAll, 8000);
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

  function emitContext(action, tabId, payload = {}) {
    emit("contextMenuCommand", { action, tabId, ...payload });
  }

  function addMenuItem(menu, label, action, tabId, payload = {}, enabled = true) {
    menu.append(
      new nw.MenuItem({
        label,
        enabled,
        click: () => emitContext(action, tabId, payload)
      })
    );
  }

  function appendSeparator(menu) {
    menu.append(new nw.MenuItem({ type: "separator" }));
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
    ping: () => console.log("NW bridge ready"),

    downloadItem: (url, fileName) => {
      if (typeof url === "string") saveToDownloads(url, fileName);
    },
    onDownloadProgress: (cb) => typeof cb === "function" && listeners.downloadProgress.push(cb),
    onDownloadComplete: (cb) => typeof cb === "function" && listeners.downloadComplete.push(cb),
    onDownloadError: (cb) => typeof cb === "function" && listeners.downloadError.push(cb),
    onStartDownloadFromWebview: (cb) => typeof cb === "function" && listeners.startDownloadFromWebview.push(cb),

    showContextMenu: (params, tabId) => {
      const menu = new nw.Menu();
      const text = params?.selectionText || "";
      const link = params?.linkURL || "";
      const imageUrl = params?.srcURL || "";

      if (text) {
        addMenuItem(menu, "Copy", "copy-selection", tabId, { text });
        addMenuItem(menu, `Search Google for "${text.substring(0, 30)}..."`, "create-tab", tabId, {
          url: `https://www.google.com/search?q=${encodeURIComponent(text)}`
        });
        appendSeparator(menu);
      }

      if (link) {
        addMenuItem(menu, "Open link in new tab", "create-tab", tabId, { url: link });
        addMenuItem(menu, "Copy link address", "copy-link", tabId, { url: link });
        appendSeparator(menu);
      }

      if (imageUrl) {
        addMenuItem(menu, "Open image in new tab", "create-tab", tabId, { url: imageUrl });
        addMenuItem(menu, "Copy image address", "copy-image-link", tabId, { url: imageUrl });
        addMenuItem(menu, "Save image as...", "download-image", tabId, {
          url: imageUrl,
          fileName: imageUrl.split("/").pop().split("?")[0] || "image.png"
        });
        appendSeparator(menu);
      }

      if (params?.isEditable) {
        addMenuItem(menu, "Paste", "paste", tabId);
        addMenuItem(menu, "Cut", "cut", tabId);
        appendSeparator(menu);
      }

      addMenuItem(menu, "Back", "back", tabId, {}, Boolean(params?.canGoBack));
      addMenuItem(menu, "Forward", "forward", tabId, {}, Boolean(params?.canGoForward));
      addMenuItem(menu, "Refresh", "reload", tabId);
      appendSeparator(menu);
      addMenuItem(menu, "Save page as...", "download-page", tabId);
      addMenuItem(menu, "Print...", "print", tabId);
      appendSeparator(menu);
      addMenuItem(menu, "View source", "view-source", tabId);
      addMenuItem(menu, "Inspect (DevTools)", "inspect", tabId);

      menu.popup(params?.x || 0, params?.y || 0);
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
      setupWebview: (webviewEl) => setupWebviewAdBlocking(webviewEl)
    }
  };

  listeners.contextMenuCommand.push((data) => {
    if (data.action === "copy-selection" && data.text) clipboard.set(data.text, "text");
    if (data.action === "copy-link" && data.url) clipboard.set(data.url, "text");
    if (data.action === "copy-image-link" && data.url) clipboard.set(data.url, "text");
  });
})();
