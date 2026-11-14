// tauriBridge.js - Tauri v2 backend bridge for Forkit Browser (WebKitGTK on Linux, WebView2 on Windows)

const isTauri = Boolean(window.__TAURI__ && window.__TAURI__.core);

export function isTauriEnv() {
  return isTauri;
}

export function isOverlayMode() {
  return window.location.search.includes('overlay=1');
}

export function getWebviewBounds() {
  const tabsBar = document.getElementById('tabs-bar');
  const toolbar = document.querySelector('.toolbar');
  const topHeight = Math.ceil(
    (tabsBar ? tabsBar.getBoundingClientRect().height : 48) +
      (toolbar ? toolbar.getBoundingClientRect().height : 56)
  );
  return {
    x: 0,
    y: Math.max(96, topHeight),
    width: Math.max(100, window.innerWidth),
    height: Math.max(100, window.innerHeight - Math.max(96, topHeight)),
  };
}

export function syncOverlayVisibility() {
  // No-op: overlay lives in its own dedicated child webview so UI never resizes.
}

export function initTauriWindowAPI() {
  if (!isTauri) return;

  const { invoke } = window.__TAURI__.core;
  const { listen, emit } = window.__TAURI__.event;

  window.windowAPI = {
    minimize: () => invoke('window_minimize'),
    maximize: () => invoke('window_maximize'),
    close: () => invoke('window_close'),
    closeApp: () => invoke('close_app'),

    downloadItem: (url, fileName) => {
      if (typeof url === 'string' && typeof fileName === 'string') {
        invoke('download_item', { url, fileName }).catch((err) =>
          console.error('download_item error:', err)
        );
      }
    },

    onDownloadProgress: (cb) => {
      if (typeof cb === 'function') {
        listen('download-progress', (e) => cb(e.payload));
      }
    },

    onDownloadComplete: (cb) => {
      if (typeof cb === 'function') {
        listen('download-complete', (e) => cb(e.payload));
      }
    },

    onDownloadError: (cb) => {
      if (typeof cb === 'function') {
        listen('download-error', (e) => cb(e.payload));
      }
    },

    onStartDownloadFromWebview: (cb) => {
      if (typeof cb === 'function') {
        listen('start-download-from-webview', (e) => cb(e.payload));
      }
    },

    showContextMenu: () => {},
    onContextMenuCommand: () => {},

    adBlock: {
      getStats: () => invoke('get_adblock_stats'),
      toggle: (enabled) => invoke('toggle_adblock', { enabled }),
      updateFilterLists: () => invoke('update_filter_lists'),
      addCustomFilter: (filter) => invoke('add_custom_filter', { filter }),
      addToWhitelist: (domain) => invoke('add_to_whitelist', { domain }),
      resetStats: () => invoke('reset_adblock_stats'),
      getStatus: () => invoke('get_adblock_status'),
    },

    ping: () => console.log('Tauri bridge active'),
  };

  if (isOverlayMode()) {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    const tabsBar = document.getElementById('tabs-bar');
    const toolbar = document.querySelector('.toolbar');
    const webviewContainer = document.getElementById('webview-container');
    if (tabsBar) tabsBar.style.display = 'none';
    if (toolbar) toolbar.style.display = 'none';
    if (webviewContainer) webviewContainer.style.display = 'none';

    const historyPage = document.getElementById('history-page');
    if (historyPage) historyPage.style.top = '0px';
    const downloadPanel = document.getElementById('download-panel');
    if (downloadPanel) downloadPanel.style.top = '0px';

    const closeAllAndHideOverlay = () => {
      const dpiModal = document.getElementById('dpi-modal');
      const confirmDialog = document.getElementById('confirm-dialog');
      const ctxMenu = document.getElementById('forkit-context-menu');
      if (historyPage) historyPage.style.display = 'none';
      if (dpiModal) dpiModal.style.display = 'none';
      if (confirmDialog) confirmDialog.style.display = 'none';
      if (downloadPanel) downloadPanel.classList.remove('open');
      if (ctxMenu) ctxMenu.style.display = 'none';
      invoke('close_overlay_panel').catch(() => {});
    };

    const openPanel = (panel) => {
      if (historyPage) historyPage.style.display = 'none';
      const dpiModal = document.getElementById('dpi-modal');
      const ctxMenu = document.getElementById('forkit-context-menu');
      if (dpiModal) dpiModal.style.display = 'none';
      if (downloadPanel) downloadPanel.classList.remove('open');
      if (ctxMenu && panel !== 'context-menu') ctxMenu.style.display = 'none';

      if (panel === 'dpi' && dpiModal) {
        dpiModal.style.display = 'flex';
      } else if (panel === 'history') {
        document.getElementById('history-btn')?.click();
      } else if (panel === 'downloads' && downloadPanel) {
        downloadPanel.classList.add('open');
      }

      if (panel !== 'context-menu') {
        setTimeout(() => {
          invoke('reveal_overlay').catch(() => {});
        }, 16);
      }
    };

    listen('overlay-open', ({ payload }) => {
      openPanel(payload && payload.panel);
    });

    const initialPanel = new URLSearchParams(window.location.search).get('panel');
    if (initialPanel) {
      setTimeout(() => openPanel(initialPanel), 30);
    }

    setTimeout(() => {
      const dpiModal = document.getElementById('dpi-modal');
      document.getElementById('dpi-modal-close')?.addEventListener('click', closeAllAndHideOverlay);
      document.getElementById('history-close')?.addEventListener('click', closeAllAndHideOverlay);
      document.getElementById('download-close')?.addEventListener('click', closeAllAndHideOverlay);
      if (dpiModal) {
        dpiModal.addEventListener('click', (e) => {
          if (e.target === dpiModal) closeAllAndHideOverlay();
        });
      }
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAllAndHideOverlay();
      });
    }, 0);
  } else {
    // Main UI bar: delegate modal/panel buttons to the dedicated overlay webview
    setTimeout(() => {
      const dpiBtn = document.getElementById('dpi-indicator');
      const historyBtn = document.getElementById('history-btn');
      const downloadBtn = document.getElementById('download-btn');

      if (dpiBtn) {
        dpiBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          invoke('open_overlay_panel', { panel: 'dpi', payload: null }).catch(() => {});
        };
      }
      if (historyBtn) {
        historyBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          invoke('open_overlay_panel', { panel: 'history', payload: null }).catch(() => {});
        };
      }
      if (downloadBtn) {
        downloadBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          invoke('open_overlay_panel', { panel: 'downloads', payload: null }).catch(() => {});
        };
      }
    }, 50);

    listen('overlay-navigate', ({ payload }) => {
      if (payload && payload.url) {
        emit('ui-navigate-url', { url: payload.url });
      }
    });
  }
}
