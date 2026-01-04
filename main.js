// main.js (debug logs removed, Cloudflare bypass preserved)
const { app, BrowserWindow, Menu, ipcMain, session, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Load @electron/remote module (if available)
let remoteMain;
try {
  remoteMain = require('@electron/remote/main');
  remoteMain.initialize();
} catch (e) {
  console.warn('@electron/remote is not installed');
}

// Set consistent User-Agent globally
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
app.userAgentFallback = userAgent;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 800,
    frame: false,
    titleBarStyle: "hidden",

    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.resolve(__dirname, "Files", "preload.js"),
      webviewTag: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      maximizable: true,
      minimizable: true
    }
  });

  // Enable remote module for this window
  if (remoteMain) {
    remoteMain.enable(win.webContents);
  }

  // Session settings - for DPI bypass
  const ses = win.webContents.session;
  
  // DNS-over-HTTPS settings
  ses.setProxy({
    mode: 'direct'
  }).then(() => {
    console.log('Proxy settings applied');
  });

  // Override User-Agent
  ses.setUserAgent(userAgent);

  // Add modern security headers
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    
    // Set consistent sec-ch-ua headers
    headers['sec-ch-ua'] = '"Not)A;Brand";v="99", "Chromium";v="142", "Google Chrome";v="142"';
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"Windows"';
    
    // Add realistic Referer if not present
    if (!headers['Referer'] && !headers['referer']) {
      headers['Referer'] = 'https://www.google.com/';
    }
    
    callback({ requestHeaders: headers });
  });

  // Webview partition session settings
  const webviewSession = session.fromPartition('persist:browser');
  
  webviewSession.setProxy({
    mode: 'direct'
  }).then(() => {
    console.log('Webview proxy settings applied');
  });

  webviewSession.setUserAgent(userAgent);

  // Apply same header manipulation for webviews
  webviewSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    
    headers['sec-ch-ua'] = '"Not)A;Brand";v="99", "Chromium";v="142", "Google Chrome";v="142"';
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"Windows"';
    
    if (!headers['Referer'] && !headers['referer']) {
      headers['Referer'] = 'https://www.google.com/';
    }
    
    callback({ requestHeaders: headers });
  });

  win.loadFile('Files/index.html');
}

app.whenReady().then(() => {
  // Disable default menu
  Menu.setApplicationMenu(null);

  // DNS-over-HTTPS settings - FIXED & WORKING
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: 'automatic',
    secureDnsServers: [
      'https://dns.google/dns-query',
      'https://cloudflare-dns.com/dns-query'
    ]
  });

  // TLS/SSL settings (for bypass purposes)
  app.commandLine.appendSwitch('ignore-certificate-errors');
  app.commandLine.appendSwitch('allow-insecure-localhost', 'true');

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Close app when last tab is closed
ipcMain.on('close-app', () => {
  app.quit();
});

// Window controls
ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  if (win.isMinimized()) {
    win.restore();
  } else {
    win.minimize();
  }
});

ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});

ipcMain.on('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// Context menu - Save Image
ipcMain.handle('save-image', async (event, imageUrl, suggestedName) => {
  const { dialog } = require('electron');
  const https = require('https');
  const http = require('http');
  
  try {
    const result = await dialog.showSaveDialog({
      defaultPath: suggestedName || 'image.png',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (!result.canceled && result.filePath) {
      const protocol = imageUrl.startsWith('https') ? https : http;
      
      return new Promise((resolve, reject) => {
        protocol.get(imageUrl, (response) => {
          if (response.statusCode === 200) {
            const fileStream = fs.createWriteStream(result.filePath);
            response.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              resolve({ success: true });
            });
          } else {
            reject(new Error('Download failed'));
          }
        }).on('error', reject);
      });
    }
    return { success: false };
  } catch (error) {
    console.error('Image save error:', error);
    return { success: false, error: error.message };
  }
});

// New: Show context menu requested from renderer (params come from webview context-menu event)
ipcMain.on('show-context-menu', (event, params, tabId) => {
  try {
    console.log('Context menu requested:', { tabId, selectionText: params.selectionText || null, linkURL: params.linkURL || null, srcURL: params.srcURL || null });
    const win = BrowserWindow.fromWebContents(event.sender);
    const Menu = require('electron').Menu;
    const MenuItem = require('electron').MenuItem;
    const menu = new Menu();

    // Helper to send commands back to renderer for actions that must run there
    const sendCmd = (action, payload = {}) => {
      event.sender.send('context-menu-command', { action, tabId, ...payload });
    };

    if (params.selectionText) {
      menu.append(new MenuItem({
        label: 'Copy',
        accelerator: 'CmdOrCtrl+C',
        click: () => {
          clipboard.writeText(params.selectionText);
        }
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
        click: async () => {
          try {
            // Reuse existing save-image logic
            const result = await ipcMain.invoke ? ipcMain.invoke('save-image', imageUrl) : null;
            // If invoked via ipcMain.invoke is not available for use here, fall back to the handler logic
            if (!result) {
              const { dialog } = require('electron');
              const https = require('https');
              const http = require('http');
              const res = await dialog.showSaveDialog({ defaultPath: imageUrl.split('/').pop().split('?')[0] || 'image.png' });
              if (!res.canceled && res.filePath) {
                const protocol = imageUrl.startsWith('https') ? https : http;
                protocol.get(imageUrl, (response) => {
                  if (response.statusCode === 200) {
                    const fileStream = fs.createWriteStream(res.filePath);
                    response.pipe(fileStream);
                    fileStream.on('finish', () => fileStream.close());
                  }
                }).on('error', (err) => console.error('Download failed', err));
              }
            }
          } catch (err) {
            console.error('Save image error from context menu:', err);
          }
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
      enabled: (params.canGoBack ?? false),
      click: () => sendCmd('back')
    }));

    menu.append(new MenuItem({
      label: 'Forward',
      enabled: (params.canGoForward ?? false),
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
      click: async () => {
        // ask renderer for HTML first
        sendCmd('request-html');
      }
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

    // Popup the menu at cursor
    if (win) menu.popup({ window: win });
  } catch (err) {
    console.error('Error building context menu:', err);
  }
});

// Context menu - Save Page
ipcMain.handle('save-page', async (event, url, title, html) => {
  const { dialog } = require('electron');
  
  try {
    const result = await dialog.showSaveDialog({
      defaultPath: (title || 'page').replace(/[<>:"/\\|?*]/g, '_') + '.html',
      filters: [
        { name: 'HTML File', extensions: ['html'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, html || '<!-- empty -->', 'utf8');
      return { success: true, filePath: result.filePath };
    }
    return { success: false };
  } catch (error) {
    console.error('Page save error:', error);
    return { success: false, error: error.message };
  }
});