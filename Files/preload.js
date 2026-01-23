const { contextBridge, ipcRenderer } = require("electron");

// Expose a minimal, safe API to the renderer
contextBridge.exposeInMainWorld("windowAPI", {
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
  closeApp: () => ipcRenderer.send("close-app"),

  // Download
  downloadItem: (url, fileName) => ipcRenderer.send('download-item', url, fileName),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, data) => cb(data)),
  onDownloadComplete: (cb) => ipcRenderer.on('download-complete', (e, data) => cb(data)),
  onDownloadError: (cb) => ipcRenderer.on('download-error', (e, data) => cb(data)),
  
  // Webview'dan gelen download istekleri için
  onStartDownloadFromWebview: (cb) => ipcRenderer.on('start-download-from-webview', (e, data) => cb(data)),

  saveImage: (imageUrl, fileName) => ipcRenderer.invoke('save-image', imageUrl, fileName),
  savePage: (url, title, html) => ipcRenderer.invoke('save-page', url, title, html),
  showContextMenu: (params, tabId) => ipcRenderer.send('show-context-menu', params, tabId),
  onContextMenuCommand: (cb) => ipcRenderer.on('context-menu-command', (event, data) => cb && cb(data)),
  ping: () => ipcRenderer.send('preload-ping'),
});

console.log("Preload loaded successfully.");