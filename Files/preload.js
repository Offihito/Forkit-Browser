const { contextBridge, ipcRenderer } = require("electron");

// SECURITY: Expose only minimal, validated API to renderer
// Never expose entire ipcRenderer or Node.js APIs
contextBridge.exposeInMainWorld("windowAPI", {
  // Window controls
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
  closeApp: () => ipcRenderer.send("close-app"),

  // Download - with input validation
  downloadItem: (url, fileName) => {
    if (typeof url === 'string' && typeof fileName === 'string') {
      ipcRenderer.send('download-item', url, fileName);
    }
  },
  
  onDownloadProgress: (cb) => {
    if (typeof cb === 'function') {
      ipcRenderer.on('download-progress', (e, data) => cb(data));
    }
  },
  
  onDownloadComplete: (cb) => {
    if (typeof cb === 'function') {
      ipcRenderer.on('download-complete', (e, data) => cb(data));
    }
  },
  
  onDownloadError: (cb) => {
    if (typeof cb === 'function') {
      ipcRenderer.on('download-error', (e, data) => cb(data));
    }
  },
  
  onStartDownloadFromWebview: (cb) => {
    if (typeof cb === 'function') {
      ipcRenderer.on('start-download-from-webview', (e, data) => cb(data));
    }
  },

  // Context menu - with validation
  showContextMenu: (params, tabId) => {
    if (typeof params === 'object' && (typeof tabId === 'string' || typeof tabId === 'number')) {
      ipcRenderer.send('show-context-menu', params, tabId);
    }
  },
  
  onContextMenuCommand: (cb) => {
    if (typeof cb === 'function') {
      ipcRenderer.on('context-menu-command', (event, data) => cb(data));
    }
  },
  
  // Ad Blocker API
  adBlock: {
    getStats: () => ipcRenderer.invoke('get-adblock-stats'),
    toggle: (enabled) => ipcRenderer.invoke('toggle-adblock', enabled),
    updateFilterLists: () => ipcRenderer.invoke('update-filter-lists'),
    addCustomFilter: (filter) => ipcRenderer.invoke('add-custom-filter', filter),
    addToWhitelist: (domain) => ipcRenderer.invoke('add-to-whitelist', domain),
    resetStats: () => ipcRenderer.invoke('reset-adblock-stats'),
    getStatus: () => ipcRenderer.invoke('get-adblock-status')
  },
  
  ping: () => ipcRenderer.send('preload-ping'),
});

console.log("Preload loaded successfully with enhanced security.");