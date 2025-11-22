// renderer.js – Forkit Browser (DPI Bypass + Context Menu)

const tabsBar = document.getElementById('tabs-bar');
const webviewContainer = document.getElementById('webview-container');
const addressInput = document.getElementById('address');
const historyDropdown = document.getElementById('history-dropdown');

const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const refreshBtn = document.getElementById('refresh');
const homeBtn = document.getElementById('home');
const goBtn = document.getElementById('go');
const newTabBtn = document.getElementById('new-tab');
const historyBtn = document.getElementById('history-btn');
const dpiIndicator = document.getElementById('dpi-indicator');

const historyPage = document.getElementById('history-page');
const historyClose = document.getElementById('history-close');
const historyContent = document.getElementById('history-content');
const historySearch = document.getElementById('history-search');
const clearHistoryBtn = document.getElementById('clear-history-btn');

const confirmDialog = document.getElementById('confirm-dialog');
const confirmCancel = document.getElementById('confirm-cancel');
const confirmOk = document.getElementById('confirm-ok');

const dpiModal = document.getElementById('dpi-modal');
const dpiModalClose = document.getElementById('dpi-modal-close');

let tabs = [];
let activeTab = null;
let tabIdCounter = 0;

// Tüm sekmelerin birleşik geçmişi
let globalHistory = [];

// Yeni sekme oluştur
function createTab(url = 'https://www.google.com') {
  const webview = document.createElement('webview');
  webview.src = url;
  webview.partition = 'persist:browser';
  webview.classList.add('webview');
  webviewContainer.appendChild(webview);

  const tabId = ++tabIdCounter;

  const tabElement = document.createElement('div');
  tabElement.className = 'tab';
  tabElement.innerHTML = `
    <img class="tab-favicon" src="https://www.google.com/s2/favicons?domain=${url}&sz=32" alt="">
    <span class="tab-title">Yeni Sekme</span>
    <span class="tab-close">×</span>
  `;
  tabsBar.appendChild(tabElement);

  const history = [{
    url,
    title: 'Yeni Sekme',
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
  };

  webview.addEventListener('did-start-loading', () => {
    tab.isLoading = true;
    updateTabTitle(tab, 'Yükleniyor...');
  });

  webview.addEventListener('did-finish-load', () => {
    tab.isLoading = false;
    const currentUrl = webview.getURL();
    
    // Başlık güncellemesini bekle
    setTimeout(() => {
      const title = webview.getTitle() || 'Adsız Sayfa';
      
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

          const lastGlobal = globalHistory[globalHistory.length - 1];
          if (!lastGlobal || lastGlobal.url !== currentUrl || lastGlobal.tabId !== tabId) {
            globalHistory.push({
              url: currentUrl,
              title,
              favicon: `https://www.google.com/s2/favicons?domain=${currentUrl}&sz=64`,
              time: new Date(),
              tabId
            });
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
      if (tab === activeTab) {
        addressInput.value = currentUrl;
        updateNavigationButtons();
        updateHistoryDropdown();
      }
      updateTabTitle(tab, title);
      updateFavicon();
    }, 100);
  });

  webview.addEventListener('did-fail-load', () => {
    tab.isLoading = false;
    if (tab === activeTab) {
      updateTabTitle(tab, 'Yükleme Hatası');
    }
  });

  webview.addEventListener('page-title-updated', (event) => {
    const title = event.title || 'Adsız Sayfa';
    updateTabTitle(tab, title);
    if (tab.history[tab.historyIndex]) {
      tab.history[tab.historyIndex].title = title;
    }
  });

  webview.addEventListener('page-favicon-updated', (event) => {
    if (event.favicons && event.favicons.length > 0) {
      updateFavicon(event.favicons[0]);
    }
  });

  // Context menu (sağ tık menüsü)
  webview.addEventListener('context-menu', (e) => {
    e.preventDefault();
    showContextMenu(e, tab);
  });

  tabElement.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) {
      closeTab(tab);
    } else {
      switchTab(tab);
    }
  });

  tabs.push(tab);
  switchTab(tab);
  
  setTimeout(() => {
    makeTabsDraggable();
    updateActiveTabHighlight();
  }, 100);
  
  return tab;
}

