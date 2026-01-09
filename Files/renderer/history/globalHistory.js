import { state } from "../core/state.js";

export function loadGlobalHistory() {
  try {
    const saved = localStorage.getItem('forkit_global_history');
    if (saved) {
      const parsed = JSON.parse(saved);
      // Convert timestamps to Date objects
      state.globalHistory = parsed.map(entry => ({
        ...entry,
        time: new Date(entry.time)
      }));
      console.log('History loaded:', state.globalHistory.length, 'entries');
    }
  } catch (error) {
    console.error('Error loading history:', error);
    state.globalHistory = [];
  }
}

export function saveGlobalHistory() {
  try {
    localStorage.setItem('forkit_global_history', JSON.stringify(state.globalHistory));
    console.log('History saved:', state.globalHistory.length, 'entries');
  } catch (error) {
    console.error('Error saving history:', error);
  }
}

export function clearHistory() {
  state.globalHistory.length = 0;
  saveGlobalHistory();
  
  state.tabs.forEach(tab => {
    const currentEntry = tab.history[tab.historyIndex];
    tab.history = [currentEntry];
    tab.historyIndex = 0;
    saveTabHistory(tab);
  });
  
  // UI'ı güncelle - dynamic import ile circular dependency sorunu çöz
  import("../ui/historyUI.js").then(({ renderHistoryPage, updateHistoryDropdown }) => {
    renderHistoryPage();
    updateHistoryDropdown();
  });
}

// Save individual tab history
export function saveTabHistory(tab) {
  try {
    const tabHistoryKey = `forkit_tab_history_${tab.tabId}`;
    localStorage.setItem(tabHistoryKey, JSON.stringify({
      history: tab.history,
      historyIndex: tab.historyIndex,
      url: tab.url
    }));
  } catch (error) {
    console.error('Error saving tab history:', error);
  }
}

// Load individual tab history
export function loadTabHistory(tab) {
  try {
    const tabHistoryKey = `forkit_tab_history_${tab.tabId}`;
    const saved = localStorage.getItem(tabHistoryKey);
    if (saved) {
      const parsed = JSON.parse(saved);
      tab.history = parsed.history.map(entry => ({
        ...entry,
        time: new Date(entry.time)
      }));
      tab.historyIndex = parsed.historyIndex;
      return true;
    }
  } catch (error) {
    console.error('Error loading tab history:', error);
  }
  return false;
}
