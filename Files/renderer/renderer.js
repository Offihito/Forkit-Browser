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

  // Titlebar button behaviors - get buttons from the main title bar (not from modals)
  const titleBar = document.querySelector('#title-bar');
  if (titleBar) {
    const minBtn = titleBar.querySelector("#min-btn");
    const maxBtn = titleBar.querySelector("#max-btn");
    const closeBtn = titleBar.querySelector("#close-btn");
    
    if (minBtn) minBtn.onclick = () => window.windowAPI?.minimize();
    if (maxBtn) maxBtn.onclick = () => window.windowAPI?.maximize();
    if (closeBtn) closeBtn.onclick = () => window.windowAPI?.close();
  }

  // Load history on app startup
  loadGlobalHistory();

  // Initialize navigation with createTab function
  initNavigation(createTab);
  initDownloadManager();
  
  // New Tab button - after initNavigation to prevent override
  let isCreatingTab = false;
  const newTabBtn = document.getElementById("new-tab");
  if (newTabBtn) {
    // Remove any existing listeners first
    const oldBtn = newTabBtn.cloneNode(true);
    newTabBtn.parentNode.replaceChild(oldBtn, newTabBtn);
    
    oldBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      if (isCreatingTab) return;
      isCreatingTab = true;
      
      console.log("New tab clicked");
      createTab('newtab.html');
      
      setTimeout(() => {
        isCreatingTab = false;
      }, 300);
    });
  }
  
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