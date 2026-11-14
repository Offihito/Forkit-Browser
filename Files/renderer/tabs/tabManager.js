import { dom } from "../core/dom.js";
import { state } from "../core/state.js";
import { makeTabsDraggable, updateActiveTabHighlight } from "./tabDrag.js";
import { updateTabTitle } from "../ui/helpers.js";
import { updateHistoryDropdown } from "../ui/historyUI.js";
import { saveTabHistory, saveGlobalHistory } from "../history/globalHistory.js";
import { userAgent } from "../env/userAgent.js";

export function createTab(url = "newtab.html") {
  const webview = document.createElement('webview');
  webview.src = url;
  webview.partition = 'persist:browser';
  webview.classList.add('webview');
  dom.webviewContainer.appendChild(webview);

  const tabId = ++state.tabIdCounter;

  const tabElement = document.createElement('div');
  tabElement.className = 'tab';
  tabElement.innerHTML = `
    <img class="tab-favicon" src="https://www.google.com/s2/favicons?domain=${url}&sz=32" alt="">
    <span class="tab-title">New Tab</span>
    <span class="tab-close">×</span>
  `;
  dom.tabsBar.appendChild(tabElement);

  const history = [{
    url,
    title: 'New Tab',
    favicon: `https://www.google.com/s2/favicons?domain=${url}&sz=32`,
    time: new Date()
  }];
  let historyIndex = 0;

  const tab = { 
    webview, 
    tabElement, 
    url, 
    history, 
    historyIndex, 
    tabId,
    isNavigating: false,
    isLoading: false
  };

  const updateFavicon = (faviconUrl) => {
    const img = tabElement.querySelector('.tab-favicon');
    img.src = faviconUrl || `https://www.google.com/s2/favicons?domain=${webview.getURL()}&sz=32`;
    if (tab.history[tab.historyIndex]) {
      tab.history[tab.historyIndex].favicon = img.src;
    }
    saveTabHistory(tab);
  };

  // ========== HISTORY DATA INJECTION FOR NEWTAB ==========
  // Webview'a history datasını gönder (newtab.html için)
  webview.addEventListener('dom-ready', () => {
    // Eğer newtab.html yüklendiyse history datasını gönder
    if (webview.getURL().includes('newtab.html')) {
      console.log('Sending history data to newtab webview...', state.globalHistory.length, 'entries');
      
      // postMessage ile webview'a history gönder
      webview.executeJavaScript(`
        window.postMessage({
          type: 'history-data',
          history: ${JSON.stringify(state.globalHistory)}
        }, '*');
      `).catch(err => {
        console.error('Error sending history to webview:', err);
      });
    }
  });
  
  // Webview'dan mesaj dinle
  webview.addEventListener('ipc-message', (event) => {
    if (event.channel === 'request-history') {
      console.log('History data requested from newtab webview');
      webview.send('history-data', state.globalHistory);
    }
  });
  // ========== END HISTORY DATA INJECTION ==========

  webview.addEventListener('did-start-loading', () => {
    tab.isLoading = true;
    updateTabTitle(tab, 'Loading...');
  });

  webview.addEventListener('did-finish-load', () => {
    tab.isLoading = false;
    const currentUrl = webview.getURL();
    
    setTimeout(() => {
      const title = webview.getTitle() || 'Untitled page';
      
      if (!tab.isNavigating) {
        if (tab.historyIndex < tab.history.length - 1) {
          tab.history = tab.history.slice(0, tab.historyIndex + 1);
        }

        const lastEntry = tab.history[tab.history.length - 1];
        if (!lastEntry || lastEntry.url !== currentUrl) {
          const newEntry = {
            url: currentUrl,
            title,
            favicon: `https://www.google.com/s2/favicons?domain=${currentUrl}&sz=64`,
            time: new Date()
          };
          tab.history.push(newEntry);
          tab.historyIndex = tab.history.length - 1;

          const lastGlobal = state.globalHistory[state.globalHistory.length - 1];
          if (!lastGlobal || lastGlobal.url !== currentUrl || lastGlobal.tabId !== tabId) {
            state.globalHistory.push({
              url: currentUrl,
              title,
              favicon: `https://www.google.com/s2/favicons?domain=${currentUrl}&sz=64`,
              time: new Date(),
              tabId
            });
            saveGlobalHistory();
          }
        } else {
          lastEntry.title = title;
          lastEntry.time = new Date();
        }
      } else {
        if (tab.history[tab.historyIndex]) {
          tab.history[tab.historyIndex].title = title;
        }
        tab.isNavigating = false;
      }

      tab.url = currentUrl;
      if (tab === state.activeTab) {
        dom.addressInput.value = currentUrl;
        updateHistoryDropdown();
      }
      updateTabTitle(tab, title);
      updateFavicon();
      saveTabHistory(tab);
    }, 100);
  });

  webview.addEventListener('did-fail-load', () => {
    tab.isLoading = false;
    if (tab === state.activeTab) {
      updateTabTitle(tab, 'Loading Failed');
    }
  });

  webview.addEventListener('page-title-updated', (event) => {
    const title = event.title || 'Untitled Page';
    updateTabTitle(tab, title);
    if (tab.history[tab.historyIndex]) {
      tab.history[tab.historyIndex].title = title;
      saveTabHistory(tab);
    }
  });

  webview.addEventListener('page-favicon-updated', (event) => {
    if (event.favicons && event.favicons.length > 0) {
      updateFavicon(event.favicons[0]);
    }
  });

  webview.addEventListener('context-menu', (e) => {
    e.preventDefault();
    window.windowAPI?.showContextMenu(e.params, tab.tabId);
  });

  // new-window event - yeni sekme veya indirme için
  webview.addEventListener('new-window', (e) => {
    e.preventDefault();
    const url = e.url;
    
    // İndirilebilir dosya uzantıları
    const downloadExtensions = ['.pdf', '.zip', '.rar', '.7z', '.tar', '.gz', 
                               '.exe', '.dmg', '.pkg', '.deb', '.rpm',
                               '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.flv',
                               '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
                               '.iso', '.apk', '.ipa'];
    
    const isDownloadable = downloadExtensions.some(ext => url.toLowerCase().includes(ext));
    
    if (isDownloadable) {
      import("../downloads/downloadManager.js").then(({ startDownload }) => {
        const fileName = url.split('/').pop().split('?')[0];
        startDownload(url, fileName);
      });
    } else {
      // Normal link - aynı sekmede aç
      webview.loadURL(url);
    }
  });

  tabElement.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) {
      closeTab(tab);
    } else {
      switchTab(tab);
    }
  });

  state.tabs.push(tab);
  switchTab(tab);
  
  setTimeout(() => {
    makeTabsDraggable();
    updateActiveTabHighlight();
    webview.setUserAgent(userAgent);
  }, 100);
  
  return tab;
}

export function switchTab(tab) {
  if (state.activeTab) {
    state.activeTab.webview.classList.remove('active');
    state.activeTab.tabElement.classList.remove('active');
  }
  state.activeTab = tab;

  tab.webview.classList.add('active');
  tab.tabElement.classList.add('active');

  dom.addressInput.value = tab.url || '';
  updateHistoryDropdown();
  updateActiveTabHighlight();
}

export function closeTab(tab) {
  const index = state.tabs.indexOf(tab);
  
  try {
    const tabHistoryKey = `forkit_tab_history_${tab.tabId}`;
    localStorage.removeItem(tabHistoryKey);
  } catch (error) {
    console.error('Error clearing tab history:', error);
  }
  
  tab.webview.remove();
  tab.tabElement.remove();
  state.tabs.splice(index, 1);

  if (state.tabs.length === 0) {
    window.windowAPI?.closeApp();
    return;
  }

  if (state.activeTab === tab) {
    const newActive = state.tabs[Math.max(0, index - 1)];
    switchTab(newActive);
  }
  
  setTimeout(() => {
    makeTabsDraggable();
    updateActiveTabHighlight();
  }, 100);
}