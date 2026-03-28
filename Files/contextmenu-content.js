(function () {
  if (window.__forkitCM) return;
  window.__forkitCM = true;

  // Use BUBBLE phase (false) so website handlers fire first.
  // If a site (e.g. YouTube player, Google Docs) already handled the event,
  // we skip and let their menu appear instead of ours.
  document.addEventListener('contextmenu', function (e) {

    // 1. If the website already prevented default → it has its own menu, skip
    if (e.defaultPrevented) return;

    // 2. Check if right-click is on/inside a <video> or <audio> with controls
    //    → let the native media player context menu appear
    let el = e.target;
    let isMedia = false;
    let checkEl = el;
    while (checkEl && checkEl !== document) {
      if (checkEl.tagName === 'VIDEO' || checkEl.tagName === 'AUDIO') {
        isMedia = true;
        break;
      }
      checkEl = checkEl.parentNode;
    }
    if (isMedia) return; // let native controls handle it

    // 3. Our custom context menu
    e.preventDefault();

    let target = e.target;
    const params = {
      x: e.screenX,
      y: e.screenY,
      selectionText: window.getSelection().toString(),
      linkURL: '',
      srcURL: '',
      isEditable: false,
      canGoBack: window.history.length > 1,
      canGoForward: true
    };

    if (
      target.isContentEditable ||
      (target.tagName === 'INPUT' && !['button', 'submit', 'checkbox', 'radio'].includes(target.type)) ||
      target.tagName === 'TEXTAREA'
    ) {
      if (!target.disabled && !target.readOnly) {
        params.isEditable = true;
      }
    }

    while (target && target !== document) {
      if (target.tagName === 'A' && target.href) {
        params.linkURL = target.href;
      }
      if (target.tagName === 'IMG' || target.tagName === 'VIDEO' || target.tagName === 'AUDIO') {
        if (target.currentSrc || target.src) {
          params.srcURL = target.currentSrc || target.src;
        }
      }
      target = target.parentNode;
    }

    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: '__FORKIT_CM__', params }, '*');
      } else {
        console.log("__FORKIT_CM__:" + JSON.stringify(params));
      }
    } catch (err) {
      console.log("__FORKIT_CM__:" + JSON.stringify(params));
    }
  }, false);
})();
