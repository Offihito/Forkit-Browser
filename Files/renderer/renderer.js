import { createTab } from "./tabs/tabManager.js";
import { makeTabsDraggable, updateActiveTabHighlight } from "./tabs/tabDrag.js";
import { initIPC } from "./ipc/ipcHandlers.js";
import { loadGlobalHistory } from "./history/globalHistory.js";
import { initNavigation } from "./navigation/navigation.js";
import { initDownloadManager } from "./downloads/downloadManager.js";
import { startDownload } from "./downloads/downloadManager.js";

document.addEventListener('DOMContentLoaded', async () => {
  console.log("windowAPI working.");
  // diagnostic ping
  window.windowAPI?.ping();

  // Titlebar button behaviors (safe checks)
  document.getElementById("min-btn").onclick = () => window.windowAPI?.minimize();
  document.getElementById("max-btn").onclick = () => window.windowAPI?.maximize();
  document.getElementById("close-btn").onclick = () => window.windowAPI?.close();

  // Load history on app startup
  loadGlobalHistory();

  // Initialize navigation with createTab function
  initNavigation(createTab);
  initDownloadManager();
  
  // Initialize Ad Blocker UI (optional - only if module exists)
  try {
    const { initAdBlockerUI } = await import("./adBlocker/adBlockerUI.js");
    initAdBlockerUI();
    console.log("Ad Blocker UI initialized");
  } catch (err) {
    console.log("Ad Blocker UI module not found - skipping");
  }
  
  // ========== WEBVIEW DOWNLOAD LISTENER ==========
  // Main process'ten gelen download isteklerini dinle
  window.windowAPI?.onStartDownloadFromWebview((data) => {
    console.log('Download request from webview:', data);
    startDownload(data.url, data.filename);
  });
  // ========== END WEBVIEW DOWNLOAD LISTENER ==========

  // FIRST TAB
  createTab('newtab.html');

  setTimeout(() => {
    makeTabsDraggable();
    updateActiveTabHighlight();
  }, 500);

  initIPC();
});