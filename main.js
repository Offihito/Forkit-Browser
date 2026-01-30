// main.js - Enhanced security for Google login
const { app, BrowserWindow, Menu, ipcMain, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const AdBlocker = require('./adBlocker');

const debug_mode = false;

// Initialize Ad Blocker
const adBlocker = new AdBlocker();

// Load @electron/remote module (if available)
let remoteMain;
try {
  remoteMain = require('@electron/remote/main');
  remoteMain.initialize();
} catch (e) {
  console.warn('@electron/remote is not installed');
}

// CRITICAL: Use Chrome's exact user agent - Google checks this
const chromeVersion = process.versions.chrome;
const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
app.userAgentFallback = userAgent;

// SECURITY: Remove Electron from user agent completely
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 800,
    frame: false,
    titleBarStyle: "hidden",
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false, // ✓ Already secure
      contextIsolation: true, // ✓ Already secure
      preload: path.resolve(__dirname, "Files", "preload.js"),
      webviewTag: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: true, // IMPORTANT: Enable sandbox
      enableRemoteModule: false, // Disable remote for security
      maximizable: true,
      minimizable: true,
      // CRITICAL: Add these for Google login
      partition: 'persist:main',
      enableWebSQL: false,
      spellcheck: true
    }
  });

  // Enable remote module for this window (if needed)
  if (remoteMain) {
    remoteMain.enable(win.webContents);
  }

  // Session settings
  const ses = win.webContents.session;
  
  // Clear any proxy (direct connection)
  ses.setProxy({ mode: 'direct' });

  // Set user agent
  ses.setUserAgent(userAgent);

  // SECURITY: Set proper permissions
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['notifications', 'media', 'geolocation', 'openExternal'];
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      callback(false);
    }
  });

  // CRITICAL: Enhanced header manipulation for Google
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    
    // Remove Electron-specific headers that Google detects
    delete headers['Electron'];
    delete headers['X-Devtools-Emulate-Network-Conditions-Client-Id'];
    
    // Set Chrome-like headers
    headers['sec-ch-ua'] = `"Chromium";v="${chromeVersion.split('.')[0]}", "Google Chrome";v="${chromeVersion.split('.')[0]}", "Not=A?Brand";v="24"`;
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"Windows"';
    headers['sec-fetch-site'] = headers['sec-fetch-site'] || 'none';
    headers['sec-fetch-mode'] = headers['sec-fetch-mode'] || 'navigate';
    headers['sec-fetch-user'] = headers['sec-fetch-user'] || '?1';
    headers['sec-fetch-dest'] = headers['sec-fetch-dest'] || 'document';
    headers['upgrade-insecure-requests'] = '1';
    
    // Accept language
    headers['accept-language'] = 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7';
    
    callback({ requestHeaders: headers });
  });

  // AD BLOCKER: Block requests
  ses.webRequest.onBeforeRequest((details, callback) => {
    // Ana sayfa ve navigation isteklerini asla engelleme
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      callback({ cancel: false });
      return;
    }
    
    const shouldBlock = adBlocker.shouldBlock(details.url, details.resourceType);
    
    if (shouldBlock) {
      console.log('🚫 Blocked:', details.resourceType, details.url);
      callback({ cancel: true });
    } else {
      callback({ cancel: false });
    }
  });

  // CRITICAL: Handle response headers
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders;
    
    // Allow necessary cookies and storage
    if (headers['set-cookie']) {
      // Google needs these cookies
      headers['set-cookie'] = headers['set-cookie'].map(cookie => {
        return cookie;
      });
    }
    
    callback({ responseHeaders: headers });
  });

  // Webview partition session settings
  const webviewSession = session.fromPartition('persist:browser');
  
  webviewSession.setProxy({ mode: 'direct' });
  webviewSession.setUserAgent(userAgent);

  // Set permissions for webview
  webviewSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['notifications', 'media', 'geolocation', 'openExternal'];
    callback(allowedPermissions.includes(permission));
  });

  // Apply same header manipulation for webviews
  webviewSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    
    delete headers['Electron'];
    delete headers['X-Devtools-Emulate-Network-Conditions-Client-Id'];
    
    headers['sec-ch-ua'] = `"Chromium";v="${chromeVersion.split('.')[0]}", "Google Chrome";v="${chromeVersion.split('.')[0]}", "Not=A?Brand";v="24"`;
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"Windows"';
    headers['sec-fetch-site'] = headers['sec-fetch-site'] || 'none';
    headers['sec-fetch-mode'] = headers['sec-fetch-mode'] || 'navigate';
    headers['sec-fetch-user'] = headers['sec-fetch-user'] || '?1';
    headers['sec-fetch-dest'] = headers['sec-fetch-dest'] || 'document';
    headers['upgrade-insecure-requests'] = '1';
    headers['accept-language'] = 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7';
    
    callback({ requestHeaders: headers });
  });

  // AD BLOCKER: Block requests for webviews
  webviewSession.webRequest.onBeforeRequest((details, callback) => {
    // Ana sayfa ve navigation isteklerini asla engelleme
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      callback({ cancel: false });
      return;
    }
    
    const shouldBlock = adBlocker.shouldBlock(details.url, details.resourceType);
    
    if (shouldBlock) {
      console.log('🚫 Blocked (webview):', details.resourceType, details.url);
      callback({ cancel: true });
    } else {
      callback({ cancel: false });
    }
  });

  webviewSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: details.responseHeaders });
  });

  // Download handler for webview
  webviewSession.on('will-download', (event, item, webContents) => {
    event.preventDefault();
    
    const url = item.getURL();
    const filename = item.getFilename();
    
    console.log('Download intercepted:', { url, filename });
    
    win.webContents.send('start-download-from-webview', {
      url: url,
      filename: filename
    });
  });

  win.loadFile('Files/index.html');
  if (debug_mode) {
    win.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  // SECURITY: Proper DNS configuration
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: 'secure',
    secureDnsServers: [
      'https://dns.google/dns-query',
      'https://cloudflare-dns.com/dns-query'
    ]
  });

  // IMPORTANT: Only use these in development, not production
  // Google may detect these as suspicious
  if (debug_mode) {
    app.commandLine.appendSwitch('ignore-certificate-errors');
  }

  // CRITICAL: Add Chrome flags to appear more like real Chrome
  app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
  app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');
  
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handlers
ipcMain.on('close-app', () => {
  app.quit();
});

ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.isMinimized() ? win.restore() : win.minimize();
  }
});

ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.isMaximized() ? win.unmaximize() : win.maximize();
  }
});

