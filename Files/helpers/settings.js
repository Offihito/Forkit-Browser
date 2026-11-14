// Settings Modal Functions

// Modal açma
function openSettings() {
  const modal = document.getElementById('settingsModal');
  modal.classList.add('active');
  loadCurrentBackground();
}

// Modal kapatma
function closeSettings() {
  const modal = document.getElementById('settingsModal');
  modal.classList.remove('active');
}

// ESC tuşu ile kapatma
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSettings();
  }
});

// Mevcut arka planı yükle ve önizleme göster
function loadCurrentBackground() {
  try {
    const savedBackground = localStorage.getItem('newtab_background');
    const preview = document.getElementById('backgroundPreview');
    
    if (savedBackground) {
      preview.innerHTML = `<img src="${savedBackground}" alt="Background Preview">`;
    } else {
      // Mevcut tema'ya göre default background göster
      const isDark = document.body.classList.contains('dark');
      const defaultBg = isDark ? 'helpers/dark.png' : 'helpers/light.webp';
      preview.innerHTML = `<img src="${defaultBg}" alt="Default Background">`;
    }
  } catch (e) {
    console.log('Error loading background preview:', e);
  }
}

// Arka plan yükleme
function handleBackgroundUpload(event) {
  const file = event.target.files[0];
  
  if (!file) return;
  
  // Dosya tipini kontrol et
  if (!file.type.startsWith('image/')) {
    alert('Please select a valid image file');
    return;
  }
  
  // Dosya boyutunu kontrol et (5MB limit)
  if (file.size > 5 * 1024 * 1024) {
    alert('Image size should be less than 5MB');
    return;
  }
  
  const reader = new FileReader();
  
  reader.onload = function(e) {
    const imageData = e.target.result;
    
    try {
      // LocalStorage'a kaydet
      localStorage.setItem('newtab_background', imageData);
      
      // Arka planı güncelle
      applyBackground(imageData);
      
      // Önizlemeyi güncelle
      const preview = document.getElementById('backgroundPreview');
      preview.innerHTML = `<img src="${imageData}" alt="Background Preview">`;
      
      // Başarı bildirimi (opsiyonel)
      showNotification('Background updated successfully!');
      
    } catch (e) {
      // LocalStorage dolu olabilir
      if (e.name === 'QuotaExceededError') {
        alert('Image is too large to save. Please choose a smaller image.');
      } else {
        alert('Error saving background. Please try again.');
      }
      console.error('Error saving background:', e);
    }
  };
  
  reader.onerror = function() {
    alert('Error reading file. Please try again.');
  };
  
  reader.readAsDataURL(file);
}

// Arka planı uygula
function applyBackground(imageData) {
  document.body.style.backgroundImage = `url("${imageData}")`;
  document.body.style.backgroundSize = 'cover';
  document.body.style.backgroundPosition = 'center';
  document.body.style.backgroundRepeat = 'no-repeat';
  document.body.style.backgroundAttachment = 'fixed';
}

// Arka planı sıfırla
function resetBackground() {
  try {
    // LocalStorage'dan sil
    localStorage.removeItem('newtab_background');
    
    // Default arka plana dön
    const isDark = document.body.classList.contains('dark');
    const defaultBg = isDark ? 'helpers/dark.png' : 'helpers/light.webp';
    
    document.body.style.backgroundImage = `url("${defaultBg}")`;
    
    // Önizlemeyi güncelle
    loadCurrentBackground();
    
    // Başarı bildirimi
    showNotification('Background reset to default');
    
  } catch (e) {
    console.error('Error resetting background:', e);
  }
}

// Bildirim göster (basit versiyon)
function showNotification(message) {
  // Basit bir bildirim div'i oluştur
  const notification = document.createElement('div');
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    bottom: 30px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 14px;
    z-index: 10000;
    animation: slideUp 0.3s ease;
  `;
  
  document.body.appendChild(notification);
  
  // 3 saniye sonra kaldır
  setTimeout(() => {
    notification.style.animation = 'slideDown 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Sayfa yüklendiğinde kayıtlı arka planı uygula
document.addEventListener('DOMContentLoaded', () => {
  try {
    const savedBackground = localStorage.getItem('newtab_background');
    if (savedBackground) {
      applyBackground(savedBackground);
    }
  } catch (e) {
    console.log('Error loading saved background:', e);
  }
});

// Tema değiştiğinde arka plan kontrolü
const originalToggleTheme = window.toggleTheme;
window.toggleTheme = function() {
  originalToggleTheme();
  
  // Eğer custom background yoksa, tema'ya göre default'u göster
  try {
    const savedBackground = localStorage.getItem('newtab_background');
    if (!savedBackground) {
      const isDark = document.body.classList.contains('dark');
      const defaultBg = isDark ? 'helpers/dark.png' : 'helpers/light.webp';
      document.body.style.backgroundImage = `url("${defaultBg}")`;
    }
  } catch (e) {
    console.log('Error updating background on theme change:', e);
  }
};