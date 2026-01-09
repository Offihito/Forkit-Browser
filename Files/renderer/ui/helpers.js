export function updateTabTitle(tab, text = null) {
  const title = text || tab.webview.getTitle() || 'New Tab';
  tab.tabElement.querySelector('.tab-title').textContent = title;
}
export function formatTime(date) {
  const now = new Date();
  const diff = now - date;
  const dayDiff = Math.floor(diff / 86400000);

  if (dayDiff === 0) return 'Today – ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  if (dayDiff === 1) return 'Yesterday – ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  if (dayDiff < 7) return `${dayDiff} days ago`;
  return date.toLocaleDateString('en-US');
}