ipcMain.on('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// Context menu handler
ipcMain.on('show-context-menu', (event, params, tabId) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { Menu, MenuItem } = require('electron');
    const menu = new Menu();

    const sendCmd = (action, payload = {}) => {
      event.sender.send('context-menu-command', { action, tabId, ...payload });
    };

    if (params.selectionText) {
      menu.append(new MenuItem({
        label: 'Copy',
        accelerator: 'CmdOrCtrl+C',
        click: () => clipboard.writeText(params.selectionText)
      }));

      menu.append(new MenuItem({
        label: `Search Google for "${params.selectionText.substring(0, 30)}..."`,
        click: () => sendCmd('create-tab', { url: `https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}` })
      }));

      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (params.linkURL) {
      menu.append(new MenuItem({
        label: 'Open link in new tab',
        click: () => sendCmd('create-tab', { url: params.linkURL })
      }));

      menu.append(new MenuItem({
        label: 'Copy link address',
        click: () => clipboard.writeText(params.linkURL)
      }));

      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (params.hasImageContents || params.srcURL) {
      const imageUrl = params.srcURL;
      menu.append(new MenuItem({
        label: 'Open image in new tab',
        click: () => sendCmd('create-tab', { url: imageUrl })
      }));

      menu.append(new MenuItem({
        label: 'Copy image address',
        click: () => clipboard.writeText(imageUrl)
      }));

      menu.append(new MenuItem({
        label: 'Save image as...',
        click: () => {
          const fileName = imageUrl.split('/').pop().split('?')[0] || 'image.png';
          sendCmd('download-image', { url: imageUrl, fileName });
        }
      }));

      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (params.isEditable) {
      menu.append(new MenuItem({
        label: 'Paste',
        accelerator: 'CmdOrCtrl+V',
        click: () => sendCmd('paste')
      }));

      menu.append(new MenuItem({
        label: 'Cut',
        accelerator: 'CmdOrCtrl+X',
        click: () => sendCmd('cut')
      }));

      menu.append(new MenuItem({ type: 'separator' }));
    }

    menu.append(new MenuItem({
      label: 'Back',
      enabled: params.canGoBack ?? false,
      click: () => sendCmd('back')
    }));

    menu.append(new MenuItem({
      label: 'Forward',
      enabled: params.canGoForward ?? false,
      click: () => sendCmd('forward')
    }));

    menu.append(new MenuItem({
      label: 'Refresh',
      accelerator: 'CmdOrCtrl+R',
      click: () => sendCmd('reload')
    }));

    menu.append(new MenuItem({ type: 'separator' }));

    menu.append(new MenuItem({
      label: 'Save page as...',
      accelerator: 'CmdOrCtrl+S',
      click: () => sendCmd('download-page')
    }));

    menu.append(new MenuItem({
      label: 'Print...',
      accelerator: 'CmdOrCtrl+P',
      click: () => sendCmd('print')
    }));

    menu.append(new MenuItem({ type: 'separator' }));

    menu.append(new MenuItem({
      label: 'View source',
      click: () => sendCmd('view-source')
    }));

    menu.append(new MenuItem({
      label: 'Inspect (DevTools)',
      accelerator: 'F12',
      click: () => sendCmd('inspect')
    }));

    if (win) menu.popup({ window: win });
  } catch (err) {
    console.error('Error building context menu:', err);
  }
});

// Download manager
ipcMain.on('download-item', (event, downloadUrl, fileName) => {
  const { dialog } = require('electron');
  const https = require('https');
  const http = require('http');
  
  dialog.showSaveDialog({
    defaultPath: fileName || 'download',
    properties: ['createDirectory']
  }).then(result => {
    if (!result.canceled && result.filePath) {
      const protocol = downloadUrl.startsWith('https') ? https : http;
      const file = fs.createWriteStream(result.filePath);
      
      protocol.get(downloadUrl, (response) => {
        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloaded = 0;
        
        response.on('data', (chunk) => {
          downloaded += chunk.length;
          const progress = totalSize ? (downloaded / totalSize) * 100 : 0;
          event.sender.send('download-progress', { 
            fileName: result.filePath.split(/[\\/]/).pop(),
            progress: Math.round(progress),
            downloaded,
            totalSize
          });
        });
        
        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          event.sender.send('download-complete', { 
            fileName: result.filePath.split(/[\\/]/).pop(),
            filePath: result.filePath 
          });
        });
      }).on('error', (err) => {
        fs.unlink(result.filePath, () => {});
        event.sender.send('download-error', { 
          fileName: result.filePath.split(/[\\/]/).pop(),
          error: err.message 
        });
      });
    }
  });
});

// ========== AD BLOCKER IPC HANDLERS ==========
// Get ad blocker stats
ipcMain.handle('get-adblock-stats', () => {
  return adBlocker.getStats();
});

// Toggle ad blocker
ipcMain.handle('toggle-adblock', (event, enabled) => {
  return adBlocker.toggle(enabled);
});

// Update filter lists
ipcMain.handle('update-filter-lists', async () => {
  return await adBlocker.updateFilterLists();
});

// Add custom filter
ipcMain.handle('add-custom-filter', (event, filter) => {
  adBlocker.addCustomFilter(filter);
  return { success: true };
});

// Add to whitelist
ipcMain.handle('add-to-whitelist', (event, domain) => {
  adBlocker.addToWhitelist(domain);
  return { success: true };
});

// Reset stats
ipcMain.handle('reset-adblock-stats', () => {
  adBlocker.resetStats();
  return { success: true };
});

// Get ad blocker status
ipcMain.handle('get-adblock-status', () => {
  return {
    enabled: adBlocker.isEnabled,
    stats: adBlocker.getStats()
  };
});