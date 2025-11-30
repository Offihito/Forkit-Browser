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
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,  
      contextIsolation: false, 
      webviewTag: true,
      webSecurity: true,
      allowRunningInsecureContent: true,
      enableRemoteModule: true
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

// Context menu - Save Page
ipcMain.handle('save-page', async (event, url, title) => {
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
      return { success: true, filePath: result.filePath };
    }
    return { success: false };
  } catch (error) {
    console.error('Page save error:', error);
    return { success: false, error: error.message };
  }
});