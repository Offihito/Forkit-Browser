use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestAction {
    pub default_popup: Option<String>,
    pub default_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestContentScript {
    #[serde(default)]
    pub matches: Vec<String>,
    #[serde(default)]
    pub exclude_matches: Vec<String>,
    #[serde(default)]
    pub js: Vec<String>,
    #[serde(default)]
    pub css: Vec<String>,
    pub run_at: Option<String>,
    #[serde(default)]
    pub all_frames: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionManifest {
    #[serde(default = "default_mv")]
    pub manifest_version: u8,
    pub name: String,
    #[serde(default = "default_version")]
    pub version: String,
    pub description: Option<String>,
    pub icons: Option<HashMap<String, String>>,
    pub action: Option<ManifestAction>,
    pub browser_action: Option<ManifestAction>,
    #[serde(default)]
    pub content_scripts: Vec<ManifestContentScript>,
    #[serde(default)]
    pub permissions: Vec<String>,
}

fn default_mv() -> u8 {
    3
}

fn default_version() -> String {
    "1.0.0".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentScriptRule {
    pub matches: Vec<String>,
    pub exclude_matches: Vec<String>,
    pub js_files: Vec<String>,
    pub css_files: Vec<String>,
    pub run_at: String,
    pub all_frames: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledExtension {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub manifest_version: u8,
    pub path: String,
    pub enabled: bool,
    pub popup: Option<String>,
    pub icon: Option<String>,
    pub content_scripts: Vec<ContentScriptRule>,
    pub raw_manifest: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct PersistedRegistry {
    extensions: Vec<InstalledExtension>,
}

pub struct DnrCompiledRules {
    pub block_domains: std::collections::HashSet<String>,
    pub allow_domains: std::collections::HashSet<String>,
    pub block_substrings: Vec<String>,
}

impl DnrCompiledRules {
    pub fn empty() -> Self {
        Self {
            block_domains: std::collections::HashSet::new(),
            allow_domains: std::collections::HashSet::new(),
            block_substrings: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.block_domains.is_empty()
            && self.allow_domains.is_empty()
            && self.block_substrings.is_empty()
    }
}

pub struct ExtensionManager {
    pub extensions: Vec<InstalledExtension>,
    pub data_dir: PathBuf,
    pub storage: HashMap<String, HashMap<String, serde_json::Value>>,
    pub dnr_rules: DnrCompiledRules,
}

pub struct ExtensionManagerState {
    pub inner: Mutex<ExtensionManager>,
}

impl ExtensionManager {
    pub fn load(data_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&data_dir);
        let _ = fs::create_dir_all(data_dir.join("ext-storage"));

        let registry_path = data_dir.join("extensions.json");
        let mut extensions = fs::read_to_string(&registry_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<PersistedRegistry>(&raw).ok())
            .map(|r| r.extensions)
            .unwrap_or_default();

        let mut migrated = false;
        for ext in &mut extensions {
            if ext.name.contains("__MSG_") || ext.description.contains("__MSG_") {
                let msgs = load_i18n_messages(Path::new(&ext.path), &ext.raw_manifest);
                if !msgs.is_empty() {
                    ext.name = resolve_i18n_str(&ext.name, &msgs);
                    ext.description = resolve_i18n_str(&ext.description, &msgs);
                    migrated = true;
                }
            }
        }

        let mut storage = HashMap::new();
        for ext in &extensions {
            let st_path = data_dir.join("ext-storage").join(format!("{}.json", ext.id));
            if let Ok(raw) = fs::read_to_string(st_path) {
                if let Ok(map) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&raw) {
                    storage.insert(ext.id.clone(), map);
                }
            }
        }

        let mut mgr = Self {
            extensions,
            data_dir,
            storage,
            dnr_rules: DnrCompiledRules::empty(),
        };
        if migrated {
            mgr.save_registry();
        }
        mgr.rebuild_dnr_rules();
        mgr
    }

    pub fn save_registry(&self) {
        let registry_path = self.data_dir.join("extensions.json");
        let reg = PersistedRegistry {
            extensions: self.extensions.clone(),
        };
        if let Ok(json) = serde_json::to_string_pretty(&reg) {
            let _ = fs::write(registry_path, json);
        }
    }

    pub fn save_ext_storage(&self, ext_id: &str) {
        let st_path = self
            .data_dir
            .join("ext-storage")
            .join(format!("{}.json", ext_id));
        let data = self.storage.get(ext_id).cloned().unwrap_or_default();
        if let Ok(json) = serde_json::to_string_pretty(&data) {
            let _ = fs::write(st_path, json);
        }
    }

    pub fn load_unpacked(&mut self, folder: &Path) -> Result<InstalledExtension, String> {
        let canon = fs::canonicalize(folder).map_err(|e| format!("Invalid folder: {}", e))?;
        let manifest_path = canon.join("manifest.json");
        if !manifest_path.is_file() {
            return Err("Selected folder does not contain manifest.json".to_string());
        }

        let raw_str = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Failed to read manifest.json: {}", e))?;
        let raw_manifest: serde_json::Value = serde_json::from_str(&raw_str)
            .map_err(|e| format!("Invalid JSON in manifest.json: {}", e))?;
        let parsed: ExtensionManifest = serde_json::from_value(raw_manifest.clone())
            .map_err(|e| format!("Unsupported manifest.json format: {}", e))?;

        let id = deterministic_ext_id(&canon.to_string_lossy());
        let popup = parsed
            .action
            .as_ref()
            .and_then(|a| a.default_popup.clone())
            .or_else(|| {
                parsed
                    .browser_action
                    .as_ref()
                    .and_then(|a| a.default_popup.clone())
            })
            .map(|p| p.trim_start_matches('/').to_string());

        let icon = parsed.icons.as_ref().and_then(|icons| {
            for size in ["48", "32", "64", "128", "16"] {
                if let Some(p) = icons.get(size) {
                    return Some(p.trim_start_matches('/').to_string());
                }
            }
            icons.values().next().map(|p| p.trim_start_matches('/').to_string())
        });

        let content_scripts = parsed
            .content_scripts
            .into_iter()
            .map(|cs| ContentScriptRule {
                matches: cs.matches,
                exclude_matches: cs.exclude_matches,
                js_files: cs.js,
                css_files: cs.css,
                run_at: cs.run_at.unwrap_or_else(|| "document_idle".to_string()),
                all_frames: cs.all_frames,
            })
            .collect();

        let i18n = load_i18n_messages(&canon, &raw_manifest);
        let ext_name = resolve_i18n_str(&parsed.name, &i18n);
        let ext_desc = resolve_i18n_str(parsed.description.as_deref().unwrap_or(""), &i18n);

        let ext = InstalledExtension {
            id: id.clone(),
            name: ext_name,
            version: parsed.version,
            description: ext_desc,
            manifest_version: parsed.manifest_version,
            path: canon.to_string_lossy().to_string(),
            enabled: true,
            popup,
            icon,
            content_scripts,
            raw_manifest,
        };

        if let Some(existing) = self.extensions.iter_mut().find(|e| e.id == id) {
            let was_enabled = existing.enabled;
            *existing = ext.clone();
            existing.enabled = was_enabled;
        } else {
            self.extensions.push(ext.clone());
        }
        self.save_registry();
        self.rebuild_dnr_rules();
        Ok(ext)
    }

    pub fn reload_extension(&mut self, id: &str) -> Result<InstalledExtension, String> {
        let path_str = self
            .extensions
            .iter()
            .find(|e| e.id == id)
            .map(|e| e.path.clone())
            .ok_or_else(|| "Extension not found".to_string())?;
        self.load_unpacked(Path::new(&path_str))
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<(), String> {
        let ext = self
            .extensions
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| "Extension not found".to_string())?;
        ext.enabled = enabled;
        self.save_registry();
        self.rebuild_dnr_rules();
        Ok(())
    }

    pub fn remove_extension(&mut self, id: &str) -> Result<(), String> {
        let before = self.extensions.len();
        self.extensions.retain(|e| e.id != id);
        if self.extensions.len() == before {
            return Err("Extension not found".to_string());
        }
        self.storage.remove(id);
        let _ = fs::remove_file(self.data_dir.join("ext-storage").join(format!("{}.json", id)));
        self.save_registry();
        self.rebuild_dnr_rules();
        Ok(())
    }

    pub fn rebuild_dnr_rules(&mut self) {
        let mut compiled = DnrCompiledRules::empty();
        for ext in &self.extensions {
            if !ext.enabled {
                continue;
            }
            let Some(dnr) = ext.raw_manifest.get("declarative_net_request") else {
                continue;
            };
            let Some(resources) = dnr.get("rule_resources").and_then(|v| v.as_array()) else {
                continue;
            };
            let root = Path::new(&ext.path);
            for res in resources {
                let enabled = res.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
                if !enabled {
                    continue;
                }
                let Some(rel_path) = res.get("path").and_then(|v| v.as_str()) else {
                    continue;
                };
                let full = root.join(rel_path.trim_start_matches('/'));
                let Ok(raw) = fs::read_to_string(full) else {
                    continue;
                };
                let Ok(rules) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
                    continue;
                };
                for rule in rules {
                    let action_type = rule
                        .get("action")
                        .and_then(|a| a.get("type"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    let is_block = action_type == "block";
                    let is_allow = action_type == "allow";
                    if !is_block && !is_allow {
                        continue;
                    }
                    let Some(cond) = rule.get("condition") else {
                        continue;
                    };
                    // Skip rules scoped to specific initiatorDomains or thirdParty-only rules
                    // so they don't over-block top-level navigations.
                    if cond
                        .get("initiatorDomains")
                        .and_then(|v| v.as_array())
                        .map(|a| !a.is_empty())
                        .unwrap_or(false)
                        || cond.get("domainType").and_then(|v| v.as_str()) == Some("thirdParty")
                    {
                        continue;
                    }
                    // Skip rules that exclude main_frame/script/xmlhttprequest (e.g. cosmetic/image-only rules)
                    if let Some(rtypes) = cond.get("resourceTypes").and_then(|v| v.as_array()) {
                        let has_nav_or_script = rtypes.iter().any(|t| {
                            matches!(
                                t.as_str(),
                                Some("main_frame") | Some("sub_frame") | Some("script") | Some("xmlhttprequest")
                            )
                        });
                        if !has_nav_or_script {
                            continue;
                        }
                    }
                    let is_safe_core_domain = |d: &str| {
                        matches!(
                            d,
                            "youtube.com"
                                | "www.youtube.com"
                                | "m.youtube.com"
                                | "youtu.be"
                                | "googlevideo.com"
                                | "ytimg.com"
                                | "i.ytimg.com"
                                | "s.ytimg.com"
                                | "ggpht.com"
                                | "google.com"
                                | "www.google.com"
                                | "accounts.google.com"
                                | "github.com"
                        )
                    };
                    if let Some(domains) = cond.get("requestDomains").and_then(|d| d.as_array()) {
                        for dom in domains {
                            if let Some(ds) = dom.as_str() {
                                let d = ds.to_ascii_lowercase();
                                if d.contains(':') || !d.contains('.') || (is_block && is_safe_core_domain(&d)) {
                                    continue;
                                }
                                if is_block {
                                    compiled.block_domains.insert(d);
                                } else {
                                    compiled.allow_domains.insert(d);
                                }
                            }
                        }
                    }
                    if let Some(uf) = cond.get("urlFilter").and_then(|u| u.as_str()) {
                        if let Some(rest) = uf.strip_prefix("||") {
                            let clean = rest.trim_end_matches('^').trim_end_matches('/');
                            if !clean.is_empty() && !clean.contains('/') && !clean.contains('*') && !clean.contains(':') && clean.contains('.') {
                                let d = clean.to_ascii_lowercase();
                                if is_block && is_safe_core_domain(&d) {
                                    continue;
                                }
                                if is_block {
                                    compiled.block_domains.insert(d);
                                } else {
                                    compiled.allow_domains.insert(d);
                                }
                            } else if is_block && !clean.is_empty() && compiled.block_substrings.len() < 4000 {
                                let sub = clean.replace('^', "").replace('*', "");
                                let has_real_path = sub
                                    .split_once('/')
                                    .map(|(dom, path)| {
                                        !dom.is_empty()
                                            && dom.contains('.')
                                            && !dom.contains(':')
                                            && path.len() >= 5
                                            && !is_safe_core_domain(&dom.to_ascii_lowercase())
                                    })
                                    .unwrap_or(false);
                                if has_real_path {
                                    compiled.block_substrings.push(sub.to_ascii_lowercase());
                                }
                            }
                        }
                    }
                }
            }
        }
        self.dnr_rules = compiled;
    }

    pub fn should_block_dnr(&self, url: &str) -> bool {
        if self.dnr_rules.is_empty() {
            return false;
        }
        let Ok(parsed) = url::Url::parse(url) else {
            return false;
        };
        let Some(host) = parsed.host_str() else {
            return false;
        };
        let host_lower = host.to_ascii_lowercase();
        if host_matches_set(&host_lower, &self.dnr_rules.allow_domains) {
            return false;
        }
        if host_matches_set(&host_lower, &self.dnr_rules.block_domains) {
            return true;
        }
        let url_lower = url.to_ascii_lowercase();
        self.dnr_rules.block_substrings.iter().any(|s| url_lower.contains(s))
    }

    pub fn build_dnr_runtime_script(&self) -> Option<String> {
        if self.dnr_rules.is_empty() {
            return None;
        }
        let block_list: Vec<&str> = self
            .dnr_rules
            .block_domains
            .iter()
            .take(15000)
            .map(|s| s.as_str())
            .collect();
        let allow_list: Vec<&str> = self
            .dnr_rules
            .allow_domains
            .iter()
            .take(4000)
            .map(|s| s.as_str())
            .collect();
        let block_json = serde_json::to_string(&block_list).unwrap_or_else(|_| "[]".to_string());
        let allow_json = serde_json::to_string(&allow_list).unwrap_or_else(|_| "[]".to_string());

        Some(format!(
            r#"(function() {{
  if (window.__forkitDnrActive) return;
  window.__forkitDnrActive = true;
  const __blockSet = new Set({block_json});
  const __allowSet = new Set({allow_json});
  const __pageHost = location.hostname.toLowerCase();

  function __hostInSet(host, set) {{
    let h = host;
    while (h) {{
      if (set.has(h)) return true;
      const dot = h.indexOf('.');
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }}
    return false;
  }}

  function __shouldBlock(rawUrl) {{
    try {{
      const u = new URL(rawUrl, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const h = u.hostname.toLowerCase();
      if (h === __pageHost || __hostInSet(h, __allowSet)) return false;
      return __hostInSet(h, __blockSet);
    }} catch (_) {{ return false; }}
  }}

  const _fetch = window.fetch;
  if (_fetch) {{
    window.fetch = function(input, init) {{
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (__shouldBlock(url)) {{
        return Promise.resolve(new Response('', {{ status: 204, statusText: 'Blocked by Extension' }}));
      }}
      return _fetch.apply(this, arguments);
    }};
  }}

  const _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {{
    this.__forkitBlocked = __shouldBlock(url);
    return _xhrOpen.apply(this, arguments);
  }};
  const _xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {{
    if (this.__forkitBlocked) {{
      try {{ this.abort(); }} catch (_) {{}}
      return;
    }}
    return _xhrSend.apply(this, arguments);
  }};

  if (navigator.sendBeacon) {{
    const _beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data) {{
      if (__shouldBlock(url)) return true;
      return _beacon(url, data);
    }};
  }}

  const _setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {{
    if ((name === 'src' || name === 'href') && (this.tagName === 'SCRIPT' || this.tagName === 'IFRAME')) {{
      if (__shouldBlock(value)) return;
    }}
    return _setAttr.call(this, name, value);
  }};
}})();"#
        ))
    }

    pub fn resolve_asset(&self, ext_id: &str, rel_path: &str) -> Option<(Vec<u8>, &'static str)> {
        let ext = self.extensions.iter().find(|e| e.id == ext_id)?;
        let root = fs::canonicalize(&ext.path).ok()?;
        let clean_rel = rel_path.trim_start_matches('/').split('?').next().unwrap_or("");
        let target = root.join(clean_rel);
        let canon_target = fs::canonicalize(&target).ok()?;
        if !canon_target.starts_with(&root) || !canon_target.is_file() {
            return None;
        }
        let bytes = fs::read(&canon_target).ok()?;
        let mime = guess_mime(&canon_target);
        Some((bytes, mime))
    }

    pub fn storage_op(
        &mut self,
        ext_id: &str,
        action: &str,
        payload: serde_json::Value,
    ) -> serde_json::Value {
        let map = self.storage.entry(ext_id.to_string()).or_default();
        match action {
            "get" => {
                let mut result = serde_json::Map::new();
                match payload {
                    serde_json::Value::Null => {
                        for (k, v) in map.iter() {
                            result.insert(k.clone(), v.clone());
                        }
                    }
                    serde_json::Value::String(key) => {
                        if let Some(v) = map.get(&key) {
                            result.insert(key, v.clone());
                        }
                    }
                    serde_json::Value::Array(keys) => {
                        for k in keys {
                            if let Some(ks) = k.as_str() {
                                if let Some(v) = map.get(ks) {
                                    result.insert(ks.to_string(), v.clone());
                                }
                            }
                        }
                    }
                    serde_json::Value::Object(defaults) => {
                        for (k, def_val) in defaults {
                            let val = map.get(&k).cloned().unwrap_or(def_val);
                            result.insert(k, val);
                        }
                    }
                    _ => {}
                }
                serde_json::Value::Object(result)
            }
            "set" => {
                if let serde_json::Value::Object(items) = payload {
                    for (k, v) in items {
                        map.insert(k, v);
                    }
                    self.save_ext_storage(ext_id);
                }
                serde_json::json!({ "ok": true })
            }
            "remove" => {
                match payload {
                    serde_json::Value::String(key) => {
                        map.remove(&key);
                    }
                    serde_json::Value::Array(keys) => {
                        for k in keys {
                            if let Some(ks) = k.as_str() {
                                map.remove(ks);
                            }
                        }
                    }
                    _ => {}
                }
                self.save_ext_storage(ext_id);
                serde_json::json!({ "ok": true })
            }
            "clear" => {
                map.clear();
                self.save_ext_storage(ext_id);
                serde_json::json!({ "ok": true })
            }
            _ => serde_json::json!({}),
        }
    }
}

fn load_i18n_messages(ext_root: &Path, raw_manifest: &serde_json::Value) -> HashMap<String, String> {
    let locales_dir = ext_root.join("_locales");
    if !locales_dir.is_dir() {
        return HashMap::new();
    }
    let default_loc = raw_manifest
        .get("default_locale")
        .and_then(|v| v.as_str())
        .unwrap_or("en");

    let mut candidates = vec![
        default_loc.to_string(),
        "en".to_string(),
        "en_US".to_string(),
        "tr".to_string(),
    ];
    if let Ok(entries) = fs::read_dir(&locales_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if !candidates.iter().any(|c| c == name) {
                    candidates.push(name.to_string());
                }
            }
        }
    }

    for loc in candidates {
        let msg_path = locales_dir.join(&loc).join("messages.json");
        if let Ok(raw) = fs::read_to_string(msg_path) {
            if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&raw) {
                let mut out = HashMap::new();
                for (k, v) in map {
                    if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
                        out.insert(k.to_ascii_lowercase(), msg.to_string());
                    }
                }
                if !out.is_empty() {
                    return out;
                }
            }
        }
    }
    HashMap::new()
}

