import { dom } from "../core/dom.js";

let statsInterval = null;

export function initAdBlockerUI() {
  const adBlock = window.windowAPI?.adBlock;
  if (!adBlock) {
    console.warn("Ad Blocker API not available");
    return;
  }

  // --- Toolbar button ---
  const btn = document.getElementById("adblock-btn");
  if (!btn) return;

  // --- Badge for blocked count ---
  const badge = document.createElement("span");
  badge.className = "adblock-badge";
  badge.textContent = "0";
  btn.style.position = "relative";
  btn.appendChild(badge);

  // --- Panel ---
  const panel = document.getElementById("adblock-panel");
  const closeBtn = document.getElementById("adblock-panel-close");

  btn.addEventListener("click", async () => {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) {
      await refreshStats();
    }
  });

  closeBtn?.addEventListener("click", () => {
    panel.classList.remove("open");
  });

  // Close panel on outside click
  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      panel.classList.remove("open");
    }
  });

  // --- Toggle ---
  const toggle = document.getElementById("adblock-toggle");
  const statusText = document.getElementById("adblock-status-text");

  toggle?.addEventListener("change", async () => {
    const enabled = toggle.checked;
    await adBlock.toggle(enabled);
    statusText.textContent = enabled ? "Active" : "Disabled";
    statusText.className = "adblock-status-text " + (enabled ? "active" : "disabled");
    btn.classList.toggle("adblock-disabled", !enabled);
  });

  // --- Update Filters ---
  const updateBtn = document.getElementById("adblock-update-btn");
  const updateStatus = document.getElementById("adblock-update-status");

  updateBtn?.addEventListener("click", async () => {
    updateBtn.disabled = true;
    updateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating...';
    updateStatus.textContent = "";
    try {
      const result = await adBlock.updateFilterLists();
      // SECURITY: Use textContent instead of template literal to prevent XSS
    updateStatus.textContent = '✅ ' + result.total.toLocaleString() + ' filters loaded (' + result.block.toLocaleString() + ' block, ' + result.allow.toLocaleString() + ' allow)';
      updateStatus.className = "adblock-update-status success";
    } catch (err) {
      // SECURITY: Use textContent, escape error message
      updateStatus.textContent = '❌ Update failed: ' + (err.message ? err.message.substring(0, 100) : 'Unknown error');
      updateStatus.className = "adblock-update-status error";
    } finally {
      updateBtn.disabled = false;
      updateBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Update Filters';
    }
  });

  // --- Custom filter input ---
  const filterInput = document.getElementById("adblock-custom-filter");
  const addFilterBtn = document.getElementById("adblock-add-filter");

  addFilterBtn?.addEventListener("click", async () => {
    const filter = filterInput.value.trim();
    if (!filter) return;
    await adBlock.addCustomFilter(filter);
    filterInput.value = "";
    // SECURITY: Escape filter text when displaying in toast
    const escapedFilter = document.createElement('div');
    escapedFilter.textContent = filter;
    showToast("Filter added: " + escapedFilter.innerHTML);
  });

  filterInput?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") addFilterBtn?.click();
  });

  // --- Whitelist input ---
  const whitelistInput = document.getElementById("adblock-whitelist-input");
  const addWhitelistBtn = document.getElementById("adblock-add-whitelist");

  addWhitelistBtn?.addEventListener("click", async () => {
    const domain = whitelistInput.value.trim();
    if (!domain) return;
    await adBlock.addToWhitelist(domain);
    whitelistInput.value = "";
    showToast("Whitelisted: " + domain);
  });

  whitelistInput?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") addWhitelistBtn?.click();
  });

  // --- Reset stats ---
  const resetBtn = document.getElementById("adblock-reset-stats");
  resetBtn?.addEventListener("click", async () => {
    await adBlock.resetStats();
    await refreshStats();
    showToast("Stats reset");
  });

  // --- Periodic badge update ---
  async function refreshStats() {
    try {
      const status = await adBlock.getStatus();
      const stats = status.stats;

      // Badge
      badge.textContent = formatCount(stats.blocked);

      // Panel stats
      const blockedEl = document.getElementById("adblock-stat-blocked");
      const allowedEl = document.getElementById("adblock-stat-allowed");
      if (blockedEl) blockedEl.textContent = stats.blocked.toLocaleString();
      if (allowedEl) allowedEl.textContent = stats.allowed.toLocaleString();

      // Toggle state
      if (toggle) toggle.checked = status.enabled;
      if (statusText) {
        statusText.textContent = status.enabled ? "Active" : "Disabled";
        statusText.className = "adblock-status-text " + (status.enabled ? "active" : "disabled");
      }
      btn.classList.toggle("adblock-disabled", !status.enabled);
    } catch (err) {
      console.error("Failed to refresh ad blocker stats:", err);
    }
  }

  // Initial + interval
  refreshStats();
  statsInterval = setInterval(refreshStats, 3000);
}

function formatCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function showToast(message) {
  let toast = document.getElementById("adblock-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "adblock-toast";
    toast.className = "adblock-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2400);
}
