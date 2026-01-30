// adBlocker.js - Ad Blocking System
const fs = require('fs');
const path = require('path');
const https = require('https');

class AdBlocker {
  constructor() {
    this.filters = {
      block: [],
      allow: [],
      cosmetic: []
    };
    this.isEnabled = true;
    this.stats = {
      blocked: 0,
      allowed: 0
    };
    this.filterListPath = path.join(__dirname, 'Data', 'adblock-filters.txt');
    this.statsPath = path.join(__dirname, 'Data', 'adblock-stats.json');
    
    this.loadFilters();
    this.loadStats();
  }

  // Filter list URL'leri (popüler reklam engelleme listeleri)
  getDefaultFilterLists() {
    return [
      {
        name: 'EasyList',
        url: 'https://easylist.to/easylist/easylist.txt',
        enabled: true
      },
      {
        name: 'EasyPrivacy',
        url: 'https://easylist.to/easylist/easyprivacy.txt',
        enabled: true
      },
      {
        name: 'AdGuard Base',
        url: 'https://filters.adtidy.org/extension/chromium/filters/2.txt',
        enabled: true
      },
      {
        name: 'Peter Lowe\'s List',
        url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0',
        enabled: true
      }
    ];
  }

  // Filter listelerini indir ve güncelle
  async updateFilterLists() {
    console.log('Updating ad block filter lists...');
    const lists = this.getDefaultFilterLists();
    let allFilters = [];

    for (const list of lists) {
      if (!list.enabled) continue;
      
      try {
        const filters = await this.downloadFilterList(list.url);
        allFilters = allFilters.concat(filters);
        console.log(`Downloaded ${list.name}: ${filters.length} filters`);
      } catch (err) {
        console.error(`Error downloading ${list.name}:`, err.message);
      }
    }

    // Filtreleri kaydet
    this.parseFilters(allFilters);
    this.saveFilters(allFilters);
    
    return {
      total: allFilters.length,
      block: this.filters.block.length,
      allow: this.filters.allow.length,
      cosmetic: this.filters.cosmetic.length
    };
  }