fn resolve_i18n_str(input: &str, msgs: &HashMap<String, String>) -> String {
    let mut out = input.to_string();
    let mut start = 0usize;
    while let Some(rel) = out[start..].find("__MSG_") {
        let abs_start = start + rel;
        let key_start = abs_start + 6;
        if let Some(rel_end) = out[key_start..].find("__") {
            let key_end = key_start + rel_end;
            let key = out[key_start..key_end].to_ascii_lowercase();
            if let Some(val) = msgs.get(&key) {
                out.replace_range(abs_start..key_end + 2, val);
                start = abs_start + val.len();
                continue;
            }
        }
        start = key_start;
    }
    out
}

fn host_matches_set(host: &str, set: &std::collections::HashSet<String>) -> bool {
    let mut cur = host;
    loop {
        if set.contains(cur) {
            return true;
        }
        match cur.split_once('.') {
            Some((_, rest)) => cur = rest,
            None => return false,
        }
    }
}

fn deterministic_ext_id(input: &str) -> String {
    // FNV-1a 128-bit style spread into 32 lowercase a-p chars (Chrome extension ID alphabet).
    let mut h1: u64 = 0xcbf29ce484222325;
    let mut h2: u64 = 0x84222325cbf29ce4;
    for b in input.as_bytes() {
        h1 ^= *b as u64;
        h1 = h1.wrapping_mul(0x100000001b3);
        h2 ^= (*b as u64).wrapping_add(17);
        h2 = h2.wrapping_mul(0x100000001b3);
    }
    let mut out = String::with_capacity(32);
    for val in [h1, h2] {
        for shift in (0..16).rev() {
            let nibble = ((val >> (shift * 4)) & 0x0f) as u8;
            out.push((b'a' + nibble) as char);
        }
    }
    out
}