function updateTabTitle(tab, text = null) {
  const title = text || tab.webview.getTitle() || 'Yeni Sekme';
  tab.tabElement.querySelector('.tab-title').textContent = title;
}

function switchTab(tab) {
  if (activeTab) {
    activeTab.webview.classList.remove('active');
    activeTab.tabElement.classList.remove('active');
  }
  activeTab = tab;

  tab.webview.classList.add('active');
  tab.tabElement.classList.add('active');

  addressInput.value = tab.url || '';
  updateNavigationButtons();
  updateHistoryDropdown();
  updateActiveTabHighlight();
}

function closeTab(tabToClose) {
  const index = tabs.indexOf(tabToClose);
  tabToClose.webview.remove();
  tabToClose.tabElement.remove();
  tabs.splice(index, 1);

  if (tabs.length === 0) {
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('close-app');
    return;
  }

  if (activeTab === tabToClose) {
    const newActive = tabs[Math.max(0, index - 1)];
    switchTab(newActive);
  }
  
  setTimeout(() => {
    makeTabsDraggable();
    updateActiveTabHighlight();
  }, 100);
}

function goBack() {
  if (!activeTab || activeTab.historyIndex <= 0) return;
  
  activeTab.isNavigating = true;
  activeTab.historyIndex--;
  const entry = activeTab.history[activeTab.historyIndex];
  activeTab.webview.loadURL(entry.url);
  addressInput.value = entry.url;
  updateNavigationButtons();
}

function goForward() {
  if (!activeTab || activeTab.historyIndex >= activeTab.history.length - 1) return;
  
  activeTab.isNavigating = true;
  activeTab.historyIndex++;
  const entry = activeTab.history[activeTab.historyIndex];
  activeTab.webview.loadURL(entry.url);
  addressInput.value = entry.url;
  updateNavigationButtons();
}

function reload() { 
  if (activeTab) {
    activeTab.isNavigating = false;
    activeTab.webview.reload(); 
  }
}

function goHome() { 
  navigateTo('https://www.google.com'); 
}

function navigateTo(url) {
  if (!url || !activeTab) return;
  
  activeTab.isNavigating = false;
  
  let displayUrl = url;
  let actualUrl = url;
  
  if (!/^https?:\/\//i.test(url)) {
    if (url.includes('.') && !url.includes(' ')) {
      // URL gibi görünüyor
      actualUrl = 'https://' + url;
      displayUrl = url;
    } else {
      // Arama sorgusu
      actualUrl = 'https://www.google.com/search?q=' + encodeURIComponent(url);
      displayUrl = url; // Sadece arama terimini göster
    }
  }
  
  activeTab.webview.loadURL(actualUrl);
  addressInput.value = displayUrl;
  historyDropdown.style.display = 'none';
}

function updateNavigationButtons() {
  if (!activeTab) {
    backBtn.disabled = true;
    forwardBtn.disabled = true;
    return;
  }
  
  backBtn.disabled = activeTab.historyIndex <= 0;
  forwardBtn.disabled = activeTab.historyIndex >= activeTab.history.length - 1;
}

function updateHistoryDropdown() {
  historyDropdown.innerHTML = '';
  if (!activeTab || activeTab.history.length <= 1) {
    historyDropdown.style.display = 'none';
    return;
  }

  const recent = activeTab.history.slice().reverse().slice(0, 10);
  recent.forEach(entry => {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `
      <img src="${entry.favicon}" alt="">
      <span>${entry.title}</span>
      <small>${new URL(entry.url).hostname}</small>
    `;
    div.onclick = (e) => {
      e.stopPropagation();
      navigateTo(entry.url);
      historyDropdown.style.display = 'none';
    };
    historyDropdown.appendChild(div);
  });
}

function formatTime(date) {
  const now = new Date();
  const diff = now - date;
  const dayDiff = Math.floor(diff / 86400000);

  if (dayDiff === 0) return 'Bugün – ' + date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  if (dayDiff === 1) return 'Dün – ' + date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  if (dayDiff < 7) return `${dayDiff} gün önce`;
  return date.toLocaleDateString('tr-TR');
}

