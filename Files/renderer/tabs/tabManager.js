import { dom } from "../core/dom.js";
import { state } from "../core/state.js";
import { makeTabsDraggable, updateActiveTabHighlight } from "./tabDrag.js";
import { updateTabTitle } from "../ui/helpers.js";
import { updateHistoryDropdown } from "../ui/historyUI.js";
import { saveTabHistory, saveGlobalHistory } from "../history/globalHistory.js";
import { userAgent } from "../env/userAgent.js";

/**
 * Replaces an iframe-based tab with a proper <webview> so it can navigate to
 * external (http/https) URLs. Called when the user clicks a quick-link, uses
 * the newtab search bar, or types an external URL in the address bar while
 * the current tab is still showing the newtab iframe.
 */
function upgradeIframeToWebview(tab, targetUrl) {
  const api = window.windowAPI;
  const oldIframe = tab.webview;

  // Clean up old iframe listeners
  tab.__removeMessageListener?.();
  tab.__removeMessageListener = null;

  // Create a real <webview>
  const webview = document.createElement("webview");
  webview.classList.add("webview");
  webview.partition = "persist:browser";

  // Resolve URL
  const resolved = api?.resolveLocalAppPageUrl?.(targetUrl);
  webview.src = resolved ?? targetUrl;

  // Preserve active class
  if (oldIframe.classList.contains("active")) {
    webview.classList.add("active");
  }

  // Replace in DOM
  dom.webviewContainer.replaceChild(webview, oldIframe);
  tab.webview = webview;

  // Standard loadURL adapter (non-iframe)
  webview.loadURL = (nextUrl) => {
    const r = api?.resolveLocalAppPageUrl?.(nextUrl);
    webview.src = r ?? nextUrl;
  };

  webview.getURL = () => {
    const raw = webview.src || "";
    const display = api?.fileUrlToDisplayPath?.(raw);
    return display || raw;
  };

  webview.getTitle = () => webview.__lastTitle || "Untitled page";

  if (typeof webview.executeJavaScript !== "function") {
    webview.executeJavaScript = (code) =>
      new Promise((resolve, reject) => {
        if (typeof webview.executeScript === "function") {
          webview.executeScript({ code }, (result) => {
            if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(Array.isArray(result) ? result[0] : result);
          });
          return;
        }
        reject(new Error("webview.executeJavaScript is not available"));
      });
  }
  if (typeof webview.setUserAgent !== "function") {
    webview.setUserAgent = (ua) => {
      if (typeof webview.setUserAgentOverride === "function") {
        webview.setUserAgentOverride(ua);
      }
    };
  }

  // Re-attach webview event listeners (same as non-iframe path in createTab)
  const onAny = (eventNames, handler) => {
    eventNames.forEach((eventName) => webview.addEventListener(eventName, handler));
  };

  onAny(["did-start-loading", "loadstart"], () => {
    tab.isLoading = true;
    updateTabTitle(tab, "Loading...");
  });

  const handleLoadedPage = (currentUrl, title) => {
    setTimeout(() => {
      const t = title || webview.getTitle() || "Untitled page";
      if (!tab.isNavigating) {
        if (tab.historyIndex < tab.history.length - 1) {
          tab.history = tab.history.slice(0, tab.historyIndex + 1);
        }
        const lastEntry = tab.history[tab.history.length - 1];
        if (!lastEntry || lastEntry.url !== currentUrl) {
          const newEntry = {
            url: currentUrl,
            title: t,
            favicon: `https://www.google.com/s2/favicons?domain=${currentUrl}&sz=64`,
            time: new Date()
          };
          tab.history.push(newEntry);
          tab.historyIndex = tab.history.length - 1;
          const lastGlobal = state.globalHistory[state.globalHistory.length - 1];
          if (!lastGlobal || lastGlobal.url !== currentUrl || lastGlobal.tabId !== tab.tabId) {
            state.globalHistory.push({
              url: currentUrl,
              title: t,
              favicon: `https://www.google.com/s2/favicons?domain=${currentUrl}&sz=64`,
              time: new Date(),
              tabId: tab.tabId
            });
            saveGlobalHistory();
          }
        } else {
          lastEntry.title = t;
          lastEntry.time = new Date();
        }
      } else {
        if (tab.history[tab.historyIndex]) {
          tab.history[tab.historyIndex].title = t;
        }
        tab.isNavigating = false;
      }
      tab.url = currentUrl;
      if (tab === state.activeTab) {
        dom.addressInput.value = currentUrl;
        updateHistoryDropdown();
      }
      updateTabTitle(tab, t);
      // Update favicon
      const img = tab.tabElement.querySelector('.tab-favicon');
      if (img) {
        try {
          const u = new URL(currentUrl);
          if (u.protocol === "http:" || u.protocol === "https:") {
            img.src = `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
          }
        } catch { /* ignore */ }
      }
      saveTabHistory(tab);
    }, 100);
  };

  onAny(["did-finish-load", "loadstop"], () => {
    tab.isLoading = false;
    const currentUrl = webview.getURL();
    const title = webview.getTitle() || webview.__lastTitle || "Untitled page";
    handleLoadedPage(currentUrl, title);
  });

  onAny(["did-fail-load", "loadabort"], () => {
    tab.isLoading = false;
    if (tab === state.activeTab) {
      updateTabTitle(tab, "Loading Failed");
    }
  });

  webview.addEventListener("page-title-updated", (event) => {
    const title = event.title || "Untitled Page";
    webview.__lastTitle = title;
    updateTabTitle(tab, title);
    if (tab.history[tab.historyIndex]) {
      tab.history[tab.historyIndex].title = title;
      saveTabHistory(tab);
    }
  });

  webview.addEventListener("page-favicon-updated", (event) => {
    if (event.favicons && event.favicons.length > 0) {
      const img = tab.tabElement.querySelector('.tab-favicon');
      if (img) img.src = event.favicons[0];
      if (tab.history[tab.historyIndex]) {
        tab.history[tab.historyIndex].favicon = event.favicons[0];
      }
      saveTabHistory(tab);
    }
  });

  webview.addEventListener("context-menu", (e) => {
    e.preventDefault();
    window.windowAPI?.showContextMenu(e.params, tab.tabId);
  });

  onAny(["new-window", "newwindow"], (e) => {
    e.preventDefault();
    const nextUrl = e.url || e.targetUrl || "";
    if (!nextUrl) return;

    const downloadExtensions = [".pdf",".zip",".rar",".7z",".tar",".gz",".exe",".dmg",".pkg",".deb",".rpm",".mp3",".mp4",".avi",".mkv",".mov",".flv",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".iso",".apk",".ipa"];
    const isDownloadable = downloadExtensions.some((ext) => nextUrl.toLowerCase().includes(ext));
    if (isDownloadable) {
      import("../downloads/downloadManager.js").then(({ startDownload }) => {
        const fileName = nextUrl.split("/").pop().split("?")[0];
        startDownload(nextUrl, fileName);
      });
    } else {
      webview.loadURL(nextUrl);
    }
  });

  // Set user agent
  webview.setUserAgent(userAgent);

  // Wire up ad blocking (network interception + YouTube injection)
  window.windowAPI?.adBlock?.setupWebview?.(webview);

  // Update address bar
  tab.url = targetUrl;
  if (tab === state.activeTab) {
    dom.addressInput.value = targetUrl;
  }
}

export function createTab(url = "newtab.html") {
  const api = window.windowAPI;
  const resolvedLocal = api?.resolveLocalAppPageUrl?.(url);
  const isLocalNewtab = !/^https?:\/\//i.test(url) && url.includes("newtab.html");
  const useIframe = typeof window.nw !== "undefined" && isLocalNewtab;

  // For local newtab in NW, use relative path so it loads inside iframe.
  const initialSrc = useIframe
    ? (api?.fileUrlToDisplayPath?.(resolvedLocal || url) || url)
    : (resolvedLocal || url);

  // NW.js does not reliably support Electron's <webview> tag.
  // In NW mode, we switch to <iframe> so local files (newtab.html) render.
  const webview = document.createElement(useIframe ? "iframe" : "webview");
  webview.classList.add("webview");
  webview.src = initialSrc;

  if (!useIframe) {
    webview.partition = "persist:browser";
  }

  dom.webviewContainer.appendChild(webview);

  // Adapter API: keep the rest of the app using Electron-like method names.
  webview.loadURL = (nextUrl) => {
    const resolved = api?.resolveLocalAppPageUrl?.(nextUrl);
    if (useIframe) {
      // If the URL is external (http/https), the iframe can't handle it.
      // Upgrade this tab to a proper webview instead.
      if (/^https?:\/\//i.test(nextUrl) && !resolved) {
        upgradeIframeToWebview(tab, nextUrl);
        return;
      }
      // Local page — load inside iframe
      webview.src = api?.fileUrlToDisplayPath?.(resolved || nextUrl) || nextUrl;
      return;
    }
    webview.src = resolved ?? nextUrl;
  };

  webview.getURL = () => {
    const raw = webview.src || "";
    const display = api?.fileUrlToDisplayPath?.(raw);
    return display || raw;
  };

  webview.getTitle = () => {
    if (typeof webview.contentDocument !== "undefined") {
      try {
        return webview.contentDocument?.title || webview.__lastTitle || "New Tab";
      } catch {
        return webview.__lastTitle || "New Tab";
      }
    }
    return webview.__lastTitle || "New Tab";
  };

  if (useIframe) {
    webview.executeJavaScript = (code) =>
      new Promise((resolve, reject) => {
        try {
          const doc = webview.contentDocument;
          if (!doc || !doc.defaultView) return reject(new Error("No document"));
          const result = doc.defaultView.eval(code);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });

    // No-ops for features that rely on Electron webview.
    webview.setUserAgent = () => {};
    webview.reload = () => {
      try {
        webview.contentWindow?.location?.reload();
      } catch {
        webview.src = webview.src;
      }
    };
    webview.print = () => {};
    webview.paste = () => {};
    webview.cut = () => {};
    webview.isDevToolsOpened = () => false;
    webview.openDevTools = () => {};
    webview.closeDevTools = () => {};
  } else {
    // Electron-style webview APIs.
    if (typeof webview.executeJavaScript !== "function") {
      webview.executeJavaScript = (code) =>
        new Promise((resolve, reject) => {
          if (typeof webview.executeScript === "function") {
            webview.executeScript({ code }, (result) => {
              if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              resolve(Array.isArray(result) ? result[0] : result);
            });
            return;
          }
          reject(new Error("webview.executeJavaScript is not available"));
        });
    }
    if (typeof webview.setUserAgent !== "function") {
      webview.setUserAgent = (ua) => {
        if (typeof webview.setUserAgentOverride === "function") {
          webview.setUserAgentOverride(ua);
        }
      };
    }
  }

  const tabId = ++state.tabIdCounter;

  const tabElement = document.createElement('div');
  tabElement.className = 'tab';
  tabElement.innerHTML = `
    <img class="tab-favicon" src="https://www.google.com/s2/favicons?domain=${url}&sz=32" alt="">
    <span class="tab-title">New Tab</span>
    <span class="tab-close">×</span>
  `;
  dom.tabsBar.appendChild(tabElement);

  const history = [{
    url,
    title: 'New Tab',
    favicon: `https://www.google.com/s2/favicons?domain=${url}&sz=32`,
    time: new Date()
  }];
  let historyIndex = 0;

  const displayInitialUrl = api?.fileUrlToDisplayPath?.(initialSrc) || url;

  const tab = {
    webview, 
    tabElement, 
    url: displayInitialUrl,
    history, 
    historyIndex, 
    tabId,
    isNavigating: false,
    isLoading: false
  };

  const updateFavicon = (faviconUrl) => {
    const img = tabElement.querySelector('.tab-favicon');
    if (faviconUrl) {
      img.src = faviconUrl;
    } else {
      const current = webview.getURL();
      try {
        const u = new URL(current);
        if (u.protocol !== "http:" && u.protocol !== "https:" || !u.hostname) {
          img.src = "https://www.google.com/favicon.ico";
        } else {
          img.src = `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
        }
      } catch {
        img.src = `https://www.google.com/s2/favicons?domain=google.com&sz=32`;
      }
    }
    if (tab.history[tab.historyIndex]) {
      tab.history[tab.historyIndex].favicon = img.src;
    }
    saveTabHistory(tab);
  };

  const handleLoadedPage = (currentUrl, title) => {
    setTimeout(() => {
      const t = title || webview.getTitle() || "Untitled page";
      if (!tab.isNavigating) {
        if (tab.historyIndex < tab.history.length - 1) {
          tab.history = tab.history.slice(0, tab.historyIndex + 1);
        }

        const lastEntry = tab.history[tab.history.length - 1];
        if (!lastEntry || lastEntry.url !== currentUrl) {
          const newEntry = {
            url: currentUrl,
            title: t,
            favicon: `https://www.google.com/s2/favicons?domain=${currentUrl}&sz=64`,
            time: new Date()
          };
          tab.history.push(newEntry);
          tab.historyIndex = tab.history.length - 1;

          const lastGlobal = state.globalHistory[state.globalHistory.length - 1];
          if (!lastGlobal || lastGlobal.url !== currentUrl || lastGlobal.tabId !== tabId) {
            state.globalHistory.push({
              url: currentUrl,
              title: t,
              favicon: `https://www.google.com/s2/favicons?domain=${currentUrl}&sz=64`,
              time: new Date(),
              tabId
            });
            saveGlobalHistory();
          }
        } else {
          lastEntry.title = t;
          lastEntry.time = new Date();
        }
      } else {
        if (tab.history[tab.historyIndex]) {
          tab.history[tab.historyIndex].title = t;
        }
        tab.isNavigating = false;
      }

      tab.url = currentUrl;
      if (tab === state.activeTab) {
        dom.addressInput.value = currentUrl;
        updateHistoryDropdown();
      }
      updateTabTitle(tab, t);
      updateFavicon();
      saveTabHistory(tab);
    }, 100);
  };

  if (useIframe) {
    // newtab.html sends `request-history` via postMessage.
    const sendHistoryData = () => {
      try {
        if (webview.contentWindow) {
          webview.contentWindow.postMessage(
            { type: "history-data", history: state.globalHistory },
            "*"
          );
        }
      } catch {
        /* ignore */
      }
    };

    const onMessage = (event) => {
      try {
        if (event.source === webview.contentWindow && event.data?.type === "request-history") {
          sendHistoryData();
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("message", onMessage);
    tab.__removeMessageListener = () => window.removeEventListener("message", onMessage);

    webview.addEventListener("load", () => {
      tab.isLoading = false;
      const currentUrl = webview.getURL();
      const title = (() => {
        try {
          return webview.contentDocument?.title || webview.__lastTitle || "Untitled page";
        } catch {
          return webview.__lastTitle || "Untitled page";
        }
      })();

      // If it's newtab, send history immediately too.
      if (String(currentUrl).includes("newtab.html")) {
        sendHistoryData();
      }

      handleLoadedPage(currentUrl, title);
    });

    // Listen for navigation requests from the newtab iframe (quick links, search)
    const onNavMessage = (event) => {
      try {
        if (event.source === webview.contentWindow && event.data?.type === "navigate-url") {
          const targetUrl = event.data.url;
          if (!targetUrl) return;
          upgradeIframeToWebview(tab, targetUrl);
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("message", onNavMessage);
    const origRemove = tab.__removeMessageListener;
    tab.__removeMessageListener = () => {
      origRemove?.();
      window.removeEventListener("message", onNavMessage);
    };
  } else {
    // Electron-style HISTORY DATA INJECTION FOR NEWTAB
    webview.addEventListener("dom-ready", () => {
      const u = webview.getURL() || "";
      if (u.includes("newtab.html")) {
        webview
          .executeJavaScript(`
            window.postMessage({
              type: "history-data",
              history: ${JSON.stringify(state.globalHistory)}
            }, "*");
          `)
          .catch(() => {});
      }
    });

    webview.addEventListener("ipc-message", (event) => {
      if (event.channel === "request-history") {
        webview.send("history-data", state.globalHistory);
      }
    });
  }

  if (!useIframe) {
    const onAny = (eventNames, handler) => {
      eventNames.forEach((eventName) => webview.addEventListener(eventName, handler));
    };

    onAny(["did-start-loading", "loadstart"], () => {
      tab.isLoading = true;
      updateTabTitle(tab, "Loading...");
    });

    onAny(["did-finish-load", "loadstop"], () => {
      tab.isLoading = false;
      const currentUrl = webview.getURL();
      const title = webview.getTitle() || webview.__lastTitle || "Untitled page";
      handleLoadedPage(currentUrl, title);
    });

    onAny(["did-fail-load", "loadabort"], () => {
      tab.isLoading = false;
      if (tab === state.activeTab) {
        updateTabTitle(tab, "Loading Failed");
      }
    });

    webview.addEventListener("page-title-updated", (event) => {
      const title = event.title || "Untitled Page";
      webview.__lastTitle = title;
      updateTabTitle(tab, title);
      if (tab.history[tab.historyIndex]) {
        tab.history[tab.historyIndex].title = title;
        saveTabHistory(tab);
      }
    });

    webview.addEventListener("page-favicon-updated", (event) => {
      if (event.favicons && event.favicons.length > 0) {
        updateFavicon(event.favicons[0]);
      }
    });

    webview.addEventListener("context-menu", (e) => {
      e.preventDefault();
      window.windowAPI?.showContextMenu(e.params, tab.tabId);
    });

    // new-window event - yeni sekme veya indirme için
    onAny(["new-window", "newwindow"], (e) => {
      e.preventDefault();
      const nextUrl = e.url || e.targetUrl || "";
      if (!nextUrl) return;

      const downloadExtensions = [
        ".pdf",
        ".zip",
        ".rar",
        ".7z",
        ".tar",
        ".gz",
        ".exe",
        ".dmg",
        ".pkg",
        ".deb",
        ".rpm",
        ".mp3",
        ".mp4",
        ".avi",
        ".mkv",
        ".mov",
        ".flv",
        ".doc",
        ".docx",
        ".xls",
        ".xlsx",
        ".ppt",
        ".pptx",
        ".iso",
        ".apk",
        ".ipa"
      ];

      const isDownloadable = downloadExtensions.some((ext) => nextUrl.toLowerCase().includes(ext));
      if (isDownloadable) {
        import("../downloads/downloadManager.js").then(({ startDownload }) => {
          const fileName = nextUrl.split("/").pop().split("?")[0];
          startDownload(nextUrl, fileName);
        });
      } else {
        webview.loadURL(nextUrl);
      }
    });
  }

  tabElement.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) {
      closeTab(tab);
    } else {
      switchTab(tab);
    }
  });

  state.tabs.push(tab);
  switchTab(tab);
  
  setTimeout(() => {
    makeTabsDraggable();
    updateActiveTabHighlight();
    webview.setUserAgent(userAgent);
    // Wire up ad blocking for non-iframe webviews
    if (!useIframe) {
      window.windowAPI?.adBlock?.setupWebview?.(webview);
    }
  }, 100);
  
  return tab;
}

export function switchTab(tab) {
  if (state.activeTab) {
    state.activeTab.webview.classList.remove('active');
    state.activeTab.tabElement.classList.remove('active');
  }
  state.activeTab = tab;

  tab.webview.classList.add('active');
  tab.tabElement.classList.add('active');

  dom.addressInput.value = tab.url || '';
  updateHistoryDropdown();
  updateActiveTabHighlight();
}

export function closeTab(tab) {
  const index = state.tabs.indexOf(tab);
  
  try {
    const tabHistoryKey = `forkit_tab_history_${tab.tabId}`;
    localStorage.removeItem(tabHistoryKey);
  } catch (error) {
    console.error('Error clearing tab history:', error);
  }

  try {
    tab.__removeMessageListener?.();
  } catch {
    /* ignore */
  }
  
  tab.webview.remove();
  tab.tabElement.remove();
  state.tabs.splice(index, 1);

  if (state.tabs.length === 0) {
    window.windowAPI?.closeApp();
    return;
  }

  if (state.activeTab === tab) {
    const newActive = state.tabs[Math.max(0, index - 1)];
    switchTab(newActive);
  }
  
  setTimeout(() => {
    makeTabsDraggable();
    updateActiveTabHighlight();
  }, 100);
}