fn guess_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Converts a Chrome match pattern (e.g. `https://*.example.com/*`) to a WebKitGTK URI pattern
/// or checks URL matching in Rust for WebView2 / runtime evaluation.
#[cfg(any(not(target_os = "linux"), test))]
pub fn url_matches_chrome_pattern(url: &str, pattern: &str) -> bool {
    if pattern == "<all_urls>" {
        return url.starts_with("http://") || url.starts_with("https://") || url.starts_with("file://");
    }
    let Some((pat_scheme, rest)) = pattern.split_once("://") else {
        return false;
    };
    let Some((url_scheme, url_rest)) = url.split_once("://") else {
        return false;
    };

    let scheme_ok = match pat_scheme {
        "*" => url_scheme == "http" || url_scheme == "https",
        s => s == url_scheme,
    };
    if !scheme_ok {
        return false;
    }

    let (pat_host, pat_path) = rest.split_once('/').unwrap_or((rest, ""));
    let (url_host_port, url_path) = url_rest.split_once('/').unwrap_or((url_rest, ""));
    let url_host = url_host_port.split(':').next().unwrap_or(url_host_port);

    let host_ok = if pat_host == "*" {
        true
    } else if let Some(domain) = pat_host.strip_prefix("*.") {
        url_host == domain || url_host.ends_with(&format!(".{}", domain))
    } else {
        let pat_host_no_port = pat_host.split(':').next().unwrap_or(pat_host);
        url_host == pat_host_no_port
    };
    if !host_ok {
        return false;
    }

    glob_match(pat_path, url_path)
}

#[cfg(any(not(target_os = "linux"), test))]
fn glob_match(pattern: &str, text: &str) -> bool {
    if pattern.is_empty() || pattern == "*" {
        return true;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return text == pattern;
    }
    let mut pos = 0usize;
    for (idx, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if idx == 0 {
            if !text.starts_with(part) {
                return false;
            }
            pos = part.len();
        } else if idx == parts.len() - 1 && !pattern.ends_with('*') {
            return text[pos..].ends_with(part);
        } else if let Some(found) = text[pos..].find(part) {
            pos += found + part.len();
        } else {
            return false;
        }
    }
    true
}

