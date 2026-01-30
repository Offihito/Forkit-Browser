// Saat ve tarih güncelleme
function updateTime() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false 
  });
  const dateStr = now.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  document.getElementById('time').textContent = timeStr;
  document.getElementById('date').textContent = dateStr;
}

updateTime();
setInterval(updateTime, 1000);

// Tema değiştirme
function toggleTheme() {
  document.body.classList.toggle('dark');
  // Webview içinde localStorage kullan
  try {
    localStorage.setItem('newtab_theme', document.body.classList.contains('dark') ? 'dark' : 'light');
  } catch (e) {
    console.log('LocalStorage not available');
  }
}

// Tema yükle
try {
  const savedTheme = localStorage.getItem('newtab_theme');
  if (savedTheme === 'dark') {
    document.body.classList.add('dark');
  }
} catch (e) {
  console.log('LocalStorage not available');
}

// Domain'den favicon URL'i al
function getFaviconUrl(url) {
  try {
    const urlObj = new URL(url);
    // Google Favicon Service - yüksek kaliteli favicon'lar için
    return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=128`;
  } catch (e) {
    return 'https://www.google.com/favicon.ico';
  }
}

// Domain'den site adı çıkar
function getSiteName(url) {
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname.replace('www.', '');
    
    // Özel isimler
    const specialNames = {
      'e-devlet.gov.tr': 'e-Devlet',
      'turkiye.gov.tr': 'Türkiye.gov.tr',
      'youtube.com': 'YouTube',
      'github.com': 'GitHub',
      'linkedin.com': 'LinkedIn',
      'stackoverflow.com': 'Stack Overflow',
      'trendyol.com': 'Trendyol',
      'hepsiburada.com': 'Hepsiburada',
      'sahibinden.com': 'Sahibinden',
      'n11.com': 'n11',
      'roblox.com': 'Roblox',
      'netflix.com': 'Netflix',
      'spotify.com': 'Spotify',
      'hbomax.com': 'HBO Max',
      'blutv.com': 'BluTV',
      'wikipedia.org': 'Wikipedia',
      'tr.wikipedia.org': 'Vikipedi',
    };
    
    if (specialNames[hostname]) {
      return specialNames[hostname];
    }
    
    // İlk kelimeyi al ve büyük harfle başlat
    const parts = hostname.split('.');
    if (parts.length > 0) {
      return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    }
    return hostname;
  } catch (e) {
    return 'Site';
  }
}

// Default siteler
function getDefaultSites() {
  return [
    { url: 'https://www.google.com', title: 'Google', favicon: 'https://www.google.com/favicon.ico' },
    { url: 'https://www.youtube.com', title: 'YouTube', favicon: 'https://www.youtube.com/favicon.ico' },
    { url: 'https://www.github.com', title: 'GitHub', favicon: 'https://github.com/favicon.ico' },
    { url: 'https://www.twitter.com', title: 'Twitter', favicon: 'https://twitter.com/favicon.ico' },
    { url: 'https://www.reddit.com', title: 'Reddit', favicon: 'https://www.reddit.com/favicon.ico' }
  ];
}

// Global history data (will be populated by parent)
let globalHistoryData = null;

// En çok ziyaret edilen siteleri hesapla
function getMostVisitedSites() {
  try {
    // Eğer parent'tan veri geldiyse onu kullan
    if (!globalHistoryData || globalHistoryData.length === 0) {
      console.log('No history data received from parent, using defaults');
      return getDefaultSites();
    }
    
    console.log('Total history entries from parent:', globalHistoryData.length);
    
    // URL'leri gruplama ve sayma
    const urlCounts = {};
    const urlData = {}; // URL için title ve favicon sakla
    
    globalHistoryData.forEach(entry => {
      try {
        // newtab.html ve boş URL'leri atla
        if (!entry.url || entry.url.includes('newtab.html') || entry.url === '') {
          return;
        }
        
        const urlObj = new URL(entry.url);
        const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
        
        // Sayımı artır
        urlCounts[baseUrl] = (urlCounts[baseUrl] || 0) + 1;
        
        // İlk karşılaşılan title ve favicon'u sakla
        if (!urlData[baseUrl]) {
          urlData[baseUrl] = {
            title: entry.title || getSiteName(baseUrl),
            favicon: entry.favicon || getFaviconUrl(baseUrl),
            url: baseUrl
          };
        }
      } catch (e) {
        // URL parse hatası, atla
        console.log('Error parsing URL:', entry.url);
      }
    });
    
    console.log('Unique sites found:', Object.keys(urlCounts).length);
    
    // Sayıya göre sırala ve en çok ziyaret edilen 8 siteyi al
    const sortedSites = Object.entries(urlCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([url, count]) => ({
        ...urlData[url],
        visitCount: count
      }));
    
    console.log('Top sites:', sortedSites);
    
    // Eğer yeterli site yoksa, default'ları ekle
    if (sortedSites.length < 5) {
      const defaults = getDefaultSites();
      const existingUrls = new Set(sortedSites.map(s => s.url));
      
      defaults.forEach(defaultSite => {
        if (!existingUrls.has(defaultSite.url) && sortedSites.length < 8) {
          sortedSites.push(defaultSite);
        }
      });
    }
    
    return sortedSites;
    
  } catch (error) {
    console.error('Error loading most visited sites:', error);
    return getDefaultSites();
  }
}

// Quick links'i render et - GERÇEK FAVICON'LAR İLE
function renderQuickLinks() {
  const quickLinksContainer = document.getElementById('quickLinks');
  if (!quickLinksContainer) {
    console.error('Quick links container not found!');
    return;
  }
  
  const mostVisited = getMostVisitedSites();
  console.log('Rendering', mostVisited.length, 'quick links');
  
  quickLinksContainer.innerHTML = mostVisited.map(site => `
    <a class="quick-link" onclick="navigate('${site.url}')" title="${site.title}${site.visitCount ? ' (' + site.visitCount + ' visits)' : ''}">
      <img src="${site.favicon}" alt="${site.title}" class="quick-link-favicon" onerror="this.src='https://www.google.com/favicon.ico'">
      <span>${site.title}</span>
    </a>
  `).join('');
}

// Parent window'dan mesaj dinle (webview için)
window.addEventListener('message', (event) => {
  console.log('Message received in newtab:', event.data);
  
  if (event.data && event.data.type === 'history-data') {
    globalHistoryData = event.data.history;
    console.log('History data received:', globalHistoryData.length, 'entries');
    renderQuickLinks();
  }
});

// İlk render - default'lar ile
renderQuickLinks();

// Parent'a hazır olduğumuzu bildir
if (window.parent !== window) {
  console.log('Requesting history data from parent...');
  window.parent.postMessage({ type: 'request-history' }, '*');
}

// Arama işlevi
function handleSearch(e) {
  e.preventDefault();
  const query = document.getElementById('searchInput').value.trim();
  if (query) {
    if (query.startsWith('http://') || query.startsWith('https://')) {
      window.location.href = query;
    } else if (query.includes('.') && !query.includes(' ')) {
      window.location.href = 'https://' + query;
    } else {
      window.location.href = 'https://www.google.com/search?q=' + encodeURIComponent(query);
    }
  }
}

// Navigasyon
function navigate(url) {
  window.location.href = url;
}

// Enter tuşu ile arama
document.getElementById('searchInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    handleSearch(e);
  }
});