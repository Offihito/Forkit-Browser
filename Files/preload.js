const { contextBridge, ipcRenderer } = require("electron");
// Expose a minimal, safe API to the renderer
contextBridge.exposeInMainWorld("windowAPI", {
  // Window controls
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
  closeApp: () => ipcRenderer.send("close-app"),

  // Async helpers
  saveImage: (imageUrl, fileName) => ipcRenderer.invoke('save-image', imageUrl, fileName),
  savePage: (url, title, html) => ipcRenderer.invoke('save-page', url, title, html),
  // Context menu bridge
  showContextMenu: (params, tabId) => ipcRenderer.send('show-context-menu', params, tabId),
  onContextMenuCommand: (cb) => ipcRenderer.on('context-menu-command', (event, data) => cb && cb(data)),
  // Diagnostics
  ping: () => ipcRenderer.send('preload-ping'),
});
console.log("Preload loaded successfully.");