/// Builds the JS shim that provides `chrome.*` and `browser.*` APIs inside a content script or popup.
pub fn build_chrome_api_shim(
    ext: &InstalledExtension,
    is_popup: bool,
    active_tab: Option<(u64, &str, &str)>,
) -> String {
    let manifest_json = serde_json::to_string(&ext.raw_manifest).unwrap_or_else(|_| "{}".to_string());
    let ext_id_json = serde_json::to_string(&ext.id).unwrap_or_else(|_| "\"\"".to_string());
    let i18n_msgs = load_i18n_messages(Path::new(&ext.path), &ext.raw_manifest);
    let i18n_json = serde_json::to_string(&i18n_msgs).unwrap_or_else(|_| "{}".to_string());
    let popup_flag = if is_popup { "true" } else { "false" };
    let active_tab_json = match active_tab {
        Some((id, url, title)) => serde_json::json!({
            "id": id,
            "url": url,
            "title": title,
            "active": true,
            "windowId": 1
        })
        .to_string(),
        None => "null".to_string(),
    };

    format!(
        r#"(function() {{
  const __extId = {ext_id_json};
  const __manifest = {manifest_json};
  const __i18n = {i18n_json};
  const __isPopup = {popup_flag};
  const __activeTab = {active_tab_json};
  const __listeners = {{ message: [], storage: [] }};
  window.__forkitExtCallbacks = window.__forkitExtCallbacks || {{}};
  let __reqSeq = 1;

  if (!window.__forkitExtReply) {{
    window.__forkitExtReply = function(reqId, result) {{
      const cb = window.__forkitExtCallbacks[reqId];
      if (cb) {{
        delete window.__forkitExtCallbacks[reqId];
        cb(result);
      }}
    }};
  }}

  function __nativeStorageCall(action, payload) {{
    return new Promise((resolve) => {{
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.forkitExt) {{
        const reqId = __extId + '_' + (__reqSeq++) + '_' + Math.random().toString(36).slice(2);
        window.__forkitExtCallbacks[reqId] = resolve;
        window.webkit.messageHandlers.forkitExt.postMessage(JSON.stringify({{
          type: 'storage',
          extId: __extId,
          reqId,
          action,
          payload
        }}));
        setTimeout(() => {{
          if (window.__forkitExtCallbacks[reqId]) {{
            delete window.__forkitExtCallbacks[reqId];
            resolve({{}});
          }}
        }}, 1500);
        return;
      }}
      // Fallback to localStorage on platforms without messageHandlers
      const prefix = '__forkit_ext_' + __extId + '_';
      if (action === 'get') {{
        const out = {{}};
        const allKeys = Object.keys(localStorage).filter(k => k.startsWith(prefix));
        if (payload === null || payload === undefined) {{
          for (const k of allKeys) out[k.slice(prefix.length)] = JSON.parse(localStorage.getItem(k));
        }} else if (typeof payload === 'string') {{
          const raw = localStorage.getItem(prefix + payload);
          if (raw !== null) out[payload] = JSON.parse(raw);
        }} else if (Array.isArray(payload)) {{
          for (const k of payload) {{
            const raw = localStorage.getItem(prefix + k);
            if (raw !== null) out[k] = JSON.parse(raw);
          }}
        }} else if (typeof payload === 'object') {{
          for (const [k, defVal] of Object.entries(payload)) {{
            const raw = localStorage.getItem(prefix + k);
            out[k] = raw !== null ? JSON.parse(raw) : defVal;
          }}
        }}
        resolve(out);
      }} else if (action === 'set') {{
        if (payload && typeof payload === 'object') {{
          for (const [k, v] of Object.entries(payload)) localStorage.setItem(prefix + k, JSON.stringify(v));
        }}
        resolve({{ ok: true }});
      }} else if (action === 'remove') {{
        const list = Array.isArray(payload) ? payload : [payload];
        for (const k of list) localStorage.removeItem(prefix + k);
        resolve({{ ok: true }});
      }} else if (action === 'clear') {{
        Object.keys(localStorage).filter(k => k.startsWith(prefix)).forEach(k => localStorage.removeItem(k));
        resolve({{ ok: true }});
      }}
    }});
  }}

  const storageArea = {{
    get(keys, cb) {{
      const p = __nativeStorageCall('get', keys ?? null);
      if (typeof cb === 'function') p.then(cb);
      return p;
    }},
    set(items, cb) {{
      const p = __nativeStorageCall('set', items || {{}}).then(() => {{
        const changes = {{}};
        for (const [k, v] of Object.entries(items || {{}})) changes[k] = {{ newValue: v }};
        __listeners.storage.forEach(fn => {{ try {{ fn(changes, 'local'); }} catch(_) {{}} }});
      }});
      if (typeof cb === 'function') p.then(() => cb());
      return p;
    }},
    remove(keys, cb) {{
      const p = __nativeStorageCall('remove', keys);
      if (typeof cb === 'function') p.then(() => cb());
      return p;
    }},
    clear(cb) {{
      const p = __nativeStorageCall('clear', null);
      if (typeof cb === 'function') p.then(() => cb());
      return p;
    }}
  }};

  const api = {{
    runtime: {{
      id: __extId,
      lastError: null,
      getManifest: () => __manifest,
      getURL: (p) => 'chrome-extension://' + __extId + '/' + String(p || '').replace(/^\/+/, ''),
      sendMessage: (msg, cb) => {{
        let reply = undefined;
        if (msg && msg.what === 'popupPanelData') {{
          const tab = __activeTab || {{ id: 1, url: '', title: '' }};
          let host = '';
          try {{ host = new URL(tab.url).hostname; }} catch (_) {{}}
          reply = {{
            tabId: tab.id,
            tabURL: tab.url,
            tabHostname: host,
            isSupported: /^https?:/.test(tab.url || ''),
            hasScriptlets: true,
            filteringMode: 2,
            defaultFilteringMode: 2,
            level: 2
          }};
        }}
        const p = Promise.resolve(reply);
        if (typeof cb === 'function') p.then(cb);
        return p;
      }},
      onMessage: {{
        addListener: (fn) => __listeners.message.push(fn),
        removeListener: (fn) => {{ const i = __listeners.message.indexOf(fn); if (i >= 0) __listeners.message.splice(i, 1); }},
        hasListener: (fn) => __listeners.message.includes(fn)
      }}
    }},
    storage: {{
      local: storageArea,
      sync: storageArea,
      onChanged: {{
        addListener: (fn) => __listeners.storage.push(fn),
        removeListener: (fn) => {{ const i = __listeners.storage.indexOf(fn); if (i >= 0) __listeners.storage.splice(i, 1); }},
        hasListener: (fn) => __listeners.storage.includes(fn)
      }}
    }},
    tabs: {{
      query: (queryInfo, cb) => {{
        const tab = __activeTab || {{ id: 1, url: location.href, title: document.title, active: true, windowId: 1 }};
        const p = Promise.resolve([tab]);
        if (typeof cb === 'function') p.then(cb);
        return p;
      }},
      create: (opts, cb) => {{
        if (__isPopup && opts && opts.url) {{
          fetch('chrome-extension://' + __extId + '/__forkit_open_tab', {{
            method: 'POST',
            headers: {{ 'Content-Type': 'application/json' }},
            body: JSON.stringify({{ url: opts.url }})
          }}).catch(() => {{}});
        }}
        const p = Promise.resolve({{ id: 1, url: opts?.url || '' }});
        if (typeof cb === 'function') p.then(cb);
        return p;
      }},
      reload: (_tabId, cb) => {{
        if (__isPopup) {{
          fetch('chrome-extension://' + __extId + '/__forkit_reload_tab', {{ method: 'POST' }}).catch(() => {{}});
        }} else {{
          location.reload();
        }}
        const p = Promise.resolve();
        if (typeof cb === 'function') p.then(cb);
        return p;
      }},
      sendMessage: (_tabId, msg, cb) => {{
        const p = Promise.resolve(undefined);
        if (typeof cb === 'function') p.then(cb);
        return p;
      }}
    }},
    i18n: {{
      getMessage: (key) => __i18n[String(key || '').toLowerCase()] || '',
      getUILanguage: () => navigator.language || 'en'
    }},
    declarativeNetRequest: {{
      getEnabledRulesets: (cb) => {{
        const list = (__manifest.declarative_net_request?.rule_resources || [])
          .filter(r => r.enabled).map(r => r.id);
        const p = Promise.resolve(list);
        if (typeof cb === 'function') p.then(cb);
        return p;
      }},
      updateEnabledRulesets: (_opts, cb) => {{
        const p = Promise.resolve();
        if (typeof cb === 'function') p.then(cb);
        return p;
      }},
      getDynamicRules: (cb) => {{ const p = Promise.resolve([]); if (typeof cb === 'function') p.then(cb); return p; }},
      updateDynamicRules: (_o, cb) => {{ const p = Promise.resolve(); if (typeof cb === 'function') p.then(cb); return p; }},
      getSessionRules: (cb) => {{ const p = Promise.resolve([]); if (typeof cb === 'function') p.then(cb); return p; }},
      updateSessionRules: (_o, cb) => {{ const p = Promise.resolve(); if (typeof cb === 'function') p.then(cb); return p; }},
      setExtensionActionOptions: (_o, cb) => {{ const p = Promise.resolve(); if (typeof cb === 'function') p.then(cb); return p; }},
      isRegexSupported: (_o, cb) => {{ const p = Promise.resolve({{ isSupported: true }}); if (typeof cb === 'function') p.then(cb); return p; }}
    }},
    scripting: {{
      getRegisteredContentScripts: (cb) => {{ const p = Promise.resolve([]); if (typeof cb === 'function') p.then(cb); return p; }},
      registerContentScripts: (_s, cb) => {{ const p = Promise.resolve(); if (typeof cb === 'function') p.then(cb); return p; }},
      unregisterContentScripts: (_f, cb) => {{ const p = Promise.resolve(); if (typeof cb === 'function') p.then(cb); return p; }},
      executeScript: (_i, cb) => {{ const p = Promise.resolve([]); if (typeof cb === 'function') p.then(cb); return p; }},
      insertCSS: (_i, cb) => {{ const p = Promise.resolve(); if (typeof cb === 'function') p.then(cb); return p; }}
    }},
    action: {{
      setBadgeText: (_d, cb) => {{ const p = Promise.resolve(); if (typeof cb === 'function') p.then(cb); return p; }},
      setBadgeBackgroundColor: (_d, cb) => {{ const p = Promise.resolve(); if (typeof cb === 'function') p.then(cb); return p; }},
      setIcon: (_d, cb) => {{ const p = Promise.resolve(); if (typeof cb === 'function') p.then(cb); return p; }},
      setTitle: (_d, cb) => {{ const p = Promise.resolve(); if (typeof cb === 'function') p.then(cb); return p; }},
      enable: (_t, cb) => {{ const p = Promise.resolve(); if (typeof cb === 'function') p.then(cb); return p; }},
      disable: (_t, cb) => {{ const p = Promise.resolve(); if (typeof cb === 'function') p.then(cb); return p; }}
    }},
    permissions: {{
      contains: (_p, cb) => {{ const p = Promise.resolve(true); if (typeof cb === 'function') p.then(cb); return p; }},
      getAll: (cb) => {{ const p = Promise.resolve({{ permissions: __manifest.permissions || [], origins: ['<all_urls>'] }}); if (typeof cb === 'function') p.then(cb); return p; }},
      request: (_p, cb) => {{ const p = Promise.resolve(true); if (typeof cb === 'function') p.then(cb); return p; }}
    }},
    windows: {{
      getCurrent: (cb) => {{ const p = Promise.resolve({{ id: 1, focused: true, type: 'normal' }}); if (typeof cb === 'function') p.then(cb); return p; }}
    }}
  }};
  api.browserAction = api.action;
  api.runtime.openOptionsPage = () => {{
    const page = __manifest.options_ui?.page || __manifest.options_page;
    if (page) api.tabs.create({{ url: api.runtime.getURL(page) }});
    return Promise.resolve();
  }};

  window.__forkitExtApis = window.__forkitExtApis || {{}};
  window.__forkitExtApis[__extId] = api;
  if (__isPopup) {{
    window.chrome = api;
    window.browser = api;
  }}
}})();"#,
        ext_id_json = ext_id_json,
        manifest_json = manifest_json,
        popup_flag = popup_flag,
    )
}

