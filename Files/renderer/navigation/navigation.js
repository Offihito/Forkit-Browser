import { state } from "../core/state.js";
import { dom } from "../core/dom.js";
import { saveTabHistory } from "../history/globalHistory.js";
import { updateHistoryDropdown, renderHistoryPage } from "../ui/historyUI.js";
import { clearHistory } from "../history/globalHistory.js";

export function goBack() {
  if (!state.activeTab || state.activeTab.historyIndex <= 0) return;
  
  state.activeTab.isNavigating = true;
  state.activeTab.historyIndex--;
  const entry = state.activeTab.history[state.activeTab.historyIndex];
  state.activeTab.webview.loadURL(entry.url);
  dom.addressInput.value = entry.url;
  updateNavigationButtons();
  saveTabHistory(state.activeTab);
}

export function goForward() {
  if (!state.activeTab || state.activeTab.historyIndex >= state.activeTab.history.length - 1) return;
  
  state.activeTab.isNavigating = true;
  state.activeTab.historyIndex++;
  const entry = state.activeTab.history[state.activeTab.historyIndex];
  state.activeTab.webview.loadURL(entry.url);
  dom.addressInput.value = entry.url;
  updateNavigationButtons();
  saveTabHistory(state.activeTab);
}

export function reload() {
  if (state.activeTab) {
    state.activeTab.isNavigating = false;
    state.activeTab.webview.reload(); 
  }
}

export function goHome() {
  navigateTo('https://www.google.com'); 
}

export function navigateTo(url) {
  if (!url || !state.activeTab) return;
  
  state.activeTab.isNavigating = false;
  
  let displayUrl = url;
  let actualUrl = url;
  
  if (!/^https?:\/\//i.test(url)) {
    if (url.includes('.') && !url.includes(' ')) {
      actualUrl = 'https://' + url;
      displayUrl = url;
    } else {
      actualUrl = 'https://www.google.com/search?q=' + encodeURIComponent(url);
      displayUrl = url;
    }
  }
  
  state.activeTab.webview.loadURL(actualUrl);
  dom.addressInput.value = displayUrl;
  dom.historyDropdown.style.display = 'none';
}

export function updateNavigationButtons() {
  if (!state.activeTab) {
    dom.backBtn.disabled = true;
    dom.forwardBtn.disabled = true;
    return;
  }
  
  dom.backBtn.disabled = state.activeTab.historyIndex <= 0;
  dom.forwardBtn.disabled = state.activeTab.historyIndex >= state.activeTab.history.length - 1;
}

// Event Listeners
export function initNavigation(createTabFn) {
  dom.backBtn.onclick = goBack;
  dom.forwardBtn.onclick = goForward;
  dom.refreshBtn.onclick = reload;
  dom.homeBtn.onclick = goHome;
  dom.newTabBtn.onclick = () => createTabFn();
  dom.goBtn.onclick = () => navigateTo(dom.addressInput.value);

  dom.addressInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') navigateTo(dom.addressInput.value);
  });

  dom.addressInput.addEventListener('focus', () => {
    if (state.activeTab && state.activeTab.history.length > 1) {
      updateHistoryDropdown();
      dom.historyDropdown.style.display = 'block';
    }
  });

  document.addEventListener('click', (e) => {
    if (!dom.addressInput.contains(e.target) && !dom.historyDropdown.contains(e.target)) {
      dom.historyDropdown.style.display = 'none';
    }
  });

  dom.historyBtn.onclick = () => {
    renderHistoryPage();
    dom.historyPage.style.display = 'flex';
    dom.historySearch.focus();
  };

  dom.historyClose.onclick = () => {
    dom.historyPage.style.display = 'none';
    dom.historySearch.value = '';
  };

  dom.historySearch.addEventListener('input', (e) => {
    renderHistoryPage(e.target.value);
  });

  dom.dpiIndicator.onclick = () => {
    dom.dpiModal.style.display = 'flex';
  };

  dom.dpiModalClose.onclick = () => {
    dom.dpiModal.style.display = 'none';
  };

  dom.dpiModal.addEventListener('click', (e) => {
    if (e.target === dom.dpiModal) {
      dom.dpiModal.style.display = 'none';
    }
  });

  dom.clearHistoryBtn.onclick = () => {
    dom.confirmDialog.style.display = 'flex';
  };

  dom.confirmCancel.onclick = () => {
    dom.confirmDialog.style.display = 'none';
  };

  dom.confirmOk.onclick = () => {
    clearHistory();
    dom.confirmDialog.style.display = 'none';
  };

  dom.confirmDialog.addEventListener('click', (e) => {
    if (e.target === dom.confirmDialog) {
      dom.confirmDialog.style.display = 'none';
    }
  });
}