  // Filter listesini indir
  downloadFilterList(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const lines = data.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('!') && !line.startsWith('['));
          resolve(lines);
        });
      }).on('error', reject);
    });
  }

  // Filtreleri parse et
  parseFilters(filterLines) {
    this.filters = {
      block: [],
      allow: [],
      cosmetic: []
    };

    for (let line of filterLines) {
      line = line.trim();
      
      // Boş veya yorum satırlarını atla
      if (!line || line.startsWith('!') || line.startsWith('[')) continue;

      // Cosmetic filters (##, #@#)
      if (line.includes('##') || line.includes('#@#')) {
        this.filters.cosmetic.push(line);
        continue;
      }

      // Exception rules (@@)
      if (line.startsWith('@@')) {
        const pattern = this.convertToRegex(line.substring(2));
        this.filters.allow.push(pattern);
        continue;
      }

      // Block rules
      const pattern = this.convertToRegex(line);
      this.filters.block.push(pattern);
    }

    console.log(`Parsed filters - Block: ${this.filters.block.length}, Allow: ${this.filters.allow.length}, Cosmetic: ${this.filters.cosmetic.length}`);
  }

  // AdBlock formatını regex'e çevir
  convertToRegex(filter) {
    // Basit wildcard dönüşümü
    let pattern = filter
      .replace(/\*/g, '.*')
      .replace(/\^/g, '[^\\w\\d_\\-.%]')
      .replace(/\|{2}/g, '^https?:\\/\\/([^/]+\\.)?')
      .replace(/^\|/g, '^')
      .replace(/\|$/g, '$');

    try {
      return new RegExp(pattern, 'i');
    } catch (e) {
      // Regex hatası varsa basit string matching kullan
      return {
        test: (url) => url.toLowerCase().includes(filter.toLowerCase())
      };
    }
  }

  // URL'nin engellenip engellenmeyeceğini kontrol et
  shouldBlock(url, type = 'other') {
    if (!this.isEnabled) return false;

    // YouTube için özel kurallar - kritik kaynakları engelleme
    const youtubeWhitelist = [
      'youtube.com/api/',
      'youtube.com/youtubei/',
      'youtube.com/s/player/',
      'youtube.com/iframe_api',
      'youtube.com/get_video_info',
      'googlevideo.com',
      'ytimg.com',
      'ggpht.com',
      'gstatic.com'
    ];
    
    for (const domain of youtubeWhitelist) {
      if (url.includes(domain)) {
        return false;
      }
    }

    // Allow listesinde mi kontrol et
    for (const pattern of this.filters.allow) {
      if (pattern.test(url)) {
        this.stats.allowed++;
        return false;
      }
    }

    // Block listesinde mi kontrol et
    for (const pattern of this.filters.block) {
      if (pattern.test(url)) {
        this.stats.blocked++;
        this.saveStats();
        return true;
      }
    }

    // Basit domain-based blocking (yaygın reklam domainleri)
    const adDomains = [
      'doubleclick.net',
      'googlesyndication.com',
      'googleadservices.com',
      'google-analytics.com',
      'facebook.com/tr',
      'facebook.net',
      'scorecardresearch.com',
      'adnxs.com',
      'advertising.com',
      'criteo.com',
      'outbrain.com',
      'taboola.com',
      'ads-twitter.com',
      'analytics.twitter.com'
    ];

    for (const domain of adDomains) {
      if (url.includes(domain)) {
        this.stats.blocked++;
        this.saveStats();
        return true;
      }
    }
    
    // YouTube reklam patternleri
    const youtubeAdPatterns = [
      '/pagead/',
      '/ptracking',
      'doubleclick.net',
      'googlesyndication.com',
      'youtube.com/api/stats/ads',
      'youtube.com/pagead/',
      'youtube.com/ptracking',
      'youtube.com/get_midroll_'
    ];
    
    if (url.includes('youtube.com') || url.includes('googlevideo.com')) {
      for (const pattern of youtubeAdPatterns) {
        if (url.includes(pattern)) {
          this.stats.blocked++;
          this.saveStats();
          return true;
        }
      }
    }

    return false;
  }

  // Cosmetic filtreleri al (element hiding için)
  getCosmeticFilters(domain) {
    if (!domain) return [];
    
    return this.filters.cosmetic.filter(filter => {
      // Domain-specific filters
      if (filter.includes(domain)) return true;
      // Generic filters
      if (!filter.includes(',') && filter.startsWith('##')) return true;
      return false;
    });
  }

  // Filtreleri kaydet
  saveFilters(filterLines) {
    try {
      const dataDir = path.dirname(this.filterListPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(this.filterListPath, filterLines.join('\n'), 'utf8');
    } catch (err) {
      console.error('Error saving filters:', err);
    }
  }

  // Filtreleri yükle
  loadFilters() {
    try {
      if (fs.existsSync(this.filterListPath)) {
        const data = fs.readFileSync(this.filterListPath, 'utf8');
        const lines = data.split('\n').filter(line => line.trim());
        this.parseFilters(lines);
        console.log('Ad block filters loaded successfully');
      } else {
        console.log('No filter list found, using basic blocking');
        // Temel filtreleri kullan
        this.parseFilters([
          '||doubleclick.net^',
          '||googlesyndication.com^',
          '||googleadservices.com^',
          '||google-analytics.com^'
        ]);
      }
    } catch (err) {
      console.error('Error loading filters:', err);
    }
  }

  // İstatistikleri kaydet
  saveStats() {
    try {
      const dataDir = path.dirname(this.statsPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(this.statsPath, JSON.stringify(this.stats, null, 2));
    } catch (err) {
      console.error('Error saving stats:', err);
    }
  }

  // İstatistikleri yükle
  loadStats() {
    try {
      if (fs.existsSync(this.statsPath)) {
        const data = fs.readFileSync(this.statsPath, 'utf8');
        this.stats = JSON.parse(data);
      }
    } catch (err) {
      console.error('Error loading stats:', err);
    }
  }

  // İstatistikleri al
  getStats() {
    return { ...this.stats };
  }

  // İstatistikleri sıfırla
  resetStats() {
    this.stats = {
      blocked: 0,
      allowed: 0
    };
    this.saveStats();
  }

  // Reklam engelleyiciyi aç/kapat
  toggle(enabled) {
    this.isEnabled = enabled;
    return this.isEnabled;
  }

  // Özel filtre ekle
  addCustomFilter(filter) {
    const pattern = this.convertToRegex(filter);
    this.filters.block.push(pattern);
    
    // Dosyaya kaydet
    try {
      const currentFilters = fs.existsSync(this.filterListPath) 
        ? fs.readFileSync(this.filterListPath, 'utf8').split('\n')
        : [];
      currentFilters.push(filter);
      fs.writeFileSync(this.filterListPath, currentFilters.join('\n'), 'utf8');
    } catch (err) {
      console.error('Error adding custom filter:', err);
    }
  }

  // Whitelist'e domain ekle
  addToWhitelist(domain) {
    const filter = `@@||${domain}^`;
    const pattern = this.convertToRegex(filter.substring(2));
    this.filters.allow.push(pattern);
    
    try {
      const whitelistPath = path.join(path.dirname(this.filterListPath), 'whitelist.txt');
      const whitelist = fs.existsSync(whitelistPath)
        ? fs.readFileSync(whitelistPath, 'utf8').split('\n')
        : [];
      whitelist.push(domain);
      fs.writeFileSync(whitelistPath, whitelist.join('\n'), 'utf8');
    } catch (err) {
      console.error('Error adding to whitelist:', err);
    }
  }
}

module.exports = AdBlocker;