function renderHistoryPage(filter = '') {
  historyContent.innerHTML = '';

  let list = globalHistory;
  if (filter) {
    const low = filter.toLowerCase();
    list = globalHistory.filter(item =>
      item.title.toLowerCase().includes(low) || item.url.toLowerCase().includes(low)
    );
  }

  const groups = { today: [], yesterday: [], older: [] };
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  list.forEach(entry => {
    if (entry.time >= todayStart) groups.today.push(entry);
    else if (entry.time >= new Date(todayStart - 86400000)) groups.yesterday.push(entry);
    else groups.older.push(entry);
  });

  const renderGroup = (title, arr) => {
    if (arr.length === 0) return;
    const g = document.createElement('div');
    g.className = 'history-group';
    g.innerHTML = `<h3>${title}</h3>`;
    arr.reverse().forEach(entry => {
      const el = document.createElement('div');
      el.className = 'history-entry';
      el.innerHTML = `
        <img src="${entry.favicon}" onerror="this.src='https://www.google.com/s2/favicons?sz=64'">
        <div class="info">
          <div class="title">${entry.title}</div>
          <div class="url">${entry.url}</div>
        </div>
        <div class="time">${formatTime(entry.time)}</div>
      `;
      el.onclick = () => {
        createTab(entry.url);
        historyPage.style.display = 'none';
      };
      g.appendChild(el);
    });
    historyContent.appendChild(g);
  };

  renderGroup('Bugün', groups.today);
  renderGroup('Dün', groups.yesterday);
  renderGroup('Daha Eski', groups.older);

  if (list.length === 0) {
    historyContent.innerHTML = '<p style="text-align:center;color:var(--tab-inactive);padding:60px;">Geçmiş bulunamadı.</p>';
  }
}

// Geçmiş temizleme fonksiyonu
function clearHistory() {
  globalHistory.length = 0;
  
  tabs.forEach(tab => {
    const currentEntry = tab.history[tab.historyIndex];
    tab.history = [currentEntry];
    tab.historyIndex = 0;
  });
  
  renderHistoryPage();
  updateHistoryDropdown();
}

// Event Listeners
backBtn.onclick = goBack;
forwardBtn.onclick = goForward;
refreshBtn.onclick = reload;
homeBtn.onclick = goHome;
newTabBtn.onclick = () => createTab();
goBtn.onclick = () => navigateTo(addressInput.value);

addressInput.addEventListener('keypress', e => {
  if (e.key === 'Enter') navigateTo(addressInput.value);
});

addressInput.addEventListener('focus', () => {
  if (activeTab && activeTab.history.length > 1) {
    updateHistoryDropdown();
    historyDropdown.style.display = 'block';
  }
});

document.addEventListener('click', (e) => {
  if (!addressInput.contains(e.target) && !historyDropdown.contains(e.target)) {
    historyDropdown.style.display = 'none';
  }
});

historyBtn.onclick = () => {
  renderHistoryPage();
  historyPage.style.display = 'flex';
  historySearch.focus();
};

historyClose.onclick = () => {
  historyPage.style.display = 'none';
  historySearch.value = '';
};

historySearch.addEventListener('input', (e) => renderHistoryPage(e.target.value));

// DPI Bypass modal
dpiIndicator.onclick = () => {
  dpiModal.style.display = 'flex';
};

dpiModalClose.onclick = () => {
  dpiModal.style.display = 'none';
};

// Modal dışına tıklayınca kapat
dpiModal.addEventListener('click', (e) => {
  if (e.target === dpiModal) {
    dpiModal.style.display = 'none';
  }
});

// Geçmiş temizleme butonları
clearHistoryBtn.onclick = () => {
  confirmDialog.style.display = 'flex';
};

confirmCancel.onclick = () => {
  confirmDialog.style.display = 'none';
};

confirmOk.onclick = () => {
  clearHistory();
  confirmDialog.style.display = 'none';
};

// Dialog dışına tıklayınca kapat
confirmDialog.addEventListener('click', (e) => {
  if (e.target === confirmDialog) {
    confirmDialog.style.display = 'none';
  }
});

