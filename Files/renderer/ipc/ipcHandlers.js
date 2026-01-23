import { createTab, switchTab } from "../tabs/tabManager.js";
import { goBack, goForward, reload } from "../navigation/navigation.js";
import { state } from "../core/state.js";
import { startDownload } from "../downloads/downloadManager.js";

export function initIPC() {
  window.windowAPI?.onContextMenuCommand(async (data) => {
    try {
      const tab = state.tabs.find(t => t.tabId === data.tabId) || state.activeTab;
      if (!tab) return;

      // Ensure the target tab is active for UI operations
      if (state.activeTab !== tab) switchTab(tab);

      switch (data.action) {
        case 'create-tab':
          if (data.url) createTab(data.url);
          break;
        
        case 'download-link':
          const fileName = data.url.split('/').pop().split('?')[0] || 'download';
          startDownload(data.url, fileName);
          break;
        
        case 'download-image':
          // Image download - send to download manager
          startDownload(data.url, data.fileName || 'image.png');
          break;
        
        case 'download-page':
          // Page download - get HTML and send to download manager
          try {
            const url = tab.webview.getURL();
            const title = tab.webview.getTitle() || 'page';
            const html = await tab.webview.executeJavaScript('document.documentElement.outerHTML');
            
            // Create blob URL for HTML
            const blob = new Blob([html], { type: 'text/html' });
            const blobUrl = URL.createObjectURL(blob);
            
            // Sanitize filename
            const safeName = title.replace(/[<>:"/\\|?*]/g, '_') + '.html';
            startDownload(blobUrl, safeName);
            
            // Clean up blob URL after a delay
            setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
          } catch (err) {
            console.error('Error downloading page:', err);
          }
          break;
        
        case 'paste':
          tab.webview.paste();
          break;
        
        case 'cut':
          tab.webview.cut();
          break;
        
        case 'back':
          goBack();
          break;
        
        case 'forward':
          goForward();
          break;
        
        case 'reload':
          reload();
          break;
        
        case 'print':
          tab.webview.print();
          break;
        
        case 'view-source':
          tab.webview.executeJavaScript('document.documentElement.outerHTML')
            .then(html => {
              const blob = new Blob([html], { type: 'text/html' });
              const url = URL.createObjectURL(blob);
              createTab(url);
            });
          break;
        
        case 'inspect':
          if (tab.webview.isDevToolsOpened()) {
            tab.webview.closeDevTools();
          } else {
            tab.webview.openDevTools();
          }
          break;
        
        default:
          console.warn('Unknown context menu action:', data.action);
      }
    } catch (err) {
      console.error('Error handling context menu command:', err);
    }
  });
}