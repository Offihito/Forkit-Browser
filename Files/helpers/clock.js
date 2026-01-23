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
      localStorage.setItem('theme', document.body.classList.contains('dark') ? 'dark' : 'light');
    }

    // Tema yükle
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      document.body.classList.add('dark');
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