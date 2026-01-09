import { createTab } from "../tabs/tabManager.js";
import { goBack, goForward, reload } from "../navigation/navigation.js";

// ==================== CONTEXT MENU (RIGHT-CLICK MENU) ====================

let Menu, MenuItem, clipboard, shell;
try {
  const remote = require('@electron/remote');
  Menu = remote.Menu;
  MenuItem = remote.MenuItem;
  clipboard = remote.clipboard;
  shell = remote.shell;
} catch (e) {
  console.warn('@electron/remote not available, context menu disabled');
  clipboard = { writeText: () => console.warn('clipboard.writeText no-op') };
  shell = { openExternal: () => console.warn('shell.openExternal no-op') };
}

export function showContextMenu(event, tab) {
    if (!Menu || !MenuItem) {
    console.warn('Context menu not supported');
    return;
  }

  const params = event.params;
  const menu = new Menu();

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
      click: () => {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`;
        createTab(searchUrl);
      }
    }));

    menu.append(new MenuItem({ type: 'separator' }));
  }

  if (params.linkURL) {
    menu.append(new MenuItem({
      label: 'Open link in new tab',
      click: () => {
        createTab(params.linkURL);
      }
    }));

    menu.append(new MenuItem({
      label: 'Copy link address',
      click: () => {
        clipboard.writeText(params.linkURL);
      }
    }));

    menu.append(new MenuItem({ type: 'separator' }));
  }

  if (params.hasImageContents || params.srcURL) {
    const imageUrl = params.srcURL;
    
    menu.append(new MenuItem({
      label: 'Open image in new tab',
      click: () => {
        createTab(imageUrl);
      }
    }));

    menu.append(new MenuItem({
      label: 'Copy image address',
      click: () => {
        clipboard.writeText(imageUrl);
      }
    }));

    menu.append(new MenuItem({
      label: 'Save image as...',
      click: async () => {
        try {
          const fileName = imageUrl.split('/').pop().split('?')[0] || 'image.png';
          const result = await window.windowAPI.saveImage(imageUrl, fileName);
          if (result && result.success) {
            console.log('Image Saved');
          }
        } catch (error) {
          console.error('Image save error:', error);
        }
      }
    }));

    menu.append(new MenuItem({ type: 'separator' }));
  }

  if (params.isEditable) {
    menu.append(new MenuItem({
      label: 'Paste',
      accelerator: 'CmdOrCtrl+V',
      click: () => {
        tab.webview.paste();
      }
    }));

    menu.append(new MenuItem({
      label: 'Cut',
      accelerator: 'CmdOrCtrl+X',
      click: () => {
        tab.webview.cut();
      }
    }));

    menu.append(new MenuItem({ type: 'separator' }));
  }

  menu.append(new MenuItem({
    label: 'Back',
    enabled: tab.historyIndex > 0,
    click: () => goBack()
  }));

  menu.append(new MenuItem({
    label: 'Forward',
    enabled: tab.historyIndex < tab.history.length - 1,
    click: () => goForward()
  }));

  menu.append(new MenuItem({
    label: 'Refresh',
    accelerator: 'CmdOrCtrl+R',
    click: () => reload()
  }));

  menu.append(new MenuItem({ type: 'separator' }));

  menu.append(new MenuItem({
    label: 'Save page as...',
    accelerator: 'CmdOrCtrl+S',
    click: async () => {
      try {
        const url = tab.webview.getURL();
        const title = tab.webview.getTitle();
        // fetch the page HTML first, then ask main to save it
        const html = await tab.webview.executeJavaScript('document.documentElement.outerHTML');
        const result = await window.windowAPI.savePage(url, title, html);
        if (result && result.success) {
          console.log('Page Saved:', result.filePath);
        }
      } catch (error) {
        console.error('Page save error:', error);
      }
    }
  }));

  menu.append(new MenuItem({
    label: 'Print...',
    accelerator: 'CmdOrCtrl+P',
    click: () => {
      tab.webview.print();
    }
  }));

  menu.append(new MenuItem({ type: 'separator' }));

  menu.append(new MenuItem({
    label: 'View source',
    click: () => {
      tab.webview.executeJavaScript('document.documentElement.outerHTML')
        .then(html => {
          const blob = new Blob([html], { type: 'text/html' });
          const url = URL.createObjectURL(blob);
          createTab(url);
        });
    }
  }));

  menu.append(new MenuItem({
    label: 'Inspect (DevTools)',
    accelerator: 'F12',
    click: () => {
      if (tab.webview.isDevToolsOpened()) {
        tab.webview.closeDevTools();
      } else {
        tab.webview.openDevTools();
      }
    }
  }));

  menu.popup();
}
