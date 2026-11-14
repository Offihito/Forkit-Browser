import { createTab } from "../tabs/tabManager.js";
import { goBack, goForward, reload } from "../navigation/navigation.js";
import { isTauriEnv, isOverlayMode } from "../tauri/tauriBridge.js";

function ensureMenuElement() {
  let menu = document.getElementById('forkit-context-menu');
  if (menu) return menu;

  menu = document.createElement('div');
  menu.id = 'forkit-context-menu';
  menu.style.cssText = [
    'position: fixed',
    'z-index: 999999',
    'min-width: 215px',
    'background: #1e1e24',
    'color: #f1f1f4',
    'border: 1px solid rgba(255,255,255,0.14)',
    'border-radius: 10px',
    'padding: 6px 0',
    'box-shadow: 0 12px 32px rgba(0,0,0,0.55)',
    'font-family: inherit',
    'font-size: 13px',
    'display: none',
    'user-select: none',
  ].join(';');
  document.body.appendChild(menu);

  return menu;
}

function hideContextMenu() {
  const menu = document.getElementById('forkit-context-menu');
  if (menu) menu.style.display = 'none';
  if (isTauriEnv()) {
    window.__TAURI__.core.invoke('close_overlay_panel').catch(() => {});
  }
}

function addItem(menu, label, onClick, disabled = false) {
  const item = document.createElement('div');
  item.textContent = label;
  item.style.cssText = [
    'padding: 7px 14px',
    'cursor: ' + (disabled ? 'default' : 'pointer'),
    'opacity: ' + (disabled ? '0.42' : '1'),
    'white-space: nowrap',
  ].join(';');
  if (!disabled) {
    item.addEventListener('mouseenter', () => (item.style.background = 'rgba(255,255,255,0.1)'));
    item.addEventListener('mouseleave', () => (item.style.background = 'transparent'));
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      hideContextMenu();
      onClick();
    });
  }
  menu.appendChild(item);
}

function addSeparator(menu) {
  const sep = document.createElement('div');
  sep.style.cssText = 'height: 1px; margin: 4px 8px; background: rgba(255,255,255,0.1);';
  menu.appendChild(sep);
}

export function initTauriContextMenu() {
  if (!isTauriEnv()) return;

  const { invoke } = window.__TAURI__.core;
  const { listen, emit } = window.__TAURI__.event;

  if (!isOverlayMode()) {
    listen('ui-create-tab', ({ payload }) => {
      if (payload && payload.url) createTab(payload.url);
    });
    listen('ui-nav-command', ({ payload }) => {
      if (!payload) return;
      if (payload.action === 'back') goBack();
      else if (payload.action === 'forward') goForward();
      else if (payload.action === 'reload') reload();
    });
    return;
  }

  document.addEventListener('mousedown', (e) => {
    const menu = document.getElementById('forkit-context-menu');
    if (menu && menu.style.display !== 'none' && !menu.contains(e.target)) {
      hideContextMenu();
    }
  });

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const menu = document.getElementById('forkit-context-menu');
    if (menu && menu.style.display !== 'none' && !menu.contains(e.target)) {
      hideContextMenu();
    }
  });

  listen('overlay-open', ({ payload }) => {
    if (!payload || payload.panel !== 'context-menu') return;
    const params = payload.payload || {};
    const tabId = params.tabId || 1;

    const menu = ensureMenuElement();
    menu.innerHTML = '';

    if (params.hasSelection) {
      addItem(menu, 'Copy', () => {
        invoke('eval_tab_js', { tabId, script: "document.execCommand('copy')" }).catch(() => {});
      });
      addItem(menu, 'Search Google for selection', () => {
        invoke('eval_tab_js', {
          tabId,
          script: `
            (function() {
              var s = window.getSelection ? window.getSelection().toString().trim() : '';
              if (s) window.open('https://www.google.com/search?q=' + encodeURIComponent(s));
            })();
          `,
        }).catch(() => {});
      });
      addSeparator(menu);
    }

    if (params.linkURL) {
      addItem(menu, 'Open link in new tab', () => {
        emit('ui-create-tab', { url: params.linkURL });
      });
      addItem(menu, 'Copy link address', () => {
        invoke('copy_to_clipboard', { text: params.linkURL }).catch(() => {});
      });
      addSeparator(menu);
    }

    if (params.hasImageContents && params.srcURL) {
      const imageUrl = params.srcURL;
      addItem(menu, 'Open image in new tab', () => {
        emit('ui-create-tab', { url: imageUrl });
      });
      addItem(menu, 'Copy image address', () => {
        invoke('copy_to_clipboard', { text: imageUrl }).catch(() => {});
      });
      addItem(menu, 'Save image as...', () => {
        const fileName = imageUrl.split('/').pop().split('?')[0] || 'image.png';
        invoke('download_item', { url: imageUrl, fileName }).catch(() => {});
      });
      addSeparator(menu);
    }

    if (params.isEditable) {
      addItem(menu, 'Paste', () => {
        invoke('eval_tab_js', { tabId, script: "document.execCommand('paste')" }).catch(() => {});
      });
      addItem(menu, 'Cut', () => {
        invoke('eval_tab_js', { tabId, script: "document.execCommand('cut')" }).catch(() => {});
      });
      addSeparator(menu);
    }

    addItem(menu, 'Back', () => emit('ui-nav-command', { action: 'back' }));
    addItem(menu, 'Forward', () => emit('ui-nav-command', { action: 'forward' }));
    addItem(menu, 'Refresh', () => invoke('reload_tab', { tabId }).catch(() => {}));
    addSeparator(menu);

    addItem(menu, 'Print...', () => {
      invoke('print_tab', { tabId }).catch(() => {});
    });
    addItem(menu, 'Inspect (DevTools)', () => {
      invoke('toggle_devtools_tab', { tabId }).catch(() => {});
    });

    menu.style.display = 'block';
    const menuW = menu.offsetWidth || 220;
    const menuH = menu.offsetHeight || 260;
    const x = Math.min(window.innerWidth - menuW - 8, Math.max(8, Math.round(params.x || 20)));
    const y = Math.min(window.innerHeight - menuH - 8, Math.max(8, Math.round(params.y || 20)));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    setTimeout(() => {
      invoke('reveal_overlay').catch(() => {});
    }, 16);
  });
}
