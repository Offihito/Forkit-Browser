const { app, BrowserWindow } = require('electron');

function createWindow () {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,        // <webview> etiketi çalışsın
      webSecurity: false       // yerel test için (isteğe bağlı)
    }
  });

  win.loadFile('index.html');
  // win.webContents.openDevTools(); // Geliştirme için açabilirsiniz
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});