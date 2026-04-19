import { dom } from "../core/dom.js";

let downloads = [];

// Helper functions
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatTime(seconds) {
  if (!seconds || seconds === Infinity) return 'Calculating...';
  if (seconds < 60) return Math.round(seconds) + ' sec';
  if (seconds < 3600) return Math.round(seconds / 60) + ' min';
  return Math.round(seconds / 3600) + ' hr';
}

export function initDownloadManager() {
  console.log('🔧 Initializing download manager');
  console.log('📍 downloadBtn:', dom.downloadBtn);
  console.log('📍 downloadPanel:', dom.downloadPanel);
  console.log('📍 downloadList:', dom.downloadList);
  
  // Download panel toggle
  dom.downloadBtn.onclick = () => {
    console.log('🔘 Download button clicked, toggling panel');
    dom.downloadPanel.classList.toggle('open');
  };

  dom.downloadClose.onclick = () => {
    console.log('❌ Close button clicked');
    dom.downloadPanel.classList.remove('open');
  };

  // Listen to download events
  window.windowAPI?.onDownloadProgress((data) => {
    console.log('📊 Download progress:', data);
    updateDownloadItem(data.fileName, data.progress, 'downloading', data);
  });

  window.windowAPI?.onDownloadComplete((data) => {
    console.log('✅ Download complete:', data);
    updateDownloadItem(data.fileName, 100, 'complete', data);
  });

  window.windowAPI?.onDownloadError((data) => {
    console.log('❌ Download error:', data);
    updateDownloadItem(data.fileName, 0, 'error', data);
  });
  
  console.log('✅ Download manager initialized');
}

export function startDownload(url, fileName) {
  const downloadId = Date.now() + Math.random();
  const name = fileName || url.split('/').pop().split('?')[0] || 'download';
  
  console.log('🔽 startDownload called:', { url, fileName, name });
  
  downloads.push({
    id: downloadId,
    name,
    progress: 0,
    status: 'starting'
  });
  
  addDownloadItem(name);
  dom.downloadPanel.classList.add('open');
  console.log('🟢 Download panel opened, item added');
  
  // Blob URL için özel işlem
  if (url.startsWith('blob:')) {
    handleBlobDownload(url, name);
  } else {
    window.windowAPI?.downloadItem(url, name);
  }
}

function handleBlobDownload(blobUrl, fileName) {
  // Blob URL'den dosyayı indir
  fetch(blobUrl)
    .then(response => response.blob())
    .then(blob => {
      // Create a download link
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      
      // Clean up
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        updateDownloadItem(fileName, 100, 'complete');
      }, 100);
    })
    .catch(err => {
      console.error('Blob download error:', err);
      updateDownloadItem(fileName, 0, 'error');
    });
}

function addDownloadItem(fileName) {
  console.log('➕ Adding download item:', fileName);
  
  const item = document.createElement('div');
  item.className = 'download-item';
  item.dataset.fileName = fileName;
  item.innerHTML = `
    <div class="download-item-header">
      <i class="fas fa-file-download"></i>
      <div class="download-item-name">${fileName}</div>
    </div>
    <div class="download-progress-bar">
      <div class="download-progress-fill" style="width: 0%"></div>
    </div>
    <div class="download-item-info">
      <span class="download-status">Starting...</span>
      <span class="download-percentage">0%</span>
    </div>
    <div class="download-item-details">
      <span class="download-size">Size: Calculating...</span>
      <span class="download-time">Time: Calculating...</span>
    </div>
  `;
  
  dom.downloadList.insertBefore(item, dom.downloadList.firstChild);
  console.log('✅ Download item added to DOM');
}

function updateDownloadItem(fileName, progress, status, data = {}) {
  const selector = `[data-file-name="${fileName}"]`;
  const item = dom.downloadList.querySelector(selector);
  
  if (!item) {
    console.warn('⚠️ Download item not found:', { fileName, selector });
    return;
  }
  
  console.log('🔄 Updating download item:', { fileName, progress, status });
  
  const fill = item.querySelector('.download-progress-fill');
  const statusEl = item.querySelector('.download-status');
  const percentEl = item.querySelector('.download-percentage');
  const sizeEl = item.querySelector('.download-size');
  const timeEl = item.querySelector('.download-time');
  
  fill.style.width = Math.min(progress, 100) + '%';
  percentEl.textContent = Math.min(progress, 100) + '%';
  
  // Update size and time if available
  if (data.totalSize) {
    const downloaded = data.downloaded || 0;
    sizeEl.textContent = `${formatBytes(downloaded)} / ${formatBytes(data.totalSize)}`;
    
    // Calculate estimated time remaining
    if (progress > 0 && progress < 100 && downloaded > 0) {
      const elapsedTime = (Date.now() - (item.dataset.startTime || Date.now())) / 1000;
      const speed = downloaded / elapsedTime; // bytes per second
      const remaining = data.totalSize - downloaded;
      const timeRemaining = remaining / speed;
      
      timeEl.textContent = `Time remaining: ${formatTime(timeRemaining)}`;
    }
  } else {
    // No size info available - show what we know
    if (data.downloaded) {
      sizeEl.textContent = `${formatBytes(data.downloaded)} / Unknown size`;
    } else {
      sizeEl.textContent = 'Size: Downloading...';
    }
    timeEl.textContent = 'Time: Calculating...';
  }
  
  // Store start time for calculations
  if (!item.dataset.startTime) {
    item.dataset.startTime = Date.now();
  }
  
  if (status === 'complete') {
    item.classList.add('download-complete');
    statusEl.textContent = 'Complete';
    timeEl.textContent = 'Completed';
    fill.style.width = '100%';
    percentEl.textContent = '100%';
    item.querySelector('.download-item-header i').className = 'fas fa-check-circle';
  } else if (status === 'error') {
    item.classList.add('download-error');
    statusEl.textContent = 'Failed';
    timeEl.textContent = 'Failed';
    item.querySelector('.download-item-header i').className = 'fas fa-exclamation-circle';
  } else if (status === 'downloading') {
    statusEl.textContent = 'Downloading...';
    item.classList.remove('download-complete', 'download-error');
  }
}