/// Reads a content script rule's JS and CSS sources for an extension and wraps them with the
/// isolated `chrome` / `browser` shim + runtime disable guard.
pub fn build_rule_bundle(ext: &InstalledExtension, rule: &ContentScriptRule) -> (Option<String>, Option<String>) {
    let root = Path::new(&ext.path);

    let mut css_combined = String::new();
    for css_rel in &rule.css_files {
        let p = root.join(css_rel.trim_start_matches('/'));
        if let Ok(content) = fs::read_to_string(p) {
            css_combined.push_str(&content);
            css_combined.push('\n');
        }
    }

    let mut js_combined = String::new();
    for js_rel in &rule.js_files {
        let p = root.join(js_rel.trim_start_matches('/'));
        if let Ok(content) = fs::read_to_string(p) {
            js_combined.push_str(&content);
            js_combined.push_str("\n;\n");
        }
    }

    let js_wrapped = if js_combined.trim().is_empty() {
        None
    } else {
        let shim = build_chrome_api_shim(ext, false, None);
        let ext_id_json = serde_json::to_string(&ext.id).unwrap_or_else(|_| "\"\"".to_string());
        Some(format!(
            "{shim}\n(function() {{\n  if (window.__forkitExtDisabled && window.__forkitExtDisabled[{ext_id_json}]) return;\n  const chrome = window.__forkitExtApis[{ext_id_json}];\n  const browser = chrome;\n  try {{\n{js_combined}\n  }} catch (e) {{ console.error('[Forkit Ext]', {ext_id_json}, e); }}\n}})();"
        ))
    };

    let css_opt = if css_combined.trim().is_empty() {
        None
    } else {
        Some(css_combined)
    };

    (js_wrapped, css_opt)
}

/// Converts Chrome match patterns into WebKitGTK UserContentManager allow/block patterns.
pub fn chrome_patterns_to_webkit(patterns: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for p in patterns {
        if p == "<all_urls>" {
            out.push("http://*/*".to_string());
            out.push("https://*/*".to_string());
        } else if let Some(rest) = p.strip_prefix("*://") {
            out.push(format!("http://{}", rest));
            out.push(format!("https://{}", rest));
        } else {
            out.push(p.clone());
        }
    }
    out
}