// ==================== SEKME SIRALAMA – DRAG & DROP ====================
let draggedTab = null;

function makeTabsDraggable() {
  const tabElements = document.querySelectorAll('.tab');
  
  tabElements.forEach(tabEl => {
    if (!tabEl.dataset.tabId) {
      const tabObj = tabs.find(t => t.tabElement === tabEl);
      if (tabObj && tabObj.tabId) {
        tabEl.dataset.tabId = tabObj.tabId;
      } else {
        tabEl.dataset.tabId = 'tab-' + Date.now() + Math.random();
      }
    }

    tabEl.setAttribute('draggable', true);

    tabEl.removeEventListener('dragstart', handleDragStart);
    tabEl.removeEventListener('dragend', handleDragEnd);
    tabEl.removeEventListener('dragover', handleDragOver);
    tabEl.removeEventListener('dragleave', handleDragLeave);
    tabEl.removeEventListener('drop', handleDrop);

    tabEl.addEventListener('dragstart', handleDragStart);
    tabEl.addEventListener('dragend', handleDragEnd);
    tabEl.addEventListener('dragover', handleDragOver);
    tabEl.addEventListener('dragleave', handleDragLeave);
    tabEl.addEventListener('drop', handleDrop);
  });
}

function handleDragStart(e) {
  const tabEl = e.target.closest('.tab');
  if (!tabEl) return;
  
  draggedTab = tabs.find(t => t.tabElement === tabEl);
  
  if (!draggedTab) return;

  tabEl.classList.add('dragging');
  
  const dummy = document.createElement('div');
  dummy.style.width = '1px';
  dummy.style.height = '1px';
  e.dataTransfer.setDragImage(dummy, 0, 0);
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
  const tabEl = e.target.closest('.tab');
  if (tabEl) tabEl.classList.remove('dragging');
  document.querySelectorAll('.tab.drag-over').forEach(el => el.classList.remove('drag-over'));
  draggedTab = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const tabEl = e.target.closest('.tab');
  if (tabEl) tabEl.classList.add('drag-over');
}

