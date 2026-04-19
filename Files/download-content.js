// Forkit Browser — Download Interceptor Content Script
// Intercepts download links and sends them through the download manager
(function () {
  if (window.__forkitDownloadInterceptor) return;
  window.__forkitDownloadInterceptor = true;

  console.log('✅ Download interceptor script loaded and initialized');

  // Track potential downloads to avoid duplicates
  const pendingDownloads = new Set();

  // Intercept link clicks that should trigger downloads
  document.addEventListener('click', function (e) {
    let target = e.target;
    
    // Find the nearest anchor element
    while (target && target !== document) {
      if (target.tagName === 'A' && target.href) {
        const href = target.href;
        const download = target.getAttribute('download');
        const dataDownload = target.getAttribute('data-download');
        
        // Check if this is a download link
        // It's a download if:
        // 1. It has download attribute
        // 2. It has data-download attribute (some sites use this)
        // 3. It's to a file URL
        if (download !== null || dataDownload !== null || 
            /\.(pdf|zip|rar|7z|tar|gz|exe|dmg|pkg|apk|bin|msi|iso|torrent|json|csv|xlsx|docx|txt|js|css|json)$/i.test(href)) {
          
          console.log('⬇️ Download link detected:', { href, download, dataDownload });
          
          e.preventDefault();
          e.stopPropagation();
          
          const fileName = download || dataDownload || target.textContent.trim() || href.split('/').pop().split('?')[0] || 'download';
          
          // Send to download manager via console message (will be caught by NW.js bridge)
          const downloadInfo = JSON.stringify({
            url: href,
            fileName: fileName
          });
          
          console.log('__FORKIT_DOWNLOAD__:' + downloadInfo);
          console.log('✅ Download message sent');
          pendingDownloads.add(href);
          
          return;
        }
      }
      target = target.parentNode;
    }
  }, true); // Use capture phase to intercept early

  // Also intercept form submissions that might trigger downloads
  document.addEventListener('submit', function (e) {
    const form = e.target;
    if (form && form.method && form.method.toLowerCase() === 'post') {
      // Check if form action might be a download endpoint
      const action = form.getAttribute('action') || window.location.href;
      if (/download|export|api\/.*download|file.*api/i.test(action)) {
        // This might be a download, but we'll let it proceed and NW.js will handle it
        console.log('Download form detected:', action);
      }
    }
  }, true);

  // Intercept navigation that results in downloads
  // This catches cases where the server sets content-disposition headers
  window.addEventListener('beforeunload', function (e) {
    // Only intercept if the current page is NOT a download already
    // (to avoid interfering with the download itself)
    if (!pendingDownloads.has(window.location.href)) {
      // The download will be handled by NW.js permission request
    }
  });
})();