/// Injects all enabled extensions into a WebKitGTK WebView's UserContentManager.
#[cfg(target_os = "linux")]
pub fn install_extensions_on_webkit(app: &AppHandle, wk: &webkit2gtk::WebView) {
    use webkit2gtk::{
        UserContentInjectedFrames, UserContentManagerExt, UserScript, UserScriptInjectionTime,
        UserStyleLevel, UserStyleSheet, WebViewExt,
    };

    let Some(ucm) = WebViewExt::user_content_manager(wk) else {
        return;
    };

    // Register storage message handler once per UCM
    let registered = ucm.register_script_message_handler("forkitExt");
    if registered {
        let app_msg = app.clone();
        let wk_weak = webkit2gtk::glib::object::ObjectExt::downgrade(wk);
        ucm.connect_script_message_received(None, move |_ucm, js_res| {
            let Some(val) = js_res.js_value() else {
                return;
            };
            let raw = val.to_string();
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw.as_str()) else {
                return;
            };
            let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if msg_type == "check_cws" {
                let cws_id = parsed.get("extId").and_then(|v| v.as_str()).unwrap_or("");
                let req_id = parsed.get("reqId").and_then(|v| v.as_str()).unwrap_or("");
                let installed = if let Some(st) = app_msg.try_state::<ExtensionManagerState>() {
                    let mgr = st.inner.lock().unwrap();
                    mgr.extensions.iter().any(|e| {
                        e.id == cws_id
                            || Path::new(&e.path)
                                .file_name()
                                .and_then(|n| n.to_str())
                                == Some(cws_id)
                    })
                } else {
                    false
                };
                if let Some(wk_strong) = wk_weak.upgrade() {
                    let req_json = serde_json::to_string(req_id).unwrap_or_else(|_| "\"\"".to_string());
                    let res_json = serde_json::json!({ "installed": installed }).to_string();
                    let js = format!("window.__forkitExtReply && window.__forkitExtReply({req_json}, {res_json});");
                    wk_strong.evaluate_javascript(&js, None, None, webkit2gtk::gio::Cancellable::NONE, |_| {});
                }
                return;
            }
            if msg_type == "install_cws" {
                let cws_id = parsed
                    .get("extId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let req_id = parsed
                    .get("reqId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let app_cws = app_msg.clone();
                let wk_cws = wk_weak.clone();
                let (tx, rx) = tokio::sync::oneshot::channel();
                tauri::async_runtime::spawn(async move {
                    let res = install_from_chrome_web_store(&app_cws, &cws_id).await;
                    let _ = tx.send(res);
                });
                webkit2gtk::glib::MainContext::default().spawn_local(async move {
                    if let Ok(res) = rx.await {
                        let json_res = match res {
                            Ok(ext) => serde_json::json!({ "ok": true, "name": ext.name, "id": ext.id }),
                            Err(err) => serde_json::json!({ "ok": false, "error": err }),
                        };
                        if let Some(wk_strong) = wk_cws.upgrade() {
                            let req_json = serde_json::to_string(&req_id).unwrap_or_else(|_| "\"\"".to_string());
                            let res_json = serde_json::to_string(&json_res).unwrap_or_else(|_| "{}".to_string());
                            let js = format!("window.__forkitExtReply && window.__forkitExtReply({req_json}, {res_json});");
                            wk_strong.evaluate_javascript(&js, None, None, webkit2gtk::gio::Cancellable::NONE, |_| {});
                        }
                    }
                });
                return;
            }
            if msg_type != "storage" {
                return;
            }
            let ext_id = parsed.get("extId").and_then(|v| v.as_str()).unwrap_or("");
            let req_id = parsed.get("reqId").and_then(|v| v.as_str()).unwrap_or("");
            let action = parsed.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let payload = parsed.get("payload").cloned().unwrap_or(serde_json::Value::Null);

            let result = if let Some(st) = app_msg.try_state::<ExtensionManagerState>() {
                st.inner.lock().unwrap().storage_op(ext_id, action, payload)
            } else {
                serde_json::json!({})
            };

            if let Some(wk_strong) = wk_weak.upgrade() {
                let req_json = serde_json::to_string(req_id).unwrap_or_else(|_| "\"\"".to_string());
                let res_json = serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string());
                let js = format!("window.__forkitExtReply && window.__forkitExtReply({req_json}, {res_json});");
                wk_strong.evaluate_javascript(&js, None, None, webkit2gtk::gio::Cancellable::NONE, |_| {});
            }
        });
    }

    if registered {
        // Inject Chrome Web Store "Add to Forkit" bridge
        let cws_allow = ["https://chromewebstore.google.com/*", "https://chrome.google.com/webstore/*"];
        let cws_script = UserScript::new(
            CWS_BRIDGE_SCRIPT,
            UserContentInjectedFrames::TopFrame,
            UserScriptInjectionTime::End,
            &cws_allow,
            &[],
        );
        ucm.add_script(&cws_script);
    }

    let Some(ext_state) = app.try_state::<ExtensionManagerState>() else {
        return;
    };
    let (extensions, dnr_script_opt) = {
        let mgr = ext_state.inner.lock().unwrap();
        if mgr.extensions.is_empty() && mgr.dnr_rules.is_empty() {
            return;
        }
        (mgr.extensions.clone(), mgr.build_dnr_runtime_script())
    };

    if let Some(dnr_js) = dnr_script_opt {
        let dnr_allow = ["http://*/*", "https://*/*"];
        let us = UserScript::new(
            &dnr_js,
            UserContentInjectedFrames::AllFrames,
            UserScriptInjectionTime::Start,
            &dnr_allow,
            &[],
        );
        ucm.add_script(&us);
    }

    for ext in extensions {
        if !ext.enabled {
            continue;
        }
        for rule in &ext.content_scripts {
            let (js_opt, css_opt) = build_rule_bundle(&ext, rule);
            let allow_owned = chrome_patterns_to_webkit(&rule.matches);
            let block_owned = chrome_patterns_to_webkit(&rule.exclude_matches);
            let allow_refs: Vec<&str> = allow_owned.iter().map(|s| s.as_str()).collect();
            let block_refs: Vec<&str> = block_owned.iter().map(|s| s.as_str()).collect();
            let frames = if rule.all_frames {
                UserContentInjectedFrames::AllFrames
            } else {
                UserContentInjectedFrames::TopFrame
            };
            let inj_time = if rule.run_at == "document_start" {
                UserScriptInjectionTime::Start
            } else {
                UserScriptInjectionTime::End
            };

            if let Some(css) = css_opt {
                let ss = UserStyleSheet::new(
                    &css,
                    frames,
                    UserStyleLevel::User,
                    &allow_refs,
                    &block_refs,
                );
                ucm.add_style_sheet(&ss);
            }
            if let Some(js) = js_opt {
                let us = UserScript::new(&js, frames, inj_time, &allow_refs, &block_refs);
                ucm.add_script(&us);
            }
        }
    }
}

/// Non-Linux fallback: returns JS/CSS injection script for a given URL on PageLoadEvent::Finished.
#[cfg(not(target_os = "linux"))]
pub fn build_page_injection_for_url(app: &AppHandle, url: &str) -> Option<String> {
    let ext_state = app.try_state::<ExtensionManagerState>()?;
    let extensions = ext_state.inner.lock().unwrap().extensions.clone();
    let mut combined = String::new();
    for ext in extensions {
        if !ext.enabled {
            continue;
        }
        for rule in &ext.content_scripts {
            let matched = rule.matches.iter().any(|p| url_matches_chrome_pattern(url, p));
            let excluded = rule
                .exclude_matches
                .iter()
                .any(|p| url_matches_chrome_pattern(url, p));
            if !matched || excluded {
                continue;
            }
            let (js_opt, css_opt) = build_rule_bundle(&ext, rule);
            if let Some(css) = css_opt {
                let css_json = serde_json::to_string(&css).unwrap_or_else(|_| "\"\"".to_string());
                combined.push_str(&format!(
                    "(function(){{ const s=document.createElement('style'); s.textContent={css_json}; (document.head||document.documentElement).appendChild(s); }})();\n"
                ));
            }
            if let Some(js) = js_opt {
                combined.push_str(&js);
                combined.push('\n');
            }
        }
    }
    if combined.is_empty() {
        None
    } else {
        Some(combined)
    }
}

// ── Tauri Commands ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ExtensionSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub manifest_version: u8,
    pub path: String,
    pub enabled: bool,
    pub popup: Option<String>,
}

impl From<&InstalledExtension> for ExtensionSummary {
    fn from(e: &InstalledExtension) -> Self {
        Self {
            id: e.id.clone(),
            name: e.name.clone(),
            version: e.version.clone(),
            description: e.description.clone(),
            manifest_version: e.manifest_version,
            path: e.path.clone(),
            enabled: e.enabled,
            popup: e.popup.clone(),
        }
    }
}

#[tauri::command]
pub fn list_extensions(app: AppHandle) -> Vec<ExtensionSummary> {
    let Some(st) = app.try_state::<ExtensionManagerState>() else {
        return Vec::new();
    };
    let res = st
        .inner
        .lock()
        .unwrap()
        .extensions
        .iter()
        .map(ExtensionSummary::from)
        .collect();
    res
}

#[tauri::command]
pub fn load_unpacked_extension(app: AppHandle, folder_path: String) -> Result<ExtensionSummary, String> {
    let st = app
        .try_state::<ExtensionManagerState>()
        .ok_or_else(|| "ExtensionManagerState not found".to_string())?;
    let ext = st.inner.lock().unwrap().load_unpacked(Path::new(&folder_path))?;
    Ok(ExtensionSummary::from(&ext))
}

#[tauri::command]
pub fn toggle_extension(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let st = app
        .try_state::<ExtensionManagerState>()
        .ok_or_else(|| "ExtensionManagerState not found".to_string())?;
    st.inner.lock().unwrap().set_enabled(&id, enabled)?;
    Ok(())
}

#[tauri::command]
pub fn remove_extension(app: AppHandle, id: String) -> Result<(), String> {
    let st = app
        .try_state::<ExtensionManagerState>()
        .ok_or_else(|| "ExtensionManagerState not found".to_string())?;
    st.inner.lock().unwrap().remove_extension(&id)?;
    Ok(())
}

#[tauri::command]
pub fn reload_extension(app: AppHandle, id: String) -> Result<ExtensionSummary, String> {
    let st = app
        .try_state::<ExtensionManagerState>()
        .ok_or_else(|| "ExtensionManagerState not found".to_string())?;
    let ext = st.inner.lock().unwrap().reload_extension(&id)?;
    Ok(ExtensionSummary::from(&ext))
}

