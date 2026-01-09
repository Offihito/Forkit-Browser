import { createTab } from "./tabs/tabManager.js";
import { makeTabsDraggable, updateActiveTabHighlight } from "./tabs/tabDrag.js";
import { initIPC } from "./ipc/ipcHandlers.js";
import { loadGlobalHistory } from "./history/globalHistory.js";
import { initNavigation } from "./navigation/navigation.js";

document.addEventListener('DOMContentLoaded', () => {
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

  // FIRST TAB
  createTab('https://www.google.com');

  setTimeout(() => {
    makeTabsDraggable();
    updateActiveTabHighlight();
  }, 500);

  initIPC();
});
