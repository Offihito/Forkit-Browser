const { contextBridge, ipcRenderer, clipboard, shell } = require('electron');

// Renderer'a güvenli şekilde API'leri expose et
contextBridge.exposeInMainWorld('electronAPI', {
  ipcRenderer: {
    send: (channel, data) => ipcRenderer.send(channel, data),
    on: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),
    invoke: (channel, data) => ipcRenderer.invoke(channel, data)
  },
  clipboard: {
    writeText: (text) => clipboard.writeText(text)
  },
  shell: {
    openExternal: (url) => shell.openExternal(url)
  },
  // Context menu için Menu/MenuItem'ı main'e taşıdık, aşağıda ipc ile yönet
  showContextMenu: (params, tabId) => ipcRenderer.invoke('show-context-menu', params, tabId)
});