#[tauri::command]
pub async fn install_cws_extension(
    app: AppHandle,
    id_or_url: String,
) -> Result<ExtensionSummary, String> {
    let ext = install_from_chrome_web_store(&app, &id_or_url).await?;
    Ok(ExtensionSummary::from(&ext))
}

pub fn extract_cws_extension_id(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.len() == 32 && trimmed.bytes().all(|b| matches!(b, b'a'..=b'p' | b'a'..=b'z')) {
        return Some(trimmed.to_string());
    }
    let no_query = trimmed.split(&['?', '#'][..]).next().unwrap_or(trimmed);
    for seg in no_query.split('/').rev() {
        if seg.len() == 32 && seg.bytes().all(|b| matches!(b, b'a'..=b'z')) {
            return Some(seg.to_string());
        }
    }
    None
}

pub fn extract_crx_to_dir(crx_bytes: &[u8], dest_dir: &Path) -> Result<(), String> {
    use std::io::Read;

    let zip_offset = if crx_bytes.starts_with(b"Cr24") && crx_bytes.len() >= 12 {
        let ver = u32::from_le_bytes(crx_bytes[4..8].try_into().unwrap());
        if ver == 3 {
            let hdr_len = u32::from_le_bytes(crx_bytes[8..12].try_into().unwrap()) as usize;
            12 + hdr_len
        } else if ver == 2 && crx_bytes.len() >= 16 {
            let pk_len = u32::from_le_bytes(crx_bytes[8..12].try_into().unwrap()) as usize;
            let sig_len = u32::from_le_bytes(crx_bytes[12..16].try_into().unwrap()) as usize;
            16 + pk_len + sig_len
        } else {
            crx_bytes
                .windows(4)
                .position(|w| w == b"PK\x03\x04")
                .ok_or_else(|| "Invalid CRX archive".to_string())?
        }
    } else if crx_bytes.starts_with(b"PK\x03\x04") {
        0
    } else {
        crx_bytes
            .windows(4)
            .position(|w| w == b"PK\x03\x04")
            .ok_or_else(|| "Downloaded file is not a valid CRX/ZIP archive".to_string())?
    };

    if zip_offset >= crx_bytes.len() {
        return Err("Corrupt CRX header offset".to_string());
    }
    let zip = &crx_bytes[zip_offset..];

    // Locate End of Central Directory (PK\x05\x06)
    let eocd_pos = zip
        .windows(4)
        .rposition(|w| w == b"PK\x05\x06")
        .ok_or_else(|| "ZIP End of Central Directory not found".to_string())?;
    if eocd_pos + 22 > zip.len() {
        return Err("Truncated ZIP EOCD".to_string());
    }
    let total_entries = u16::from_le_bytes(zip[eocd_pos + 10..eocd_pos + 12].try_into().unwrap()) as usize;
    let cd_offset = u32::from_le_bytes(zip[eocd_pos + 16..eocd_pos + 20].try_into().unwrap()) as usize;

    if dest_dir.exists() {
        let _ = fs::remove_dir_all(dest_dir);
    }
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;

    let mut pos = cd_offset;
    for _ in 0..total_entries {
        if pos + 46 > zip.len() || &zip[pos..pos + 4] != b"PK\x01\x02" {
            return Err("Invalid ZIP Central Directory entry".to_string());
        }
        let method = u16::from_le_bytes(zip[pos + 10..pos + 12].try_into().unwrap());
        let comp_size = u32::from_le_bytes(zip[pos + 20..pos + 24].try_into().unwrap()) as usize;
        let name_len = u16::from_le_bytes(zip[pos + 28..pos + 30].try_into().unwrap()) as usize;
        let extra_len = u16::from_le_bytes(zip[pos + 30..pos + 32].try_into().unwrap()) as usize;
        let comment_len = u16::from_le_bytes(zip[pos + 32..pos + 34].try_into().unwrap()) as usize;
        let local_hdr_off = u32::from_le_bytes(zip[pos + 42..pos + 46].try_into().unwrap()) as usize;

        if pos + 46 + name_len > zip.len() {
            return Err("Truncated ZIP entry name".to_string());
        }
        let name = String::from_utf8_lossy(&zip[pos + 46..pos + 46 + name_len]).to_string();
        pos += 46 + name_len + extra_len + comment_len;

        if name.ends_with('/') || name.is_empty() {
            continue;
        }
        // Prevent Zip Slip
        let rel_path = Path::new(&name);
        if rel_path.is_absolute()
            || rel_path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }

        if local_hdr_off + 30 > zip.len() || &zip[local_hdr_off..local_hdr_off + 4] != b"PK\x03\x04" {
            return Err("Invalid ZIP Local File Header".to_string());
        }
        let l_name_len = u16::from_le_bytes(zip[local_hdr_off + 26..local_hdr_off + 28].try_into().unwrap()) as usize;
        let l_extra_len = u16::from_le_bytes(zip[local_hdr_off + 28..local_hdr_off + 30].try_into().unwrap()) as usize;
        let data_start = local_hdr_off + 30 + l_name_len + l_extra_len;
        let data_end = data_start + comp_size;
        if data_end > zip.len() {
            return Err("Truncated ZIP file payload".to_string());
        }
        let compressed = &zip[data_start..data_end];

        let out_bytes = match method {
            0 => compressed.to_vec(),
            8 => {
                let mut decoder = flate2::read::DeflateDecoder::new(compressed);
                let mut buf = Vec::new();
                decoder
                    .read_to_end(&mut buf)
                    .map_err(|e| format!("Deflate decode failed for {}: {}", name, e))?;
                buf
            }
            other => {
                return Err(format!("Unsupported ZIP compression method {} for {}", other, name));
            }
        };

        let out_path = dest_dir.join(rel_path);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&out_path, &out_bytes).map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub async fn install_from_chrome_web_store(
    app: &AppHandle,
    id_or_url: &str,
) -> Result<InstalledExtension, String> {
    let ext_id = extract_cws_extension_id(id_or_url)
        .ok_or_else(|| "Invalid Chrome Web Store URL or 32-char extension ID".to_string())?;

    let crx_url = format!(
        "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0.0.0&acceptformat=crx2,crx3&x=id%3D{}%26uc",
        ext_id
    );

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&crx_url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Chrome Web Store returned HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed reading CRX bytes: {}", e))?;

    let data_dir = {
        let st = app
            .try_state::<ExtensionManagerState>()
            .ok_or_else(|| "ExtensionManagerState not found".to_string())?;
        let dir = st.inner.lock().unwrap().data_dir.clone();
        dir
    };

    let dest_dir = data_dir.join("crx-extensions").join(&ext_id);
    extract_crx_to_dir(&bytes, &dest_dir)?;

    let st = app
        .try_state::<ExtensionManagerState>()
        .ok_or_else(|| "ExtensionManagerState not found".to_string())?;
    let ext = st.inner.lock().unwrap().load_unpacked(&dest_dir)?;
    Ok(ext)
}

