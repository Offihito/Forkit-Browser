(function () {
  if (window.__forkitCM) return;
  window.__forkitCM = true;

  document.addEventListener('contextmenu', function (e) {
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
  }, true);
})();
