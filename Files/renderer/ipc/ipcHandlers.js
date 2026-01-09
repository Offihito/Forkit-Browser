import { createTab, switchTab } from "../tabs/tabManager.js";
import { goBack, goForward, reload } from "../navigation/navigation.js";

export function initIPC() {
  window.windowAPI?.onContextMenuCommand(async (data) => {
    try {
      const tab = tabs.find(t => t.tabId === data.tabId) || activeTab;
      if (!tab) return;

      // Ensure the target tab is active for UI operations
      if (activeTab !== tab) switchTab(tab);

      switch (data.action) {
        case 'create-tab':
          if (data.url) createTab(data.url);
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
          if (tab.webview.isDevToolsOpened()) tab.webview.closeDevTools(); else tab.webview.openDevTools();
          break;
        case 'request-html':
          // Main asked for HTML to save page
          const url = tab.webview.getURL();
          const title = tab.webview.getTitle();
          try {
            const html = await tab.webview.executeJavaScript('document.documentElement.outerHTML');
            await window.windowAPI?.savePage(url, title, html);
          } catch (err) {
            console.error('Error fetching HTML for save-page request:', err);
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