const CWS_BRIDGE_SCRIPT: &str = r#"(function() {
  if (window.__forkitCwsBridge) return;
  window.__forkitCwsBridge = true;
  window.__forkitExtCallbacks = window.__forkitExtCallbacks || {};
  if (!window.__forkitExtReply) {
    window.__forkitExtReply = function(reqId, result) {
      const cb = window.__forkitExtCallbacks[reqId];
      if (cb) {
        delete window.__forkitExtCallbacks[reqId];
        cb(result);
      }
    };
  }

  function getExtId() {
    const parts = location.pathname.split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^[a-z]{32}$/.test(parts[i])) return parts[i];
    }
    return null;
  }

  function hideUnavailableBanner() {
    const needles = ['öğe şu anda kullanılamıyor', 'item is currently unavailable', 'currently unavailable', 'rehberi görüntüleyin', 'view troubleshooting'];
    const candidates = document.querySelectorAll('div, section, aside');
    for (const el of candidates) {
      if (el.dataset.forkitHidden) continue;
      if (el.querySelector('h1')) continue;
      const txt = (el.innerText || '').trim().toLowerCase();
      if (!txt || txt.length > 260) continue;
      if (needles.some(n => txt.includes(n))) {
        const rect = el.getBoundingClientRect();
        if (rect.height > 20 && rect.height < 140) {
          el.style.display = 'none';
          el.dataset.forkitHidden = '1';
        }
      }
    }
  }

  function injectButton() {
    hideUnavailableBanner();

    const extId = getExtId();
    if (!extId) return;

    if (document.getElementById('forkit-cws-install-btn')) {
      const existing = document.getElementById('forkit-cws-install-btn');
      if (existing.dataset.extId === extId) return;
      existing.remove();
    }

    // Find disabled "Add to Chrome" / "Chrome'a ekle" button
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const targetBtn = buttons.find(b => {
      const t = (b.innerText || b.textContent || '').trim().toLowerCase();
      return t.includes("chrome'a ekle") || t.includes('add to chrome') || t.includes('chrome’a ekle');
    });
    if (!targetBtn || !targetBtn.parentElement) return;

    targetBtn.style.display = 'none';

    const btn = document.createElement('button');
    btn.id = 'forkit-cws-install-btn';
    btn.dataset.extId = extId;
    btn.textContent = "Forkit'e Ekle";
    btn.style.cssText = 'background:#8b5cf6;color:#fff;border:none;border-radius:8px;padding:10px 22px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:background 0.15s;';
    btn.onmouseenter = () => { if (!btn.disabled) btn.style.background = '#7c3aed'; };
    btn.onmouseleave = () => { if (!btn.disabled) btn.style.background = '#8b5cf6'; };

    const setInstalledState = () => {
      btn.disabled = true;
      btn.textContent = "✓ Forkit'e Eklendi";
      btn.style.background = '#188038';
      btn.style.cursor = 'default';
    };

    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.forkitExt) {
      const chkId = 'chk_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      window.__forkitExtCallbacks[chkId] = (res) => {
        if (res && res.installed) setInstalledState();
      };
      window.webkit.messageHandlers.forkitExt.postMessage(JSON.stringify({
        type: 'check_cws',
        extId,
        reqId: chkId
      }));
    }

    btn.onclick = () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = 'Yükleniyor...';
      btn.style.background = '#5f6368';
      const reqId = 'cws_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      window.__forkitExtCallbacks[reqId] = (res) => {
        if (res && res.ok) {
          setInstalledState();
        } else {
          btn.disabled = false;
          btn.textContent = "Tekrar Dene (Hata)";
          btn.style.background = '#c5221f';
          console.error('[Forkit CWS]', res && res.error);
        }
      };
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.forkitExt) {
        window.webkit.messageHandlers.forkitExt.postMessage(JSON.stringify({
          type: 'install_cws',
          extId,
          reqId
        }));
      }
    };

    targetBtn.parentElement.insertBefore(btn, targetBtn);
  }

  setInterval(injectButton, 600);
  if (document.readyState !== 'loading') injectButton();
  else document.addEventListener('DOMContentLoaded', injectButton);
})();"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_patterns_work() {
        assert!(url_matches_chrome_pattern("https://example.com/foo", "<all_urls>"));
        assert!(url_matches_chrome_pattern("https://sub.example.com/a/b", "https://*.example.com/*"));
        assert!(url_matches_chrome_pattern("https://example.com/", "https://*.example.com/*"));
        assert!(!url_matches_chrome_pattern("http://example.com/", "https://*.example.com/*"));
        assert!(url_matches_chrome_pattern("https://youtube.com/watch?v=123", "*://youtube.com/watch*"));
        assert!(!url_matches_chrome_pattern("https://youtube.com/shorts/123", "*://youtube.com/watch*"));
    }

    #[test]
    fn load_storage_and_asset_resolution_work() {
        let base = std::env::temp_dir().join(format!("forkit-ext-test-{}", std::process::id()));
        let ext_dir = base.join("sample-ext");
        let data_dir = base.join("data");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&ext_dir).unwrap();
        fs::write(
            ext_dir.join("manifest.json"),
            r#"{
                "manifest_version": 3,
                "name": "Sample Ext",
                "version": "1.2.3",
                "action": { "default_popup": "popup.html" },
                "content_scripts": [{
                    "matches": ["https://*.example.com/*"],
                    "js": ["content.js"],
                    "run_at": "document_end"
                }]
            }"#,
        )
        .unwrap();
        fs::write(ext_dir.join("popup.html"), "<html><head></head><body>Hi</body></html>").unwrap();
        fs::write(ext_dir.join("content.js"), "console.log('hi');").unwrap();

        let mut mgr = ExtensionManager::load(data_dir.clone());
        let ext = mgr.load_unpacked(&ext_dir).unwrap();
        assert_eq!(ext.name, "Sample Ext");
        assert_eq!(ext.popup.as_deref(), Some("popup.html"));
        assert_eq!(ext.content_scripts.len(), 1);

        // Storage set & get
        mgr.storage_op(&ext.id, "set", serde_json::json!({ "theme": "dark", "count": 5 }));
        let got = mgr.storage_op(&ext.id, "get", serde_json::json!(["theme", "missing"]));
        assert_eq!(got.get("theme").and_then(|v| v.as_str()), Some("dark"));
        assert!(got.get("missing").is_none());

        // Asset resolution + path traversal block
        assert!(mgr.resolve_asset(&ext.id, "popup.html").is_some());
        assert!(mgr.resolve_asset(&ext.id, "../manifest.json").is_none());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn cws_id_extraction_works() {
        assert_eq!(
            extract_cws_extension_id("https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh"),
            Some("ddkjiahejlhfcafbddmgiahcphecmpfh".to_string())
        );
        assert_eq!(
            extract_cws_extension_id("ddkjiahejlhfcafbddmgiahcphecmpfh"),
            Some("ddkjiahejlhfcafbddmgiahcphecmpfh".to_string())
        );
        assert_eq!(extract_cws_extension_id("https://example.com/not-an-ext"), None);
    }

    #[test]
    fn dnr_ruleset_blocking_works() {
        let base = std::env::temp_dir().join(format!("forkit-dnr-test-{}", std::process::id()));
        let ext_dir = base.join("ubol-test");
        let rules_dir = ext_dir.join("rulesets");
        let data_dir = base.join("data");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&rules_dir).unwrap();
        fs::write(
            ext_dir.join("manifest.json"),
            r#"{
                "manifest_version": 3,
                "name": "uBOL Test",
                "version": "1.0",
                "declarative_net_request": {
                    "rule_resources": [{ "id": "default", "enabled": true, "path": "rulesets/default.json" }]
                }
            }"#,
        )
        .unwrap();
        fs::write(
            rules_dir.join("default.json"),
            r#"[
                { "id": 1, "action": { "type": "block" }, "condition": { "urlFilter": "||doubleclick.net^" } },
                { "id": 2, "action": { "type": "block" }, "condition": { "requestDomains": ["ads.example.com"] } },
                { "id": 3, "action": { "type": "allow" }, "condition": { "requestDomains": ["safe.doubleclick.net"] } },
                { "id": 4, "action": { "type": "block" }, "condition": { "urlFilter": "||youtube.com/*", "resourceTypes": ["script"] } },
                { "id": 5, "action": { "type": "block" }, "condition": { "urlFilter": "||www.youtube.com^", "domainType": "thirdParty" } }
            ]"#,
        )
        .unwrap();

        let mut mgr = ExtensionManager::load(data_dir);
        mgr.load_unpacked(&ext_dir).unwrap();
        assert!(mgr.should_block_dnr("https://pagead2.doubleclick.net/pagead/js/adsbygoogle.js"));
        assert!(mgr.should_block_dnr("https://ads.example.com/banner.js"));
        assert!(!mgr.should_block_dnr("https://safe.doubleclick.net/ok.js"));
        assert!(!mgr.should_block_dnr("https://www.youtube.com/"));
        assert!(!mgr.should_block_dnr("https://youtube.com/watch?v=123"));
        assert!(mgr.build_dnr_runtime_script().is_some());

        let _ = fs::remove_dir_all(&base);
    }
}