function handleDragLeave(e) {
  const tabEl = e.target.closest('.tab');
  if (tabEl) tabEl.classList.remove('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  const targetEl = e.target.closest('.tab');
  if (!targetEl) return;
  
  targetEl.classList.remove('drag-over');

  if (!draggedTab) return;

  const targetTab = tabs.find(t => t.tabElement === targetEl);

  if (!targetTab || draggedTab === targetTab) return;

  const fromIndex = tabs.indexOf(draggedTab);
  const toIndex = tabs.indexOf(targetTab);

  if (fromIndex === -1 || toIndex === -1) return;

  if (fromIndex < toIndex) {
    tabsBar.insertBefore(draggedTab.tabElement, targetEl.nextSibling);
  } else {
    tabsBar.insertBefore(draggedTab.tabElement, targetEl);
  }

  tabs.splice(fromIndex, 1);
  tabs.splice(toIndex > fromIndex ? toIndex : toIndex, 0, draggedTab);

  updateActiveTabHighlight();
}

function updateActiveTabHighlight() {
  document.querySelectorAll('.tab').forEach(tabEl => {
    const tabObj = tabs.find(t => t.tabElement === tabEl);
    if (tabObj) {
      tabEl.classList.toggle('active', tabObj === activeTab);
    }
  });
}

// ==================== CONTEXT MENU (SAĞ TIK MENÜSÜ) ====================
const { ipcRenderer, clipboard, shell } = require('electron');

// Remote modülünü kontrol et
let Menu, MenuItem;
try {
  const remote = require('@electron/remote');
  Menu = remote.Menu;
  MenuItem = remote.MenuItem;
} catch (e) {
  console.warn('@electron/remote yüklü değil, context menu devre dışı');
}

function showContextMenu(event, tab) {
  // Eğer Menu yüklü değilse basit bir context menu göster
  if (!Menu || !MenuItem) {
    console.warn('Context menu desteklenmiyor');
    return;
  }

  const params = event.params;
  const menu = new Menu();

  // Metin seçiliyse
  if (params.selectionText) {
    menu.append(new MenuItem({
      label: 'Kopyala',
      accelerator: 'CmdOrCtrl+C',
      click: () => {
        clipboard.writeText(params.selectionText);
      }
    }));

    menu.append(new MenuItem({
      label: `"${params.selectionText.substring(0, 30)}..." için Google'da ara`,
      click: () => {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`;
        createTab(searchUrl);
      }
    }));

    menu.append(new MenuItem({ type: 'separator' }));
  }

  // Link üzerinde
  if (params.linkURL) {
    menu.append(new MenuItem({
      label: 'Linki yeni sekmede aç',
      click: () => {
        createTab(params.linkURL);
      }
    }));

    menu.append(new MenuItem({
      label: 'Link adresini kopyala',
      click: () => {
        clipboard.writeText(params.linkURL);
      }
    }));

    menu.append(new MenuItem({ type: 'separator' }));
  }

  // Resim üzerinde
  if (params.hasImageContents || params.srcURL) {
    const imageUrl = params.srcURL;
    
    menu.append(new MenuItem({
      label: 'Resmi yeni sekmede aç',
      click: () => {
        createTab(imageUrl);
      }
    }));

    menu.append(new MenuItem({
      label: 'Resim adresini kopyala',
      click: () => {
        clipboard.writeText(imageUrl);
      }
    }));

    menu.append(new MenuItem({
      label: 'Resmi farklı kaydet...',
      click: async () => {
        try {
          const fileName = imageUrl.split('/').pop().split('?')[0] || 'image.png';
          const result = await ipcRenderer.invoke('save-image', imageUrl, fileName);
          if (result.success) {
            console.log('Resim kaydedildi');
          }
        } catch (error) {
          console.error('Resim kaydetme hatası:', error);
        }
      }
    }));

    menu.append(new MenuItem({ type: 'separator' }));
  }

  // Genel menü öğeleri
  if (params.isEditable) {
    menu.append(new MenuItem({
      label: 'Yapıştır',
      accelerator: 'CmdOrCtrl+V',
      click: () => {
        tab.webview.paste();
      }
    }));

    menu.append(new MenuItem({
      label: 'Kes',
      accelerator: 'CmdOrCtrl+X',
      click: () => {
        tab.webview.cut();
      }
    }));

    menu.append(new MenuItem({ type: 'separator' }));
  }

  menu.append(new MenuItem({
    label: 'Geri',
    enabled: tab.historyIndex > 0,
    click: () => goBack()
  }));

  menu.append(new MenuItem({
    label: 'İleri',
    enabled: tab.historyIndex < tab.history.length - 1,
    click: () => goForward()
  }));

  menu.append(new MenuItem({
    label: 'Yenile',
    accelerator: 'CmdOrCtrl+R',
    click: () => reload()
  }));

  menu.append(new MenuItem({ type: 'separator' }));

  menu.append(new MenuItem({
    label: 'Sayfayı farklı kaydet...',
    accelerator: 'CmdOrCtrl+S',
    click: async () => {
      try {
        const url = tab.webview.getURL();
        const title = tab.webview.getTitle();
        const result = await ipcRenderer.invoke('save-page', url, title);
        
        if (result.success && result.filePath) {
          // Sayfa içeriğini al ve kaydet
          tab.webview.executeJavaScript('document.documentElement.outerHTML')
            .then(html => {
              const fs = require('fs');
              fs.writeFileSync(result.filePath, html, 'utf8');
              console.log('Sayfa kaydedildi:', result.filePath);
            })
            .catch(err => console.error('Sayfa kaydetme hatası:', err));
        }
      } catch (error) {
        console.error('Sayfa kaydetme hatası:', error);
      }
    }
  }));

  menu.append(new MenuItem({
    label: 'Yazdır...',
    accelerator: 'CmdOrCtrl+P',
    click: () => {
      tab.webview.print();
    }
  }));

  menu.append(new MenuItem({ type: 'separator' }));

  menu.append(new MenuItem({
    label: 'Kaynağı görüntüle',
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
    label: 'Öğeyi denetle (DevTools)',
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

// İlk sekme
createTab('https://www.google.com');

setTimeout(() => {
  makeTabsDraggable();
  updateActiveTabHighlight();
}, 500);