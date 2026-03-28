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

      // Hard whitelist for primary domains to prevent Ghostery from blocking them
      // as "sub_frames" (which causes ERR_ABORTED silently in background).
      if (url.includes("roblox.com") || url.includes("discord.com") || url.includes("discordapp.com") || url.includes("cloudflare.com") || url.includes("rbxcdn.com")) {
        return { cancel: false };
      }

      var shouldBlock = adBlocker.shouldBlock(url, details.type || "other", details.documentUrl || details.initiator || '');
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

// ── DPI and Anti-Bot Bypass via Webview Headers ──────────────
// Intercepts requests and injects/modifies headers to bypass Cloudflare, Discord, and Roblox blocks.
try {
  // Try to get Chrome version to spoof correctly
  let chromeVersion = "120.0.0.0";
  if (typeof process !== "undefined" && process.versions && process.versions.chrome) {
    chromeVersion = process.versions.chrome;
  }
  const majorVersion = chromeVersion.split('.')[0];
  
  chrome.webRequest.onBeforeSendHeaders.addListener(
    function (details) {
      var headers = details.requestHeaders || [];
      var url = details.url || "";
      
      for (var j = 0; j < headers.length; j++) {
        var name = headers[j].name.toLowerCase();
        
        // Strip NW.js / Electron / Headless signatures from User-Agent
        if (name === 'user-agent') {
           let ua = headers[j].value;
           ua = ua.replace(/nwjs\/[\d\.]+\s*/i, '');
           ua = ua.replace(/electron\/[\d\.]+\s*/i, '');
           ua = ua.replace(/HeadlessChrome/i, 'Chrome');
           headers[j].value = ua.trim();
        }
      }
      
      return { requestHeaders: headers };
    },
    { urls: ["http://*/*", "https://*/*"] },
    ["blocking", "requestHeaders", "extraHeaders"]
  );
  console.log("✅ Anti-bot & DPI bypass header injection active (bg-script)");
} catch (err) {
  console.error("❌ Failed to set up bypass headers:", err.message);
}

// ─────────────────────────────────────────────────────────────────
// NATIVE DOH LOCAL TUNNEL PROXY (BYPASSES ISP DPI/DNS BLOCKS)
// ─────────────────────────────────────────────────────────────────
const http = require('http');
const net = require('net');
const https = require('https');

// Resolve domain via Cloudflare DNS-over-HTTPS
const resolveDoH = (hostname) => {
  return new Promise((resolve, reject) => {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return resolve(hostname);
    
    const req = https.get(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { 'accept': 'application/dns-json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          let ip = null;
          if (json.Answer) {
            for (let ans of json.Answer) {
              if (ans.type === 1) { ip = ans.data; break; }
            }
          }
          if (ip) resolve(ip);
          else reject(new Error("No A record found"));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
};

const proxy = http.createServer((req, res) => {
  try {
    const url = new URL(req.url);
    resolveDoH(url.hostname).then(ip => {
      const options = {
        hostname: ip, 
        port: url.port || 80, 
        path: url.pathname + url.search, 
        method: req.method, 
        headers: req.headers
      };
      // For HTTP traffic
      const proxyReq = http.request(options, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => res.end());
      req.pipe(proxyReq);
    }).catch(() => {
      // Fallback native
      const proxyReq = http.request(req.url, { method: req.method, headers: req.headers }, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => res.end());
      req.pipe(proxyReq);
    });
  } catch(e) { res.end(); }
});

// For HTTPS CONNECT tunnels
proxy.on('connect', (req, clientSocket, head) => {
  const [hostname, port] = req.url.split(':');
  
  resolveDoH(hostname).then(ip => {
    const serverSocket = net.connect(port || 443, ip, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', () => clientSocket.end());
    clientSocket.on('error', () => serverSocket.end());
  }).catch(err => {
    const serverSocket = net.connect(port || 443, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', () => clientSocket.end());
    clientSocket.on('error', () => serverSocket.end());
  });
});

proxy.listen(7676, '127.0.0.1', () => {
  console.log('✅ Background: Native DoH Tunnel Proxy active on 127.0.0.1:7676');
});
