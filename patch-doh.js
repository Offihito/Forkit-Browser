const fs = require('fs');
const path = require('path');
const os = require('os');

try {
  // Path for NW.js chromium user-data-dir
  const prefsDir = path.join(os.homedir(), '.config', 'forkit', 'Default');
  const prefsFile = path.join(prefsDir, 'Preferences');

  if (!fs.existsSync(prefsFile)) {
    console.error('Preferences file not found! Start the app fully once and close it to generate it.');
    process.exit(1);
  }

  const rawData = fs.readFileSync(prefsFile, 'utf8');
  let prefs = JSON.parse(rawData);

  // Force native Chrome Secure DNS engine setup
  if (!prefs.dns_over_https) {
    prefs.dns_over_https = {};
  }

  prefs.dns_over_https.mode = 'secure';
  prefs.dns_over_https.templates = 'https://cloudflare-dns.com/dns-query';

  fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));
  console.log('✅ Successfully patched Chrome Preferences for Native DoH.');
} catch (err) {
  console.error('❌ Failed to patch Native DoH Preferences:', err);
}
