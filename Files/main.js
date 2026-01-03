// main.js (debug removed, Cloudflare bypass preserved)
const { app, BrowserWindow, Menu, ipcMain, session, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// @electron/remote modülünü yükle (eğer varsa)
let remoteMain;
try {
  remoteMain = require('@electron/remote/main');
  remoteMain.initialize();
} catch (e) {
  console.warn('@electron/remote yüklü değil');
}

// Set consistent User-Agent globally
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
app.userAgentFallback = userAgent;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
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

  // Remote modülü etkinleştir
  if (remoteMain) {
    remoteMain.enable(win.webContents);
  }

  // Session ayarları - DPI bypass için
  const ses = win.webContents.session;
  
  // DNS-over-HTTPS ayarları
  ses.setProxy({
    mode: 'direct'
  }).then(() => {
    console.log('Proxy ayarları yapıldı');
  });

  // User-Agent değiştir
  ses.setUserAgent(userAgent);

  // Add modern security headers
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    
    // Set consistent sec-ch-ua headers
    headers['sec-ch-ua'] = '"Not)A;Brand";v="99", "Chromium";v="142", "Google Chrome";v="142"';
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"Windows"';
    
    // Referrer ekle - but only if not set, and make it realistic
    if (!headers['Referer'] && !headers['referer']) {
      headers['Referer'] = 'https://www.google.com/';
    }
    
    callback({ requestHeaders: headers });
  });

  // Webview için partition session ayarları
  const webviewSession = session.fromPartition('persist:browser');
  
  webviewSession.setProxy({
    mode: 'direct'
  }).then(() => {
    console.log('Webview proxy ayarları yapıldı');
  });

  webviewSession.setUserAgent(userAgent);

  // Webview için de header manipülasyonu
  webviewSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    
    // Set consistent sec-ch-ua
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
  // Menüyü kapat
  Menu.setApplicationMenu(null);

  // DNS-over-HTTPS ayarları - DÜZELTİLMİŞ
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: 'automatic',
    secureDnsServers: [
      'https://dns.google/dns-query',
      'https://cloudflare-dns.com/dns-query'
    ]
  });

  // TLS/SSL ayarları
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

// Son sekme kapatıldığında uygulamayı kapat
ipcMain.on('close-app', () => {
  app.quit();
});

// Context menu olayları
ipcMain.handle('save-image', async (event, imageUrl, suggestedName) => {
  const { dialog } = require('electron');
  const https = require('https');
  const http = require('http');
  
  try {
    const result = await dialog.showSaveDialog({
      defaultPath: suggestedName || 'image.png',
      filters: [
        { name: 'Resimler', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'Tüm Dosyalar', extensions: ['*'] }
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
            reject(new Error('İndirme başarısız'));
          }
        }).on('error', reject);
      });
    }
    return { success: false };
  } catch (error) {
    console.error('Resim kaydetme hatası:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-page', async (event, url, title) => {
  const { dialog } = require('electron');
  
  try {
    const result = await dialog.showSaveDialog({
      defaultPath: (title || 'sayfa').replace(/[<>:"/\\|?*]/g, '_') + '.html',
      filters: [
        { name: 'HTML Dosyası', extensions: ['html'] },
        { name: 'Tüm Dosyalar', extensions: ['*'] }
      ]
    });

    if (!result.canceled && result.filePath) {
      return { success: true, filePath: result.filePath };
    }
    return { success: false };
  } catch (error) {
    console.error('Sayfa kaydetme hatası:', error);
    return { success: false, error: error.message };
  }
});