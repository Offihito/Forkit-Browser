// bg-script.js — NW.js persistent background script
// Runs in a persistent background context where chrome.webRequest blocking API is available.
const path = require("path");
const AdBlocker = require(path.join(process.cwd(), "adBlocker.js"));
const adBlocker = new AdBlocker();

// ── Network-level request blocking via chrome.webRequest ──────────────
// This is the NW.js equivalent of Electron's session.webRequest.onBeforeRequest.
// It blocks ad network requests BEFORE they render, preventing ads from loading.
// IMPORTANT: Only block requests from web pages, not from extension/app pages.
try {
  chrome.webRequest.onBeforeRequest.addListener(
    function (details) {
      // Never block main page navigation
      if (details.type === "main_frame") {
        return { cancel: false };
      }

      var url = details.url || "";
      if (!url) return { cancel: false };

      // Skip local and chrome URLs
      if (url.startsWith("file://") || url.startsWith("chrome")) {
        return { cancel: false };
      }

      // CRITICAL: Only block requests that originate from web pages (http/https)
      // Don't block requests from the app's own pages (chrome-extension://)
      // This prevents blocking CDN resources (Font Awesome, Unsplash, etc.)
      // loaded by newtab.html and other app pages
      var initiator = details.initiator || details.documentUrl || "";
      if (initiator.startsWith("chrome-extension://") || initiator.startsWith("file://")) {
        return { cancel: false };
      }
      // If no tab ID (background request) or negative tab ID, skip
      if (details.tabId < 0) {
        return { cancel: false };
      }

      var shouldBlock = adBlocker.shouldBlock(url, details.type || "other");
      if (shouldBlock) {
        console.log("🚫 [webRequest] Blocked:", details.type, url.substring(0, 120));
        return { cancel: true };
      }

      return { cancel: false };
    },
    { urls: ["http://*/*", "https://*/*"] },
    ["blocking"]
  );
  console.log("✅ chrome.webRequest.onBeforeRequest ad blocker active (bg-script)");
} catch (err) {
  console.error("❌ Failed to set up chrome.webRequest:", err.message);
}
