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
    // SECURITY: Use textContent for title, not innerHTML
    const h3 = document.createElement('h3');
    h3.textContent = title;
    g.appendChild(h3);
    
    arr.reverse().forEach(entry => {
      const el = document.createElement('div');
      el.className = 'history-entry';
      
      // SECURITY: Build DOM safely without innerHTML injection
      const img = document.createElement('img');
      img.src = entry.favicon || 'https://www.google.com/s2/favicons?sz=64';
      img.onerror = () => { img.src = 'https://www.google.com/s2/favicons?sz=64'; };
      el.appendChild(img);
      
      const info = document.createElement('div');
      info.className = 'info';
      
      const titleDiv = document.createElement('div');
      titleDiv.className = 'title';
      titleDiv.textContent = entry.title;
      info.appendChild(titleDiv);
      
      const urlDiv = document.createElement('div');
      urlDiv.className = 'url';
      urlDiv.textContent = entry.url;
      info.appendChild(urlDiv);
      
      el.appendChild(info);
      
      const timeDiv = document.createElement('div');
      timeDiv.className = 'time';
      timeDiv.textContent = formatTime(entry.time);
      el.appendChild(timeDiv);
      
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
    let hostname = entry.url;
    try { hostname = new URL(entry.url).hostname; } catch(e) {}
    
    const div = document.createElement('div');
    div.className = 'history-item';
    
    // SECURITY: Build DOM safely without innerHTML injection
    const img = document.createElement('img');
    img.src = entry.favicon || '';
    img.alt = '';
    div.appendChild(img);
    
    const span = document.createElement('span');
    span.textContent = entry.title;
    div.appendChild(span);
    
    const small = document.createElement('small');
    small.textContent = hostname;
    div.appendChild(small);
    
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
