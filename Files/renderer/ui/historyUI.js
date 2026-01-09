import { state } from "../core/state.js";
import { dom } from "../core/dom.js";

function formatTime(date) {
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString();
}

export function renderHistoryPage(filter = "") {
  dom.historyContent.innerHTML = '';

  let list = state.globalHistory;
  if (filter) {
    const low = filter.toLowerCase();
    list = state.globalHistory.filter(item =>
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
        // Dynamic import to avoid circular dependency
        import("../tabs/tabManager.js").then(({ createTab }) => {
          createTab(entry.url);
          dom.historyPage.style.display = 'none';
        });
      };
      g.appendChild(el);
    });
    dom.historyContent.appendChild(g);
  };

  renderGroup('Today', groups.today);
  renderGroup('Yesterday', groups.yesterday);
  renderGroup('Earlier', groups.older);

  if (list.length === 0) {
    dom.historyContent.innerHTML = '<p style="text-align:center;color:var(--tab-inactive);padding:60px;">No history found.</p>';
  }
}

export function updateHistoryDropdown() {
  dom.historyDropdown.innerHTML = '';
  if (!state.activeTab || state.activeTab.history.length <= 1) {
    dom.historyDropdown.style.display = 'none';
    return;
  }

  const recent = state.activeTab.history.slice().reverse().slice(0, 10);
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
      // Dynamic import to avoid circular dependency
      import("../navigation/navigation.js").then(({ navigateTo }) => {
        navigateTo(entry.url);
        dom.historyDropdown.style.display = 'none';
      });
    };
    dom.historyDropdown.appendChild(div);
  });
}
